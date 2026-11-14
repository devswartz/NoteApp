// /.well-known files that let https links open the native apps (Owner: Mobile).
//
//   /.well-known/apple-app-site-association   iOS universal links  (needs APNS_TEAM_ID or APPLE_TEAM_ID)
//   /.well-known/assetlinks.json              Android app links    (needs ANDROID_CERT_SHA256)
//
// Both are public (no auth), served as application/json without redirects, and
// 404 until configured. Only in-app paths under /w/ are claimed, so login and
// API URLs always stay in the browser. See docs/MOBILE.md.
//
// Also the OAuth metadata for AI connectors (always public, CORS *):
//   /.well-known/oauth-authorization-server            RFC 8414
//   /.well-known/oauth-protected-resource[/mcp]        RFC 9728, resource = <origin>/mcp
//
// And OpenAI's domain verification for the ChatGPT plugin directory
// (https://developers.openai.com/plugins/deploy/submission, "Connect the MCP server"):
//   /.well-known/openai-apps-challenge   the token from OPENAI_APPS_CHALLENGE, as text/plain and nothing else
//
// Any other /.well-known path is a plain 404, never the web app's HTML. Served on every host,
// REDIRECT_HOSTS included (server/redirectHosts.ts never redirects /.well-known).
import { Router } from 'express';
import { oauthWellKnownRoutes } from './oauth/routes.ts';

export const DEFAULT_APP_ID = 'com.devswartz.notivelo';

export interface WellKnownConfig {
  teamId: string | null;
  bundleId: string;
  androidPackage: string;
  /** SHA-256 fingerprints of the Android signing certificates (upload key and/or Play app signing key). */
  androidCerts: string[];
}

/** "aa:bb…" / "AABB…" → "AA:BB:…" (32 bytes); anything else is dropped. */
export function normalizeFingerprint(raw: string): string | null {
  const hex = raw.replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g)!.join(':');
}

export function wellKnownConfig(env: NodeJS.ProcessEnv = process.env): WellKnownConfig {
  const teamId = (env.APPLE_TEAM_ID || env.APNS_TEAM_ID || '').trim();
  return {
    teamId: /^[A-Z0-9]{10}$/.test(teamId) ? teamId : null,
    bundleId: env.APNS_BUNDLE_ID?.trim() || DEFAULT_APP_ID,
    androidPackage: env.ANDROID_PACKAGE?.trim() || DEFAULT_APP_ID,
    androidCerts: (env.ANDROID_CERT_SHA256 ?? '')
      .split(',')
      .map((s) => normalizeFingerprint(s))
      .filter((s): s is string => !!s),
  };
}

export function appleAppSiteAssociation(c: WellKnownConfig) {
  if (!c.teamId) return null;
  return {
    applinks: {
      details: [{ appIDs: [`${c.teamId}.${c.bundleId}`], components: [{ '/': '/w/*', comment: 'Workspace pages and tasks' }] }],
    },
  };
}

export function assetLinks(c: WellKnownConfig) {
  if (!c.androidCerts.length) return null;
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: c.androidPackage, sha256_cert_fingerprints: c.androidCerts },
    },
  ];
}

/** OPENAI_APPS_CHALLENGE, trimmed; null when unset or not a single printable token (read per request). */
export function openaiAppsChallenge(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = (env.OPENAI_APPS_CHALLENGE ?? '').trim();
  return t && /^[\x21-\x7e]{1,512}$/.test(t) ? t : null;
}

export function wellKnownRoutes(config: () => WellKnownConfig = wellKnownConfig) {
  const r = Router();
  const send = (body: unknown, res: import('express').Response) => {
    if (!body) return res.status(404).type('text/plain').send('Not configured');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/json').send(JSON.stringify(body));
  };
  r.get('/apple-app-site-association', (_req, res) => void send(appleAppSiteAssociation(config()), res));
  r.get('/assetlinks.json', (_req, res) => void send(assetLinks(config()), res));
  r.get('/openai-apps-challenge', (_req, res) => {
    const token = openaiAppsChallenge();
    res.setHeader('Cache-Control', 'no-store');
    if (!token) return void res.status(404).type('text/plain').send('Not configured');
    res.type('text/plain').send(token); // exactly the token: no newline, no markup
  });
  r.use(oauthWellKnownRoutes()); // oauth-authorization-server, oauth-protected-resource[/mcp] (server/oauth/routes.ts)
  // Nothing else lives here: a 404, not the web app's index.html.
  r.get(/.*/, (_req, res) => void res.status(404).type('text/plain').send('Not found'));
  return r;
}
