// OAuth clients: Dynamic Client Registration (RFC 7591) and Client ID Metadata Documents
// (draft-ietf-oauth-client-id-metadata-document, recommended by the MCP authorization spec).
//
// Every client is public (no secret): token_endpoint_auth_method "none", and PKCE S256 is always required.
// Redirect URIs must be https, or http on a loopback address (native apps), and are matched exactly
// (except that a loopback redirect may use any port, RFC 8252 §7.3).
//
// A metadata document is fetched only over https, from a public address (private, loopback and link-local
// addresses are refused at connect time, so DNS rebinding can't reach internal services), without
// redirects, with a timeout and a size cap, and cached in oauth_clients for its max-age (5 min to 24 h).
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { db, newId, now } from '../db.ts';

export interface OAuthClient {
  id: string;
  kind: 'dcr' | 'cimd';
  name: string;
  clientUri: string | null;
  redirectUris: string[];
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

const MAX_REDIRECTS = 10;
const MAX_URI = 2000;
const MAX_NAME = 100;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** A redirect URI a client may register: https, or http on loopback; absolute, no fragment, no credentials. */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URI || raw.includes('#')) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

/** Whether `uri` (from an authorization request) matches one of the client's registered redirect URIs. */
export function redirectMatches(client: OAuthClient, uri: string): boolean {
  if (client.redirectUris.includes(uri)) return true;
  // RFC 8252 §7.3: native apps listen on an ephemeral loopback port, so the port may differ.
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname)) return false;
  return client.redirectUris.some((r) => {
    const v = new URL(r);
    return v.protocol === 'http:' && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search;
  });
}

const cleanName = (v: unknown, fallback: string) => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return (s || fallback).slice(0, MAX_NAME);
};
const cleanUri = (v: unknown) => (typeof v === 'string' && v.length <= MAX_URI && /^https:\/\/[^\s]+$/.test(v) ? v : null);

function validRedirectList(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array');
  if (v.length > MAX_REDIRECTS) throw new OAuthError('invalid_redirect_uri', `At most ${MAX_REDIRECTS} redirect_uris`);
  for (const r of v) if (!validRedirectUri(r)) throw new OAuthError('invalid_redirect_uri', 'Each redirect URI must be https, or http on a loopback address, without a fragment');
  return [...new Set(v as string[])];
}

/**
 * The client must be able to use the authorization code flow. Other grant and response types it lists
 * (e.g. Claude's metadata document also lists urn:ietf:params:oauth:grant-type:jwt-bearer) are ignored, not
 * refused: this server only ever issues codes and refresh tokens, and the registration response says so.
 */
function checkTypes(meta: Record<string, unknown>) {
  const grants = meta.grant_types ?? ['authorization_code'];
  if (!Array.isArray(grants) || !grants.includes('authorization_code'))
    throw new OAuthError('invalid_client_metadata', 'The client must support the authorization_code grant type');
  const responses = meta.response_types ?? ['code'];
  if (!Array.isArray(responses) || !responses.includes('code')) throw new OAuthError('invalid_client_metadata', 'The client must support response_type "code"');
}

/** RFC 7591 registration. Any requested auth method is answered with "none": every client here is public. */
export function registerClient(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new OAuthError('invalid_client_metadata', 'Expected a JSON object');
  const m = meta as Record<string, unknown>;
  const redirectUris = validRedirectList(m.redirect_uris);
  checkTypes(m);
  const id = newId();
  const name = cleanName(m.client_name, 'Unnamed app');
  const clientUri = cleanUri(m.client_uri);
  const ts = now();
  db.prepare('INSERT INTO oauth_clients (id, kind, name, client_uri, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    'dcr',
    name,
    clientUri,
    JSON.stringify(redirectUris),
    ts,
  );
  return {
    client_id: id,
    client_id_issued_at: Math.floor(Date.parse(ts) / 1000),
    client_name: name,
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

interface ClientRow {
  id: string;
  kind: 'dcr' | 'cimd';
  name: string;
  client_uri: string | null;
  redirect_uris: string;
  expires_at: string | null;
}
const toClient = (r: ClientRow): OAuthClient => ({ id: r.id, kind: r.kind, name: r.name, clientUri: r.client_uri, redirectUris: JSON.parse(r.redirect_uris) });

/** A client already known (registered, or a cached metadata document even if stale). For the token endpoint and the UI. */
export function getStoredClient(id: unknown): OAuthClient | null {
  if (typeof id !== 'string' || !id || id.length > MAX_URI) return null;
  const r = db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id) as ClientRow | undefined;
  return r ? toClient(r) : null;
}

/** A client_id that names a metadata document: https, with a path, no fragment, credentials, or dot segments. */
export function isMetadataUrl(id: string): boolean {
  if (!id.startsWith('https://') || id.length > MAX_URI) return false;
  try {
    const u = new URL(id);
    return !u.username && !u.password && !u.hash && !id.includes('#') && u.pathname !== '/' && !/\/\.\.?(\/|$)/.test(id.slice(8)) && u.href === id;
  } catch {
    return false;
  }
}

/** Resolve a client for an authorization request, fetching (or refreshing) its metadata document if it is a URL. */
export async function resolveClient(id: unknown): Promise<OAuthClient | null> {
  if (typeof id !== 'string' || !id) return null;
  if (!isMetadataUrl(id)) {
    const c = getStoredClient(id);
    return c?.kind === 'dcr' ? c : null;
  }
  const cached = db.prepare("SELECT * FROM oauth_clients WHERE id = ? AND kind = 'cimd'").get(id) as ClientRow | undefined;
  if (cached && cached.expires_at && cached.expires_at > now()) return toClient(cached);
  const { body, maxAge } = await fetcher(id);
  const doc = parseMetadataDocument(id, body);
  const expires = new Date(Date.now() + Math.min(86_400, Math.max(300, maxAge ?? 3600)) * 1000).toISOString();
  db.prepare(
    `INSERT INTO oauth_clients (id, kind, name, client_uri, redirect_uris, created_at, expires_at) VALUES (?, 'cimd', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, client_uri = excluded.client_uri, redirect_uris = excluded.redirect_uris, expires_at = excluded.expires_at`,
  ).run(id, doc.name, doc.clientUri, JSON.stringify(doc.redirectUris), now(), expires);
  return { id, kind: 'cimd', ...doc };
}

/** Validate a fetched Client ID Metadata Document. */
export function parseMetadataDocument(url: string, body: string): Omit<OAuthClient, 'id' | 'kind'> {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(body);
  } catch {
    throw new OAuthError('invalid_client', 'The client metadata document is not valid JSON');
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new OAuthError('invalid_client', 'The client metadata document must be a JSON object');
  if (m.client_id !== url) throw new OAuthError('invalid_client', 'The client metadata document’s client_id does not match its URL');
  if (typeof m.client_name !== 'string' || !m.client_name.trim()) throw new OAuthError('invalid_client', 'The client metadata document has no client_name');
  const method = m.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') throw new OAuthError('invalid_client', 'Only public clients (token_endpoint_auth_method "none") are supported');
  if ('client_secret' in m || 'client_secret_expires_at' in m) throw new OAuthError('invalid_client', 'A client metadata document must not contain a secret');
  let redirectUris: string[];
  try {
    redirectUris = validRedirectList(m.redirect_uris);
    checkTypes(m);
  } catch (e) {
    throw new OAuthError('invalid_client', e instanceof Error ? e.message : 'Invalid client metadata');
  }
  return { name: cleanName(m.client_name, new URL(url).hostname), clientUri: cleanUri(m.client_uri), redirectUris };
}

// ── Fetching metadata documents ──

const MAX_DOC_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5000;

/** Addresses a metadata fetch must never reach. */
const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 127], // :: and ::1
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(a, p, 'ipv6');

export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  const family = net.isIP(address);
  if (!family) return true;
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** dns.lookup that refuses non-public addresses, used as the socket's lookup so the checked address is the one connected to. */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, '', 0);
    const list = addresses as unknown as dns.LookupAddress[];
    const bad = !list.length || list.some((a) => isBlockedAddress(a.address));
    if (bad) return (callback as (e: Error | null, a: string, f: number) => void)(new Error('Refusing to fetch client metadata from a non-public address'), '', 0);
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

export type MetadataFetcher = (url: string) => Promise<{ body: string; maxAge: number | null }>;

const httpsFetcher: MetadataFetcher = (url) =>
  new Promise((resolve, reject) => {
    const fail = (msg: string) => reject(new OAuthError('invalid_client', msg));
    if (net.isIP(new URL(url).hostname.replace(/^\[|\]$/g, ''))) return fail('The client metadata URL must use a host name');
    const req = https.get(url, { lookup: safeLookup, timeout: FETCH_TIMEOUT_MS, headers: { accept: 'application/json', 'user-agent': 'Notivelo-OAuth' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return fail(`Fetching the client metadata document returned HTTP ${res.statusCode}`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_DOC_BYTES) {
          req.destroy();
          fail('The client metadata document is too large');
        } else chunks.push(c);
      });
      res.on('end', () => {
        const cc = String(res.headers['cache-control'] ?? '');
        const age = /max-age=(\d+)/.exec(cc);
        resolve({ body: Buffer.concat(chunks).toString('utf8'), maxAge: /no-store|no-cache/.test(cc) ? 0 : age ? Number(age[1]) : null });
      });
      res.on('error', () => fail('Could not read the client metadata document'));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => fail('Could not fetch the client metadata document'));
  });

let fetcher: MetadataFetcher = httpsFetcher;
/** Tests only: replace the metadata fetcher (undefined restores the real one). */
export function setMetadataFetcher(f: MetadataFetcher | undefined) {
  fetcher = f ?? httpsFetcher;
}

/** Housekeeping: registered clients nobody ever connected, and stale cached documents nobody uses. */
export function pruneClients() {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  db.prepare(
    `DELETE FROM oauth_clients WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)
       AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = oauth_clients.id)
       AND ((kind = 'dcr' AND created_at < ?) OR (kind = 'cimd' AND expires_at < ?))`,
  ).run(weekAgo, now());
}
