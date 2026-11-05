// Capacitor implementation of the platform adapter (the iPhone and Android
// apps in apps/mobile/). Loaded lazily by initPlatform() only inside the native
// shell, so the web bundle doesn't carry it. See docs/MOBILE.md.
//
// What it adds on top of the web behaviour:
//   secure storage     Keychain (iOS) / Keystore-encrypted prefs (Android) for the refresh token
//   notifications      local notifications for in-app reminders; APNs/FCM push registered with
//                      the server after sign-in; tapping either deep-links to the task
//   deep links         noteapp://… and https://notes.devswartz.com/w/… (universal/app links)
//   app badge          number of my open tasks due today or overdue
//   haptics            light tap on checkbox toggles and [data-haptic] elements; platform.haptics
//   system UI          status bar text follows the theme, splash hidden after first render,
//                      keyboard height exposed as --keyboard-height + html.keyboard-open,
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
import type { Task } from '../../shared/types.ts';
import type { NotificationPermission, Platform } from './types.ts';
import { webPlatform } from './web.ts';

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
}

/** What the adapter needs from the app (wired to the store and API client in loadAppBridge()). */
export interface AppBridge {
  /** Calls back with the signed-in user's id (null when signed out), now and on every change. */
  onUser(cb: (userId: string | null) => void): void;
  /** Calls back with the loaded tasks whenever they change. */
  onTasks(cb: (tasks: Task[], userId: string | null) => void): void;
  post(path: string, body: unknown): Promise<unknown>;
  del(path: string, body: unknown): Promise<unknown>;
}

/** Native capabilities beyond the shared Platform interface (feature-detect with `'haptics' in platform`). */
export interface MobileExtras {
  haptics: {
    tap(): void;
    success(): void;
  };
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
  return `noteapp:/${url}`;
}

/** Notification ids must be positive 32-bit ints (Android); derive a stable one from a tag. */
export function notificationId(tag: string | undefined): number {
  if (!tag) return Math.floor(Math.random() * 2 ** 30) + 1;
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (Math.imul(h, 31) + tag.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2 ** 30) + 1;
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
    if (userId) {
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

  // ── Badge ──
  let badgeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBadge = -1;
  const scheduleBadge = (tasks: Task[], me: string | null) => {
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      const n = dueTodayCount(tasks, me);
      if (n === lastBadge || notifPermission !== 'granted') return;
      lastBadge = n;
      void (n ? native.Badge.set({ count: n }) : native.Badge.clear()).catch(() => {});
    }, 500);
  };

  const platform: Platform & MobileExtras = {
    kind: 'capacitor',
    haptics,

    async init() {
      // Keychain items readable after the first unlock (so a background token
      // refresh works) and never restored onto another device from a backup.
      await native.SecureStorage.setDefaultKeychainAccess(3 /* afterFirstUnlockThisDeviceOnly */).catch(() => {});
      await refreshPermission();

      // Deep links: custom scheme + universal/app links.
      void native.App.addListener('appUrlOpen', ({ url }) => emitLink(url));
      void native.App.addListener('appStateChange', ({ isActive }) => {
        hidden = !isActive;
        if (isActive) void refreshPermission();
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

      installSystemUi(native, haptics);

      // Session-dependent work (push registration, badge) starts once the app's store is up.
      void bridge().then((b) => {
        app = b;
        b.onUser((u) => void onUser(u));
        b.onTasks(scheduleBadge);
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
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.add('native', `native-${native.os}`);

  // Status bar text colour follows the resolved theme (<html data-theme>).
  const applyTheme = () => {
    const dark = root.dataset.theme === 'dark';
    void native.SystemBars.setStyle({ style: (dark ? 'DARK' : 'LIGHT') as SystemBarsStyle }).catch(() => {});
  };
  applyTheme();
  new MutationObserver(applyTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  // Keyboard: hide iOS's prev/next/done bar (meaningless in a single-page app);
  // expose the keyboard height so bottom bars and the editor toolbar can react.
  void native.Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {});
  void native.Keyboard.addListener('keyboardWillShow', ({ keyboardHeight }) => {
    root.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
    root.classList.add('keyboard-open');
  });
  void native.Keyboard.addListener('keyboardWillHide', () => {
    root.style.setProperty('--keyboard-height', '0px');
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
  const [{ useStore }, api] = await Promise.all([import('../store/state.ts'), import('../api.ts')]);
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
        cb(Object.values(s.tasks), s.user?.id ?? null);
      };
      emit();
      useStore.subscribe((s, prev) => {
        if (s.tasks !== prev.tasks || s.user !== prev.user) emit();
      });
    },
    post: (path, body) => api.post(path, body),
    del: (path, body) => api.api(path, { method: 'DELETE', json: body }),
  };
}

/** The real plugins. Imported dynamically so tests (and the web bundle) never load them. */
async function loadPlugins(): Promise<NativePlugins> {
  const [core, app, browser, haptics, keyboard, local, push, splash, secure, badge] = await Promise.all([
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
  ]);
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
  };
}

export async function loadCapacitorPlatform(): Promise<Platform & MobileExtras> {
  return createCapacitorPlatform(await loadPlugins(), loadAppBridge);
}
