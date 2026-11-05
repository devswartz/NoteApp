// Reminders: settings, reminder CRUD, scheduler timing with a fake clock,
// catch-up after restart, idempotent delivery, push/email channels, digest.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import type { Notice, DeliveryChannel } from '../server/reminders/channels.ts';
import type { Reminder, Task } from '../shared/types.ts';

let app: TestApp;
let sched: typeof import('../server/reminders/scheduler.ts');
let deliverMod: typeof import('../server/reminders/deliver.ts');
let push: typeof import('../server/reminders/push.ts');
let email: typeof import('../server/reminders/email.ts');
let mail: typeof import('../server/mail.ts');
let store: typeof import('../server/reminders/store.ts');

before(async () => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.SMTP_HOST;
  app = await startTestApp();
  sched = await import('../server/reminders/scheduler.ts');
  deliverMod = await import('../server/reminders/deliver.ts');
  push = await import('../server/reminders/push.ts');
  email = await import('../server/reminders/email.ts');
  mail = await import('../server/mail.ts');
  store = await import('../server/reminders/store.ts');
});
after(() => app.close());

/** A channel that records what it sends. */
function fakeChannel(name = 'fake') {
  const sent: { target: string; notice: Notice }[] = [];
  const ch: DeliveryChannel = {
    name,
    available: () => true,
    targets: (userId) => [`${name}:${userId}`],
    async send(target, notice) {
      sent.push({ target, notice });
    },
  };
  return { ch, sent };
}

class Clock {
  constructor(public t: number) {}
  set(iso: string) {
    this.t = Date.parse(iso);
  }
  now = () => this.t;
}

async function setup(name: string, tz = 'Europe/London'): Promise<TestUser> {
  const u = await app.signUp(name);
  const r = await app.call('PATCH', '/notifications/settings', u.token, { timeZone: tz });
  assert.equal(r.status, 200);
  return u;
}

async function task(u: TestUser, body: Partial<Task>): Promise<Task> {
  const r = await app.call<Task>('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'T', ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

async function remind(u: TestUser, taskId: string, spec: object): Promise<Reminder> {
  const r = await app.call<Reminder>('POST', `/tasks/${taskId}/reminders`, u.token, spec);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

test('notification settings: defaults, update, validation', async () => {
  const u = await app.signUp('Settings');
  const r = await app.call('GET', '/notifications/settings', u.token);
  assert.deepEqual(r.data, { timeZone: 'UTC', emailEnabled: true, defaultReminderTime: '09:00', digestEnabled: false, digestTime: '08:00' });
  const p = await app.call('PATCH', '/notifications/settings', u.token, { timeZone: 'America/New_York', digestEnabled: true, digestTime: '07:30' });
  assert.equal(p.data.timeZone, 'America/New_York');
  assert.equal(p.data.digestTime, '07:30');
  assert.equal((await app.call('PATCH', '/notifications/settings', u.token, { timeZone: 'Mars/Base' })).status, 400);
  assert.equal((await app.call('PATCH', '/notifications/settings', u.token, { digestTime: '25:00' })).status, 400);
  const push = await app.call('GET', '/notifications/push', u.token);
  assert.deepEqual(push.data, { publicKey: null, emailAvailable: false, devices: 0 });
});

test('reminder CRUD computes next_fire_at in the user time zone', async () => {
  const u = await setup('Crud');
  const t = await task(u, { dueDate: '2030-07-10', dueTime: '09:00' });
  const r = await remind(u, t.id, { kind: 'before', minutes: 60 });
  assert.equal(r.nextFireAt, '2030-07-10T07:00:00.000Z'); // 08:00 BST
  // No due time → default reminder time (09:00 local).
  const t2 = await task(u, { dueDate: '2030-12-10' });
  const r2 = await remind(u, t2.id, { kind: 'before', minutes: 0 });
  assert.equal(r2.nextFireAt, '2030-12-10T09:00:00.000Z'); // GMT in winter
  // Moving the due date moves the reminder.
  await app.call('PATCH', `/tasks/${t.id}`, u.token, { dueDate: '2030-07-11' });
  const list = await app.call<Reminder[]>('GET', `/tasks/${t.id}/reminders`, u.token);
  assert.equal(list.data[0].nextFireAt, '2030-07-11T07:00:00.000Z');
  // Update and delete; validation; other users can't see it.
  const upd = await app.call<Reminder>('PATCH', `/reminders/${r.id}`, u.token, { kind: 'at', at: '2030-07-01T12:00:00Z' });
  assert.equal(upd.data.nextFireAt, '2030-07-01T12:00:00.000Z');
  assert.equal((await app.call('POST', `/tasks/${t.id}/reminders`, u.token, { kind: 'before', minutes: -5 })).status, 400);
  assert.equal((await app.call('POST', `/tasks/${t.id}/reminders`, u.token, { kind: 'at', at: 'nope' })).status, 400);
  const other = await app.signUp('Other');
  assert.equal((await app.call('GET', `/tasks/${t.id}/reminders`, other.token)).status, 404);
  assert.equal((await app.call('DELETE', `/reminders/${r.id}`, other.token)).status, 404);
  assert.equal((await app.call('DELETE', `/reminders/${r.id}`, u.token)).status, 200);
  assert.equal((await app.call<Reminder[]>('GET', `/tasks/${t.id}/reminders`, u.token)).data.length, 0);
});

test('scheduler fires on time, once, with a fake clock', async () => {
  const u = await setup('Timing', 'UTC');
  const t = await task(u, { title: 'Call the bank', dueDate: '2031-01-15', dueTime: '10:00' });
  await remind(u, t.id, { kind: 'before', minutes: 30 });
  const clock = new Clock(Date.parse('2031-01-15T09:29:00Z'));
  const { ch, sent } = fakeChannel();
  const s = new sched.ReminderScheduler({ now: clock.now, channels: [ch] });
  const mine = () => sent.filter((x) => x.notice.taskId === t.id);

  await s.tick();
  assert.equal(mine().length, 0, 'not yet');
  clock.set('2031-01-15T09:30:05Z');
  await Promise.all([s.tick(), s.tick()]); // overlapping ticks share one pass
  assert.equal(mine().length, 1);
  assert.equal(mine()[0].notice.title, 'Call the bank');
  assert.equal(mine()[0].notice.body, 'Due 2031-01-15 at 10:00');
  assert.match(mine()[0].notice.path, new RegExp(`/w/${u.wsId}/tasks/today\\?task=${t.id}`));
  clock.set('2031-01-15T09:31:00Z');
  await s.tick();
  assert.equal(mine().length, 1, 'no repeat');
  // A completed task doesn't fire.
  const t2 = await task(u, { dueDate: '2031-01-15', dueTime: '11:00' });
  await remind(u, t2.id, { kind: 'before', minutes: 0 });
  await app.call('PATCH', `/tasks/${t2.id}`, u.token, { status: 'done' });
  clock.set('2031-01-15T11:01:00Z');
  await s.tick();
  assert.equal(sent.filter((x) => x.notice.taskId === t2.id).length, 0);
});

test('catch-up after restart: missed within 12 h fire once, older are dropped', async () => {
  const u = await setup('Restart', 'UTC');
  const recent = await task(u, { dueDate: '2032-03-01', dueTime: '06:00' });
  const stale = await task(u, { dueDate: '2032-02-29', dueTime: '12:00' });
  await remind(u, recent.id, { kind: 'before', minutes: 0 });
  await remind(u, stale.id, { kind: 'before', minutes: 0 });
  const { ch, sent } = fakeChannel();
  // Server was down from before both until 2032-03-01 11:00 (recent: 5 h ago, stale: 23 h ago).
  const clock = new Clock(Date.parse('2032-03-01T11:00:00Z'));
  const first = new sched.ReminderScheduler({ now: clock.now, channels: [ch] });
  const report = await first.tick();
  assert.equal(sent.filter((x) => x.notice.taskId === recent.id).length, 1);
  assert.equal(sent.filter((x) => x.notice.taskId === stale.id).length, 0);
  assert.ok(report.missed >= 1);
  // Another restart: nothing is sent again.
  const second = new sched.ReminderScheduler({ now: clock.now, channels: [ch] });
  await second.tick();
  assert.equal(sent.filter((x) => x.notice.taskId === recent.id).length, 1);
});

test('crash between claiming and sending never double-sends (idempotent log)', async () => {
  const u = await setup('Idem', 'UTC');
  const { ch, sent } = fakeChannel();
  const notice: Notice = { key: `reminder:x:${u.user.id}`, userId: u.user.id, title: 'x', body: 'y', path: '/' };
  const a = await deliverMod.deliver(notice, [ch]);
  const b = await deliverMod.deliver(notice, [ch]);
  assert.deepEqual([a.sent, b.sent, b.skipped], [1, 0, 1]);
  assert.equal(sent.length, 1);
  // Reset the reminder's next_fire_at to an already-delivered firing (as if the claim
  // update was lost in a crash): the log still prevents a resend.
  const t = await task(u, { dueDate: '2033-05-05', dueTime: '08:00' });
  const r = await remind(u, t.id, { kind: 'before', minutes: 0 });
  const clock = new Clock(Date.parse('2033-05-05T08:00:30Z'));
  const s = new sched.ReminderScheduler({ now: clock.now, channels: [ch] });
  await s.tick();
  const { db } = await import('../server/db.ts');
  db.prepare('UPDATE task_reminders SET next_fire_at = ?, last_fired_at = NULL WHERE id = ?').run(r.nextFireAt, r.id);
  await new sched.ReminderScheduler({ now: clock.now, channels: [ch] }).tick();
  assert.equal(sent.filter((x) => x.notice.taskId === t.id).length, 1);
});

test('recurring task: completing rolls forward and the reminder fires for the next occurrence', async () => {
  const u = await setup('Recurring', 'UTC');
  const t = await task(u, { dueDate: '2034-01-10', dueTime: '09:00', recurrence: { freq: 'day', interval: 1 } });
  await remind(u, t.id, { kind: 'before', minutes: 15 });
  const { ch, sent } = fakeChannel();
  const clock = new Clock(Date.parse('2034-01-10T08:45:01Z'));
  const s = new sched.ReminderScheduler({ now: clock.now, channels: [ch] });
  await s.tick();
  assert.equal(sent.filter((x) => x.notice.taskId === t.id).length, 1);
  const done = await app.call<Task>('PATCH', `/tasks/${t.id}`, u.token, { status: 'done' });
  assert.equal(done.data.dueDate, '2034-01-11');
  const list = await app.call<Reminder[]>('GET', `/tasks/${t.id}/reminders`, u.token);
  assert.equal(list.data[0].nextFireAt, '2034-01-11T08:45:00.000Z');
  clock.set('2034-01-11T08:46:00Z');
  await s.tick();
  assert.equal(sent.filter((x) => x.notice.taskId === t.id).length, 2);
});

test('legacy tasks.reminder_at is mirrored for the assignee/creator', async () => {
  const u = await setup('Legacy', 'UTC');
  const t = await task(u, { reminderAt: '2035-02-02T10:00:00.000Z' });
  const { ch, sent } = fakeChannel();
  const clock = new Clock(Date.parse('2035-02-02T10:00:10Z'));
  await new sched.ReminderScheduler({ now: clock.now, channels: [ch] }).tick();
  const mine = sent.filter((x) => x.notice.taskId === t.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].notice.userId, u.user.id);
  assert.equal(mine[0].notice.body, 'Reminder');
});

test('web push: subscriptions per device, payload, expired endpoints removed, skipped without VAPID', async () => {
  const u = await setup('Push', 'UTC');
  const sub = (n: number) => ({ endpoint: `https://push.example.com/send/${u.user.id}/${n}`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });
  assert.equal((await app.call('POST', '/notifications/push-subscriptions', u.token, sub(1))).status, 200);
  assert.equal((await app.call('POST', '/notifications/push-subscriptions', u.token, sub(2))).status, 200);
  assert.equal((await app.call('POST', '/notifications/push-subscriptions', u.token, sub(1))).status, 200); // same device again
  assert.equal((await app.call('POST', '/notifications/push-subscriptions', u.token, { endpoint: 'http://x' })).status, 400);
  assert.equal((await app.call('GET', '/notifications/push', u.token)).data.devices, 2);

  const calls: { endpoint: string; payload: string }[] = [];
  const channel = push.webPushChannel((async (s: { endpoint: string }, payload: string) => {
    calls.push({ endpoint: s.endpoint, payload });
    if (s.endpoint.endsWith('/2')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    return {};
  }) as never);
  assert.equal(channel.available(), false, 'no VAPID keys → skipped');
  process.env.VAPID_PUBLIC_KEY = 'BDd3_hVL9fZi9Ybo2UUzA284WG5FZR30_95YeZJsiApwXKpNcF1rRPF3foIiBHXRdJI2Qhumhf6_LFTeZaNndIo';
  process.env.VAPID_PRIVATE_KEY = 'xKZKYRNdFFn8iQIF2MH54KTfUHwH105zBdzMR7SI3xI';
  try {
    assert.equal(channel.available(), true);
    const r = await deliverMod.deliver({ key: `push-test:${u.user.id}`, userId: u.user.id, title: 'Hi', body: 'There', path: '/w/x', taskId: 't1' }, [channel]);
    assert.deepEqual([r.sent, r.failed], [1, 1]);
    assert.deepEqual(JSON.parse(calls[0].payload), { title: 'Hi', body: 'There', url: '/w/x', taskId: 't1' });
    assert.equal((await app.call('GET', '/notifications/push', u.token)).data.devices, 1, 'gone endpoint deleted');
  } finally {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  }
  await app.call('DELETE', '/notifications/push-subscriptions', u.token, { endpoint: sub(1).endpoint });
  assert.equal((await app.call('GET', '/notifications/push', u.token)).data.devices, 0);
});

test('email channel and daily digest', async () => {
  const u = await setup('Digest', 'Europe/London');
  await app.call('PATCH', '/notifications/settings', u.token, { digestEnabled: true, digestTime: '07:30' });
  // Start from an empty task list (sign-up seeds onboarding tasks).
  for (const t of (await app.call<Task[]>('GET', `/workspaces/${u.wsId}/tasks`, u.token)).data)
    await app.call('DELETE', `/tasks/${t.id}`, u.token);
  await task(u, { title: 'Overdue thing', dueDate: '2036-06-01' });
  await task(u, { title: 'Today <thing>', dueDate: '2036-06-03', dueTime: '14:00' });
  await task(u, { title: 'Tomorrow thing', dueDate: '2036-06-04' });
  const mails: { to: string; subject: string; text: string; html?: string }[] = [];
  mail.setMailSinkForTests((m) => mails.push(m));
  try {
    assert.equal(email.emailChannel().available(), false, 'no SMTP → skipped');
    const channels = [email.emailChannel({ force: true })];
    const clock = new Clock(Date.parse('2036-06-03T06:00:00Z')); // 07:00 BST: too early
    const s = new sched.ReminderScheduler({ now: clock.now, channels });
    await s.tick();
    assert.equal(mails.filter((m) => m.to === u.user.email).length, 0);
    clock.set('2036-06-03T06:31:00Z');
    await s.tick();
    await s.tick();
    const mine = mails.filter((m) => m.to === u.user.email);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].subject, 'Today: 2 tasks (1 overdue)');
    assert.match(mine[0].text, /Overdue thing \(overdue, 2036-06-01\)/);
    assert.match(mine[0].text, /Today <thing> \(14:00\)/);
    assert.doesNotMatch(mine[0].text, /Tomorrow/);
    assert.match(mine[0].html!, /Today &lt;thing&gt;/);
    // Email off → nothing.
    await app.call('PATCH', '/notifications/settings', u.token, { emailEnabled: false });
    clock.set('2036-06-04T06:31:00Z');
    await s.tick();
    assert.equal(mails.filter((m) => m.to === u.user.email).length, 1);
  } finally {
    mail.setMailSinkForTests(null);
  }
});

test('default channels skip gracefully when nothing is configured', async () => {
  const chans = sched.defaultChannels();
  assert.deepEqual(chans.map((c) => [c.name, c.available()]), [['push', false], ['email', false]]);
  const u = await setup('NoConfig', 'UTC');
  const r = await app.call('POST', '/notifications/test', u.token);
  assert.deepEqual(r.data, { sent: 0, failed: 0, skipped: 2 });
  void store;
});
