// Tauri (desktop: macOS, Windows, Linux) implementation of the platform adapter.
// Loaded only inside the desktop app, by a dynamic import in index.ts, so the
// web bundle never carries @tauri-apps/*. The Rust side is apps/desktop/src-tauri.
//
// The desktop app bundles dist/ and talks to a configurable server. The Rust
// side injects the chosen URL as window.__NOTEAPP_API_URL__ (read by
// src/api.ts) and the whole config as window.__NOTEAPP_SERVER__.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrent as getCurrentDeepLinks, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import type { NotificationPermission, Platform } from './types.ts';
import { webPlatform } from './web.ts';
import { isApple } from '../hooks/useShortcuts.ts';
import { navigateTo, runMenuCommand } from './tauri/commands.ts';
import { registerMenulessCommands } from './tauri/menuless.ts';
import { serverInfo, showServerSetup } from './tauri/serverSetup.ts';
import { createClickTracker } from './tauri/notificationClicks.ts';

let notificationPermission: NotificationPermission = 'default';
let focused = true;
const notificationClicks = createClickTracker();
const linkListeners = new Set<(url: string) => void>();
const pendingLinks: string[] = [];

function deliverLinks(urls: string[]) {
  for (const url of urls) {
    if (linkListeners.size === 0) pendingLinks.push(url);
    else linkListeners.forEach((l) => l(url));
  }
}

export const tauriPlatform: Platform = {
  kind: 'tauri',

  // Desktop updates go through the Tauri updater (tauri/updates.ts: checked on
  // start and from "Check for Updates…" in the menu), with its own dialog.
  appUpdates: { subscribe: () => () => {} },

  async init() {
    const win = getCurrentWindow();

    // First run: ask which server to use (the default is pre-filled). Saving restarts the app.
    if (!serverInfo().configured) {
      await showServerSetup({ firstRun: true });
      return new Promise<never>(() => {}); // never render the app; the restart reloads everything
    }

    if (win.label === 'quick') {
      // The quick-capture window renders its own small UI instead of the app.
      const { mountQuickCapture } = await import('./tauri/quickCapture.tsx');
      await mountQuickCapture();
      return new Promise<never>(() => {});
    }

    focused = await win.isFocused().catch(() => true);
    void win.onFocusChanged(({ payload }) => {
      focused = payload;
      if (payload) notificationClicks.focused();
    });

    notificationPermission = (await isPermissionGranted().catch(() => false)) ? 'granted' : 'default';

    // Deep links: the one the app was launched with, then any that arrive while running.
    const initial = await getCurrentDeepLinks().catch(() => null);
    if (initial?.length) pendingLinks.push(...initial);
    void onOpenUrl((urls) => {
      void tauriPlatform.focus();
      deliverLinks(urls);
    });

    // macOS has a native menu; elsewhere its shortcuts and menu-only actions are registered here.
    if (!isApple) registerMenulessCommands();

    // App menu and tray items run commands from the web app's command registry.
    void listen<string>('menu-command', ({ payload }) => runMenuCommand(payload));
    void listen<string>('open-path', ({ payload }) => {
      if (payload.startsWith('/')) navigateTo(payload);
    });
    void listen('change-server', () => void showServerSetup({ firstRun: false }));
    void listen('check-updates', () => void import('./tauri/updates.ts').then((m) => m.checkForUpdates({ interactive: true })));

    // After the app has rendered: keep the dock badge / tray count in sync and check for updates.
    setTimeout(() => {
      void import('./tauri/badge.ts').then((m) => m.startBadgeSync());
      if (!isApple) void import('./tauri/menuless.ts').then((m) => m.startWindowThemeSync());
      void import('./tauri/updates.ts').then((m) => m.checkForUpdates({ interactive: false }));
    }, 0);
  },

  // The WebView's localStorage is per app and persistent, so the web implementation works as is.
  kv: webPlatform.kv,

  // The OS keychain (macOS Keychain, Windows Credential Manager), namespaced by server.
  secureStorage: {
    get: (key) => invoke<string | null>('secure_get', { key }),
    set: (key, value) => invoke<void>('secure_set', { key, value }),
    remove: (key) => invoke<void>('secure_remove', { key }),
  },

  notifications: {
    permission: () => notificationPermission,
    async request() {
      if (notificationPermission === 'granted') return 'granted';
      const p = await requestPermission().catch(() => 'denied' as const);
      notificationPermission = p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'default';
      return notificationPermission;
    },
    // Desktop notifications can't report clicks, but clicking one brings the
    // app forward; coming to the front shortly after one was shown runs its
    // onClick (see tauri/notificationClicks.ts).
    show(title, { body, onClick }) {
      if (notificationPermission !== 'granted') return;
      sendNotification({ title, body });
      notificationClicks.shown(onClick, tauriPlatform.isHidden());
    },
  },

  openExternal(url) {
    void openUrl(url).catch(() => {});
  },

  deepLinks: {
    initial: async () => pendingLinks.shift() ?? null,
    subscribe(onLink) {
      linkListeners.add(onLink);
      // Links that arrived before anyone listened (cold start, early clicks).
      while (pendingLinks.length) onLink(pendingLinks.shift()!);
      return () => linkListeners.delete(onLink);
    },
  },

  // WebKit/WebView2 show the native file panel for <input type=file>, and
  // drag-and-drop goes to the page (the Rust side disables Tauri's own handler).
  pickFiles: webPlatform.pickFiles,

  // Every window is the same origin in one WebView process, so Web Locks span them.
  withLock: webPlatform.withLock,

  isHidden: () => document.hidden || !focused,

  focus() {
    const w = getCurrentWindow();
    void w
      .unminimize()
      .then(() => w.show())
      .then(() => w.setFocus())
      .catch(() => {});
  },
};
