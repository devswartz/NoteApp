// The server the mobile app talks to, chosen at runtime (first-run screen or
// "Change server…"). Same rules as the desktop app (apps/desktop/src-tauri/src/config.rs):
// https only, plain http only for this device (localhost / 127.0.0.1 / [::1]),
// an optional path prefix, no query or fragment. Owner: Mobile.
//
// Kept tiny and dependency-free because src/api.ts reads it while the app's
// modules load, before the platform adapter has initialised.

export const SERVER_URL_KEY = 'noteapp.serverUrl';

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
