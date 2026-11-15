// GET /api/app/version?os=ios: the version on the App Store and the minimum supported version, for the
// iPhone/iPad app's update prompt (src/platform/storeUpdates.ts). No auth: it's public information.
//
// `latest` comes from Apple's public lookup (itunes.apple.com/lookup?bundleId=…), cached here so devices
// don't each ask Apple, and so the app never needs CORS to Apple. `minimum` is env MIN_APP_VERSION_IOS
// (unset = no minimum); versions below it see a blocking "Update required" screen, so only raise it
// once the new version is live on the App Store. Android (a sideloaded APK) gets nulls for now.
import { Router } from 'express';
import { h } from '../http.ts';
import { log } from '../log.ts';
import { MOBILE_APP_ID, parseVersion, type AppVersionInfo } from '../../shared/appVersion.ts';

const OK_TTL_MS = 60 * 60 * 1000; // Apple's own lookup lags a release by a few hours anyway
const FAIL_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;

export interface StoreListing {
  version: string;
  url: string;
}

/** Asks Apple for the app's App Store listing; null when it isn't listed (or Apple can't be reached). */
async function appleLookup(): Promise<StoreListing | null> {
  const country = process.env.APP_STORE_COUNTRY || 'us';
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(MOBILE_APP_ID)}&country=${encodeURIComponent(country)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`App Store lookup: HTTP ${res.status}`);
  const body = (await res.json()) as { results?: { version?: unknown; trackViewUrl?: unknown; trackId?: unknown }[] };
  const hit = body.results?.[0];
  if (!hit || typeof hit.version !== 'string' || !parseVersion(hit.version)) return null;
  const url2 =
    typeof hit.trackViewUrl === 'string' && hit.trackViewUrl.startsWith('https://apps.apple.com/')
      ? hit.trackViewUrl
      : typeof hit.trackId === 'number'
        ? `https://apps.apple.com/app/id${hit.trackId}`
        : null;
  return url2 ? { version: hit.version, url: url2 } : null;
}

let lookup: () => Promise<StoreListing | null> = appleLookup;
let cached: { at: number; ttl: number; value: StoreListing | null } | null = null;
let inFlight: Promise<StoreListing | null> | null = null;

/** Tests: replace Apple with a fake (and forget the cache). Call with no argument to restore. */
export function setStoreLookup(fn?: () => Promise<StoreListing | null>): void {
  lookup = fn ?? appleLookup;
  cached = null;
  inFlight = null;
}

async function storeListing(): Promise<StoreListing | null> {
  if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
  inFlight ??= lookup()
    .then((value) => {
      cached = { at: Date.now(), ttl: OK_TTL_MS, value };
      return value;
    })
    .catch((err) => {
      log.warn('app store lookup failed', { err: String(err) });
      // Keep serving the last good answer for a while rather than nothing.
      const value = cached?.value ?? null;
      cached = { at: Date.now(), ttl: FAIL_TTL_MS, value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function minimum(os: string): string | null {
  const v = os === 'ios' ? process.env.MIN_APP_VERSION_IOS : undefined;
  return v && parseVersion(v) ? v.trim() : null;
}

export const appVersionRoutes = Router();

appVersionRoutes.get(
  '/app/version',
  h(async (req, res): Promise<AppVersionInfo> => {
    const os = String(req.query.os ?? '');
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (os !== 'ios') return { latest: null, minimum: null, storeUrl: null };
    const listing = await storeListing();
    return { latest: listing?.version ?? null, minimum: minimum(os), storeUrl: listing?.url ?? null };
  }),
);
