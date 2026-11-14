// The server the mobile app talks to. Owner: Mobile.
//
// Release builds are locked to PRODUCTION_SERVER_URL: no first-run screen, no
// "Change server…", and a server saved by an older version is forgotten on start
// (takeStaleServer). Debug / internal builds (VITE_ALLOW_SERVER_SWITCH=1, e.g. a
// TestFlight build for staging) keep a "Change server…" command in the command
// palette and use the saved choice, else the build's VITE_API_URL. Address rules
// are the desktop app's (apps/desktop/src-tauri/src/config.rs): https only, plain
// http only for this device (localhost / 127.0.0.1 / [::1]), an optional path
// prefix, no query or fragment.
//
// Kept tiny and dependency-free because src/api.ts reads it while the app's
// modules load, before the platform adapter has initialised.

/** The one server release builds of the apps talk to (desktop: DEFAULT_SERVER_URL in config.rs). */
export const PRODUCTION_SERVER_URL = 'https://app.notiveloapp.com';

export const SERVER_URL_KEY = 'noteapp.serverUrl';
/** Set by older versions once the first-run server screen was answered. */
export const SERVER_CONFIRMED_KEY = 'noteapp.serverConfirmed';
/** The refresh token in secure storage (src/api.ts). */
export const REFRESH_TOKEN_KEY = 'noteapp.refreshToken';

export type ServerUrlResult = { ok: true; url: string } | { ok: false; error: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** "notes.example.com" → "https://notes.example.com"; rejects anything unsafe. */
export function normalizeServerUrl(input: string): ServerUrlResult {
  const s = input.trim();
  const bad: ServerUrlResult = { ok: false, error: "That doesn't look like a server address." };
  if (!s) return bad;
  let u: URL;
  try {
    u = new URL(s.includes('://') ? s : `https://${s}`);
  } catch {
    return bad;
  }
  if (!u.hostname || u.search || u.hash || u.username || u.password) return bad;
  // Tokens travel with every request, so plain http is only allowed to this device.
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)))) {
    return { ok: false, error: 'The server address must start with https://' };
  }
  return { ok: true, url: (u.origin + u.pathname).replace(/\/+$/, '') };
}

/** The saved choice, re-validated (storage is not trusted blindly). Null if none or invalid. */
export function storedServerUrl(storage: Pick<Storage, 'getItem'> | null | undefined = safeLocalStorage()): string | null {
  try {
    const raw = storage?.getItem(SERVER_URL_KEY);
    if (!raw) return null;
    const r = normalizeServerUrl(raw);
    return r.ok ? r.url : null;
  } catch {
    return null;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** What a build allows, from its VITE_* variables (see package.json mobile:build). */
export interface ServerBuild {
  /** Debug / internal builds: the server can be changed (hidden "Change server…" command). */
  allowSwitch: boolean;
  /** The build's default server when switching is allowed (VITE_API_URL); null = same origin (dev). */
  buildServer: string | null;
  /** Other host names of the production server (old domains), from LEGACY_PROD_HOSTS at build time. */
  legacyProdHosts: string[];
}

type Env = { DEV?: boolean; VITE_ALLOW_SERVER_SWITCH?: string; VITE_API_URL?: string; VITE_LEGACY_PROD_HOSTS?: string } | undefined;

/** The Vite dev server (live reload, CAP_SERVER_URL) also counts as a debug build. */
export function serverBuild(env: Env = (import.meta as { env?: Env }).env): ServerBuild {
  const api = normalizeServerUrl(env?.VITE_API_URL ?? '');
  return {
    allowSwitch: env?.DEV === true || env?.VITE_ALLOW_SERVER_SWITCH === '1' || env?.VITE_ALLOW_SERVER_SWITCH === 'true',
    buildServer: api.ok ? api.url : null,
    legacyProdHosts: parseHostList(env?.VITE_LEGACY_PROD_HOSTS),
  };
}

/** "a.example, https://b.example/" → ["a.example", "b.example"] (lower case, hosts only). */
export function parseHostList(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
}

/** The server the mobile app uses: the locked production server, unless this build may switch. */
export function mobileServerUrl(build: ServerBuild, storage: Pick<Storage, 'getItem'> | null | undefined = safeLocalStorage()): string {
  if (!build.allowSwitch) return PRODUCTION_SERVER_URL;
  return storedServerUrl(storage) ?? build.buildServer ?? '';
}

/**
 * Locked builds: forget a server choice saved by an older version. Returns null when there was
 * none (or this build may switch); otherwise the saved URL and whether its sign-in can be kept,
 * which is only when it was the production server under this or a LEGACY_PROD_HOSTS name.
 */
export function takeStaleServer(
  kv: { get(key: string): string | null; remove(key: string): void },
  build: ServerBuild,
): { stored: string | null; keepSession: boolean } | null {
  if (build.allowSwitch) return null;
  const raw = kv.get(SERVER_URL_KEY);
  const confirmed = kv.get(SERVER_CONFIRMED_KEY);
  if (raw == null && confirmed == null) return null;
  kv.remove(SERVER_URL_KEY);
  kv.remove(SERVER_CONFIRMED_KEY);
  if (!raw) return { stored: null, keepSession: true }; // confirmed the build's default server
  const r = normalizeServerUrl(raw);
  if (!r.ok) return { stored: null, keepSession: false };
  return { stored: r.url, keepSession: isProductionServer(r.url, build.legacyProdHosts) };
}

/** The production server under its current name or one of its old (legacy) names; https only. */
export function isProductionServer(url: string, legacyProdHosts: string[]): boolean {
  if (url.replace(/\/+$/, '') === PRODUCTION_SERVER_URL) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.pathname.replace(/\/+$/, '') === '' && legacyProdHosts.includes(u.host.toLowerCase());
  } catch {
    return false;
  }
}
