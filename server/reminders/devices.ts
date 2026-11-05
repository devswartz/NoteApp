// Native push tokens registered by the mobile app (Phase 3): APNs (ios) and FCM (android).
import { db, newId, now } from '../db.ts';
import { HttpError } from '../access.ts';

export type DevicePlatform = 'ios' | 'android';

export function saveDeviceToken(userId: string, platform: unknown, token: unknown) {
  if (platform !== 'ios' && platform !== 'android') throw new HttpError(400, 'platform must be ios or android');
  if (typeof token !== 'string' || !/^[\w:.\-]{20,4096}$/.test(token)) throw new HttpError(400, 'Invalid device token');
  // A token belongs to one app install; if another user signs in there, it moves to them.
  db.prepare(
    `INSERT INTO device_tokens (id, user_id, platform, token, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`,
  ).run(newId(), userId, platform, token, now());
}

export function deleteDeviceToken(userId: string, token: string) {
  db.prepare('DELETE FROM device_tokens WHERE user_id = ? AND token = ?').run(userId, token);
}

export function deviceTokens(userId: string, platform: DevicePlatform): string[] {
  return (db.prepare('SELECT token FROM device_tokens WHERE user_id = ? AND platform = ?').all(userId, platform) as { token: string }[]).map((r) => r.token);
}

export function markDeviceSuccess(token: string) {
  db.prepare('UPDATE device_tokens SET last_success_at = ? WHERE token = ?').run(now(), token);
}

export function forgetDeviceToken(token: string) {
  db.prepare('DELETE FROM device_tokens WHERE token = ?').run(token);
}

/** Env values holding PEM keys may have their newlines escaped as \n. */
export const pem = (s: string) => s.replace(/\\n/g, '\n');
