// Old host names (REDIRECT_HOSTS, comma-separated) that still reach this server,
// e.g. after a domain move. A browser opening a page there gets a 301 to the same
// path on PUBLIC_URL; everything else keeps working on the old name, because app
// builds already in the field still call it: the API, both WebSockets (upgrades
// never pass through Express), uploads, the AI connector (/mcp, /oauth), the
// /.well-known files and static files (assets, the service worker, icons).
// Mounted in server/app.ts right after the security headers. See docs/DEPLOY_CONTRACT.md.
import type { Request, RequestHandler } from 'express';

/** Paths that are never redirected: API, sockets, files, connector, well-known. */
const KEEP = /^\/(api|mcp|oauth|\.well-known|uploads|collab|assets)(\/|$)/;

/** "Old.Example.com, https://older.example/ " → ["old.example.com", "older.example"]. */
export function parseRedirectHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, ''),
    )
    .filter(Boolean);
}

/** The request's host name without port, lower case (honours X-Forwarded-Host only behind a trusted proxy). */
function hostOf(req: Request): string {
  return (req.hostname ?? '').toLowerCase().replace(/:\d+$/, '');
}

/** A browser page load: GET/HEAD of an app route (no file extension, or .html). */
export function isPageLoad(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (KEEP.test(path)) return false;
  const last = path.split('/').pop() ?? '';
  return !last.includes('.') || last.endsWith('.html');
}

/** 301 page loads on a REDIRECT_HOSTS host to PUBLIC_URL; read per request so tests can change it. */
export const redirectOldHosts: RequestHandler = (req, res, next) => {
  const hosts = parseRedirectHosts(process.env.REDIRECT_HOSTS);
  const target = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (!hosts.length || !target || !isPageLoad(req.method, req.path)) return next();
  let targetHost: string;
  try {
    targetHost = new URL(target).hostname.toLowerCase();
  } catch {
    return next();
  }
  const host = hostOf(req);
  if (host === targetHost || !hosts.includes(host)) return next(); // never loop onto ourselves
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.redirect(301, target + req.originalUrl);
};
