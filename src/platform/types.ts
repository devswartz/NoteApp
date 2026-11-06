// The platform adapter: everything that differs between the web app and the
// Tauri (desktop) and Capacitor (mobile) shells. App code calls `platform.*`
// (src/platform/index.ts) instead of browser-only APIs such as localStorage,
// Notification, window.open, <input type=file> or navigator.locks.
//
// Shell implementations live next to web.ts (tauri.ts, capacitor.ts) and are
// selected in index.ts.

export type PlatformKind = 'web' | 'tauri' | 'capacitor';
export type NotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export interface Platform {
  kind: PlatformKind;

  /** Called once before the app renders (hydrate caches, register the service worker, …). */
  init(): Promise<void>;

  /**
   * Small, non-sensitive preferences (last workspace, collapsed sidebar
   * sections, …). Synchronous so it can be used during render; async-backed
   * shells hydrate an in-memory cache in init() and write through.
   */
  kv: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };

  /** Secrets (the refresh token). Keychain/Keystore in the shells. */
  secureStorage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };

  notifications: {
    permission(): NotificationPermission;
    request(): Promise<NotificationPermission>;
    /** Show a system notification. onClick should bring the app forward and navigate. */
    show(title: string, opts: { body?: string; tag?: string; onClick?: () => void }): void;
  };

  /** Open a URL outside the app (system browser, mail client). */
  openExternal(url: string): void;

  deepLinks: {
    /** The link the app was launched with, if any (e.g. notivelo://page/<id>). */
    initial(): Promise<string | null>;
    /** Links received while running. Returns an unsubscribe function. */
    subscribe(onLink: (url: string) => void): () => void;
  };

  /** Let the user pick files. Resolves to [] if they cancel. */
  pickFiles(opts?: { accept?: string; multiple?: boolean }): Promise<File[]>;

  /**
   * Save a file to the user's device (a download on the web). Optional: shells
   * without it get a clipboard fallback from the caller.
   */
  saveFile?(name: string, data: Blob): Promise<void>;

  /**
   * New app versions. Web: a new service worker is waiting; Tauri: the
   * auto-updater. The callback gets `apply()`, which switches to the new
   * version (reloading or restarting). Late subscribers still get a pending update.
   */
  appUpdates: {
    subscribe(onAvailable: (apply: () => void) => void): () => void;
  };

  /** Run fn while holding a named lock shared by every window/tab of the app. */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /** Whether the app's UI is currently hidden (background tab, minimised window). */
  isHidden(): boolean;
  /** Bring the app's window to the front. */
  focus(): void;
}
