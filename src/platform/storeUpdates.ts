// "A new version is available" for the iPhone/iPad app. The web bundle ships inside each native
// release, so a newer App Store version is the only kind of update there is. Asks our server
// (GET /api/app/version, server/routes/appVersion.ts) when the app starts and when it comes back to the
// foreground (at most every CHECK_EVERY_MS), and compares with the installed version:
//   newer on the store       → appUpdates subscribers get apply() = open the App Store page
//   installed < the minimum  → required subscribers get open() (AppUpdates shows a blocking screen)
// Pure logic with injected dependencies, so it's unit tested without a device (tests/storeUpdates.test.ts).
import { compareVersions, type AppVersionInfo } from '../../shared/appVersion.ts';

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface StoreUpdateDeps {
  /** The installed version (CFBundleShortVersionString), e.g. "0.5.3". */
  installed(): Promise<string | null>;
  /** GET /api/app/version?os=ios; null when offline or the server can't say. */
  fetchInfo(): Promise<AppVersionInfo | null>;
  /** Opens the App Store page. */
  openStore(url: string): void;
  now?: () => number;
}

type Listener = (run: () => void) => void;

export function createStoreUpdates(deps: StoreUpdateDeps) {
  const now = deps.now ?? Date.now;
  const available = new Set<Listener>();
  const required = new Set<Listener>();
  let lastCheck = -Infinity;
  let running: Promise<void> | null = null;
  /** The newest store version already offered (so the notice shows once per version, not on every foreground). */
  let offered: string | null = null;
  let pendingUpdate: (() => void) | null = null;
  let pendingRequired: (() => void) | null = null;

  async function run(): Promise<void> {
    const [installed, info] = await Promise.all([deps.installed().catch(() => null), deps.fetchInfo().catch(() => null)]);
    if (!installed || !info?.storeUrl) return;
    const url = info.storeUrl;
    const open = () => deps.openStore(url);
    if (info.minimum && compareVersions(installed, info.minimum) < 0) {
      if (!pendingRequired) {
        pendingRequired = open;
        required.forEach((fn) => fn(open));
      }
      return;
    }
    if (info.latest && compareVersions(info.latest, installed) > 0 && info.latest !== offered) {
      offered = info.latest;
      pendingUpdate = open;
      available.forEach((fn) => fn(open));
    }
  }

  return {
    /** Checks now unless it checked less than CHECK_EVERY_MS ago (or `force`). Never throws. */
    check(force = false): Promise<void> {
      if (running) return running;
      if (!force && now() - lastCheck < CHECK_EVERY_MS) return Promise.resolve();
      lastCheck = now();
      running = run()
        .catch(() => {})
        .finally(() => {
          running = null;
        });
      return running;
    },
    /** Platform.appUpdates.subscribe: a late subscriber still gets an update found earlier. */
    subscribe(fn: Listener): () => void {
      available.add(fn);
      if (pendingUpdate) fn(pendingUpdate);
      return () => void available.delete(fn);
    },
    subscribeRequired(fn: Listener): () => void {
      required.add(fn);
      if (pendingRequired) fn(pendingRequired);
      return () => void required.delete(fn);
    },
  };
}
