// Web push for reminders (owner: Recurrence & Reminders). Loaded by the
// service worker with importScripts('/sw-push.js') (public/sw.js, Foundation).
//
// The server (server/reminders/push.ts) sends JSON:
//   { title, body, url, tag?, taskId?, snoozeToken? }
// Clicking the notification focuses an open app window and navigates it to
// `url`, or opens a new window there. Reminders carry a snoozeToken and get
// "Snooze 10 min" / "Snooze 1 hour" / "Tomorrow" actions (browsers show as
// many as Notification.maxActions allows), which POST /api/reminders/snooze.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Reminder';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: data.url || '/', taskId: data.taskId || null, snoozeToken: data.snoozeToken || null },
    // Browsers show up to 2 actions (Notification.maxActions); clicking the body opens the task.
    actions: data.snoozeToken
      ? [
          { action: 'snooze-10m', title: 'Snooze 10 min' },
          { action: 'snooze-1h', title: 'Snooze 1 hour' },
          { action: 'snooze-tomorrow', title: 'Tomorrow' },
        ]
      : data.taskId
        ? [{ action: 'open', title: 'Open task' }]
        : [],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  if (event.action && event.action.startsWith('snooze-') && d.snoozeToken) {
    const option = event.action.slice('snooze-'.length);
    event.waitUntil(
      fetch('/api/reminders/snooze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: d.snoozeToken, option }),
      }).catch(() => {}),
    );
    return;
  }
  const path = (event.notification.data && event.notification.data.url) || '/';
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const same = windows.filter((w) => new URL(w.url).origin === self.location.origin);
      const win = same.find((w) => w.focused) || same[0];
      if (win) {
        // Tell the app (so it can route without a reload), then navigate as a fallback.
        win.postMessage({ type: 'notification-click', url: path, taskId: event.notification.data && event.notification.data.taskId });
        await win.focus();
        if ('navigate' in win && new URL(win.url).pathname + new URL(win.url).search !== path) {
          try {
            await win.navigate(target);
          } catch {
            /* cross-origin or not controlled */
          }
        }
        return;
      }
      return self.clients.openWindow(target);
    }),
  );
});

// The browser can rotate a subscription; re-register the new one with the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  const old = event.oldSubscription;
  const key = old && old.options && old.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).then((sub) =>
      // No access token in the worker: the app re-syncs its subscription on next start.
      self.clients.matchAll({ type: 'window' }).then((ws) => ws.forEach((w) => w.postMessage({ type: 'push-subscription-changed', subscription: sub.toJSON() }))),
    ),
  );
});
