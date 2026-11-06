// Reports uncaught errors, unhandled rejections and React render errors to POST /api/client-errors, which only
// logs them (server/routes/clientErrors.ts). Collected: error message, stack, script URL, line/column, the page
// URL without query string or fragment, user agent, the app version, and for React the component stack; plus the
// user id when signed in (from the bearer token). No page content, note text or storage is read.
//
// Best effort and silent: throttled (src/lib/errorFilter.ts), never while offline, no retries, and nothing in
// here may throw or report itself.
import { apiUrl, getAccessToken } from '../api.ts';
import { createThrottle, describeThrown, shouldIgnore, stripUrl, type ErrorKind } from './errorFilter.ts';

const throttle = createThrottle({ max: 5, windowMs: 60_000 });
let busy = false; // an error raised while reporting is dropped, never reported (no loops)
let installed = false;

const cut = (s: string | undefined, n: number) => (s ? s.slice(0, n) : undefined);

export interface Report {
  kind: ErrorKind;
  message: string;
  stack?: string;
  name?: string;
  source?: string;
  line?: number;
  col?: number;
  componentStack?: string;
}

/** Send one report if it passes the filters and the throttle. Never throws. */
export function reportClientError(r: Report): void {
  if (busy) return;
  busy = true;
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (shouldIgnore(r) || !throttle.allow(r)) return;
    const body: Record<string, unknown> = {
      kind: r.kind,
      message: cut(r.message, 500),
      stack: cut(r.stack, 4000),
      componentStack: cut(r.componentStack, 2000),
      source: r.source ? stripUrl(r.source) : undefined,
      line: r.line,
      col: r.col,
      url: stripUrl(location.href),
      userAgent: cut(navigator.userAgent, 300),
      version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
    };
    let json = JSON.stringify(body);
    if (json.length > 12_000) json = JSON.stringify({ ...body, stack: undefined, componentStack: undefined }); // stay under the server's 16 KB cap
    const token = getAccessToken();
    void fetch(apiUrl('/client-errors'), {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: json,
    }).catch(() => {});
  } catch {
    /* the reporter must never throw */
  } finally {
    busy = false;
  }
}

/** Hook window 'error' and 'unhandledrejection'. Safe to call more than once. React errors come from ErrorBoundary. */
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e: ErrorEvent) => {
    try {
      // Resource load failures (img/script) arrive here too, with no message: filtered out as empty.
      const d = describeThrown(e.error ?? e.message);
      reportClientError({
        kind: 'error',
        message: e.message || d.message,
        stack: d.stack,
        name: d.name,
        source: e.filename || undefined,
        line: e.lineno || undefined,
        col: e.colno || undefined,
      });
    } catch {
      /* ignore */
    }
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    try {
      const status = (e.reason as { status?: unknown } | null)?.status;
      if (typeof status === 'number' && status < 500) return; // expected API answers (401, 403, 404…), not bugs
      reportClientError({ kind: 'unhandledrejection', ...describeThrown(e.reason) });
    } catch {
      /* ignore */
    }
  });
}

/** For the React error boundary. */
export function reportReactError(error: unknown, componentStack?: string | null): void {
  try {
    reportClientError({ kind: 'react', ...describeThrown(error), componentStack: componentStack ?? undefined });
  } catch {
    /* ignore */
  }
}
