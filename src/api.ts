// API client: base URL, bearer-token session (access + rotating refresh token),
// JSON fetch wrapper with one transparent refresh-and-retry on 401.
//
// - The API base is the server the desktop shell injects (__NOTEAPP_API_URL__)
//   or the one picked in the mobile app, else VITE_API_URL (other shells, other origins), else the page's own
//   origin. WebSocket URLs are derived from it.
// - The access token lives only in memory. The refresh token is persisted
//   (tokenStore) and rotated on every refresh. Refreshes are single-flight per
//   tab and serialized across tabs, each reading the latest stored token.
import type { AuthSession } from '../shared/types.ts';
import { EMAIL_UNVERIFIED } from '../shared/config.ts';
import { signUploadPath, type FileKey } from '../shared/fileLinks.ts';
import { detectPlatform, platform } from './platform/index.ts';
import { storedServerUrl } from './platform/serverUrl.ts';

// The desktop shell injects its configured server before any script runs. Only
// trusted inside Tauri and only as a string, so a DOM element with that id
// (DOM clobbering) can't redirect the web build's API calls.
const injectedApiUrl = (globalThis as { __NOTEAPP_API_URL__?: unknown }).__NOTEAPP_API_URL__;
// The mobile shell keeps the server the user picked (src/platform/serverUrl.ts); re-validated here.
const kind = detectPlatform();
const shellApiUrl =
  kind === 'tauri' && typeof injectedApiUrl === 'string' ? injectedApiUrl : kind === 'capacitor' ? (storedServerUrl() ?? undefined) : undefined;
const API_BASE = (shellApiUrl ?? import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

/** Absolute or same-origin URL for an API path ("/me" → ".../api/me"). */
export const apiUrl = (path: string) => `${API_BASE}/api${path}`;

/**
 * URL to show or open a file the API returned ("/uploads/…"): on the API's origin, signed for the
 * signed-in user (shared/fileLinks.ts), since an <img> or download link can't send the token.
 * Anything else is returned unchanged.
 */
export const fileUrl = (url: string) => (url.startsWith('/uploads/') ? API_BASE + signUploadPath(url, currentFileKey()) : url);

/** The same file's plain, unsigned URL, for exports and copies that outlive the session (opening one signs it again: /open-file). */
export const plainFileUrl = (url: string) => (url.startsWith('/uploads/') ? API_BASE + url : url);

// ───────────── Upload link key ─────────────
// Comes with every session (login, refresh), so it rolls over with the access token; the server
// re-checks access on every file request, so a key only ever opens what its user can see.
let fileKey: FileKey | null = null;
let fileKeyFetch: Promise<void> | null = null;

/** While locked notes are unlocked on this sign-in: a key whose links also open files on locked pages (src/lib/lockedNotes.ts). */
let lockedFileKey: FileKey | null = null;
export function setLockedFileKey(k: FileKey | null) {
  lockedFileKey = k;
}

/** The key to sign upload links with, while it still has a little life left (else null: links render unsigned). */
function currentFileKey(): FileKey | null {
  if (lockedFileKey && lockedFileKey.e - Date.now() / 1000 > 60) return lockedFileKey;
  if (!fileKey) return null;
  const left = fileKey.e - Date.now() / 1000;
  if (left < 15 * 60) {
    // Nearly expired (a device that slept through refreshes): fetch a new one for next time.
    fileKeyFetch ??= api<FileKey>('/files/key')
      .then((k) => void (fileKey = k))
      .catch(() => {})
      .finally(() => (fileKeyFetch = null));
  }
  return left > 60 ? fileKey : null;
}

/** ws(s):// URL on the API's origin for a WebSocket path ("/api/events", "/collab"). */
export function wsUrl(path: string): string {
  const base = API_BASE || `${location.protocol}//${location.host}`;
  return base.replace(/^http/, 'ws') + path;
}

/** WebSocket subprotocols carrying the access token (the server never echoes the token). */
export function wsProtocols(): string[] {
  return access ? ['noteapp.v1', `bearer.${access.token}`] : ['noteapp.v1'];
}

// ───────────── Token storage ─────────────
// The refresh token lives in platform secure storage (the OS keychain in the shells).
const REFRESH_KEY = 'noteapp.refreshToken';
export const tokenStore = {
  get: (): Promise<string | null> => platform.secureStorage.get(REFRESH_KEY),
  async set(token: string | null): Promise<void> {
    if (token) await platform.secureStorage.set(REFRESH_KEY, token);
    else await platform.secureStorage.remove(REFRESH_KEY);
    platform.kv.remove('noteapp.token'); // pre-refresh-token sessions
  },
};

// ───────────── Session ─────────────
let access: { token: string; expiresAt: number } | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing: Promise<AuthSession | null> | null = null;

export function getAccessToken(): string | null {
  return access?.token ?? null;
}

/** Adopt a session returned by /auth/login, /auth/register or /auth/refresh. */
export async function startSession(s: AuthSession) {
  await tokenStore.set(s.refreshToken);
  access = { token: s.accessToken, expiresAt: Date.now() + s.expiresIn * 1000 };
  if (s.fileKey) fileKey = s.fileKey;
  if (refreshTimer) clearTimeout(refreshTimer);
  // Refresh a minute before expiry so sockets and requests always have a valid token.
  refreshTimer = setTimeout(() => void refreshSession(), Math.max(5_000, (s.expiresIn - 60) * 1000));
}

/** Forget the session locally and revoke it on the server (best effort). */
export async function endSession() {
  const refreshToken = await tokenStore.get();
  access = null;
  fileKey = null;
  lockedFileKey = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  await tokenStore.set(null);
  if (refreshToken) {
    fetch(apiUrl('/auth/logout'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) }).catch(
      () => {},
    );
  }
}

/**
 * Exchange the stored refresh token for a new session. Resolves to the session
 * (including the user), or null if signed out / the refresh token is no longer
 * valid. Network errors reject, so callers can tell "offline" from "signed out".
 */
export function refreshSession(): Promise<AuthSession | null> {
  // Serialized across tabs/windows so two never spend the same refresh token.
  refreshing ??= platform.withLock('noteapp-auth-refresh', async () => {
    const refreshToken = await tokenStore.get();
    if (!refreshToken) return null;
    const res = await fetch(apiUrl('/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (res.status === 401) {
      // Another tab may have rotated it meanwhile; only clear if it's still ours.
      if ((await tokenStore.get()) === refreshToken) await tokenStore.set(null);
      access = null;
      return null;
    }
    if (!res.ok) throw new ApiError(res.status, `Refresh failed (${res.status})`);
    const s = (await res.json()) as AuthSession;
    await startSession(s);
    return s;
  }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * After a socket was rejected with 4401: refresh the session. 'signed-out'
 * means the refresh token was definitively rejected (the app is told to sign
 * out); 'retry' means the server couldn't be reached and the caller should
 * back off and try again.
 */
export async function reauthorize(): Promise<'ok' | 'signed-out' | 'retry'> {
  try {
    if (await refreshSession()) return 'ok';
    notifyUnauthorized();
    return 'signed-out';
  } catch {
    return 'retry';
  }
}

/** Exponential backoff with jitter: ~1 s, 2 s, 4 s … capped at 30 s. */
export const backoffMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() / 2);

/** A valid access token, refreshing first if it is about to expire. */
export async function freshAccessToken(): Promise<string | null> {
  if (access && access.expiresAt - Date.now() > 30_000) return access.token;
  try {
    return (await refreshSession())?.accessToken ?? null;
  } catch {
    return access?.token ?? null; // offline: try what we have
  }
}

// ───────────── Requests ─────────────
export class ApiError extends Error {
  /** Server request id (X-Request-Id), to match a report with the server log. */
  requestId?: string;
  /** Stable machine-readable code from the server, e.g. 'email_unverified'. */
  code?: string;
  constructor(public status: number, message: string, requestId?: string | null, code?: string) {
    super(message);
    this.requestId = requestId ?? undefined;
    this.code = code;
  }
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with retries for safe requests (GET/HEAD): network errors and
 * 502/503/504 (a restarting server or proxy) are retried twice with backoff.
 * Writes are never retried, so they can't be applied twice.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const tries = method === 'GET' || method === 'HEAD' ? 3 : 1;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, init);
      if (i + 1 < tries && RETRYABLE_STATUS.has(res.status)) {
        await sleep(400 * 3 ** i);
        continue;
      }
      return res;
    } catch (e) {
      // Known offline: fail fast so the offline cache can answer.
      if (i + 1 >= tries || (typeof navigator !== 'undefined' && !navigator.onLine)) throw e;
      await sleep(400 * 3 ** i);
    }
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}
/** Called when the session is gone for good (refresh token rejected). */
export const notifyUnauthorized = () => onUnauthorized();

let onEmailUnverified: () => void = () => {};
/** Called when the server answers 403 `email_unverified`: the app then shows its "check your email" screen. */
export function setEmailUnverifiedHandler(fn: () => void) {
  onEmailUnverified = fn;
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  // /auth/* are the public sign-in endpoints (no token), except asking for a new confirmation email, which needs one.
  // Account deletion (/auth/account…) is signed in too, and its 401 means "wrong password", not "session over".
  const signedIn = path === '/auth/resend-verification' || path.startsWith('/auth/account');
  const isAuth = path.startsWith('/auth/') && !signedIn;
  const headers = new Headers(init.headers);
  const token = isAuth ? null : await freshAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetchWithRetry(apiUrl(path), { ...init, headers, body });
  if (res.status === 401 && !isAuth && !path.startsWith('/auth/account')) {
    if (retry && (await refreshSession().catch(() => null))) return api<T>(path, init, false);
    onUnauthorized();
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 403 && data?.code === EMAIL_UNVERIFIED) onEmailUnverified();
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.requestId ?? res.headers.get('x-request-id'), data?.code);
  }
  return data as T;
}

/** Authenticated binary download: the body plus the server's suggested file name. */
export async function download(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const send = async () =>
    fetchWithRetry(apiUrl(path), { headers: { Authorization: `Bearer ${(await freshAccessToken()) ?? ''}` } });
  let res = await send();
  if (res.status === 401 && (await refreshSession().catch(() => null))) res = await send();
  if (!res.ok) {
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    throw new ApiError(res.status, data?.error ?? `Download failed (${res.status})`, data?.requestId ?? res.headers.get('x-request-id'));
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  return { blob: await res.blob(), filename: star ? decodeURIComponent(star[1]) : (plain?.[1] ?? null) };
}

export const get = <T,>(p: string) => api<T>(p);
export const post = <T,>(p: string, json?: unknown) => api<T>(p, { method: 'POST', json: json ?? {} });
export const patch = <T,>(p: string, json: unknown) => api<T>(p, { method: 'PATCH', json });
export const del = <T,>(p: string) => api<T>(p, { method: 'DELETE' });

export async function upload(file: File): Promise<{ url: string; name: string; size: number }> {
  return api('/uploads', {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
  });
}
