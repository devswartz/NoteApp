// Apple Push Notification service channel (Phase 3 iOS app). Token-based auth
// (.p8 key). Enabled only when all of these are set:
//   APNS_KEY_ID       key id of the .p8 key (10 chars)
//   APNS_TEAM_ID      Apple developer team id
//   APNS_BUNDLE_ID    the iOS app's bundle id (the apns-topic)
//   APNS_PRIVATE_KEY  contents of the .p8 file (newlines may be written as \n)
//   APNS_ENV          'production' (default) or 'sandbox' (development builds)
import http2 from 'node:http2';
import jwt from 'jsonwebtoken';
import { TargetGoneError, type DeliveryChannel, type Notice } from './channels.ts';
import { deviceTokens, forgetDeviceToken, markDeviceSuccess, pem } from './devices.ts';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKey: string;
  host: string;
}

export function apnsConfig(): ApnsConfig | null {
  const { APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRIVATE_KEY, APNS_ENV } = process.env;
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID || !APNS_PRIVATE_KEY) return null;
  return {
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    bundleId: APNS_BUNDLE_ID,
    privateKey: pem(APNS_PRIVATE_KEY),
    host: APNS_ENV === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com',
  };
}

export interface ApnsRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
export type ApnsSender = (req: ApnsRequest) => Promise<{ status: number; body: string }>;

/** One HTTP/2 request to APNs. */
export const http2Send: ApnsSender = (req) =>
  new Promise((resolve, reject) => {
    const client = http2.connect(`https://${req.host}`);
    client.on('error', reject);
    const stream = client.request({ ':method': 'POST', ':path': req.path, ...req.headers });
    let status = 0;
    let body = '';
    stream.setEncoding('utf8');
    stream.on('response', (h) => (status = Number(h[':status'])));
    stream.on('data', (c) => (body += c));
    stream.on('end', () => {
      client.close();
      resolve({ status, body });
    });
    stream.on('error', (e) => {
      client.close();
      reject(e);
    });
    stream.setTimeout(15_000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
    stream.end(req.body);
  });

/** The APNs payload; the app reads url/taskId/snoozeToken. Category REMINDER carries the snooze actions. */
export function apnsPayload(n: Notice) {
  return {
    aps: { alert: { title: n.title, body: n.body }, sound: 'default', 'thread-id': n.tag, category: n.snoozeToken ? 'REMINDER' : undefined },
    url: n.path,
    taskId: n.taskId,
    snoozeToken: n.snoozeToken,
  };
}

export function apnsChannel(send: ApnsSender = http2Send, config: () => ApnsConfig | null = apnsConfig): DeliveryChannel {
  let cached: { token: string; at: number; key: string } | null = null;
  const authToken = (c: ApnsConfig) => {
    // Apple wants the token refreshed at most every 20 min and at least every hour.
    const key = `${c.keyId}|${c.teamId}`;
    if (!cached || cached.key !== key || Date.now() - cached.at > 40 * 60_000) {
      cached = { key, at: Date.now(), token: jwt.sign({}, c.privateKey, { algorithm: 'ES256', keyid: c.keyId, issuer: c.teamId }) };
    }
    return cached.token;
  };
  return {
    name: 'apns',
    available: () => config() !== null,
    targets: (userId) => deviceTokens(userId, 'ios'),
    async send(token, n) {
      const c = config();
      if (!c) throw new Error('APNs not configured');
      const headers: Record<string, string> = {
        authorization: `bearer ${authToken(c)}`,
        'apns-topic': c.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 12 * 3600),
      };
      if (n.tag) headers['apns-collapse-id'] = n.tag.slice(0, 64);
      const res = await send({ host: c.host, path: `/3/device/${token}`, headers, body: JSON.stringify(apnsPayload(n)) });
      if (res.status === 200) return markDeviceSuccess(token);
      let reason = '';
      try {
        reason = JSON.parse(res.body).reason ?? '';
      } catch {
        /* empty body */
      }
      if (res.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic')
        throw new TargetGoneError(`APNs: ${reason || res.status}`);
      throw new Error(`APNs ${res.status} ${reason}`);
    },
    forget: forgetDeviceToken,
  };
}
