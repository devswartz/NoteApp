// Capacitor platform adapter (src/platform/capacitor.ts), run against fake
// native plugins. Owner: Mobile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELOCK_AFTER_MS,
  biometryLabel,
  createAppLock,
  createCapacitorPlatform,
  inboxSection,
  shareContent,
  widgetSnapshot,
  type SharedItem,
  dueTodayCount,
  notificationId,
  notificationLink,
  type AppBridge,
  type NativePlugins,
} from '../src/platform/capacitor.ts';
import { parseDeepLink } from '../src/platform/deepLinks.ts';
import type { Task } from '../shared/types.ts';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// The adapter keeps small preferences in the web view's localStorage (platform.kv).
const ls = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) },
};

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
function fakes(opts: { receive?: string; display?: string; launchUrl?: string; shares?: SharedItem[] } = {}) {
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
    NoteAppNative: plugin('Native', {
      getPendingShares: async () => ({ items: (opts.shares ?? []).splice(0) }),
    }),
  } as unknown as NativePlugins;
  const fire = (key: string, event: unknown) => handlers.get(key)!(event as never);
  return { native, calls, fire, store };
}

function fakeBridge() {
  const posts: [string, unknown][] = [];
  const captured: SharedItem[] = [];
  let userCb: (u: string | null) => void = () => {};
  let tasksCb: (t: Task[], u: string | null, ws: string | null) => void = () => {};
  const bridge: AppBridge = {
    onUser: (cb) => void (userCb = cb),
    onTasks: (cb) => void (tasksCb = cb),
    post: async (path, body) => void posts.push([path, body]),
    del: async (path, body) => void posts.push([`DELETE ${path}`, body]),
    registerCommands: () => {},
    signOut: async () => {},
    apiBase: () => 'https://notes.example.com',
    capture: async (item) => {
      captured.push(item);
      return item.kind === 'note' ? '/w/ws/p/new-page' : '/w/ws/tasks/today';
    },
  };
  return { bridge, posts, captured, setUser: (u: string | null) => userCb(u), setTasks: (t: Task[], u: string | null, ws: string | null = 'ws') => tasksCb(t, u, ws) };
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
  assert.deepEqual(f.calls.find(([c]) => c === 'Native.setConfig'), ['Native.setConfig', { apiBase: 'https://notes.example.com' }], 'Android snooze actions know the server');
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

  const due = [task({ dueDate: '2000-01-01' }), task({ dueDate: '2000-01-02' })];
  b.setTasks(due, 'me');
  await tick(600);
  assert.deepEqual(f.calls.filter(([c]) => c === 'Badge.set').at(-1), ['Badge.set', { count: 2 }]);
  const widget = f.calls.filter(([c]) => c === 'Native.writeWidgetSnapshot').at(-1)![1] as { json: string };
  assert.equal(JSON.parse(widget.json).total, 2, 'the widget snapshot is written with the badge');
  const writes = f.calls.filter(([c]) => c === 'Native.writeWidgetSnapshot').length;
  b.setTasks([...due], 'me');
  await tick(600);
  assert.equal(f.calls.filter(([c]) => c === 'Native.writeWidgetSnapshot').length, writes, 'unchanged snapshot is not rewritten');
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

test('mobile: shared items become a quick-add line or a note title + body', () => {
  assert.deepEqual(shareContent({ kind: 'task', text: 'Call the plumber tomorrow' }), {
    quickAdd: 'Call the plumber tomorrow',
    title: 'Call the plumber tomorrow',
    paragraphs: [],
    url: null,
  });
  const link = shareContent({ kind: 'note', title: 'Yjs docs', text: 'Read this\n\nSecond para', url: 'https://www.yjs.dev/docs' });
  assert.equal(link.title, 'Yjs docs');
  assert.deepEqual(link.paragraphs, ['Read this', 'Second para']);
  assert.equal(link.quickAdd, 'Yjs docs https://www.yjs.dev/docs');
  assert.equal(shareContent({ kind: 'note', url: 'https://www.example.com/a' }).title, 'example.com');
  assert.equal(shareContent({ kind: 'note', url: 'javascript:alert(1)' }).url, null, 'only web links');
  const long = 'x'.repeat(300);
  const c = shareContent({ kind: 'note', text: long });
  assert.equal(c.title.length, 120);
  assert.deepEqual(c.paragraphs, [long], 'a long first line is kept in full in the body');
});

test('mobile: shared notes go to the Inbox section, else the first section', () => {
  const tree = {
    notebooks: [
      { id: 'nb2', position: 2 },
      { id: 'nb1', position: 1 },
    ],
    sections: [
      { id: 's-b', notebookId: 'nb1', name: 'Work', position: 2 },
      { id: 's-a', notebookId: 'nb1', name: 'Ideas', position: 1 },
      { id: 's-inbox', notebookId: 'nb2', name: ' inbox ', position: 1 },
    ],
    pages: [],
  } as never;
  assert.equal(inboxSection(tree), 's-inbox');
  (tree as { sections: { name: string }[] }).sections[2].name = 'Later';
  assert.equal(inboxSection(tree), 's-a');
  assert.equal(inboxSection({ notebooks: [], sections: [], pages: [] }), null);
});

test('mobile: shares wait for sign-in, then open where they were saved', async () => {
  const shares: SharedItem[] = [];
  const f = fakes({ shares });
  const b = fakeBridge();
  const p = createCapacitorPlatform(f.native, async () => b.bridge);
  await p.init();
  await tick();
  const links: string[] = [];
  p.deepLinks.subscribe((u) => links.push(u));
  b.setUser('u1'); // u1 has used this device before…
  await tick();
  b.setUser(null); // …is signed out when the share arrives
  await tick();
  shares.push({ kind: 'note', text: 'From Safari' });
  f.fire('App.appStateChange', { isActive: true });
  await tick();
  assert.equal(b.captured.length, 0, 'signed out: kept for later');
  b.setUser('u1');
  await tick();
  assert.deepEqual(b.captured, [{ kind: 'note', text: 'From Safari' }]);
  assert.deepEqual(links, ['noteapp://w/ws/p/new-page']);
  shares.push({ kind: 'task', text: 'Buy milk' });
  f.fire('Native.shareReceived', {});
  await tick();
  assert.equal(b.captured.length, 2);
  assert.equal(links.at(-1), 'noteapp://w/ws/tasks/today');
});

test('mobile: Today widget snapshot — my due tasks, overdue first, capped, with deep links', () => {
  const today = '2026-11-05';
  const tasks = [
    task({ id: 'b', title: 'Later today', dueDate: today, dueTime: '15:00', priority: 2 }),
    task({ id: 'a', title: 'Overdue', dueDate: '2026-11-03' }),
    task({ id: 'c', title: 'Morning', dueDate: today, dueTime: '09:00', priority: 4 }),
    task({ id: 'd', title: 'Not mine', dueDate: today, assigneeId: 'sam' }),
    task({ id: 'e', title: 'Tomorrow', dueDate: '2026-11-06' }),
  ];
  const snap = widgetSnapshot(tasks, 'me', 'ws 1', today);
  assert.equal(snap.total, 3);
  assert.deepEqual(snap.items.map((i) => i.id), ['a', 'c', 'b']);
  assert.equal(snap.items[0].overdue, true);
  assert.equal(snap.items[1].time, '09:00');
  assert.equal(snap.path, '/w/ws%201/tasks/today');
  assert.equal(snap.items[0].path, '/w/ws%201/tasks/today?task=a');
  assert.equal(widgetSnapshot(tasks, 'me', 'ws', today, 2).items.length, 2);
  assert.equal(widgetSnapshot(tasks, 'me', 'ws', today, 2).total, 3, 'total counts everything');
  assert.deepEqual(widgetSnapshot(tasks, null, null, today), { v: 1, date: today, signedIn: false, locked: false, path: null, total: 0, items: [] });
  const locked = widgetSnapshot(tasks, 'me', 'ws', today, 8, true);
  assert.equal(locked.total, 3);
  assert.deepEqual(locked.items, [], 'app lock on: no task titles on the home screen');
});

/** Just enough DOM for the lock cover: elements with style, children and click listeners. */
function installFakeDom() {
  class El {
    style: Record<string, string> & { cssText?: string } = {};
    children: El[] = [];
    listeners: Record<string, (() => void)[]> = {};
    className = '';
    textContent = '';
    constructor(public tag: string) {}
    setAttribute() {}
    append(...els: El[]) {
      this.children.push(...els);
    }
    appendChild(el: El) {
      this.children.push(el);
    }
    get lastElementChild(): El | null {
      return this.children.at(-1) ?? null;
    }
    addEventListener(type: string, fn: () => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    click() {
      this.listeners.click?.forEach((f) => f());
    }
  }
  const body = new El('body');
  (globalThis as Record<string, unknown>).document = { body, createElement: (t: string) => new El(t) };
  return {
    body,
    cover: () => body.children[0] as El | undefined,
    visible: () => {
      const c = body.children[0];
      return !!c && c.style.display !== 'none';
    },
    remove: () => delete (globalThis as Record<string, unknown>).document,
  };
}

test('mobile: lock cover is really removed after unlocking; password fallback when biometrics are gone', async () => {
  const dom = installFakeDom();
  try {
    let auth: 'ok' | 'cancel' | 'gone' = 'ok';
    const native = {
      os: 'ios',
      BiometricAuth: {
        checkBiometry: async () => ({ isAvailable: true, biometryType: 2, deviceIsSecure: true }),
        authenticate: async () => {
          if (auth === 'cancel') throw Object.assign(new Error('cancel'), { code: 'userCancel' });
          if (auth === 'gone') throw Object.assign(new Error('gone'), { code: 'passcodeNotSet' });
        },
      },
    } as unknown as NativePlugins;
    const kv = memoryKv();
    kv.set('noteapp.appLock', '1');
    let clock = 0;
    let signedOut = 0;
    const lock = createAppLock(native, kv, () => clock, async () => void signedOut++);

    lock.start();
    assert.equal(dom.visible(), true, 'covered on launch');
    await tick();
    assert.equal(lock.locked(), false);
    assert.equal(dom.visible(), false, 'cover gone after Face ID');

    lock.background();
    assert.equal(dom.visible(), true, 'privacy cover in the app switcher');
    clock += 1000;
    lock.foreground();
    assert.equal(dom.visible(), false, 'quick switch: cover removed without a prompt');

    lock.background();
    clock += 120_000;
    auth = 'cancel';
    lock.foreground();
    await tick();
    assert.equal(dom.visible(), true);
    const actions = dom.cover()!.lastElementChild!;
    assert.equal(actions.style.visibility, 'visible', 'Unlock and password buttons offered after cancelling');
    auth = 'ok';
    (actions as unknown as { children: { click(): void }[] }).children[0].click(); // Unlock
    await tick();
    assert.equal(dom.visible(), false);

    // Face ID and passcode removed: falls back to signing in with the password.
    lock.background();
    clock += 120_000;
    auth = 'gone';
    lock.foreground();
    await tick();
    assert.equal(signedOut, 1);
    assert.equal(dom.visible(), false);
    assert.equal(lock.api.enabled(), false, 'lock turned off so the password sign-in works');
  } finally {
    dom.remove();
  }
});

test('mobile: shares wait while locked and never go to a different account', async () => {
  const dom = installFakeDom();
  try {
    ls.set('noteapp.appLock', '1');
    const shares: SharedItem[] = [];
    const f = fakes({ shares });
    let finishFaceId: () => void = () => {};
    (f.native as unknown as Record<string, unknown>).BiometricAuth = {
      checkBiometry: async () => ({ isAvailable: true, biometryType: 2, deviceIsSecure: true }),
      authenticate: () => new Promise<void>((r) => (finishFaceId = r)), // prompt stays open until we finish it
    };
    const b = fakeBridge();
    const p = createCapacitorPlatform(f.native, async () => b.bridge);
    await p.init();
    await tick();
    b.setUser('alice');
    await tick();
    shares.push({ kind: 'note', text: 'for alice' });
    f.fire('Native.shareReceived', {});
    await tick();
    assert.equal(b.captured.length, 0, 'nothing is saved behind the lock screen');
    finishFaceId();
    await tick();
    await tick();
    assert.deepEqual(b.captured.map((i) => i.text), ['for alice'], 'saved once unlocked');

    // A share arrives for alice, but she signs out and mallory signs in before it's saved.
    ls.delete('noteapp.appLock');
    shares.push({ kind: 'task', text: 'alice private' });
    b.setUser(null);
    await tick();
    f.fire('App.appStateChange', { isActive: true });
    await tick();
    b.setUser('mallory');
    await tick();
    assert.deepEqual(b.captured.map((i) => i.text), ['for alice'], 'not handed to another account');
  } finally {
    dom.remove();
    ls.clear();
  }
});

test('mobile: cold start with biometrics unavailable — stays covered until sign-out finishes, then lock off', async () => {
  const dom = installFakeDom();
  try {
    ls.set('noteapp.appLock', '1');
    const f = fakes();
    (f.native as unknown as Record<string, unknown>).BiometricAuth = {
      checkBiometry: async () => ({ isAvailable: false, biometryType: 0, deviceIsSecure: false }),
      authenticate: async () => {
        throw Object.assign(new Error('no passcode'), { code: 'passcodeNotSet' });
      },
    };
    // The app bridge (store) is slow to load: the fallback must wait for it, not skip the sign-out.
    let releaseBridge: () => void = () => {};
    const b = fakeBridge();
    let signedOut = false;
    let signOutDone: () => void = () => {};
    b.bridge.signOut = () =>
      new Promise<void>((r) => {
        signedOut = true;
        signOutDone = r;
      });
    const p = createCapacitorPlatform(f.native, () => new Promise<AppBridge>((r) => (releaseBridge = () => r(b.bridge))));
    await p.init();
    await tick();
    assert.equal(dom.visible(), true, 'covered while the bridge is still loading');
    assert.equal(signedOut, false);
    assert.equal(ls.get('noteapp.appLock'), '1', 'lock not turned off before signing out');

    releaseBridge();
    await tick();
    assert.equal(signedOut, true, 'signs out once the bridge is ready');
    assert.equal(dom.visible(), true, 'still covered while signing out');
    assert.equal(ls.get('noteapp.appLock'), '1');

    signOutDone();
    await tick();
    await tick();
    assert.equal(dom.visible(), false, 'cover removed only after the sign-out finished');
    assert.equal(ls.get('noteapp.appLock'), undefined, 'then the lock is off');
  } finally {
    dom.remove();
    ls.clear();
  }
});

test('mobile: a failed fallback sign-out keeps the app covered', async () => {
  const dom = installFakeDom();
  try {
    const kv = memoryKv();
    kv.set('noteapp.appLock', '1');
    const native = {
      os: 'ios',
      BiometricAuth: {
        checkBiometry: async () => ({ isAvailable: false, biometryType: 0, deviceIsSecure: false }),
        authenticate: async () => {
          throw Object.assign(new Error('x'), { code: 'biometryNotAvailable' });
        },
      },
    } as unknown as NativePlugins;
    const lock = createAppLock(native, kv, () => 0, async () => {
      throw new Error('offline');
    });
    lock.start();
    await tick();
    await lock.settled();
    assert.equal(dom.visible(), true);
    assert.equal(lock.locked(), true);
    assert.equal(kv.get('noteapp.appLock'), '1');
  } finally {
    dom.remove();
  }
});
