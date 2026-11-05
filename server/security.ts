// HTTP security headers for the production server. Owner: Collaboration &
// Access (hardening). Mounted first in server/app.ts.
//
// - Every response: nosniff, no framing, a strict referrer policy, a minimal
//   Permissions-Policy, and HSTS in production.
// - The web app (HTML and static files): a strict CSP. Scripts come only from
//   our own origin (the Vite build has no inline scripts). Styles allow
//   'unsafe-inline' because the editor (ProseMirror/TipTap) and the comment
//   highlighter inject <style> and style attributes. Connections: our origin
//   plus its ws:/wss: equivalents (/api/events, /collab).
// - /api: JSON only, so `default-src 'none'`.
// - /uploads sets its own sandbox CSP (routes/files.ts) and is left alone.
//
// The desktop (Tauri) and mobile (Capacitor) shells load the app from their
// bundled files, not from this server, so this CSP doesn't apply to them; they
// only call /api (CORS *, bearer tokens) and load /uploads images.
import type { RequestHandler } from 'express';

const IS_PROD = () => process.env.NODE_ENV === 'production';

/** ws(s):// origins for the page's own host, so the sockets work under the CSP in every browser. */
function socketOrigins(host: string | undefined): string {
  const fromPublic = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).host : null;
  const hosts = new Set([fromPublic, host].filter((h): h is string => !!h && /^[\w.-]+(:\d+)?$/.test(h)));
  return [...hosts].flatMap((h) => [`wss://${h}`, `ws://${h}`]).join(' ');
}

export function appCsp(host: string | undefined): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // Notes may embed images by URL; uploads are same-origin.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${socketOrigins(host)}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()';

export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // Browsers ignore HSTS over plain http, so it's safe to always send in production (TLS ends at Cloudflare).
  if (IS_PROD()) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/') || req.path === '/api') res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  else if (!req.path.startsWith('/uploads/')) res.setHeader('Content-Security-Policy', appCsp(req.headers.host));
  next();
};
