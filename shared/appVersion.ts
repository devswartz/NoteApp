// App versions for the native apps' update prompt (server/routes/appVersion.ts, src/platform/storeUpdates.ts).

/** iOS bundle id / Android application id. Changing it makes a new app in the stores. */
export const MOBILE_APP_ID = 'com.devswartz.notivelo';

/** What GET /api/app/version?os=ios answers. Every field is null when unknown. */
export interface AppVersionInfo {
  /** The version on the App Store right now (from Apple's lookup, cached by the server). */
  latest: string | null;
  /** Older versions must update before they can be used (env MIN_APP_VERSION_IOS). */
  minimum: string | null;
  /** Where the Update button goes. */
  storeUrl: string | null;
}

/** Parses "1.2.3" (also "1.2", "v1.2.3", "1.2.3 (45)") into numbers; null if it isn't a version. */
export function parseVersion(v: string | null | undefined): number[] | null {
  const m = /^\s*v?(\d+(?:\.\d+){0,3})\b/.exec(v ?? '');
  return m ? m[1].split('.').map(Number) : null;
}

/** <0 when a is older than b, 0 when equal ("1.2" equals "1.2.0"), >0 when newer. Unparseable sorts as equal. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
