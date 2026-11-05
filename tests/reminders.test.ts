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
  const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${u.user.id}-${n}`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });
  assert.equal((await app.call('POST', '/notifications/push-subscriptions', u.token, sub(1))).status, 200);
  assert.equal((await app.call('POST', '/notifications/push-subscriptions', u.token, sub(2))).status, 200);
  assert.equal((await app.call('POST', '/notifications/push-subscriptions', u.token, sub(1))).status, 200); // same device again
  assert.equal((await app.call('POST', '/notifications/push-subscriptions', u.token, { endpoint: 'http://x' })).status, 400);
  // Not a push service (would let the server be used to call internal hosts).
  const internal = { ...sub(3), endpoint: 'https://192.168.1.10/admin' };
  assert.equal((await app.call('POST', '/notifications/push-subscriptions', u.token, internal)).status, 400);
  assert.ok(push.isPushEndpoint('https://web.push.apple.com/QGx'));
  assert.ok(!push.isPushEndpoint('https://fcm.googleapis.com.evil.com/x'));
  assert.ok(!push.isPushEndpoint('https://fcm.googleapis.com:8443/x'));
  assert.equal((await app.call('GET', '/notifications/push', u.token)).data.devices, 2);

  const calls: { endpoint: string; payload: string }[] = [];
  const channel = push.webPushChannel((async (s: { endpoint: string }, payload: string) => {
    calls.push({ endpoint: s.endpoint, payload });
    if (s.endpoint.endsWith('-2')) throw Object.assign(new Error('gone'), { statusCode: 410 });
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
  {
    assert.equal(email.emailChannel().available(), false, 'no SMTP → skipped');
    const channels = [
      email.emailChannel({
        force: true,
        send: async (m) => {
          mails.push(m);
          return { sent: true };
        },
      }),
    ];
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
  }
});

test('default channels skip gracefully when nothing is configured', async () => {
  const chans = sched.defaultChannels();
  assert.deepEqual(chans.map((c) => [c.name, c.available()]), [['push', false], ['email', false], ['apns', false], ['fcm', false]]);
  const u = await setup('NoConfig', 'UTC');
  const r = await app.call('POST', '/notifications/test', u.token);
  assert.deepEqual(r.data, { sent: 0, failed: 0, skipped: 4 });
  void store;
});

test('nextDueDate (for server/tasks.ts): user time zone and count from recorded occurrences', async () => {
  const { nextDueDate } = await import('../server/reminders/recurring.ts');
  const u = await setup('NextDue', 'America/Los_Angeles');
  const t = await task(u, { dueDate: '2026-11-05' });
  // 06:30 UTC on 6 Nov is still 5 Nov in Los Angeles.
  const at = Date.parse('2026-11-06T06:30:00Z');
  assert.equal(nextDueDate({ freq: 'day', interval: 1 }, '2026-11-05', t.id, u.user.id, at), '2026-11-06');
  assert.equal(nextDueDate({ freq: 'day', interval: 1, count: 1 }, '2026-11-05', t.id, u.user.id, at), null);
  assert.equal(nextDueDate({ freq: 'day', interval: 1, count: 2 }, '2026-11-05', t.id, u.user.id, at), '2026-11-06');
});

test('snooze from a push notification: token in the payload, +1 h / tomorrow, expiry, no auth needed', async () => {
  const u = await setup('Snooze', 'Europe/London');
  const t = await task(u, { title: 'Pay rent', dueDate: '2037-01-05', dueTime: '09:00' });
  await remind(u, t.id, { kind: 'before', minutes: 0 });
  const { ch, sent } = fakeChannel();
  const clock = new Clock(Date.parse('2037-01-05T09:00:05Z'));
  const s = new sched.ReminderScheduler({ now: clock.now, channels: [ch] });
  await s.tick();
  const n = sent.find((x) => x.notice.taskId === t.id)!.notice;
  assert.ok(n.snoozeToken && n.snoozeToken.length >= 30);

  const snoozeMod = await import('../server/reminders/snooze.ts');
  // Via HTTP without an access token.
  const bad = await app.call('POST', '/reminders/snooze', undefined, { token: 'nope', option: '1h' });
  assert.equal(bad.status, 404);
  assert.equal((await app.call('POST', '/reminders/snooze', undefined, { token: n.snoozeToken, option: '2h' })).status, 400);
  const ok = await app.call('POST', '/reminders/snooze', undefined, { token: n.snoozeToken, option: '1h' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.taskId, t.id);
  // Deterministic version with the fake clock: snooze 1 h from 09:00:05 → fires at 10:00:05, once.
  const r = snoozeMod.snooze(n.snoozeToken, '1h', clock.t);
  assert.equal(r.until, '2037-01-05T10:00:05.000Z');
  clock.set('2037-01-05T10:00:06Z');
  await s.tick();
  await s.tick();
  assert.equal(sent.filter((x) => x.notice.taskId === t.id).length, 2);
  // The snooze shows in the task's reminders.
  const list = await app.call<Reminder[]>('GET', `/tasks/${t.id}/reminders`, u.token);
  assert.equal(list.data.length, 2);
  // Tomorrow = default reminder time (09:00 local) the next day.
  assert.equal(snoozeMod.snoozeUntil('tomorrow', u.user.id, Date.parse('2037-07-05T22:30:00Z')).toISOString(), '2037-07-06T08:00:00.000Z');
  // Expired after 7 days.
  assert.throws(() => snoozeMod.snooze(n.snoozeToken, '10m', clock.t + 8 * 864e5), /expired/);
});

test('APNs and FCM channels (fakes): auth, payloads, dead tokens removed', async () => {
  const crypto = await import('node:crypto');
  const jwt = (await import('jsonwebtoken')).default;
  const { apnsChannel } = await import('../server/reminders/apns.ts');
  const { fcmChannel } = await import('../server/reminders/fcm.ts');
  const u = await setup('Native', 'UTC');
  const ios1 = 'a'.repeat(64), ios2 = 'b'.repeat(64), android = 'fcm-token:' + 'c'.repeat(40);
  for (const [platform, token] of [['ios', ios1], ['ios', ios2], ['android', android]])
    assert.equal((await app.call('POST', '/notifications/devices', u.token, { platform, token })).status, 200);
  assert.equal((await app.call('POST', '/notifications/devices', u.token, { platform: 'web', token: ios1 })).status, 400);
  const notice: Notice = { key: `native:${u.user.id}`, userId: u.user.id, title: 'Pay rent', body: 'Due today', path: '/w/1/tasks/today?task=t1', taskId: 't1', tag: 'task-t1', snoozeToken: 'snz' };

  // APNs
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const apnsCfg = { keyId: 'KEY1234567', teamId: 'TEAM123456', bundleId: 'com.example.noteapp', privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), host: 'api.sandbox.push.apple.com' };
  const reqs: { host: string; path: string; headers: Record<string, string>; body: string }[] = [];
  const apns = apnsChannel(async (req) => {
    reqs.push(req);
    return req.path.endsWith(ios2) ? { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) } : { status: 200, body: '' };
  }, () => apnsCfg);
  assert.equal(apnsChannel(undefined, () => null).available(), false);
  const ra = await deliverMod.deliver(notice, [apns]);
  assert.deepEqual([ra.sent, ra.failed], [1, 1]);
  const ok = reqs.find((r) => r.path === `/3/device/${ios1}`)!;
  assert.equal(ok.host, 'api.sandbox.push.apple.com');
  assert.equal(ok.headers['apns-topic'], 'com.example.noteapp');
  assert.equal(ok.headers['apns-push-type'], 'alert');
  const claims = jwt.verify(ok.headers.authorization.replace('bearer ', ''), ec.publicKey.export({ type: 'spki', format: 'pem' }).toString(), { algorithms: ['ES256'], complete: true }) as { header: { kid: string }; payload: { iss: string } };
  assert.equal(claims.header.kid, 'KEY1234567');
  assert.equal(claims.payload.iss, 'TEAM123456');
  const body = JSON.parse(ok.body);
  assert.deepEqual(body.aps.alert, { title: 'Pay rent', body: 'Due today' });
  assert.equal(body.aps.category, 'REMINDER');
  assert.equal(body.snoozeToken, 'snz');
  assert.equal(body.url, '/w/1/tasks/today?task=t1');
  assert.deepEqual(apns.targets(u.user.id), [ios1], 'unregistered token removed');

  // FCM
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fcmCfg = { projectId: 'noteapp-test', clientEmail: 'push@noteapp-test.iam.gserviceaccount.com', privateKey: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), tokenUri: 'https://oauth2.example/token' };
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (url === fcmCfg.tokenUri) return { status: 200, text: async () => JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }) };
    return { status: 200, text: async () => '{}' };
  };
  const fcm = fcmChannel(fakeFetch, () => fcmCfg);
  const rf = await deliverMod.deliver(notice, [fcm]);
  assert.equal(rf.sent, 1);
  const assertion = new URLSearchParams(calls[0].body).get('assertion')!;
  const a = jwt.verify(assertion, rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(), { algorithms: ['RS256'] }) as { iss: string; scope: string };
  assert.equal(a.iss, fcmCfg.clientEmail);
  assert.equal(a.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(calls[1].url, 'https://fcm.googleapis.com/v1/projects/noteapp-test/messages:send');
  assert.equal(calls[1].headers.authorization, 'Bearer ya29.fake');
  const msg = JSON.parse(calls[1].body).message;
  assert.equal(msg.token, android);
  assert.deepEqual(msg.data, { url: '/w/1/tasks/today?task=t1', taskId: 't1', snoozeToken: 'snz' });
  // Unregistered token → removed.
  const gone = fcmChannel(async (url, init) => (url === fcmCfg.tokenUri ? fakeFetch(url, init) : { status: 404, text: async () => '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' }), () => fcmCfg);
  const rg = await deliverMod.deliver({ ...notice, key: `native2:${u.user.id}` }, [gone]);
  assert.equal(rg.failed, 1);
  assert.deepEqual(gone.targets(u.user.id), []);
});

test('quiet hours: window math (wraps midnight, DST) and reminders held until the window ends', async () => {
  const { quietUntil } = await import('../server/reminders/quiet.ts');
  const at = (iso: string) => Date.parse(iso);
  const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());
  assert.equal(iso(quietUntil(at('2038-01-10T23:30:00Z'), 'UTC', '22:00', '07:00')), '2038-01-11T07:00:00.000Z');
  assert.equal(iso(quietUntil(at('2038-01-10T03:00:00Z'), 'UTC', '22:00', '07:00')), '2038-01-10T07:00:00.000Z');
  assert.equal(quietUntil(at('2038-01-10T12:00:00Z'), 'UTC', '22:00', '07:00'), null);
  assert.equal(iso(quietUntil(at('2038-01-10T12:30:00Z'), 'UTC', '12:00', '13:00')), '2038-01-10T13:00:00.000Z');
  assert.equal(quietUntil(at('2038-01-10T13:00:00Z'), 'UTC', '12:00', '13:00'), null);
  assert.equal(quietUntil(at('2038-01-10T13:00:00Z'), 'UTC', '09:00', '09:00'), null);
  // London, night of the spring-forward change (28→29 Mar 2038): ends 07:00 BST = 06:00Z.
  assert.equal(iso(quietUntil(at('2038-03-28T23:00:00Z'), 'Europe/London', '22:00', '07:00')), '2038-03-29T06:00:00.000Z');

  const u = await setup('Quiet', 'UTC');
  const other = await app.signUp('QuietOther');
  assert.equal((await app.call('PUT', `/workspaces/${u.wsId}/quiet-hours`, u.token, { start: '22:00', end: '07:00' })).status, 200);
  assert.equal((await app.call('PUT', `/workspaces/${u.wsId}/quiet-hours`, u.token, { start: '25:00', end: '07:00' })).status, 400);
  assert.equal((await app.call('PUT', `/workspaces/${u.wsId}/quiet-hours`, other.token, { start: '22:00', end: '07:00' })).status, 404); // not a member
  assert.deepEqual((await app.call('GET', '/notifications/quiet-hours', u.token)).data, [{ workspaceId: u.wsId, start: '22:00', end: '07:00' }]);

  const t = await task(u, { dueDate: '2038-02-01', dueTime: '23:00' });
  await remind(u, t.id, { kind: 'before', minutes: 0 });
  const { ch, sent } = fakeChannel();
  const clock = new Clock(at('2038-02-01T23:00:10Z'));
  const s = new sched.ReminderScheduler({ now: clock.now, channels: [ch] });
  const r1 = await s.tick();
  assert.equal(r1.deferred, 1);
  assert.equal(sent.filter((x) => x.notice.taskId === t.id).length, 0);
  clock.set('2038-02-02T06:59:00Z');
  await s.tick();
  assert.equal(sent.filter((x) => x.notice.taskId === t.id).length, 0);
  clock.set('2038-02-02T07:00:05Z');
  await s.tick();
  await s.tick();
  assert.equal(sent.filter((x) => x.notice.taskId === t.id).length, 1);
  assert.equal((await app.call('DELETE', `/workspaces/${u.wsId}/quiet-hours`, u.token)).status, 200);
  assert.deepEqual((await app.call('GET', '/notifications/quiet-hours', u.token)).data, []);
});

test('calendar feed: secret URL, events for my dated open tasks, RRULE, reset/disable', async () => {
  const { toRRule } = await import('../server/reminders/ics.ts');
  const u = await setup('Calendar', 'Europe/London');
  for (const t of (await app.call<Task[]>('GET', `/workspaces/${u.wsId}/tasks`, u.token)).data) await app.call('DELETE', `/tasks/${t.id}`, u.token);
  await task(u, { title: 'Dentist, 2nd floor; bring card', dueDate: '2026-12-01', dueTime: '14:30' });
  await task(u, { title: 'Pay rent', dueDate: '2026-12-01', recurrence: { freq: 'month', interval: 1, byMonthDay: 1 } });
  await task(u, { title: 'No date' });
  const done = await task(u, { title: 'Finished', dueDate: '2026-11-01' });
  await app.call('PATCH', `/tasks/${done.id}`, u.token, { status: 'done' });

  assert.deepEqual((await app.call('GET', '/calendar-feed', u.token)).data, { enabled: false });
  const created = await app.call<{ path: string }>('POST', '/calendar-feed', u.token);
  assert.match(created.data.path, /^\/calendar\/[\w-]{30,}\.ics$/);
  const res = await fetch(`${app.origin}/api${created.data.path}`); // no auth header
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/calendar/);
  const ics = await res.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Dentist\\, 2nd floor\; bring card\r\n/);
  assert.match(ics, /DTSTART;TZID=Europe\/London:20261201T143000\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202/);
  assert.match(ics, /RRULE:FREQ=MONTHLY;BYMONTHDAY=1\r\n/);
  assert.doesNotMatch(ics, /No date|Finished/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines folded');

  // Someone else's token / garbage → 404. Reset kills the old URL.
  assert.equal((await fetch(`${app.origin}/api/calendar/${'x'.repeat(32)}.ics`)).status, 404);
  const again = await app.call<{ path: string }>('POST', '/calendar-feed', u.token);
  assert.equal((await fetch(`${app.origin}/api${created.data.path}`)).status, 404);
  assert.equal((await fetch(`${app.origin}/api${again.data.path}`)).status, 200);
  await app.call('DELETE', '/calendar-feed', u.token);
  assert.equal((await fetch(`${app.origin}/api${again.data.path}`)).status, 404);

  assert.equal(toRRule({ freq: 'week', interval: 2, byWeekday: [4, 1] }), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,MO');
  assert.equal(toRRule({ freq: 'weekday' }), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(toRRule({ freq: 'month', interval: 1, byNthWeekday: { n: -1, weekday: 5 } }), 'FREQ=MONTHLY;BYDAY=-1FR');
  assert.equal(toRRule({ freq: 'day', interval: 1, count: 5 }, 2), 'FREQ=DAILY;COUNT=3');
  assert.equal(toRRule({ freq: 'day', interval: 1, until: '2027-01-31' }), 'FREQ=DAILY;UNTIL=20270131');
  assert.equal(toRRule({ freq: 'day', interval: 3, basis: 'completion' }), null);
});
