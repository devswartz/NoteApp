// Firebase Cloud Messaging channel (Phase 3 Android app), HTTP v1 API.
// Enabled only when FCM_SERVICE_ACCOUNT_JSON is set: the Firebase service
// account key JSON (raw, or base64-encoded), with project_id, client_email
// and private_key.
import jwt from 'jsonwebtoken';
import { TargetGoneError, type DeliveryChannel, type Notice } from './channels.ts';
import { deviceTokens, forgetDeviceToken, markDeviceSuccess, pem } from './devices.ts';

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export function fcmConfig(): FcmConfig | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(text) as { project_id?: string; client_email?: string; private_key?: string; token_uri?: string };
    if (!j.project_id || !j.client_email || !j.private_key) return null;
    return { projectId: j.project_id, clientEmail: j.client_email, privateKey: pem(j.private_key), tokenUri: j.token_uri || 'https://oauth2.googleapis.com/token' };
  } catch {
    return null;
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;

/** FCM data values must be strings. */
export function fcmMessage(token: string, n: Notice) {
  const data: Record<string, string> = { url: n.path };
  if (n.taskId) data.taskId = n.taskId;
  if (n.snoozeToken) data.snoozeToken = n.snoozeToken;
  return {
    message: {
      token,
      notification: { title: n.title, body: n.body },
      data,
      android: { priority: 'high', ttl: '43200s', notification: { tag: n.tag, click_action: n.snoozeToken ? 'REMINDER' : undefined } },
    },
  };
}

export function fcmChannel(doFetch: Fetch = fetch as unknown as Fetch, config: () => FcmConfig | null = fcmConfig): DeliveryChannel {
  let access: { token: string; expires: number; key: string } | null = null;
  const accessToken = async (c: FcmConfig) => {
    if (access && access.key === c.clientEmail && access.expires > Date.now() + 60_000) return access.token;
    const iat = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { iss: c.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: c.tokenUri, iat, exp: iat + 3600 },
      c.privateKey,
      { algorithm: 'RS256' },
    );
    const res = await doFetch(c.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const body = JSON.parse(await res.text()) as { access_token?: string; expires_in?: number };
    if (res.status !== 200 || !body.access_token) throw new Error(`FCM auth failed (${res.status})`);
    access = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000, key: c.clientEmail };
    return access.token;
  };
  return {
    name: 'fcm',
    available: () => config() !== null,
    targets: (userId) => deviceTokens(userId, 'android'),
    async send(token, n) {
      const c = config();
      if (!c) throw new Error('FCM not configured');
      const res = await doFetch(`https://fcm.googleapis.com/v1/projects/${c.projectId}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await accessToken(c)}`, 'content-type': 'application/json' },
        body: JSON.stringify(fcmMessage(token, n)),
      });
      if (res.status === 200) return markDeviceSuccess(token);
      const text = await res.text();
      if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text)) throw new TargetGoneError(`FCM: ${res.status}`);
      throw new Error(`FCM ${res.status} ${text.slice(0, 200)}`);
    },
    forget: forgetDeviceToken,
  };
}
