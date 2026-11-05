// The service-worker push handler (public/sw-push.js), run against a fake worker scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Objects created inside the vm context have another realm's prototypes.
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

function load() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const windows: { url: string; focused: boolean; messages: unknown[]; navigated?: string; focus(): Promise<void>; postMessage(m: unknown): void; navigate(u: string): Promise<void> }[] = [];
  const self = {
    location: { origin: 'https://notes.example.com' },
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  vm.runInNewContext(fs.readFileSync('public/sw-push.js', 'utf8'), { self, URL });
  const fire = async (type: string, e: Record<string, unknown>) => {
    let p: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...e, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  const addWindow = (url: string, focused = false) => {
    const w = {
      url,
      focused,
      messages: [] as unknown[],
      navigated: undefined as string | undefined,
      focus: async () => {},
      postMessage(m: unknown) {
        this.messages.push(m);
      },
      async navigate(u: string) {
        this.navigated = u;
      },
    };
    windows.push(w);
    return w;
  };
  return { fire, shown, opened, addWindow };
}

test('push shows a notification with an Open task action', async () => {
  const sw = load();
  const payload = { title: 'Call the bank', body: 'Due 2031-01-15 at 10:00', url: '/w/1/tasks/today?task=t1', tag: 'task-t1', taskId: 't1' };
  await sw.fire('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'Call the bank');
  assert.equal(sw.shown[0].options.body, 'Due 2031-01-15 at 10:00');
  assert.equal(sw.shown[0].options.tag, 'task-t1');
  assert.deepEqual(plain(sw.shown[0].options.data), { url: '/w/1/tasks/today?task=t1', taskId: 't1' });
  assert.equal((sw.shown[0].options.actions as { action: string }[])[0].action, 'open');
});

test('click focuses and navigates an open window, or opens one', async () => {
  const sw = load();
  const close = () => {};
  const notification = { close, data: { url: '/w/1/tasks/today?task=t1', taskId: 't1' } };
  await sw.fire('notificationclick', { notification, action: 'open' });
  assert.deepEqual(sw.opened, ['https://notes.example.com/w/1/tasks/today?task=t1']);
  const w = sw.addWindow('https://notes.example.com/w/1/notes');
  await sw.fire('notificationclick', { notification });
  assert.equal(w.navigated, 'https://notes.example.com/w/1/tasks/today?task=t1');
  assert.deepEqual(plain(w.messages[0]), { type: 'notification-click', url: '/w/1/tasks/today?task=t1', taskId: 't1' });
  assert.equal(sw.opened.length, 1);
});

test('push with a non-JSON payload still shows something', async () => {
  const sw = load();
  await sw.fire('push', { data: { json: () => JSON.parse('nope'), text: () => 'hello' } });
  assert.equal(sw.shown[0].title, 'Reminder');
  assert.equal(sw.shown[0].options.body, 'hello');
});
