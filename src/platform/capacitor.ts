// Capacitor implementation of the platform adapter (the iPhone and Android
// apps in apps/mobile/). Loaded lazily by initPlatform() only inside the native
// shell, so the web bundle doesn't carry it. See docs/MOBILE.md.
//
// What it adds on top of the web behaviour:
//   secure storage     Keychain (iOS) / Keystore-encrypted prefs (Android) for the refresh token
//   notifications      local notifications for in-app reminders; APNs/FCM push registered with
//                      the server after sign-in; tapping either deep-links to the task
//   deep links         notivelo://… and https://notes.devswartz.com/w/… (universal/app links)
//   app badge          number of my open tasks due today or overdue
//   Today widget       a snapshot of those tasks for the iOS WidgetKit / Android home-screen widget
//   haptics            light tap on checkbox toggles and [data-haptic] elements; platform.haptics
//   share capture      "Share to Notivelo" (iOS Share Extension, Android share targets): a task opens
//                      quick add prefilled, a note becomes a new page in the workspace's Inbox section
//   server             first-run "Connect to a server" screen and "Change server…" (platform.server),
//                      same rules as the desktop app (src/platform/serverUrl.ts)
//   app lock           optional Face ID / Touch ID / fingerprint lock (platform.appLock), with a
//                      privacy cover while the app is in the background
//   system UI          status bar text follows the theme, splash hidden after first render,
//                      keyboard height exposed as --keyboard-height + html.keyboard-open (and --keyboard-inset, the part
//                      the web view didn't already give up: what the page pads by),
//                      Android back button walks history
//
// Everything native goes through the `NativePlugins` object, so the logic can
// be unit tested with fakes (tests/mobile.test.ts). Pure helpers are exported.
import type { AppPlugin } from '@capacitor/app';
import type { BrowserPlugin } from '@capacitor/browser';
import type { HapticsPlugin, ImpactStyle } from '@capacitor/haptics';
import type { KeyboardPlugin } from '@capacitor/keyboard';
import type { LocalNotificationsPlugin } from '@capacitor/local-notifications';
import type { PushNotificationsPlugin } from '@capacitor/push-notifications';
import type { SplashScreenPlugin } from '@capacitor/splash-screen';
import type { SystemBarsStyle, SystemBarsStyleOptions } from '@capacitor/core';
import type { SecureStoragePlugin } from '@aparajita/capacitor-secure-storage';
import type { BadgePlugin } from '@capawesome/capacitor-badge';
import type { Task, Tree } from '../../shared/types.ts';
import type { NotificationPermission, Platform } from './types.ts';
import { keyboardInset } from './keyboardInset.ts';
import { webPlatform } from './web.ts';
import { SERVER_URL_KEY, normalizeServerUrl, storedServerUrl } from './serverUrl.ts';
import { APP_NAME } from '../../shared/config.ts';

export type MobileOS = 'ios' | 'android';

export interface NativePlugins {
  os: MobileOS;
  App: Pick<AppPlugin, 'addListener' | 'getLaunchUrl' | 'minimizeApp'>;
  Browser: Pick<BrowserPlugin, 'open'>;
  Haptics: Pick<HapticsPlugin, 'impact' | 'selectionChanged' | 'notification'>;
  Keyboard: Pick<KeyboardPlugin, 'addListener' | 'setAccessoryBarVisible'>;
  LocalNotifications: Pick<
    LocalNotificationsPlugin,
    'addListener' | 'checkPermissions' | 'requestPermissions' | 'schedule' | 'createChannel'
  >;
  PushNotifications: Pick<
    PushNotificationsPlugin,
    'addListener' | 'checkPermissions' | 'requestPermissions' | 'register' | 'unregister' | 'createChannel'
  >;
  SplashScreen: Pick<SplashScreenPlugin, 'hide'>;
  SystemBars: { setStyle(options: SystemBarsStyleOptions): Promise<void> };
  SecureStorage: Pick<SecureStoragePlugin, 'getItem' | 'setItem' | 'removeItem' | 'setDefaultKeychainAccess'>;
  Badge: Pick<BadgePlugin, 'set' | 'clear'>;
  /** The app's own plugin (apps/mobile/ios/App/App/NoteAppNativePlugin.swift, android/…/NoteAppNativePlugin.java). */
  NoteAppNative: {
    getPendingShares(): Promise<{ items: SharedItem[] }>;
    /** Stores the Today snapshot for the widget (App Group / SharedPreferences) and refreshes it. */
    writeWidgetSnapshot(options: { json: string }): Promise<void>;
    /** Values the native side needs on its own (Android snooze actions call the API directly). */
    setConfig(options: { apiBase: string | null }): Promise<void>;
    /** Opens the system print dialog for the web view (print stylesheet applied). */
    print(options: { jobName: string }): Promise<void>;
    addListener(event: 'shareReceived', fn: () => void): Promise<unknown>;
  };
  BiometricAuth: {
    checkBiometry(): Promise<{ isAvailable: boolean; biometryType: number; deviceIsSecure: boolean }>;
    authenticate(options?: {
      reason?: string;
      cancelTitle?: string;
      allowDeviceCredential?: boolean;
      androidTitle?: string;
      androidSubtitle?: string;
    }): Promise<void>;
  };
}

/** What the adapter needs from the app (wired to the store and API client in loadAppBridge()). */
export interface AppBridge {
  /** Calls back with the signed-in user's id (null when signed out), now and on every change. */
  onUser(cb: (userId: string | null) => void): void;
  /** Calls back with the loaded tasks (of the current workspace) whenever they change. */
  onTasks(cb: (tasks: Task[], userId: string | null, workspaceId: string | null) => void): void;
  post(path: string, body: unknown): Promise<unknown>;
  del(path: string, body: unknown): Promise<unknown>;
  /** Handles a shared item once someone is signed in. Resolves to an in-app path to open, if any. */
  capture(item: SharedItem): Promise<string | null>;
  signOut(): Promise<void>;
  /** The server origin the API client uses ("https://notes.example.com"), or null if same-origin. */
  apiBase(): string | null;
  /** Adds commands to the ⌘K palette (src/hooks/useShortcuts.ts). */
  registerCommands(cmds: { id: string; title: string; group?: string; keywords?: string; run: () => void; when?: () => boolean }[]): void;
}

/** Native capabilities beyond the shared Platform interface (feature-detect with `'haptics' in platform`). */
export interface MobileExtras {
  haptics: {
    tap(): void;
    success(): void;
  };
  /** The server this app talks to. Settings or the login screen can offer "Change server…". */
  server: {
    /** The server in use ("https://notes.example.com"), or null when same-origin (dev). */
    current(): string | null;
    /** Shows the server screen; saving a different server signs out and restarts the app. */
    change(): Promise<void>;
  };
  /** Optional biometric lock. Settings can offer a toggle when `'appLock' in platform`. */
  appLock: {
    /** What the device offers: "Face ID", "Touch ID", "Fingerprint", "Passcode", or null if nothing is set up. */
    method(): Promise<string | null>;
    enabled(): boolean;
    /** Turning it on asks for one successful unlock first. Resolves to the new state. */
    setEnabled(on: boolean): Promise<boolean>;
    /** Notifies when the setting changes (for a Settings toggle). */
    subscribe(cb: (enabled: boolean) => void): () => void;
  };
  /** Face ID / Touch ID / fingerprint for locked pages (src/lib/lockedNotes.ts). */
  lockedNotesBio: LockedNotesBio;
}

/** A device unlock secret for locked notes (POST /api/locked-notes/devices), kept in the keychain behind biometry. */
export interface LockedNotesCredential {
  deviceId: string;
  secret: string;
}

export interface LockedNotesBio {
  /** "Face ID", "Touch ID", "Fingerprint"… or null when the device has no biometrics enrolled (a passcode alone is not enough). */
  method(): Promise<string | null>;
  /** Whether this device keeps a credential for this user. */
  has(userId: string): Promise<boolean>;
  /** Asks for Face ID / Touch ID once, then stores the credential. False if that was cancelled or failed. */
  save(userId: string, cred: LockedNotesCredential): Promise<boolean>;
  /** Asks for Face ID / Touch ID, then hands back the credential. */
  read(userId: string): Promise<{ result: 'ok'; cred: LockedNotesCredential } | { result: 'none' | 'cancelled' | 'unavailable' }>;
  forget(userId: string): Promise<void>;
}

// ───────────── Pure helpers (unit tested) ─────────────

/** Snooze choices offered on reminder notifications; must match server/reminders/snooze.ts. */
export const SNOOZE_ACTIONS = ['10m', '1h', 'tomorrow'] as const;

/**
 * Turns the data carried by a push or local notification into a deep link
 * the router understands. The server sends `url` as an in-app path
 * ("/w/<ws>/tasks/today?task=<id>"). Anything else is ignored, so a payload
 * can never navigate the web view to another origin.
 */
export function notificationLink(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const url = (data as { url?: unknown }).url;
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null;
  return `notivelo:/${url}`;
}

/** Notification ids must be positive 32-bit ints (Android); derive a stable one from a tag. */
export function notificationId(tag: string | undefined): number {
  if (!tag) return Math.floor(Math.random() * 2 ** 30) + 1;
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (Math.imul(h, 31) + tag.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2 ** 30) + 1;
}

/** Something shared into the app from another app's share sheet. */
export interface SharedItem {
  kind: 'task' | 'note';
  text?: string;
  url?: string;
  title?: string;
}

export interface ShareContent {
  /** Prefill for quick add (kind 'task'). */
  quickAdd: string;
  /** Page title and body paragraphs (kind 'note'); the link, if any, is its own last paragraph. */
  title: string;
  paragraphs: string[];
  url: string | null;
}

/** Splits a shared item into a task line or a note's title and body. */
export function shareContent(item: SharedItem): ShareContent {
  const url = item.url && /^https?:\/\//i.test(item.url) ? item.url : null;
  const lines = (item.text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const explicitTitle = item.title?.trim();
  let host = '';
  try {
    host = url ? new URL(url).host.replace(/^www\./, '') : '';
  } catch {
    /* ignore */
  }
  const firstLine = lines[0] ?? '';
  const title = (explicitTitle || firstLine || host || 'Shared note').slice(0, 120);
  const paragraphs = explicitTitle ? lines : lines.slice(1);
  if (!explicitTitle && firstLine.length > 120) paragraphs.unshift(firstLine);
  const head = explicitTitle || firstLine || '';
  const quickAdd = [head.slice(0, 200), url].filter(Boolean).join(' ');
  return { quickAdd, title, paragraphs, url };
}

/** Where shared notes go: a section called "Inbox" if there is one, else the first section. */
export function inboxSection(tree: Tree): string | null {
  const nbPos = new Map(tree.notebooks.map((n) => [n.id, n.position]));
  const sections = [...tree.sections]
    .filter((s) => nbPos.has(s.notebookId))
    .sort((a, b) => nbPos.get(a.notebookId)! - nbPos.get(b.notebookId)! || a.position - b.position);
  return (sections.find((s) => s.name.trim().toLowerCase() === 'inbox') ?? sections[0])?.id ?? null;
}

/** What the Today widget shows (read by TodayWidget.swift and TodayWidgetProvider.java). */
export interface WidgetSnapshot {
  v: 1;
  /** Local date the snapshot was made; tasks "due today" then are overdue after it. */
  date: string;
  signedIn: boolean;
  /** App lock is on: the widget shows the count only (items is empty). */
  locked: boolean;
  /** In-app path for the widget as a whole. */
  path: string | null;
  total: number;
  items: { id: string; title: string; overdue: boolean; time: string | null; priority: number; path: string }[];
}

/** My open tasks due today or overdue, sorted like the Today view (overdue first, then time, priority). */
export function widgetSnapshot(
  tasks: Iterable<Task>,
  me: string | null,
  wsId: string | null,
  today = localDate(),
  max = 8,
  locked = false,
): WidgetSnapshot {
  if (!me || !wsId) return { v: 1, date: today, signedIn: !!me, locked, path: null, total: 0, items: [] };
  const due = [...tasks].filter(
    (t) => (t.assigneeId === me || (!t.assigneeId && t.createdBy === me)) && t.status === 'open' && !!t.dueDate && t.dueDate <= today,
  );
  due.sort(
    (a, b) =>
      a.dueDate!.localeCompare(b.dueDate!) ||
      (a.dueTime ?? '99').localeCompare(b.dueTime ?? '99') ||
      a.priority - b.priority ||
      a.createdAt.localeCompare(b.createdAt),
  );
  const base = `/w/${encodeURIComponent(wsId)}/tasks/today`;
  return {
    v: 1,
    date: today,
    signedIn: true,
    locked,
    path: base,
    total: due.length,
    items: (locked ? [] : due.slice(0, max)).map((t) => ({
      id: t.id,
      title: t.title.slice(0, 200),
      overdue: t.dueDate! < today,
      time: t.dueTime,
      priority: t.priority,
      path: `${base}?task=${encodeURIComponent(t.id)}`,
    })),
  };
}

const LAST_USER_KEY = 'noteapp.lastUserId';

/** Lock again after the app has been in the background this long. */
export const RELOCK_AFTER_MS = 60_000;
export const APP_LOCK_KEY = 'noteapp.appLock';

/** Human name for the device's unlock method (BiometryType from @aparajita/capacitor-biometric-auth). */
export function biometryLabel(type: number, os: MobileOS, deviceIsSecure: boolean): string | null {
  switch (type) {
    case 1:
      return 'Touch ID';
    case 2:
      return 'Face ID';
    case 3:
      return 'Fingerprint';
    case 4:
      return os === 'ios' ? 'Face ID' : 'Face unlock';
    case 5:
      return 'Iris unlock';
    default:
      return deviceIsSecure ? (os === 'ios' ? 'Passcode' : 'Screen lock') : null;
  }
}

/** Local YYYY-MM-DD. */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** My open tasks due today or overdue: what the app icon badge counts. */
export function dueTodayCount(tasks: Iterable<Task>, me: string | null, today = localDate()): number {
  if (!me) return 0;
  let n = 0;
  for (const t of tasks) {
    const mine = t.assigneeId === me || (!t.assigneeId && t.createdBy === me);
    if (mine && t.status === 'open' && t.dueDate && t.dueDate <= today) n++;
  }
  return n;
}

// ───────────── Server choice ─────────────

const SERVER_CONFIRMED_KEY = 'noteapp.serverConfirmed';
/** The server baked into this build (npm run mobile:sync → MOBILE_SERVER_URL). */
const BUILD_SERVER = (import.meta.env?.VITE_API_URL ?? '').replace(/\/+$/, '') || null;

/** Is there a Notivelo server at this address? (GET /api/health → {ok:true}) */
export async function probeServer(url: string, doFetch: typeof fetch = fetch, timeoutMs = 8000): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await doFetch(`${url}/api/health`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates and probes an address the user typed; on success saves it (and
 * marks the first-run choice as made). Resolves to the saved URL or an error.
 */
export async function chooseServer(
  input: string,
  kv: Platform['kv'],
  doFetch: typeof fetch = fetch,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const r = normalizeServerUrl(input);
  if (!r.ok) return r;
  if (!(await probeServer(r.url, doFetch))) return { ok: false, error: `Couldn't reach a server at ${r.url}. Check the address and your connection.` };
  kv.set(SERVER_URL_KEY, r.url);
  kv.set(SERVER_CONFIRMED_KEY, '1');
  return { ok: true, url: r.url };
}

/** The "Connect to a server" screen (DOM, outside React; it can run before the app renders). */
function serverScreen(opts: { firstRun: boolean; current: string; appName: string; kv: Platform['kv'] }): Promise<string | null> {
  return new Promise((resolve) => {
    const el = (tag: string, css = '', text = '') => {
      const e = document.createElement(tag);
      if (css) e.style.cssText = css;
      if (text) e.textContent = text;
      return e;
    };
    const root = el(
      'div',
      'position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;justify-content:center;gap:14px;' +
        'padding:calc(var(--safe-top, 0px) + 24px) 24px calc(var(--safe-bottom, 0px) + 24px);background:var(--bg, #fff);color:var(--text, #18181b);font:inherit',
    );
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Connect to a server');
    const title = el('h1', 'margin:0;font-size:22px', 'Connect to a server');
    const hint = el('p', 'margin:0;color:var(--text-muted, #71717a)', `The address of your ${opts.appName} server.`);
    const input = document.createElement('input');
    input.type = 'url';
    input.inputMode = 'url';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.value = opts.current;
    input.className = 'input';
    input.style.cssText = 'font-size:16px;padding:12px;border-radius:10px;border:1px solid var(--border, #d4d4d8);background:var(--bg-subtle, #fafafa);color:inherit';
    const error = el('p', 'margin:0;min-height:1.4em;color:var(--danger, #dc2626);font-size:14px');
    error.setAttribute('role', 'alert');
    const connect = el('button', 'padding:12px;font-size:16px', 'Connect') as HTMLButtonElement;
    connect.className = 'btn btn-primary';
    const form = document.createElement('form');
    form.style.cssText = 'display:flex;flex-direction:column;gap:14px';
    form.append(input, error, connect);
    root.append(title, hint, form);
    if (!opts.firstRun) {
      const cancel = el('button', 'padding:10px;font-size:15px', 'Cancel') as HTMLButtonElement;
      cancel.type = 'button';
      cancel.className = 'btn btn-ghost';
      cancel.addEventListener('click', () => {
        root.remove();
        resolve(null);
      });
      root.append(cancel);
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      connect.disabled = true;
      error.textContent = 'Checking…';
      void chooseServer(input.value, opts.kv).then((r) => {
        connect.disabled = false;
        if (!r.ok) return void (error.textContent = r.error);
        root.remove();
        resolve(r.url);
      });
    });
    document.body.appendChild(root);
  });
}

// ───────────── App lock ─────────────

/**
 * The biometric lock. While locked, a full-screen cover (outside React's root)
 * hides the app; it is also shown as soon as the app goes to the background,
 * so the app switcher never shows note contents.
 */
/** BiometricAuth error codes that mean "this device can't unlock right now", not "the user cancelled". */
const UNAVAILABLE = new Set(['biometryNotAvailable', 'biometryNotEnrolled', 'biometryLockout', 'passcodeNotSet', 'noDeviceCredential', 'notInteractive']);

/**
 * @param signOut  Used when the user chooses (or is forced) to unlock with
 *                 their account password instead. The cover stays up until it
 *                 has finished; only then is the lock turned off, so the next
 *                 step is the normal sign-in and nobody gets in signed in.
 */
export function createAppLock(native: NativePlugins, kv: Platform['kv'], now = () => Date.now(), signOut: () => Promise<void> = async () => {}) {
  const listeners = new Set<(on: boolean) => void>();
  const unlockListeners = new Set<() => void>();
  let cover: HTMLElement | null = null;
  let locked = false;
  let prompting = false;
  let backgroundedAt: number | null = null;
  const enabled = () => kv.get(APP_LOCK_KEY) === '1';

  const showCover = (withButton: boolean) => {
    if (typeof document === 'undefined') return;
    if (!cover) {
      cover = document.createElement('div');
      cover.className = 'app-lock';
      cover.setAttribute('role', 'dialog');
      cover.setAttribute('aria-label', 'Locked');
      cover.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;' +
        'background:var(--bg, #fff);color:var(--text, #18181b);font:inherit;padding:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)';
      const icon = document.createElement('img');
      icon.src = '/icon.svg';
      icon.alt = '';
      icon.width = icon.height = 72;
      const actions = document.createElement('div');
      actions.className = 'app-lock-actions';
      actions.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-primary';
      button.textContent = 'Unlock';
      button.addEventListener('click', () => void unlock());
      const password = document.createElement('button');
      password.type = 'button';
      password.className = 'btn btn-ghost btn-sm';
      password.textContent = 'Sign in with password instead';
      password.addEventListener('click', () => void usePassword());
      actions.append(button, password);
      cover.append(icon, actions);
      document.body.appendChild(cover);
    }
    // The cover's own `display:flex` would override the `hidden` attribute, so toggle display.
    (cover.lastElementChild as HTMLElement).style.visibility = withButton ? 'visible' : 'hidden';
    cover.style.display = 'flex';
  };
  const hideCover = () => {
    if (cover) cover.style.display = 'none';
  };
  const coverVisible = () => !!cover && cover.style.display !== 'none';

  /**
   * Way out when biometrics/passcode can't be used: sign out (the account
   * password gets you back in), then turn the lock off and remove the cover.
   * The cover is never removed unless the sign-out finished.
   */
  let signingOut: Promise<void> | null = null;
  function usePassword(): Promise<void> {
    return (signingOut ??= (async () => {
      showCover(false);
      try {
        await signOut();
      } catch (e) {
        console.warn('Sign-out failed; staying locked', e);
        showCover(true);
        return;
      } finally {
        signingOut = null;
      }
      kv.remove(APP_LOCK_KEY);
      listeners.forEach((l) => l(false));
      locked = false;
      hideCover();
    })());
  }

  async function authenticate(reason: string): Promise<'ok' | 'cancelled' | 'unavailable'> {
    try {
      await native.BiometricAuth.authenticate({
        reason,
        cancelTitle: 'Cancel',
        allowDeviceCredential: true, // fall back to the passcode
        androidTitle: 'Unlock',
        androidSubtitle: reason,
      });
      return 'ok';
    } catch (e) {
      return UNAVAILABLE.has((e as { code?: string } | null)?.code ?? '') ? 'unavailable' : 'cancelled';
    }
  }

  async function unlock() {
    if (prompting) return;
    prompting = true;
    const result = await authenticate('Unlock your notes');
    prompting = false;
    if (result === 'ok') {
      locked = false;
      hideCover();
      unlockListeners.forEach((l) => l());
    } else if (result === 'unavailable') {
      // Face ID / passcode removed or locked out: never a dead end.
      await usePassword();
    } else showCover(true); // cancelled: offer Unlock again, or the password
  }

  const lock = {
    locked: () => locked,
    coverVisible,
    /** Resolves when a password fallback in progress has finished (tests). */
    settled: () => signingOut ?? Promise.resolve(),
    /** Runs after every successful unlock. */
    onUnlock(cb: () => void) {
      unlockListeners.add(cb);
    },
    /** Cold start. */
    start() {
      if (!enabled()) return;
      locked = true;
      showCover(false);
      void unlock();
    },
    background() {
      if (!enabled()) return;
      backgroundedAt ??= now();
      if (!locked) showCover(false);
    },
    foreground() {
      if (!enabled()) return;
      const away = backgroundedAt === null ? 0 : now() - backgroundedAt;
      backgroundedAt = null;
      if (locked || away >= RELOCK_AFTER_MS) {
        locked = true;
        showCover(false);
        void unlock();
      } else if (!prompting) hideCover();
    },
    api: {
      async method() {
        try {
          const r = await native.BiometricAuth.checkBiometry();
          return biometryLabel(r.isAvailable ? r.biometryType : 0, native.os, r.deviceIsSecure);
        } catch {
          return null;
        }
      },
      enabled,
      async setEnabled(on: boolean) {
        if (on === enabled()) return on;
        // Prove it works before relying on it (and when turning it off, that it's really you).
        if ((await authenticate(on ? 'Turn on app lock' : 'Turn off app lock')) !== 'ok') return enabled();
        if (on) kv.set(APP_LOCK_KEY, '1');
        else kv.remove(APP_LOCK_KEY);
        listeners.forEach((l) => l(on));
        return on;
      },
      subscribe(cb: (on: boolean) => void) {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
    } satisfies MobileExtras['appLock'],
  };
  return lock;
}

// ───────────── Locked notes: Face ID / Touch ID ─────────────

export const lockedNotesKey = (userId: string) => `noteapp.lockedNotes.${userId}`;

/**
 * The device side of "Use Face ID for locked notes". After a password unlock the app asks the server for a device
 * secret (only an unlocked sign-in gets one) and keeps it in the keychain (SecureStorage, this-device-only). It is only
 * read back after a successful biometric check, with no passcode fallback: biometrics are the second factor here.
 * The server forgets every device secret when the locked-notes password changes or is reset.
 */
export function createLockedNotesBiometrics(native: Pick<NativePlugins, 'os' | 'BiometricAuth' | 'SecureStorage'>): LockedNotesBio {
  async function authenticate(reason: string): Promise<'ok' | 'cancelled' | 'unavailable'> {
    try {
      await native.BiometricAuth.authenticate({ reason, cancelTitle: 'Use password', allowDeviceCredential: false, androidTitle: 'Locked notes', androidSubtitle: reason });
      return 'ok';
    } catch (e) {
      return UNAVAILABLE.has((e as { code?: string } | null)?.code ?? '') ? 'unavailable' : 'cancelled';
    }
  }
  const load = async (userId: string): Promise<LockedNotesCredential | null> => {
    try {
      const raw = (await native.SecureStorage.getItem(lockedNotesKey(userId))) as unknown;
      const v = typeof raw === 'string' ? (JSON.parse(raw) as Partial<LockedNotesCredential>) : null;
      return v && typeof v.deviceId === 'string' && typeof v.secret === 'string' ? { deviceId: v.deviceId, secret: v.secret } : null;
    } catch {
      return null;
    }
  };
  return {
    async method() {
      try {
        const r = await native.BiometricAuth.checkBiometry();
        // Biometrics only: a passcode-only device can't offer this (biometryType 0).
        return r.isAvailable && r.biometryType ? biometryLabel(r.biometryType, native.os, r.deviceIsSecure) : null;
      } catch {
        return null;
      }
    },
    has: async (userId) => !!(await load(userId)),
    async save(userId, cred) {
      if ((await authenticate('Use biometrics to unlock locked notes')) !== 'ok') return false;
      await native.SecureStorage.setItem(lockedNotesKey(userId), JSON.stringify(cred));
      return true;
    },
    async read(userId) {
      const cred = await load(userId);
      if (!cred) return { result: 'none' };
      const r = await authenticate('Unlock locked notes');
      return r === 'ok' ? { result: 'ok', cred } : { result: r };
    },
    async forget(userId) {
      await native.SecureStorage.removeItem(lockedNotesKey(userId)).catch(() => {});
    },
  };
}

// ───────────── The adapter ─────────────

type Listener = (url: string) => void;

export function createCapacitorPlatform(native: NativePlugins, bridge: () => Promise<AppBridge>): Platform & MobileExtras {
  const kv = webPlatform.kv; // WKWebView / Android WebView localStorage persists with the app's data
  let hidden = false;
  let notifPermission: NotificationPermission = 'default';

  // Deep links that arrive before the router subscribes (cold start from a
  // notification tap) are queued and handed to the first subscriber.
  const linkListeners = new Set<Listener>();
  const pendingLinks: string[] = [];
  const emitLink = (url: string) => {
    if (linkListeners.size) linkListeners.forEach((l) => l(url));
    else pendingLinks.push(url);
  };

  const localClicks = new Map<number, () => void>();
  // The bridge (store + API) loads after init; the lock may need it earlier (cold-start fallback).
  let bridgePromise: Promise<AppBridge> | null = null;
  const appBridge = () => (bridgePromise ??= bridge());
  const appLock = createAppLock(native, kv, undefined, async () => (await appBridge()).signOut());

  const haptics: MobileExtras['haptics'] = {
    tap: () => void native.Haptics.selectionChanged().catch(() => {}),
    success: () => void native.Haptics.impact({ style: 'LIGHT' as ImpactStyle }).catch(() => {}),
  };

  async function refreshPermission() {
    try {
      const { display } = await native.LocalNotifications.checkPermissions();
      notifPermission = display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'default';
    } catch {
      notifPermission = 'unsupported';
    }
  }

  // ── Push (APNs / FCM) ──
  let app: AppBridge | null = null;
  let pushToken: string | null = null;
  let registeredFor: string | null = null;
  let currentUser: string | null = null;

  async function registerPush() {
    let { receive } = await native.PushNotifications.checkPermissions();
    if (receive === 'prompt' || receive === 'prompt-with-rationale') receive = (await native.PushNotifications.requestPermissions()).receive;
    await refreshPermission();
    if (receive !== 'granted') return;
    await native.PushNotifications.register(); // → 'registration' event
  }

  async function sendToken() {
    if (!app || !pushToken || !currentUser || registeredFor === `${currentUser}|${pushToken}`) return;
    registeredFor = `${currentUser}|${pushToken}`;
    try {
      await app.post('/notifications/devices', { platform: native.os, token: pushToken });
    } catch (e) {
      registeredFor = null;
      console.warn('Could not register this device for push notifications', e);
    }
  }

  async function onUser(userId: string | null) {
    if (userId === currentUser) return;
    const previous = currentUser;
    currentUser = userId;
    // Shares belong to whoever was signed in when they arrived; never hand them to another account.
    for (let i = shareQueue.length - 1; i >= 0; i--) {
      const owner = shareQueue[i].owner;
      const keep = userId && (owner === userId || (owner === null && kv.get(LAST_USER_KEY) === userId));
      if (!keep) shareQueue.splice(i, 1);
    }
    if (userId) {
      kv.set(LAST_USER_KEY, userId);
      void drainShares();
      await registerPush().catch((e) => console.warn('Push registration failed', e));
      await sendToken();
    } else if (previous) {
      // Signed out: stop this install receiving the previous user's reminders.
      // The access token is already gone, so the server can't be told directly;
      // unregistering invalidates the APNs/FCM token, and the server forgets it
      // on the next delivery attempt (TargetGoneError).
      registeredFor = null;
      pushToken = null;
      await native.PushNotifications.unregister().catch(() => {});
      await native.Badge.clear().catch(() => {});
    }
  }

  async function snoozeFromNotification(data: unknown, option: string) {
    const token = (data as { snoozeToken?: unknown } | null)?.snoozeToken;
    if (typeof token !== 'string' || !app) return;
    await app.post('/reminders/snooze', { token, option }).catch((e) => console.warn('Snooze failed', e));
  }

  // ── Share capture ──
  // Each item is tagged with the user signed in when it arrived (null: nobody;
  // then only the device's last user may take it). Nothing is saved while the app is locked.
  const shareQueue: { item: SharedItem; owner: string | null }[] = [];
  let draining = false;
  async function drainShares() {
    try {
      const { items } = await native.NoteAppNative.getPendingShares();
      shareQueue.push(...items.map((item) => ({ item, owner: currentUser })));
    } catch {
      /* plugin missing (e.g. live-reload dev build) */
    }
    if (draining || !app || !currentUser || appLock.locked() || appLock.coverVisible()) return;
    draining = true;
    try {
      while (shareQueue.length && currentUser && !appLock.locked()) {
        const { item, owner } = shareQueue.shift()!;
        if (owner !== null && owner !== currentUser) continue;
        const path = await app.capture(item).catch((e) => {
          console.warn('Could not save the shared item', e);
          return null;
        });
        if (path) emitLink(`notivelo:/${path}`);
      }
    } finally {
      draining = false;
    }
  }

  // ── Badge ──
  let badgeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBadge = -1;
  let lastWidget = '';
  let lastTasks: [Task[], string | null, string | null] | null = null;
  const scheduleBadge = (tasks: Task[], me: string | null, wsId: string | null) => {
    lastTasks = [tasks, me, wsId];
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      // With the app lock on, the home screen shows a count only, never task titles.
      const json = JSON.stringify(widgetSnapshot(tasks, me, wsId, undefined, undefined, appLock.api.enabled()));
      if (json !== lastWidget) {
        lastWidget = json;
        void native.NoteAppNative.writeWidgetSnapshot({ json }).catch(() => {});
      }
      const n = dueTodayCount(tasks, me);
      if (n === lastBadge || notifPermission !== 'granted') return;
      lastBadge = n;
      void (n ? native.Badge.set({ count: n }) : native.Badge.clear()).catch(() => {});
    }, 500);
  };

  const platform: Platform & MobileExtras = {
    kind: 'capacitor',
    haptics,
    server: {
      current: () => storedServerUrl() ?? BUILD_SERVER,
      async change() {
        const before = storedServerUrl() ?? BUILD_SERVER;
        const chosen = await serverScreen({ firstRun: false, current: before ?? '', appName: APP_NAME, kv });
        if (!chosen || chosen === before) return;
        // Tokens belong to the old server: sign out there, then restart on the new one.
        await (await appBridge()).signOut().catch(() => {});
        location.reload();
      },
    },
    appLock: appLock.api,
    lockedNotesBio: createLockedNotesBiometrics(native),

    // The native app updates through the App Store / Play Store; the web
    // bundle inside it ships with each native release, so nothing to prompt.
    appUpdates: { subscribe: () => () => {} },

    // TODO(Mobile): save via @capacitor/filesystem + share sheet; the web download is a stopgap.
    saveFile: (name, data) => webPlatform.saveFile(name, data),

    // A WKWebView / Android WebView ignores window.print(): the app's plugin prints the web
    // view natively (iOS UIPrintInteractionController with the web view's print formatter;
    // Android PrintManager with the WebView's print adapter). Both use the print stylesheet
    // and offer saving a PDF.
    async print(title) {
      await native.NoteAppNative.print({ jobName: title || 'Note' });
    },

    async init() {
      // Keychain items readable after the first unlock (so a background token
      // refresh works) and never restored onto another device from a backup.
      await native.SecureStorage.setDefaultKeychainAccess(3 /* afterFirstUnlockThisDeviceOnly */).catch(() => {});
      await refreshPermission();
      // First run: confirm which server to use (the build's default is filled in). Dev builds that
      // load the Vite server (same origin) skip this.
      if (BUILD_SERVER && kv.get(SERVER_CONFIRMED_KEY) !== '1' && typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
        void native.SplashScreen.hide().catch(() => {});
        const chosen = await serverScreen({ firstRun: true, current: storedServerUrl() ?? BUILD_SERVER, appName: APP_NAME, kv });
        // src/api.ts read the server when the app loaded; restart if the choice differs.
        if (chosen && chosen !== BUILD_SERVER) return void location.reload();
      }
      appLock.start(); // before the first render, so nothing shows through
      appLock.onUnlock(() => void drainShares());
      appLock.api.subscribe(() => {
        if (lastTasks) scheduleBadge(...lastTasks); // widget: titles hidden / shown again
      });

      // Deep links: custom scheme + universal/app links.
      void native.App.addListener('appUrlOpen', ({ url }) => emitLink(url));
      void native.App.addListener('appStateChange', ({ isActive }) => {
        hidden = !isActive;
        if (isActive) {
          appLock.foreground();
          void refreshPermission();
          void drainShares();
          if (lastTasks) scheduleBadge(...lastTasks); // the date may have changed overnight
        } else {
          appLock.background();
          // Locked pages lock again when the app goes to the background (src/lib/lockedNotes.ts).
          if (typeof window !== 'undefined') window.dispatchEvent(new Event('noteapp:background'));
        }
      });
      void native.App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) history.back();
        else void native.App.minimizeApp();
      });

      // Notifications.
      if (native.os === 'android') {
        const channel = { id: 'reminders', name: 'Reminders', description: 'Task reminders', importance: 4 as const, visibility: 1 as const };
        await native.LocalNotifications.createChannel(channel).catch(() => {});
        await native.PushNotifications.createChannel(channel).catch(() => {});
      }
      void native.LocalNotifications.addListener('localNotificationActionPerformed', ({ notification, actionId }) => {
        const extra = notification.extra as unknown;
        if ((SNOOZE_ACTIONS as readonly string[]).includes(actionId)) return void snoozeFromNotification(extra, actionId);
        const click = localClicks.get(notification.id);
        localClicks.delete(notification.id);
        if (click) return click();
        const link = notificationLink(extra);
        if (link) emitLink(link);
      });
      void native.PushNotifications.addListener('registration', ({ value }) => {
        pushToken = value;
        void sendToken();
      });
      void native.PushNotifications.addListener('registrationError', (e) => console.warn('Push registration error', e));
      void native.PushNotifications.addListener('pushNotificationActionPerformed', ({ notification, actionId }) => {
        if ((SNOOZE_ACTIONS as readonly string[]).includes(actionId)) return void snoozeFromNotification(notification.data, actionId);
        const link = notificationLink(notification.data);
        if (link) emitLink(link);
      });

      void native.NoteAppNative.addListener('shareReceived', () => void drainShares()).catch(() => {});

      installSystemUi(native, haptics);

      // Session-dependent work (push registration, badge) starts once the app's store is up.
      void appBridge().then((b) => {
        app = b;
        void native.NoteAppNative.setConfig({ apiBase: b.apiBase() }).catch(() => {});
        b.onUser((u) => void onUser(u));
        b.onTasks(scheduleBadge);
        if (BUILD_SERVER)
          b.registerCommands([
            { id: 'mobile.changeServer', title: 'Change server…', group: 'Settings', keywords: 'server url address host', run: () => void platform.server.change() },
          ]);
        void appLock.api.method().then((label) => {
          if (!label) return;
          b.registerCommands([
            { id: 'mobile.appLockOn', title: `Lock app with ${label}`, group: 'Settings', keywords: 'face id touch id biometric security', run: () => void appLock.api.setEnabled(true), when: () => !appLock.api.enabled() },
            { id: 'mobile.appLockOff', title: `Stop locking app with ${label}`, group: 'Settings', keywords: 'face id touch id biometric security', run: () => void appLock.api.setEnabled(false), when: () => appLock.api.enabled() },
          ]);
        });
      });
    },

    kv,

    secureStorage: {
      get: async (key) => {
        try {
          return await native.SecureStorage.getItem(key);
        } catch {
          return null;
        }
      },
      set: (key, value) => native.SecureStorage.setItem(key, value),
      remove: async (key) => {
        await native.SecureStorage.removeItem(key).catch(() => {});
      },
    },

    notifications: {
      permission: () => notifPermission,
      async request() {
        const { display } = await native.LocalNotifications.requestPermissions();
        await refreshPermission();
        if (display === 'granted' && currentUser) void registerPush().catch(() => {});
        return notifPermission;
      },
      show(title, { body, tag, onClick }) {
        if (notifPermission !== 'granted') return;
        const id = notificationId(tag);
        if (onClick) localClicks.set(id, onClick);
        void native.LocalNotifications.schedule({
          notifications: [{ id, title, body: body ?? '', channelId: 'reminders', extra: { tag } }],
        }).catch(() => {});
      },
    },

    openExternal(url) {
      if (/^https?:/i.test(url)) void native.Browser.open({ url, presentationStyle: 'popover' });
      // mailto:, tel:, … — the web view hands non-web schemes to the OS.
      else window.location.href = url;
    },

    deepLinks: {
      async initial() {
        const launch = await native.App.getLaunchUrl().catch(() => undefined);
        if (launch?.url) return launch.url;
        return pendingLinks.shift() ?? null;
      },
      subscribe(onLink) {
        linkListeners.add(onLink);
        while (pendingLinks.length) onLink(pendingLinks.shift()!);
        return () => linkListeners.delete(onLink);
      },
    },

    // <input type=file> works in both web views (Capacitor wires the Android file chooser).
    pickFiles: webPlatform.pickFiles,
    withLock: webPlatform.withLock,
    isHidden: () => hidden,
    focus: () => {},
  };
  return platform;
}

/** Status bar, keyboard, splash screen and haptic taps: DOM wiring, no app state. */
function installSystemUi(native: NativePlugins, haptics: MobileExtras['haptics']) {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return; // not a browser (tests)
  const root = document.documentElement;
  root.classList.add('native', `native-${native.os}`);

  // Status bar text colour follows the resolved theme (<html data-theme>).
  const applyTheme = () => {
    const dark = root.dataset.theme === 'dark' || root.dataset.theme === 'hybrid'; // hybrid: the bars sit on dark chrome
    void native.SystemBars.setStyle({ style: (dark ? 'DARK' : 'LIGHT') as SystemBarsStyle }).catch(() => {});
  };
  applyTheme();
  new MutationObserver(applyTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  // Keyboard: hide iOS's prev/next/done bar (meaningless in a single-page app);
  // expose the keyboard height so bottom bars and the editor toolbar can react.
  void native.Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {});
  // The web view is resized by the keyboard itself (capacitor.config: Keyboard.resize 'native'), so the page already has
  // the space above the keyboard: --keyboard-inset is only the part the web view did NOT give up (keyboardInset.ts).
  // Padding the page by the whole keyboard height squeezed the note to a line or two with an empty band under it.
  let heightBefore = window.innerHeight;
  let keyboardHeightNow = 0;
  const applyInset = () => {
    if (!keyboardHeightNow) return;
    root.style.setProperty('--keyboard-inset', `${keyboardInset(keyboardHeightNow, heightBefore, window.innerHeight)}px`);
  };
  void native.Keyboard.addListener('keyboardWillShow', ({ keyboardHeight }) => {
    if (!root.classList.contains('keyboard-open')) heightBefore = window.innerHeight; // before the web view shrinks
    keyboardHeightNow = keyboardHeight;
    root.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
    root.classList.add('keyboard-open');
    applyInset();
  });
  void native.Keyboard.addListener('keyboardDidShow', applyInset);
  window.addEventListener('resize', applyInset); // the web view settles a moment after the event
  void native.Keyboard.addListener('keyboardWillHide', () => {
    keyboardHeightNow = 0;
    root.style.setProperty('--keyboard-height', '0px');
    root.style.setProperty('--keyboard-inset', '0px');
    root.classList.remove('keyboard-open');
  });

  // Light haptic tap on checkbox toggles (task completion) and anything marked data-haptic.
  document.addEventListener(
    'click',
    (e) => {
      const el = (e.target as Element | null)?.closest?.('[data-haptic], input[type="checkbox"], [role="checkbox"]');
      if (el) haptics.tap();
    },
    { capture: true, passive: true },
  );

  // Hide the native splash once React has put something on screen.
  const rootEl = document.getElementById('root');
  const hide = () => void native.SplashScreen.hide({ fadeOutDuration: 200 }).catch(() => {});
  if (!rootEl || rootEl.childElementCount) return hide();
  const timer = setTimeout(hide, 4000);
  const obs = new MutationObserver(() => {
    if (!rootEl.childElementCount) return;
    obs.disconnect();
    clearTimeout(timer);
    requestAnimationFrame(hide);
  });
  obs.observe(rootEl, { childList: true });
}

/** Wires the adapter to the store and API client (loaded after them, so no import cycle at startup). */
async function loadAppBridge(): Promise<AppBridge> {
  const [{ useStore }, api, shortcuts] = await Promise.all([import('../store/state.ts'), import('../api.ts'), import('../hooks/useShortcuts.ts')]);
  return {
    onUser(cb) {
      cb(useStore.getState().user?.id ?? null);
      useStore.subscribe((s, prev) => {
        if (s.user?.id !== prev.user?.id) cb(s.user?.id ?? null);
      });
    },
    onTasks(cb) {
      const emit = () => {
        const s = useStore.getState();
        cb(Object.values(s.tasks), s.user?.id ?? null, s.wsId);
      };
      emit();
      useStore.subscribe((s, prev) => {
        if (s.tasks !== prev.tasks || s.user !== prev.user || s.wsId !== prev.wsId) emit();
      });
    },
    post: (path, body) => api.post(path, body),
    del: (path, body) => api.api(path, { method: 'DELETE', json: body }),
    registerCommands: (cmds) => void shortcuts.registerCommands(cmds),
    signOut: async () => (await import('../store/session.ts')).signOut(),
    apiBase: () => {
      const url = api.apiUrl('');
      return /^https?:\/\//.test(url) ? url.replace(/\/api$/, '') : null;
    },
    async capture(item) {
      const ws = await workspaceReady(useStore);
      if (!ws) return null;
      const c = shareContent(item);
      const { ui } = await import('../store/ui.ts');
      const section = item.kind === 'note' ? inboxSection(useStore.getState().tree) : null;
      if (!section) {
        // A task, or a note with nowhere to go: quick add, prefilled, on Today.
        ui.openQuickAdd({ text: c.quickAdd });
        return `/w/${ws}/tasks/today`;
      }
      const { id } = await api.post<{ id: string }>(`/sections/${section}/pages`, { title: c.title });
      await seedPage(id, c);
      return `/w/${ws}/p/${id}`;
    },
  };
}

/** Waits (up to 15 s) until a workspace and its tree are loaded; resolves to its id. */
function workspaceReady(useStore: typeof import('../store/state.ts').useStore): Promise<string | null> {
  const ready = () => {
    const s = useStore.getState();
    return s.user && s.wsId && s.treeLoaded ? s.wsId : null;
  };
  const now = ready();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, 15_000);
    const off = useStore.subscribe(() => {
      const id = ready();
      if (!id) return;
      clearTimeout(timer);
      off();
      resolve(id);
    });
  });
}

/**
 * Writes a new page's body into its local Yjs cache (the same IndexedDB
 * database NoteEditor opens: noteapp-page-<id>). The editor loads it when the
 * page opens and syncs it to the server like any offline edit.
 */
async function seedPage(pageId: string, c: ShareContent) {
  const [Y, { IndexeddbPersistence }] = await Promise.all([import('yjs'), import('y-indexeddb')]);
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const paragraph = (text: string, marks?: Record<string, object>) => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text, marks);
    p.insert(0, [t]);
    return p;
  };
  const blocks = c.paragraphs.map((t) => paragraph(t));
  if (c.url) blocks.push(paragraph(c.url, { link: { href: c.url } }));
  if (!blocks.length) return;
  frag.insert(0, blocks);
  const idb = new IndexeddbPersistence(`noteapp-page-${pageId}`, doc);
  await idb.whenSynced;
  await idb.destroy(); // closes the database; the stored update stays
  doc.destroy();
}

/** The real plugins. Imported dynamically so tests (and the web bundle) never load them. */
async function loadPlugins(): Promise<NativePlugins> {
  const [core, app, browser, haptics, keyboard, local, push, splash, secure, badge, biometric] = await Promise.all([
    import('@capacitor/core'),
    import('@capacitor/app'),
    import('@capacitor/browser'),
    import('@capacitor/haptics'),
    import('@capacitor/keyboard'),
    import('@capacitor/local-notifications'),
    import('@capacitor/push-notifications'),
    import('@capacitor/splash-screen'),
    import('@aparajita/capacitor-secure-storage'),
    import('@capawesome/capacitor-badge'),
    import('@aparajita/capacitor-biometric-auth'),
  ]);
  const NoteAppNative = core.registerPlugin<NativePlugins['NoteAppNative']>('NoteAppNative');
  return {
    os: core.Capacitor.getPlatform() === 'android' ? 'android' : 'ios',
    App: app.App,
    Browser: browser.Browser,
    Haptics: haptics.Haptics,
    Keyboard: keyboard.Keyboard,
    LocalNotifications: local.LocalNotifications,
    PushNotifications: push.PushNotifications,
    SplashScreen: splash.SplashScreen,
    SystemBars: core.SystemBars,
    SecureStorage: secure.SecureStorage,
    Badge: badge.Badge,
    BiometricAuth: biometric.BiometricAuth,
    NoteAppNative,
  };
}

export async function loadCapacitorPlatform(): Promise<Platform & MobileExtras> {
  return createCapacitorPlatform(await loadPlugins(), loadAppBridge);
}
