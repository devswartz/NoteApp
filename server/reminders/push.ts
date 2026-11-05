// Web push delivery (VAPID, the web-push library) and per-device subscriptions.
// Skipped when VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY aren't set.
import webpush from 'web-push';
import { db, newId, now } from '../db.ts';
import { HttpError } from '../access.ts';
import { TargetGoneError, type DeliveryChannel, type Notice } from './channels.ts';
import type { PushSubscriptionInput } from '../../shared/types.ts';

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PUBLIC_KEY : null;
}

let configured = '';
function configure() {
  const key = `${process.env.VAPID_PUBLIC_KEY}|${process.env.VAPID_SUBJECT}`;
  if (configured === key) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  configured = key;
}

// Only real push services: the server POSTs to the endpoint, so an arbitrary
// URL would let a user make it call internal hosts.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function saveSubscription(userId: string, sub: PushSubscriptionInput, userAgent?: string) {
  if (
    !sub ||
    typeof sub.endpoint !== 'string' ||
    !isPushEndpoint(sub.endpoint) ||
    sub.endpoint.length > 2000 ||
    typeof sub.keys?.p256dh !== 'string' ||
    typeof sub.keys?.auth !== 'string' ||
    sub.keys.p256dh.length > 200 ||
    sub.keys.auth.length > 200
  )
    throw new HttpError(400, 'Invalid push subscription');
  // An endpoint belongs to one browser; if another user signs in there, it moves to them.
  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (@id, @userId, @endpoint, @p256dh, @auth, @ua, @ts)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = @userId, p256dh = @p256dh, auth = @auth, user_agent = @ua`,
  ).run({ id: newId(), userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, ua: userAgent?.slice(0, 300) ?? null, ts: now() });
}

export function deleteSubscription(userId: string, endpoint: string) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

export function countSubscriptions(userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }).n;
}

/** The JSON the service worker (public/sw-push.js) receives. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
  taskId?: string;
}

export function webPushChannel(send: typeof webpush.sendNotification = webpush.sendNotification): DeliveryChannel {
  return {
    name: 'push',
    available: () => vapidPublicKey() !== null,
    targets: (userId) =>
      (db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').all(userId) as { endpoint: string }[]).map((r) => r.endpoint),
    async send(endpoint, n: Notice) {
      const row = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as SubRow | undefined;
      if (!row) throw new TargetGoneError('Subscription removed');
      configure();
      const payload: PushPayload = { title: n.title, body: n.body, url: n.path, tag: n.tag, taskId: n.taskId };
      try {
        await send({ endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(payload), { TTL: 12 * 3600, urgency: 'high' });
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) throw new TargetGoneError(`Push endpoint gone (${status})`);
        throw e;
      }
      db.prepare('UPDATE push_subscriptions SET last_success_at = ? WHERE endpoint = ?').run(now(), endpoint);
    },
    forget(endpoint) {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    },
  };
}
