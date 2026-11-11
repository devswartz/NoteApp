// Web implementation of the platform adapter (browsers and the installed PWA).
import type { NotificationPermission, Platform } from './types.ts';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // disabled / private mode
  }
}

// ── Service worker and update prompt ──
const updateListeners = new Set<(apply: () => void) => void>();
let pendingUpdate: (() => void) | null = null;

function announceUpdate(worker: ServiceWorker) {
  pendingUpdate = () => {
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    worker.postMessage('skipWaiting');
  };
  for (const fn of updateListeners) fn(pendingUpdate);
}

async function registerServiceWorker() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  // Only an update if a version is already controlling this page.
  const watch = (w: ServiceWorker | null) => {
    if (!w) return;
    const check = () => w.state === 'installed' && navigator.serviceWorker.controller && announceUpdate(w);
    check();
    w.addEventListener('statechange', check);
  };
  watch(reg.waiting);
  reg.addEventListener('updatefound', () => watch(reg.installing));
  // Look for new deploys every 30 minutes and when the app comes back into view.
  setInterval(() => void reg.update().catch(() => {}), 30 * 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void reg.update().catch(() => {}));
}

const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

export const webPlatform: Platform = {
  kind: 'web',

  async init() {
    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      window.addEventListener('load', () => void registerServiceWorker().catch(() => {}));
    }
  },

  kv: {
    get: (key) => {
      try {
        return storage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        storage()?.setItem(key, value);
      } catch {
        /* quota / disabled */
      }
    },
    remove: (key) => {
      try {
        storage()?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  },

  // Browsers have no keychain; localStorage is the best available. The shells
  // replace this with the OS keychain.
  secureStorage: {
    get: async (key) => webPlatform.kv.get(key),
    set: async (key, value) => webPlatform.kv.set(key, value),
    remove: async (key) => webPlatform.kv.remove(key),
  },

  notifications: {
    permission: () => (notificationsSupported() ? (Notification.permission as NotificationPermission) : 'unsupported'),
    request: async () => (notificationsSupported() ? ((await Notification.requestPermission()) as NotificationPermission) : 'unsupported'),
    show(title, { body, tag, onClick }) {
      if (!notificationsSupported() || Notification.permission !== 'granted') return;
      const n = new Notification(title, { body, tag });
      n.onclick = () => {
        window.focus();
        onClick?.();
        n.close();
      };
    },
  },

  openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  // On the web a "deep link" is just the URL the page was opened at, which the
  // router already handles.
  deepLinks: {
    initial: async () => null,
    subscribe: () => () => {},
  },

  // The browser's dialog is modal: print() returns once it closes.
  async print() {
    window.print();
  },

  async saveFile(name, data) {
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  pickFiles({ accept, multiple } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.multiple = !!multiple;
      input.style.display = 'none';
      let settled = false;
      const done = (files: File[]) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(files);
      };
      input.addEventListener('change', () => done([...(input.files ?? [])]));
      input.addEventListener('cancel', () => done([]));
      document.body.appendChild(input);
      input.click();
    });
  },

  appUpdates: {
    subscribe(fn) {
      updateListeners.add(fn);
      if (pendingUpdate) fn(pendingUpdate);
      return () => updateListeners.delete(fn);
    },
  },

  withLock(name, fn) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    return locks ? (locks.request(name, fn) as ReturnType<typeof fn>) : fn();
  },

  isHidden: () => typeof document !== 'undefined' && document.hidden,
  focus: () => window.focus(),
};
