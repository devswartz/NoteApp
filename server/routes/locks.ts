// Locked pages: the locked-notes password, unlocking and relocking, device (biometric) secrets, reset, and locking
// a page. Rules and the gate: server/locks.ts. Owner: Collaboration & Access.
//
//   GET    /locked-notes                    → LockedNotesStatus (shared/types.ts)
//   POST   /locked-notes/password           { password, currentPassword? }  set, or change (needs the current one)
//   POST   /locked-notes/unlock             { password } | { deviceId, secret } → { expiresAt }   (rate limited)
//   POST   /locked-notes/lock               "Lock now" (this sign-in)
//   POST   /locked-notes/keepalive          activity while unlocked → { unlocked, expiresAt }
//   POST   /locked-notes/devices            { label? } → { id, secret }  (only while unlocked; for Face ID / Touch ID)
//   DELETE /locked-notes/devices/:id
//   POST   /locked-notes/reset/start        { password: <login password> } → emails a 6-digit code
//   POST   /locked-notes/reset              { code, newPassword }  sets a new locked-notes password (reveals nothing)
//   POST   /pages/:id/lock                  lock a page (needs a locked-notes password; the caller becomes its owner)
//   POST   /pages/:id/lock/remove           { password } remove the lock (owner only)
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.ts';
import { HttpError, h, param } from '../http.ts';
import { lockCheckPassed, refuse, takeLockCheck, takeLockReset } from '../ratelimit.ts';
import {
  checkDevice,
  checkLockPassword,
  consumeResetCode,
  createDevice,
  grantUnlock,
  hasLockPassword,
  keepUnlocked,
  lockPage,
  lockStatus,
  relock,
  removeDevice,
  removeLock,
  setLockPassword,
  startReset,
  unlockExpiry,
  validLockPassword,
} from '../locks.ts';
import { escapeHtml, sendMail } from '../mail.ts';
import { APP_NAME } from '../../shared/config.ts';

export const lockRoutes = Router();

const needSid = (req: Request): string => {
  if (!req.sid) throw new HttpError(401, 'Sign in again to unlock locked notes');
  return req.sid;
};

/** Run a rate-limited check; false (after counting it) when it failed, null when refused (already answered 429). */
async function limited(req: Request, res: Response, check: () => boolean | Promise<boolean>): Promise<boolean | null> {
  const wait = takeLockCheck(req, req.user.id);
  if (wait) {
    refuse(res, wait);
    return null;
  }
  const ok = await check();
  if (ok) lockCheckPassed(req.user.id);
  return ok;
}

lockRoutes.get('/locked-notes', h((req) => lockStatus(req.user.id, req.sid)));

lockRoutes.post(
  '/locked-notes/password',
  h(async (req, res) => {
    const password = validLockPassword(req.body?.password);
    if (hasLockPassword(req.user.id)) {
      const ok = await limited(req, res, () => checkLockPassword(req.user.id, req.body?.currentPassword));
      if (ok === null) return;
      if (!ok) throw new HttpError(400, 'Your current locked-notes password is incorrect');
    }
    await setLockPassword(req.user.id, password);
    // Whoever just chose the password is unlocked on this sign-in (they are about to lock something).
    const expiresAt = req.sid ? grantUnlock(req.user.id, req.sid) : null;
    return { ok: true, expiresAt };
  }),
);

lockRoutes.post(
  '/locked-notes/unlock',
  h(async (req, res) => {
    const sid = needSid(req);
    if (!hasLockPassword(req.user.id)) throw new HttpError(409, 'Set a locked-notes password first', 'no_lock_password');
    const b = req.body ?? {};
    const viaDevice = typeof b.deviceId === 'string';
    const ok = await limited(req, res, () => (viaDevice ? checkDevice(req.user.id, b.deviceId, b.secret) : checkLockPassword(req.user.id, b.password)));
    if (ok === null) return;
    if (!ok) throw new HttpError(viaDevice ? 401 : 400, viaDevice ? 'This device can no longer unlock locked notes. Use your password.' : 'Incorrect password', viaDevice ? 'device_revoked' : 'wrong_password');
    return { expiresAt: grantUnlock(req.user.id, sid) };
  }),
);

lockRoutes.post(
  '/locked-notes/lock',
  h((req) => {
    relock(req.user.id, req.sid);
    return { ok: true };
  }),
);

lockRoutes.post(
  '/locked-notes/keepalive',
  h((req) => {
    const expiresAt = keepUnlocked(req.user.id, req.sid);
    return { unlocked: !!expiresAt, expiresAt };
  }),
);

lockRoutes.post(
  '/locked-notes/devices',
  h((req) => {
    if (!unlockExpiry(req.user.id, req.sid)) throw new HttpError(403, 'Unlock your locked notes with your password first', 'locked');
    return createDevice(req.user.id, req.body?.label);
  }),
);

lockRoutes.delete(
  '/locked-notes/devices/:id',
  h((req) => {
    if (!removeDevice(req.user.id, param(req, 'id'))) throw new HttpError(404, 'Not found');
    return { ok: true };
  }),
);

lockRoutes.post(
  '/locked-notes/reset/start',
  h(async (req, res) => {
    const row = db.prepare('SELECT email, name, password_hash FROM users WHERE id = ?').get(req.user.id) as { email: string; name: string; password_hash: string };
    const ok = await limited(req, res, () => bcrypt.compare(String(req.body?.password ?? '').slice(0, 1024), row.password_hash));
    if (ok === null) return;
    if (!ok) throw new HttpError(400, 'Incorrect account password');
    const wait = takeLockReset(req.user.id);
    if (wait) return refuse(res, wait);
    const code = startReset(req.user.id);
    const text = `Hi ${row.name},\n\nYour code to reset your ${APP_NAME} locked-notes password is ${code}\n\nIt works once, for 15 minutes. If you didn't ask for this, someone has your account password: change it now.`;
    await sendMail({
      to: row.email,
      subject: `Reset your ${APP_NAME} locked-notes password`,
      text,
      html: `<p>Hi ${escapeHtml(row.name)},</p><p>Your code to reset your ${escapeHtml(APP_NAME)} locked-notes password is</p><p style="font-size:24px;letter-spacing:4px"><b>${code}</b></p><p style="color:#666;font-size:13px">It works once, for 15 minutes. If you didn't ask for this, someone has your account password: change it now.</p>`,
    });
    return { ok: true };
  }),
);

lockRoutes.post(
  '/locked-notes/reset',
  h(async (req, res) => {
    const password = validLockPassword(req.body?.newPassword);
    const ok = await limited(req, res, () => consumeResetCode(req.user.id, req.body?.code));
    if (ok === null) return;
    if (!ok) throw new HttpError(400, 'That code is wrong or has expired', 'bad_code');
    await setLockPassword(req.user.id, password); // relocks every sign-in and forgets every device
    return { ok: true };
  }),
);

lockRoutes.post(
  '/pages/:id/lock',
  h((req) => {
    lockPage(param(req, 'id'), req.user.id);
    return { ok: true };
  }),
);

lockRoutes.post(
  '/pages/:id/lock/remove',
  h(async (req, res) => {
    const id = param(req, 'id');
    // Existence first, without revealing anything to non-owners (404 for them, like every other route).
    const owner = db.prepare('SELECT locked_by FROM pages WHERE id = ?').pluck().get(id) as string | null | undefined;
    if (owner !== req.user.id) throw new HttpError(404, 'Not found');
    const ok = await limited(req, res, () => checkLockPassword(req.user.id, req.body?.password));
    if (ok === null) return;
    if (!ok) throw new HttpError(400, 'Incorrect password', 'wrong_password');
    removeLock(id, req.user.id);
    return { ok: true };
  }),
);
