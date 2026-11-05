// Capacitor platform adapter (src/platform/capacitor.ts), run against fake
// native plugins. Owner: Mobile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELOCK_AFTER_MS,
  biometryLabel,
  createAppLock,
  createCapacitorPlatform,
  dueTodayCount,
  notificationId,
  notificationLink,
  type AppBridge,
  type NativePlugins,
} from '../src/platform/capacitor.ts';
import { parseDeepLink } from '../src/platform/deepLinks.ts';
import type { Task } from '../shared/types.ts';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function task(over: Partial<Task>): Task {
  return {
    id: 't' + Math.random(),
    workspaceId: 'ws',
    title: 'x',
    description: '',
    status: 'open',
    priority: 4,
    dueDate: null,
    dueTime: null,
    recurrence: null,
    reminderAt: null,
    assigneeId: null,
    createdBy: 'me',
    pageId: null,
    completedAt: null,
    completedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Task;
}

/** Fake plugins: records calls, lets the test fire native events. */
function fakes(opts: { receive?: string; display?: string; launchUrl?: string } = {}) {
  const calls: [string, unknown?][] = [];
  const handlers = new Map<string, (e: never) => void>();
  const store = new Map<string, string>();
  const plugin = (name: string, extra: Record<string, unknown> = {}) =>
    new Proxy(extra, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (prop === 'addListener')
          return async (event: string, fn: (e: never) => void) => {
            handlers.set(`${name}.${event}`, fn);
            return { remove: async () => {} };
          };
        if (prop === 'then') return undefined;
        return async (arg?: unknown) => {
          calls.push([`${name}.${prop}`, arg]);
        };
      },
    });
  const native = {
    os: 'ios',
    App: plugin('App', { getLaunchUrl: async () => (opts.launchUrl ? { url: opts.launchUrl } : undefined) }),
    Browser: plugin('Browser'),
    Haptics: plugin('Haptics'),
    Keyboard: plugin('Keyboard'),
    LocalNotifications: plugin('Local', {
      checkPermissions: async () => ({ display: opts.display ?? 'granted' }),
      requestPermissions: async () => ({ display: 'granted' }),
    }),
    PushNotifications: plugin('Push', {
      checkPermissions: async () => ({ receive: opts.receive ?? 'granted' }),
      requestPermissions: async () => {
        calls.push(['Push.requestPermissions']);
        return { receive: 'granted' };
      },
    }),
    SplashScreen: plugin('Splash'),
    SystemBars: plugin('SystemBars'),
    SecureStorage: plugin('Secure', {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => void store.set(k, v),
      removeItem: async (k: string) => void store.delete(k),
    }),
    Badge: plugin('Badge'),
  } as unknown as NativePlugins;
  const fire = (key: string, event: unknown) => handlers.get(key)!(event as never);
  return { native, calls, fire, store };
}

function fakeBridge() {
  const posts: [string, unknown][] = [];
  let userCb: (u: string | null) => void = () => {};
  let tasksCb: (t: Task[], u: string | null) => void = () => {};
  const bridge: AppBridge = {
    onUser: (cb) => void (userCb = cb),
    onTasks: (cb) => void (tasksCb = cb),
    post: async (path, body) => void posts.push([path, body]),
    del: async (path, body) => void posts.push([`DELETE ${path}`, body]),
    registerCommands: () => {},
  };
  return { bridge, posts, setUser: (u: string | null) => userCb(u), setTasks: (t: Task[], u: string | null) => tasksCb(t, u) };
}

test('mobile: notification payloads become safe in-app deep links', () => {
  const link = notificationLink({ url: '/w/ws1/tasks/today?task=t1', taskId: 't1' });
  assert.equal(link, 'noteapp://w/ws1/tasks/today?task=t1');
  assert.deepEqual(parseDeepLink(link!), { kind: 'path', path: '/w/ws1/tasks/today?task=t1' });
  assert.equal(notificationLink({ url: 'https://evil.example/x' }), null);
  assert.equal(notificationLink({ url: '//evil.example/x' }), null);
  assert.equal(notificationLink({ taskId: 't1' }), null);
  assert.equal(notificationLink(null), null);
  assert.equal(notificationLink('x'), null);
});

test('mobile: notification ids are stable positive 32-bit ints', () => {
  const a = notificationId('reminder:abc');
  assert.equal(a, notificationId('reminder:abc'));
  assert.notEqual(a, notificationId('reminder:abd'));
  for (const tag of ['', 'x', 'a'.repeat(500), undefined]) {
    const id = notificationId(tag);
    assert.ok(Number.isInteger(id) && id > 0 && id < 2 ** 31, `${tag} → ${id}`);
  }
});

test('mobile: badge counts my open tasks due today or overdue', () => {
  const today = '2026-11-05';
  const tasks = [
    task({ dueDate: '2026-11-05' }), // mine (created, unassigned)
    task({ dueDate: '2026-11-01', assigneeId: 'me', createdBy: 'sam' }), // overdue, assigned to me
    task({ dueDate: '2026-11-05', assigneeId: 'sam' }), // someone else's
    task({ dueDate: '2026-11-06' }), // tomorrow
    task({ dueDate: null }),
    task({ dueDate: '2026-11-04', status: 'done' }),
  ];
  assert.equal(dueTodayCount(tasks, 'me', today), 2);
  assert.equal(dueTodayCount(tasks, null, today), 0);
});

test('mobile: refresh token goes to the keychain plugin', async () => {
  const f = fakes();
  const p = createCapacitorPlatform(f.native, async () => fakeBridge().bridge);
  await p.secureStorage.set('noteapp.refreshToken', 'r1');
  assert.equal(f.store.get('noteapp.refreshToken'), 'r1');
  assert.equal(await p.secureStorage.get('noteapp.refreshToken'), 'r1');
  await p.secureStorage.remove('noteapp.refreshToken');
  assert.equal(await p.secureStorage.get('noteapp.refreshToken'), null);
});

test('mobile: deep links — launch URL, queued before the router subscribes, then live', async () => {
  const f = fakes({ launchUrl: 'noteapp://page/p1' });
  const p = createCapacitorPlatform(f.native, async () => fakeBridge().bridge);
  await p.init();
  assert.equal(await p.deepLinks.initial(), 'noteapp://page/p1');

  f.fire('App.appUrlOpen', { url: 'noteapp://w/ws/tasks/today' }); // before anyone listens
  const got: string[] = [];
  const off = p.deepLinks.subscribe((u) => got.push(u));
  assert.deepEqual(got, ['noteapp://w/ws/tasks/today']);
  f.fire('App.appUrlOpen', { url: 'https://notes.devswartz.com/w/ws/p/pg' });
  assert.equal(got.length, 2);
  off();
});

test('mobile: push token registered with the server after sign-in, once; unregistered on sign-out', async () => {
  const f = fakes({ receive: 'prompt' });
  const b = fakeBridge();
  const p = createCapacitorPlatform(f.native, async () => b.bridge);
  await p.init();
  await tick();
  b.setUser('u1');
  await tick();
  assert.ok(f.calls.some(([c]) => c === 'Push.requestPermissions'), 'asks for permission after sign-in');
  assert.ok(f.calls.some(([c]) => c === 'Push.register'));
  f.fire('Push.registration', { value: 'apns-token-1' });
  await tick();
  assert.deepEqual(b.posts, [['/notifications/devices', { platform: 'ios', token: 'apns-token-1' }]]);
  f.fire('Push.registration', { value: 'apns-token-1' }); // same token again on next launch
  await tick();
  assert.equal(b.posts.length, 1);

  b.setUser(null);
  await tick();
  assert.ok(f.calls.some(([c]) => c === 'Push.unregister'));
  assert.ok(f.calls.some(([c]) => c === 'Badge.clear'));
});

test('mobile: tapping a push opens the task; snooze actions call the server', async () => {
  const f = fakes();
  const b = fakeBridge();
  const p = createCapacitorPlatform(f.native, async () => b.bridge);
  await p.init();
  await tick();
  const links: string[] = [];
  p.deepLinks.subscribe((u) => links.push(u));
  const data = { url: '/w/ws/tasks/today?task=t1', taskId: 't1', snoozeToken: 'snz' };
  f.fire('Push.pushNotificationActionPerformed', { actionId: 'tap', notification: { data } });
  assert.deepEqual(links, ['noteapp://w/ws/tasks/today?task=t1']);
  f.fire('Push.pushNotificationActionPerformed', { actionId: '1h', notification: { data } });
  await tick();
  assert.deepEqual(b.posts.at(-1), ['/reminders/snooze', { token: 'snz', option: '1h' }]);
  assert.equal(links.length, 1, 'snoozing does not open the app on the task');
});

test('mobile: local notifications run their click handler; badge follows tasks', async () => {
  const f = fakes();
  const b = fakeBridge();
  const p = createCapacitorPlatform(f.native, async () => b.bridge);
  await p.init();
  await tick();
  assert.equal(p.notifications.permission(), 'granted');
  let clicked = 0;
  p.notifications.show('Reminder', { body: 'Pay rent', tag: 'task-1', onClick: () => clicked++ });
  const scheduled = f.calls.find(([c]) => c === 'Local.schedule')![1] as { notifications: { id: number; title: string }[] };
  const id = scheduled.notifications[0].id;
  assert.equal(scheduled.notifications[0].title, 'Reminder');
  f.fire('Local.localNotificationActionPerformed', { actionId: 'tap', notification: { id, extra: {} } });
  assert.equal(clicked, 1);

  b.setTasks([task({ dueDate: '2000-01-01' }), task({ dueDate: '2000-01-02' })], 'me');
  await tick(600);
  assert.deepEqual(f.calls.filter(([c]) => c === 'Badge.set').at(-1), ['Badge.set', { count: 2 }]);
});

function memoryKv() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), remove: (k: string) => void m.delete(k) };
}

test('mobile: biometry labels', () => {
  assert.equal(biometryLabel(2, 'ios', true), 'Face ID');
  assert.equal(biometryLabel(1, 'ios', true), 'Touch ID');
  assert.equal(biometryLabel(3, 'android', true), 'Fingerprint');
  assert.equal(biometryLabel(0, 'ios', true), 'Passcode');
  assert.equal(biometryLabel(0, 'android', false), null);
});

test('mobile: app lock — opt-in, needs a successful unlock to change, relocks after a minute away', async () => {
  let authOk = true;
  let prompts = 0;
  const native = {
    os: 'ios',
    BiometricAuth: {
      checkBiometry: async () => ({ isAvailable: true, biometryType: 2, deviceIsSecure: true }),
      authenticate: async () => {
        prompts++;
        if (!authOk) throw new Error('userCancel');
      },
    },
  } as unknown as NativePlugins;
  const kv = memoryKv();
  let clock = 0;
  const lock = createAppLock(native, kv, () => clock);
  assert.equal(await lock.api.method(), 'Face ID');

  lock.start();
  assert.equal(lock.locked(), false, 'off by default');
  assert.equal(prompts, 0);

  const seen: boolean[] = [];
  lock.api.subscribe((on) => seen.push(on));
  authOk = false;
  assert.equal(await lock.api.setEnabled(true), false, 'cancelled prompt leaves it off');
  authOk = true;
  assert.equal(await lock.api.setEnabled(true), true);
  assert.deepEqual(seen, [true]);

  lock.start(); // next cold start
  assert.equal(lock.locked(), true);
  await tick();
  assert.equal(lock.locked(), false, 'unlocked after Face ID');

  const before = prompts;
  lock.background();
  clock += 5_000;
  lock.foreground();
  assert.equal(prompts, before, 'a quick app switch does not prompt');

  lock.background();
  clock += RELOCK_AFTER_MS;
  authOk = false;
  lock.foreground();
  assert.equal(lock.locked(), true);
  await tick();
  assert.equal(lock.locked(), true, 'stays locked when Face ID is cancelled');
  authOk = true;
  lock.foreground();
  await tick();
  assert.equal(lock.locked(), false);

  assert.equal(await lock.api.setEnabled(false), false);
  assert.equal(kv.get('noteapp.appLock'), null);
});
