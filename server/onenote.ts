// Import from OneNote through Microsoft Graph (#117). Owner: Import.
//
// Flow (all server-side; the browser only ever sees our own URLs and opaque ids):
//   1. POST /import/onenote/start {workspaceId}  (signed in) → a one-time URL /import/onenote/authorize?ticket=…
//   2. GET  /import/onenote/authorize?ticket=…   (top-level navigation) → sets a short-lived HttpOnly cookie
//      bound to this flow and redirects to Microsoft (authorization code + PKCE S256, `common` authority).
//   3. GET  /import/onenote/callback?code&state  → `state` must name a pending flow (single use, 10 min) AND the
//      browser must present that flow's cookie; otherwise 400. This stops CSRF and login-swap: a link to
//      Microsoft crafted by someone else has no cookie in the victim's browser, and a flow started by someone
//      else hands its result to a connection only its own user can read. The code is exchanged with the
//      PKCE verifier and the client secret, and the tokens go into an in-memory "connection" known only by a
//      fresh random id, sent back in the redirect to the app.
//   4. The app (bearer auth) lists notebooks and starts an import job; it polls the job for progress.
// Tokens live only in memory, only for the connection (1 hour) and the job using it; they are never sent to
// the client and never logged. Graph requests only ever go to https://graph.microsoft.com/v1.0/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, newId, now, pickColor } from './db.ts';
import { HttpError, requireRole } from './access.ts';
import { FILES_DIR, PUBLIC_URL } from './config.ts';
import { publish } from './events.ts';
import { log } from './log.ts';
import { createTask, updateTask } from './tasks.ts';
import { nextPos, nextSectionPos } from './tree.ts';
import { MAX_SECTION_DEPTH } from '../shared/sections.ts';
import { seedPageDoc } from './collab.ts';
import { sanitizeYDoc } from './sanitizeDoc.ts';
import { MAX_UPLOAD_BYTES, SAFE_TYPES, storedExt } from './routes/files.ts';
import { convertOneNotePage, jsonToYFragment, RES_PREFIX, type PMNode, type Resource } from './onenoteHtml.ts';
import { safeImageUrl, sanitizeContent } from '../shared/urls.ts';
import { BOXES_KEY, boxField } from '../shared/pageDoc.ts';
import * as Y from 'yjs';

export const LOGIN_ORIGIN = 'https://login.microsoftonline.com';
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
export const SCOPES = 'Notes.Read offline_access User.Read';
export const CALLBACK_PATH = '/api/import/onenote/callback';
export const COOKIE = 'onenote_flow';
export const FLOW_TTL_MS = 10 * 60_000;
export const TICKET_TTL_MS = 2 * 60_000;
export const CONNECTION_TTL_MS = 60 * 60_000;
const MAX_PENDING = 500;
export const MAX_PAGES_PER_JOB = 5000;
export const MAX_PAGE_HTML_BYTES = 1024 * 1024;
/** Resource limits for jobs (one small server, open sign-up). Mutable only so tests can shrink them. */
export const limits = {
  /** Files downloaded by one job (the same as workspace import's unpacked cap). */
  maxJobBytes: 300 * 1024 * 1024,
  /** Files downloaded per user in a rolling 24 hours, across jobs. */
  dailyUserBytes: 1024 * 1024 * 1024,
  /** One Graph request, body included. */
  requestTimeoutMs: 30_000,
  /** A job ends as "partial" after this, keeping what it imported. */
  jobDeadlineMs: 30 * 60_000,
  /** Total Retry-After waiting per job; past it the request fails (the page becomes a warning). */
  maxWaitTotalMs: 10 * 60_000,
  /** Sections plus section groups read per job. */
  maxSections: 500,
  /** Microsoft sign-ins kept per user (the oldest idle one is dropped). */
  maxConnectionsPerUser: 2,
};
const MAX_RESOURCES_PER_PAGE = 200;
export const MAX_TRIES = 6;
const MAX_WAIT_S = 120;

/** Injected so tests replay recorded Graph responses and don't wait for real Retry-After delays. */
export const deps = {
  fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Stopped());
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Stopped())), { once: true });
    }),
};

/** The feature is on only when both values are configured (read on each call, so tests can switch it). */
export function oneNoteConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.MS_CLIENT_ID?.trim();
  const clientSecret = process.env.MS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: `${PUBLIC_URL}${CALLBACK_PATH}` };
}
const config = () => {
  const c = oneNoteConfig();
  if (!c) throw new HttpError(404, 'Not found');
  return c;
};

const rand = () => crypto.randomBytes(24).toString('base64url');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const sameSecret = (a: string, hash: Buffer) => crypto.timingSafeEqual(sha(a), hash);

// ───────── OAuth flows ─────────

interface Flow {
  userId: string;
  workspaceId: string;
  verifier: string;
  ticket: string | null;
  cookieHash: Buffer | null;
  expires: number;
}
const flows = new Map<string, Flow>(); // state → flow
const tickets = new Map<string, string>(); // ticket → state

function prune() {
  const t = Date.now();
  for (const [state, f] of flows) if (f.expires < t) flows.delete(state);
  for (const [ticket, state] of tickets) if (!flows.has(state) || flows.get(state)!.ticket !== ticket || flows.get(state)!.expires < t) tickets.delete(ticket);
  for (const [id, c] of connections) if (!c.busy && c.expires < t) connections.delete(id);
  for (const [id, j] of jobs) if (j.finishedAt && Date.parse(j.finishedAt) + CONNECTION_TTL_MS < t) jobs.delete(id);
}

/** Step 1: a one-time URL that starts the Microsoft sign-in in the browser. */
export function startFlow(userId: string, workspaceId: string): { url: string } {
  config();
  requireRole(workspaceId, userId, 'member');
  prune();
  for (const [state, f] of flows) if (f.userId === userId) flows.delete(state); // one pending sign-in per user
  if (flows.size >= MAX_PENDING) throw new HttpError(429, 'Too many sign-ins in progress. Try again in a few minutes.');
  const state = rand();
  const ticket = rand();
  flows.set(state, { userId, workspaceId, verifier: crypto.randomBytes(48).toString('base64url'), ticket, cookieHash: null, expires: Date.now() + FLOW_TTL_MS });
  tickets.set(ticket, state);
  setTimeout(() => tickets.delete(ticket), TICKET_TTL_MS).unref();
  return { url: `${PUBLIC_URL}/api/import/onenote/authorize?ticket=${encodeURIComponent(ticket)}` };
}

/** Step 2: consume the ticket, bind the flow to a cookie, and build Microsoft's authorize URL. */
export function authorizeFlow(ticket: unknown): { cookie: string; location: string } | null {
  const c = config();
  prune();
  const state = typeof ticket === 'string' ? tickets.get(ticket) : undefined;
  if (!state) return null;
  tickets.delete(ticket as string);
  const f = flows.get(state);
  if (!f || f.ticket !== ticket) return null;
  const cookie = rand();
  f.ticket = null;
  f.cookieHash = sha(cookie);
  const q = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: c.redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: crypto.createHash('sha256').update(f.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { cookie, location: `${LOGIN_ORIGIN}/common/oauth2/v2.0/authorize?${q}` };
}

export class BadState extends Error {}

/**
 * Step 3: check `state` and the flow cookie BEFORE anything else (single use), then exchange the code.
 * Returns where to send the browser. Throws BadState for an unknown/expired/replayed state or a missing/wrong cookie.
 */
export async function completeFlow(q: { state?: unknown; code?: unknown; error?: unknown }, cookie: string | undefined): Promise<{ redirect: string }> {
  const c = config();
  prune();
  const state = typeof q.state === 'string' ? q.state : '';
  const f = state ? flows.get(state) : undefined;
  if (!f || !f.cookieHash || !cookie || !sameSecret(cookie, f.cookieHash)) throw new BadState('invalid state');
  flows.delete(state);
  const back = (params: string) => ({ redirect: `${PUBLIC_URL}/w/${encodeURIComponent(f.workspaceId)}/settings?s=workspace&${params}` });
  if (q.error || typeof q.code !== 'string' || !q.code) return back('onenote=denied');
  const res = await deps.fetch(`${LOGIN_ORIGIN}/common/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code: q.code, redirect_uri: c.redirectUri, code_verifier: f.verifier, scope: SCOPES }),
    signal: AbortSignal.timeout(limits.requestTimeoutMs),
  });
  if (!res.ok) {
    log.warn('OneNote sign-in: token exchange failed', { event: 'onenote_token', status: res.status });
    return back('onenote=failed');
  }
  const t = (await res.json()) as TokenResponse;
  if (typeof t.access_token !== 'string') return back('onenote=failed');
  const id = rand();
  const conn: Connection = { userId: f.userId, workspaceId: f.workspaceId, ...tokens(t), expires: Date.now() + CONNECTION_TTL_MS, busy: false, account: null, run: null };
  // Which Microsoft account this is (User.Read), shown in the app so the user confirms it before importing.
  try {
    const me = JSON.parse((await graphGet(conn, '/me?$select=displayName,mail,userPrincipalName', 64 * 1024)).body.toString('utf8'));
    conn.account = { name: String(me.displayName ?? '').slice(0, 200), email: String(me.mail || me.userPrincipalName || '').slice(0, 320) };
  } catch {
    conn.account = null;
  }
  // At most a couple of sign-ins per user: drop the oldest idle ones.
  const mine = [...connections].filter(([, c]) => c.userId === f.userId && !c.busy).sort((a, b) => a[1].expires - b[1].expires);
  while (mine.length >= limits.maxConnectionsPerUser) connections.delete(mine.shift()![0]);
  connections.set(id, conn);
  return back(`onenote=${encodeURIComponent(id)}`);
}

// ───────── Connections and Graph ─────────

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}
interface Connection {
  userId: string;
  workspaceId: string;
  access: string;
  refresh: string | null;
  accessExpires: number;
  expires: number;
  busy: boolean;
  /** The signed-in Microsoft account (GET /me), if Graph told us. */
  account: { name: string; email: string } | null;
  /** The job using this connection: its abort signal (cancel / deadline) and Retry-After budget. */
  run: { abort: AbortController; waitedMs: number } | null;
}
const connections = new Map<string, Connection>();
const tokens = (t: TokenResponse) => ({ access: t.access_token!, refresh: t.refresh_token ?? null, accessExpires: Date.now() + (Number(t.expires_in) || 3600) * 1000 });

/** The caller's own connection, or 404 (someone else's id looks exactly like a missing one). */
export function connectionFor(id: string, userId: string): Connection {
  config();
  prune();
  const c = connections.get(id);
  if (!c || c.userId !== userId) throw new HttpError(404, 'That Microsoft sign-in has expired. Sign in again.');
  return c;
}

async function refresh(conn: Connection): Promise<boolean> {
  const c = oneNoteConfig();
  if (!c || !conn.refresh) return false;
  const res = await deps.fetch(`${LOGIN_ORIGIN}/common/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: conn.refresh, scope: SCOPES }),
    signal: AbortSignal.timeout(limits.requestTimeoutMs),
  });
  if (!res.ok) return false;
  const t = (await res.json()) as TokenResponse;
  if (typeof t.access_token !== 'string') return false;
  Object.assign(conn, tokens({ ...t, refresh_token: t.refresh_token ?? conn.refresh }));
  return true;
}

export class GraphError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** Graph's error code (e.g. "40004"), from at most 4 KB of an error body. Never the message: it can contain account details. */
async function graphErrorCode(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).slice(0, 4096);
    const code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
    return typeof code === 'string' ? code.replace(/[^\w.-]/g, '').slice(0, 60) : undefined;
  } catch {
    return undefined;
  }
}
/** The job was cancelled or reached its deadline. */
export class Stopped extends Error {}

/** Seconds to wait before retry `attempt` (0-based): Retry-After (seconds or a date) if given, else 1, 2, 4… */
export function retryDelay(header: string | null, attempt: number): number {
  let s = Number.NaN;
  if (header) s = /^\d+$/.test(header.trim()) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
  if (!Number.isFinite(s) || s < 0) s = 2 ** attempt;
  return Math.min(MAX_WAIT_S, Math.max(0, s));
}

/** An absolute https://graph.microsoft.com/v1.0/… URL, or a GraphError. The only place the token may go. */
function graphUrl(url: string): string {
  const full = url.startsWith('/') ? `${GRAPH_BASE}${url}` : url;
  if (!full.startsWith(`${GRAPH_BASE}/`) || /[\s\\]/.test(full) || new URL(full).origin !== new URL(GRAPH_BASE).origin) throw new GraphError(400, 'Not a Microsoft Graph URL');
  return full;
}

/**
 * GET a Graph URL with the connection's token. Only https://graph.microsoft.com/v1.0/… is ever fetched (URLs
 * from page HTML, @odata.nextLink and redirects included), so the token can't be sent anywhere else. Each
 * request (body included) times out; 429/503/504 and network errors are retried (Retry-After honoured, within
 * the job's total waiting budget); the token is refreshed once on 401; the body size is capped.
 */
export async function graphGet(conn: Connection, url: string, maxBytes = 10 * 1024 * 1024): Promise<{ body: Buffer; type: string }> {
  let full = graphUrl(url);
  const run = conn.run;
  const stopped = () => run?.abort.signal.aborted;
  let refreshed = false;
  let hops = 0;
  for (let attempt = 0; ; attempt++) {
    if (stopped()) throw new Stopped();
    if (conn.accessExpires < Date.now() + 60_000 && conn.refresh && !refreshed) refreshed = await refresh(conn);
    const signal = run ? AbortSignal.any([AbortSignal.timeout(limits.requestTimeoutMs), run.abort.signal]) : AbortSignal.timeout(limits.requestTimeoutMs);
    const wait = async (ms: number) => {
      if (run) {
        if (run.waitedMs + ms > limits.maxWaitTotalMs) throw new GraphError(429, 'Microsoft Graph kept throttling the import');
        run.waitedMs += ms;
      }
      await deps.sleep(ms, run?.abort.signal);
    };
    let res: Response;
    try {
      // Redirects are followed by hand, and only to Graph (see graphUrl).
      res = await deps.fetch(full, { headers: { authorization: `Bearer ${conn.access}` }, redirect: 'manual', signal });
    } catch {
      if (stopped()) throw new Stopped();
      if (attempt + 1 >= MAX_TRIES) throw new GraphError(502, 'Microsoft Graph could not be reached');
      await wait(retryDelay(null, attempt) * 1000);
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get('location');
      if (!loc || ++hops > 3) throw new GraphError(502, 'Unexpected redirect from Microsoft Graph');
      full = graphUrl(new URL(loc, full).href);
      attempt--;
      continue;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await res.body?.cancel().catch(() => {});
      if (await refresh(conn)) continue;
      throw new GraphError(401, 'The Microsoft sign-in has expired');
    }
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt + 1 < MAX_TRIES) {
      await res.body?.cancel().catch(() => {});
      await wait(retryDelay(res.headers.get('retry-after'), attempt) * 1000);
      continue;
    }
    if (!res.ok) {
      const code = await graphErrorCode(res);
      log.warn('OneNote: Microsoft Graph error', { event: 'onenote_graph', status: res.status, code });
      throw new GraphError(res.status, `Microsoft Graph answered ${res.status}`, code);
    }
    if (Number(res.headers.get('content-length')) > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new GraphError(413, 'Too large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      if (res.body) {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > maxBytes) throw new GraphError(413, 'Too large');
          chunks.push(Buffer.from(chunk));
        }
      }
    } catch (e) {
      if (e instanceof GraphError) throw e;
      if (stopped()) throw new Stopped();
      throw new GraphError(504, 'Microsoft Graph timed out');
    }
    return { body: Buffer.concat(chunks), type: res.headers.get('content-type') ?? '' };
  }
}

/** A Graph collection, following @odata.nextLink. */
async function graphList<T>(conn: Connection, url: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < 100; i++) {
    const { body } = await graphGet(conn, next);
    const j = JSON.parse(body.toString('utf8')) as { value?: T[]; '@odata.nextLink'?: string };
    if (Array.isArray(j.value)) out.push(...j.value);
    next = typeof j['@odata.nextLink'] === 'string' ? j['@odata.nextLink'] : undefined;
  }
  return out;
}

interface GNotebook {
  id: string;
  displayName?: string;
}
interface GSection {
  id: string;
  displayName?: string;
}
interface GPage {
  id: string;
  title?: string;
  order?: number;
}
const seg = (id: string) => encodeURIComponent(id);

export async function listNotebooks(conn: Connection): Promise<{ id: string; name: string }[]> {
  let nbs: GNotebook[];
  try {
    nbs = await graphList<GNotebook>(conn, '/me/onenote/notebooks?$select=id,displayName');
  } catch (e) {
    // An account where OneNote was never set up has no notebook store yet: Graph answers 404, or 403
    // (e.g. OneDrive not provisioned) instead of an empty list. Show it as "no notebooks".
    if (e instanceof GraphError && (e.status === 404 || e.status === 403)) return [];
    throw e;
  }
  return nbs.filter((n) => typeof n.id === 'string').map((n) => ({ id: n.id, name: String(n.displayName ?? 'Notebook').slice(0, 100) }));
}

/**
 * A section to create: a OneNote section (`graphId` set, its pages are imported) or a section group
 * (`graphId` null: a section that only holds subsections). `parentKey` is the enclosing group's `key`.
 */
export interface ImportSection {
  key: string;
  graphId: string | null;
  name: string;
  parentKey: string | null;
}

/**
 * Sections of a notebook, parents before children. Section groups become sections holding their
 * contents as subsections, up to MAX_SECTION_DEPTH levels; groups nested deeper than that are
 * flattened into a "Group / Section" name at the deepest level. `budget.left` counts sections + groups per job.
 */
async function sectionsOf(conn: Connection, notebookId: string, budget: { left: number }): Promise<ImportSection[]> {
  const out: ImportSection[] = [];
  // level: the level the sections found here are created at (1 = top of the notebook).
  const walk = async (base: string, parentKey: string | null, level: number, prefix: string, depth: number) => {
    for (const s of await graphList<GSection>(conn, `${base}/sections?$select=id,displayName`)) {
      if (budget.left-- <= 0) return;
      out.push({ key: `s:${s.id}`, graphId: s.id, name: `${prefix}${s.displayName ?? 'Section'}`, parentKey });
    }
    if (depth > 10) return;
    for (const g of await graphList<GSection>(conn, `${base}/sectionGroups?$select=id,displayName`)) {
      if (budget.left-- <= 0) return;
      const groupBase = `/me/onenote/sectionGroups/${seg(g.id)}`;
      const name = `${prefix}${g.displayName ?? 'Group'}`;
      if (level < MAX_SECTION_DEPTH) {
        const key = `g:${g.id}`;
        out.push({ key, graphId: null, name, parentKey });
        await walk(groupBase, key, level + 1, '', depth + 1);
      } else {
        await walk(groupBase, parentKey, level, `${name} / `, depth + 1);
      }
    }
  };
  await walk(`/me/onenote/notebooks/${seg(notebookId)}`, null, 1, '', 0);
  return out;
}

// ───────── Import jobs ─────────

export interface JobStatus {
  id: string;
  /** partial: stopped at the deadline; cancelled: stopped by the user; failed: an error. Then `incomplete` is true. */
  status: 'running' | 'done' | 'partial' | 'cancelled' | 'failed';
  incomplete: boolean;
  workspaceId: string;
  notebooks: { total: number; done: number };
  pages: { total: number; done: number };
  images: number;
  attachments: number;
  tasks: number;
  imported: { id: string; name: string }[];
  warnings: string[];
  error: string | null;
  finishedAt: string | null;
}
type Job = JobStatus & { userId: string; abort: AbortController };
const jobs = new Map<string, Job>();

/** Bytes downloaded per user in the current 24-hour window. */
const daily = new Map<string, { since: number; bytes: number }>();
function dailyUsage(userId: string) {
  const t = Date.now();
  let d = daily.get(userId);
  if (!d || d.since + 864e5 < t) daily.set(userId, (d = { since: t, bytes: 0 }));
  return d;
}

function own(id: string, userId: string): Job {
  config();
  const j = jobs.get(id);
  if (!j || j.userId !== userId) throw new HttpError(404, 'Import not found');
  return j;
}
export function jobFor(id: string, userId: string): JobStatus {
  const { userId: _u, abort: _a, ...status } = own(id, userId);
  return { ...status, imported: status.imported.map((n) => ({ ...n })), warnings: status.warnings.slice(0, 50) };
}
/** Stop a running import (owner only). What's imported so far stays, marked "(incomplete)". */
export function cancelJob(id: string, userId: string): JobStatus {
  const j = own(id, userId);
  if (j.status === 'running') j.abort.abort('cancelled');
  return jobFor(id, userId);
}

/** Start importing the chosen notebooks into the connection's workspace. `release` ends the import admission. */
export function startJob(conn: Connection, connId: string, notebookIds: string[], release: () => void): JobStatus {
  requireRole(conn.workspaceId, conn.userId, 'member');
  if (conn.busy) throw new HttpError(409, 'An import is already running for this sign-in');
  const abort = new AbortController();
  const job: Job = {
    id: newId(), userId: conn.userId, abort, status: 'running', incomplete: false, workspaceId: conn.workspaceId,
    notebooks: { total: notebookIds.length, done: 0 }, pages: { total: 0, done: 0 }, images: 0, attachments: 0, tasks: 0,
    imported: [], warnings: [], error: null, finishedAt: null,
  };
  jobs.set(job.id, job);
  conn.busy = true;
  conn.run = { abort, waitedMs: 0 };
  const deadline = setTimeout(() => abort.abort('deadline'), limits.jobDeadlineMs);
  deadline.unref();
  const unfinished = new Set<string>(); // notebooks created but not finished
  void runJob(job, conn, notebookIds, unfinished)
    .catch((e) => {
      if (e instanceof Stopped || abort.signal.aborted) {
        job.status = abort.signal.reason === 'cancelled' ? 'cancelled' : 'partial';
        job.error = job.status === 'cancelled' ? 'Cancelled' : `Stopped after ${Math.round(limits.jobDeadlineMs / 60_000)} minutes`;
        return;
      }
      job.status = 'failed';
      job.error = e instanceof GraphError || e instanceof HttpError ? e.message : 'The import stopped unexpectedly';
      log.warn('OneNote import failed', { event: 'onenote_import', jobId: job.id, error: (e as Error).message });
    })
    .finally(() => {
      clearTimeout(deadline);
      if (job.status === 'running') job.status = 'done';
      // A half-imported notebook says so in its name, rather than looking complete.
      if (job.status !== 'done' && unfinished.size) {
        job.incomplete = true;
        for (const n of job.imported) {
          if (!unfinished.has(n.id)) continue;
          n.name = `${n.name} (incomplete)`.slice(0, 100);
          db.prepare('UPDATE notebooks SET name = ? WHERE id = ?').run(n.name, n.id);
        }
      }
      if (job.status !== 'done') job.incomplete = true;
      job.finishedAt = now();
      // The tokens are only for this import: forget them.
      conn.busy = false;
      conn.run = null;
      connections.delete(connId);
      release();
      publish({ type: 'tree', workspaceId: job.workspaceId });
    });
  return jobFor(job.id, conn.userId);
}

const warn = (job: JobStatus, msg: string) => {
  if (job.warnings.length < 200 && !job.warnings.includes(msg)) job.warnings.push(msg);
};

async function runJob(job: Job, conn: Connection, notebookIds: string[], unfinished: Set<string>) {
  const { userId, workspaceId } = job;
  const all = await listNotebooks(conn);
  const ctx = { bytes: 0 };
  const budget = { left: limits.maxSections };
  for (const nbId of notebookIds) {
    if (job.abort.signal.aborted) throw new Stopped();
    const nb = all.find((n) => n.id === nbId);
    if (!nb) {
      warn(job, 'A notebook you picked is no longer available');
      job.notebooks.done++;
      continue;
    }
    const sections = await sectionsOf(conn, nb.id, budget);
    if (budget.left < 0) warn(job, `Only the first ${limits.maxSections} sections and section groups were imported`);
    const notebookId = newId();
    // Imported notebooks are private to the importer (the issue: "private by default"); they can share them later.
    db.prepare('INSERT INTO notebooks (id, workspace_id, name, color, visibility, created_by, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      notebookId, workspaceId, nb.name || 'Notebook', pickColor(), 'private', userId, nextPos('notebooks', 'workspace_id', workspaceId), now(),
    );
    job.imported.push({ id: notebookId, name: nb.name });
    unfinished.add(notebookId);
    const created = new Map<string, string>(); // ImportSection.key → our section id
    const addSection = (s: ImportSection) => {
      const sectionId = newId();
      const parentId = s.parentKey ? (created.get(s.parentKey) ?? null) : null;
      db.prepare('INSERT INTO sections (id, notebook_id, parent_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        sectionId, notebookId, parentId, s.name.slice(0, 100) || 'Section', pickColor(), nextSectionPos(notebookId, parentId), now(),
      );
      created.set(s.key, sectionId);
      return sectionId;
    };
    for (const s of sections) {
      if (!s.graphId) {
        addSection(s); // a section group: holds subsections, no pages of its own
        continue;
      }
      let pages: GPage[];
      try {
        pages = await graphList<GPage>(conn, `/me/onenote/sections/${seg(s.graphId)}/pages?$select=id,title,order&pagelevel=true&$top=100`);
      } catch (e) {
        if (e instanceof Stopped) throw e;
        warn(job, `Section “${s.name}” in “${nb.name}” couldn't be read${e instanceof GraphError && e.status === 403 ? ' (password-protected sections can’t be imported)' : ''}`);
        continue;
      }
      pages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const sectionId = addSection(s);
      job.pages.total += pages.length;
      for (const p of pages) {
        if (job.pages.done >= MAX_PAGES_PER_JOB) {
          warn(job, `Stopped after ${MAX_PAGES_PER_JOB} pages`);
          return;
        }
        try {
          await importPage(job, conn, ctx, sectionId, p);
        } catch (e) {
          if (e instanceof Stopped) throw e;
          warn(job, `Page “${String(p.title ?? '').slice(0, 80) || 'Untitled'}” couldn't be imported${e instanceof GraphError ? ` (${e.message})` : ''}`);
        }
        job.pages.done++;
      }
    }
    unfinished.delete(notebookId);
    job.notebooks.done++;
    publish({ type: 'tree', workspaceId });
  }
}

const IMAGE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif' };

async function importPage(job: JobStatus & { userId: string }, conn: Connection, ctx: { bytes: number }, sectionId: string, p: GPage) {
  const { userId, workspaceId } = job;
  const { body } = await graphGet(conn, `/me/onenote/pages/${seg(p.id)}/content`, MAX_PAGE_HTML_BYTES);
  const page = convertOneNotePage(body.toString('utf8'), typeof p.title === 'string' ? p.title : '');
  const pageId = newId();
  const ts = now();
  db.prepare(
    `INSERT INTO pages (id, section_id, title, icon, kind, ydoc, text, position, created_by, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, NULL, ?, NULL, '', ?, ?, ?, ?, ?)`,
  ).run(pageId, sectionId, page.title, 'canvas', nextPos('pages', 'section_id', sectionId), userId, ts, ts, userId);

  // Images and attachments → our own files (fresh ids, allow-listed extensions, upload size limit).
  const stored = new Map<string, PMNode['attrs']>();
  for (const r of page.resources.slice(0, MAX_RESOURCES_PER_PAGE)) {
    const attrs = await storeResource(job, conn, ctx, workspaceId, pageId, r);
    if (attrs) stored.set(r.key, attrs);
  }
  if (page.resources.length > MAX_RESOURCES_PER_PAGE) warn(job, `“${page.title}”: only the first ${MAX_RESOURCES_PER_PAGE} images and attachments were imported`);

  // To-dos → real tasks on this page.
  const taskIds = new Map<string, string>();
  for (const t of page.todos) {
    const task = createTask(userId, workspaceId, { title: t.title, pageId });
    if (t.done) updateTask(userId, task.id, { status: 'done' });
    taskIds.set(t.key, task.id);
    job.tasks++;
  }

  const fill = (n: PMNode): PMNode | null => {
    if (n.type === 'image' || n.type === 'fileAttachment') {
      const key = String(n.attrs?.[n.type === 'image' ? 'src' : 'url'] ?? '');
      if (!key.startsWith(RES_PREFIX)) return n;
      const a = stored.get(key);
      if (!a) return null;
      // An image whose bytes aren't a showable raster type becomes a file card.
      return a.url ? { type: 'fileAttachment', attrs: a } : { type: 'image', attrs: { ...n.attrs, ...a } };
    }
    if (n.type === 'taskRef') {
      const id = taskIds.get(String(n.attrs?.taskId));
      return id ? { type: 'taskRef', attrs: { taskId: id } } : null;
    }
    return n.content ? { ...n, content: n.content.map(fill).filter((c): c is PMNode => c !== null) } : n;
  };
  const clean = (d: PMNode) => sanitizeContent(fill(d)!) as PMNode;
  // seedPageDoc stores the search text from extractPage, which reads every box.
  seedPageDoc(pageId, (frag) => {
    const ydoc = frag.doc!;
    if (page.kind === 'canvas') {
      // A canvas: one box per positioned OneNote outline (shared/pageDoc.ts), `default` stays empty.
      const boxes = ydoc.getMap<Y.Map<number>>(BOXES_KEY);
      for (const b of page.boxes) {
        const id = newId();
        const geom = new Y.Map<number>();
        for (const k of ['x', 'y', 'w', 'z'] as const) geom.set(k, b[k]);
        boxes.set(id, geom);
        jsonToYFragment(clean(b.doc), ydoc.getXmlFragment(boxField(id)));
      }
    } else jsonToYFragment(clean(page.doc), frag); // no positions: seedPageDoc makes it one wide box
    sanitizeYDoc(ydoc); // every fragment, boxes included
  });
}

/** Download one Graph resource into FILES_DIR. Returns the node attributes to use, or null (skipped). */
async function storeResource(job: JobStatus, conn: Connection, ctx: { bytes: number }, workspaceId: string, pageId: string, r: Resource): Promise<Record<string, unknown> | null> {
  if (!r.url.startsWith(`${GRAPH_BASE}/`)) {
    // Not a OneNote resource: an external image stays a link to it if it's a plain http(s) image; anything else is dropped.
    return r.kind === 'image' && safeImageUrl(r.url) ? { src: r.url } : null;
  }
  const userId = (job as Job).userId;
  const overBudget = (extra: number) => {
    if (ctx.bytes + extra > limits.maxJobBytes) return warn(job, `Some images and attachments were skipped: an import can bring in at most ${Math.round(limits.maxJobBytes / 1024 / 1024)} MB of files`), true;
    if (dailyUsage(userId).bytes + extra > limits.dailyUserBytes) return warn(job, `Some images and attachments were skipped: you can import at most ${Math.round(limits.dailyUserBytes / 1024 / 1024)} MB of files a day`), true;
    return false;
  };
  if (overBudget(0)) return null;
  let data: Buffer;
  try {
    data = (await graphGet(conn, r.url, MAX_UPLOAD_BYTES)).body;
  } catch (e) {
    if (e instanceof Stopped) throw e;
    warn(job, `An ${r.kind === 'image' ? 'image' : `attachment (${r.name})`} couldn't be downloaded${e instanceof GraphError && e.status === 413 ? ` (larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` : ''}`);
    return null;
  }
  if (!data.length || overBudget(data.length)) return null;
  ctx.bytes += data.length;
  dailyUsage(userId).bytes += data.length;
  const declared = r.type.toLowerCase().split(';')[0].trim();
  const imageExt = r.kind === 'image' ? IMAGE_EXT[declared] : undefined;
  const name = (r.kind === 'image' ? `image${imageExt ?? ''}` : path.basename(r.name.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim()).slice(0, 200) || 'file';
  const ext = imageExt ?? storedExt(name);
  const mime = (SAFE_TYPES[ext] ?? 'application/octet-stream').split(';')[0];
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(path.join(FILES_DIR, id + ext), data, { flag: 'wx' });
  db.prepare('INSERT INTO files (id, workspace_id, page_id, name, ext, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, workspaceId, pageId, name, ext, mime, data.length, (job as JobStatus & { userId: string }).userId, now(),
  );
  const url = `/uploads/${id}${ext}`;
  if (imageExt) {
    job.images++;
    return { src: url };
  }
  job.attachments++;
  return { url, name, size: data.length, mime };
}

/** Tests only. */
export function resetOneNote() {
  flows.clear();
  tickets.clear();
  connections.clear();
  jobs.clear();
  daily.clear();
}
