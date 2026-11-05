// Web implementation of the platform adapter (browsers and the installed PWA).
import type { NotificationPermission, Platform } from './types.ts';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // disabled / private mode
  }
}

const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

export const webPlatform: Platform = {
  kind: 'web',

  async init() {
    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
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

  withLock(name, fn) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    return locks ? (locks.request(name, fn) as ReturnType<typeof fn>) : fn();
  },

  isHidden: () => typeof document !== 'undefined' && document.hidden,
  focus: () => window.focus(),
};
