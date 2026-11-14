// Locked pages. A page is LOCKED, not encrypted: its content stays readable on the server, which refuses to serve it
// until its owner unlocks (so a forgotten password can be reset). Schema: migration 021-locked-pages.sql.
//
// - Only the person who locked a page can ever open it. For everyone else, admins included, it is gone: the gate is
//   pageAccess (null for anyone but the locker), PAGE_VISIBLE / TASK_VISIBLE (which drop someone else's locked pages
//   and their tasks) and the tree, trash, activity and notification queries. Locking needs notebook-level edit
//   access (canManage), and the locker is recorded as the page's owner (pages.locked_by).
// - The owner sees the page's title (sidebar, title search) while it is locked; its content (collab socket, /doc,
//   versions, comments, backlinks, files, export, print, task text) needs an unlock grant: a row in lock_unlocks
//   for the sign-in (refresh-token family, `sid` in the access token) that unlocked. Grants last UNLOCK_IDLE_MS and
//   are extended by activity (POST /locked-notes/keepalive, edits on the collab socket); "Lock now", sign-out and
//   password changes delete them; the sweep below drops expired ones and kicks open collab sockets.
// - Code with no viewer (server/viewer.ts: timers, reminders, the AI connector at /mcp) never gets content: tasks
//   go out as "Locked task" (redactTask), reminders as "Reminder from a locked note". The AI connector doesn't see
//   locked pages or their tasks at all, unlocked or not.
// - Page bodies are never in search (pages_fts.text is kept empty while locked); titles stay searchable for the owner.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, newId, now } from './db.ts';
import { HttpError, UNLOCK_IDLE_MS, accessChanged, lockOpen, pageAccess, sessionUnlocked } from './access.ts';
import { publish } from './events.ts';
import { rowToTask } from './tasks.ts';
import type { LockedNotesStatus, Task } from '../shared/types.ts';

export { UNLOCK_IDLE_MS };
import { LOCKED_REMINDER_TITLE, LOCKED_TASK_TITLE } from '../shared/config.ts';
export { LOCKED_REMINDER_TITLE, LOCKED_TASK_TITLE };
export const MIN_LOCK_PASSWORD = 6;
/** Wrong tries before unlocking is refused for a while (LOCKOUT_BASE_MS, doubling per further failure, up to LOCKOUT_MAX_MS). */
export const LOCKOUT_AFTER = 5;
export const LOCKOUT_BASE_MS = 15 * 60_000;
export const LOCKOUT_MAX_MS = 24 * 60 * 60_000;
/** Device (biometric) secrets lapse after this long; the device has to be set up again with the password. */
export const DEVICE_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_LOCK_PASSWORD_BYTES = 72; // bcrypt
const BCRYPT_ROUNDS = 10;
const RESET_TTL_MS = 15 * 60_000;
const RESET_MAX_ATTEMPTS = 5;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function validLockPassword(v: unknown): string {
  if (typeof v !== 'string' || v.length < MIN_LOCK_PASSWORD) throw new HttpError(400, `The locked-notes password must be at least ${MIN_LOCK_PASSWORD} characters`);
  if (Buffer.byteLength(v, 'utf8') > MAX_LOCK_PASSWORD_BYTES) throw new HttpError(400, 'That password is too long');
  return v;
}

export function hasLockPassword(userId: string): boolean {
  return !!db.prepare('SELECT lock_password_hash FROM users WHERE id = ?').pluck().get(userId);
}

export async function checkLockPassword(userId: string, password: unknown): Promise<boolean> {
  const hash = db.prepare('SELECT lock_password_hash FROM users WHERE id = ?').pluck().get(userId) as string | null | undefined;
  if (!hash || typeof password !== 'string' || !password) return false;
  return bcrypt.compare(password.slice(0, 1024), hash);
}

/** Set (or replace) the locked-notes password. Every unlock and device secret of the user ends: they must use the new one. */
export async function setLockPassword(userId: string, password: string) {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  db.transaction(() => {
    db.prepare('UPDATE users SET lock_password_hash = ?, lock_failures = 0, lock_blocked_until = NULL WHERE id = ?').run(hash, userId);
    db.prepare('DELETE FROM lock_devices WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM lock_unlocks WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM lock_resets WHERE user_id = ?').run(userId);
  })();
  accessChanged();
}

// ── Unlock grants ──

/** Unlock all of the user's locked pages on this sign-in. Returns when it lapses without activity. */
export function grantUnlock(userId: string, sid: string): string {
  const expires = new Date(Date.now() + UNLOCK_IDLE_MS).toISOString();
  db.prepare(
    `INSERT INTO lock_unlocks (family_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (family_id) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at`,
  ).run(sid, userId, now(), expires);
  return expires;
}

/** Activity on an unlocked sign-in: push its relock back. Returns the new expiry, or null if it is locked. */
export function keepUnlocked(userId: string, sid: string | null): string | null {
  if (!sid || !sessionUnlocked(userId, sid)) return null;
  return grantUnlock(userId, sid);
}

export function unlockExpiry(userId: string, sid: string | null): string | null {
  if (!sid) return null;
  const r = db.prepare('SELECT expires_at FROM lock_unlocks WHERE family_id = ? AND user_id = ?').get(sid, userId) as { expires_at: string } | undefined;
  return r && r.expires_at > new Date().toISOString() ? r.expires_at : null;
}

/** Lock again: this sign-in, or (no sid) every sign-in of the user. Open locked pages close at once. */
export function relock(userId: string, sid?: string | null) {
  const r = sid
    ? db.prepare('DELETE FROM lock_unlocks WHERE family_id = ? AND user_id = ?').run(sid, userId)
    : db.prepare('DELETE FROM lock_unlocks WHERE user_id = ?').run(userId);
  if (r.changes) accessChanged();
}

/** Drop lapsed unlocks; open collab sockets on locked pages are re-checked (and closed) when any went. */
export function sweepUnlocks(): number {
  const r = db.prepare('DELETE FROM lock_unlocks WHERE expires_at <= ?').run(new Date().toISOString());
  if (r.changes) accessChanged();
  return r.changes;
}
setInterval(() => {
  try {
    sweepUnlocks();
  } catch {
    // the database may be closing (tests, shutdown)
  }
}, 15_000).unref();

// ── Wrong passwords: lockout ──

export interface LockoutState {
  failures: number;
  /** Unlocking is refused until then (null: not locked out). */
  blockedUntil: string | null;
}

export function lockoutState(userId: string): LockoutState {
  const r = db.prepare('SELECT lock_failures AS f, lock_blocked_until AS b FROM users WHERE id = ?').get(userId) as { f: number; b: string | null } | undefined;
  const blocked = r?.b && r.b > new Date().toISOString() ? r.b : null;
  return { failures: r?.f ?? 0, blockedUntil: blocked };
}

/** How long the lockout after the `failures`-th wrong try in a row lasts (0 below LOCKOUT_AFTER). */
export function lockoutMs(failures: number): number {
  if (failures < LOCKOUT_AFTER) return 0;
  return Math.min(LOCKOUT_MAX_MS, LOCKOUT_BASE_MS * 2 ** (failures - LOCKOUT_AFTER));
}

/** A wrong password or device secret. Returns the new state; `alert` is true the moment it reaches LOCKOUT_AFTER. */
export function recordFailure(userId: string): LockoutState & { alert: boolean } {
  const failures = (lockoutState(userId).failures ?? 0) + 1;
  const ms = lockoutMs(failures);
  const blockedUntil = ms ? new Date(Date.now() + ms).toISOString() : null;
  db.prepare('UPDATE users SET lock_failures = ?, lock_blocked_until = ? WHERE id = ?').run(failures, blockedUntil, userId);
  return { failures, blockedUntil, alert: failures === LOCKOUT_AFTER };
}

export function recordSuccess(userId: string) {
  db.prepare('UPDATE users SET lock_failures = 0, lock_blocked_until = NULL WHERE id = ? AND (lock_failures > 0 OR lock_blocked_until IS NOT NULL)').run(userId);
}

// ── Device secrets (Face ID / Touch ID / Android biometrics) ──

const installHash = (userId: string, installId: unknown) => (typeof installId === 'string' && installId.length >= 16 && installId.length <= 200 ? sha(`install:${userId}:${installId}`) : null);

/**
 * A new device secret, handed out once to a sign-in that is unlocked right now. The device keeps it behind biometry.
 * It only ever works for this sign-in (`sid`: signing out or changing the login password removes it), from this app
 * install (`installId`, a random id the app keeps), for DEVICE_TTL_MS.
 */
export function createDevice(userId: string, sid: string, installId: unknown, label: unknown): { id: string; secret: string; expiresAt: string } {
  const install = installHash(userId, installId);
  if (!install) throw new HttpError(400, 'Missing device id');
  const id = newId();
  const secret = crypto.randomBytes(32).toString('base64url');
  const name = typeof label === 'string' ? label.trim().slice(0, 80) || null : null;
  const expiresAt = new Date(Date.now() + DEVICE_TTL_MS).toISOString();
  db.transaction(() => {
    // One per sign-in and install: setting it up again replaces the old one.
    db.prepare('DELETE FROM lock_devices WHERE user_id = ? AND family_id = ? AND install_hash = ?').run(userId, sid, install);
    db.prepare('INSERT INTO lock_devices (id, user_id, family_id, install_hash, expires_at, secret_hash, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, userId, sid, install, expiresAt, sha(secret), name, now(),
    );
  })();
  return { id, secret, expiresAt };
}

/** Does this device secret unlock, for this sign-in and app install? Lapsed ones are removed. */
export function checkDevice(userId: string, sid: string, installId: unknown, id: unknown, secret: unknown): boolean {
  if (typeof id !== 'string' || typeof secret !== 'string' || !secret) return false;
  const row = db.prepare('SELECT secret_hash, family_id, install_hash, expires_at FROM lock_devices WHERE id = ? AND user_id = ?').get(id, userId) as
    | { secret_hash: string; family_id: string; install_hash: string; expires_at: string }
    | undefined;
  if (!row) return false;
  if (row.expires_at <= new Date().toISOString()) {
    db.prepare('DELETE FROM lock_devices WHERE id = ?').run(id);
    return false;
  }
  if (row.family_id !== sid || row.install_hash !== installHash(userId, installId)) return false;
  const a = Buffer.from(row.secret_hash, 'hex');
  const b = Buffer.from(sha(secret), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  db.prepare('UPDATE lock_devices SET last_used_at = ? WHERE id = ?').run(now(), id);
  return true;
}

// ── Upload links for an unlocked sign-in ──

/** The tag in upload links signed for an unlocked sign-in (an opaque stand-in for its id). */
export const lockFileTag = (sid: string) => sha(`lockfile:${sid}`).slice(0, 24);

/** The sign-in behind a tag, if it belongs to `userId` and is unlocked right now. */
export function sidForLockTag(userId: string, tag: string): string | null {
  const live = db.prepare('SELECT family_id FROM lock_unlocks WHERE user_id = ? AND expires_at > ?').all(userId, new Date().toISOString()) as { family_id: string }[];
  return live.find((r) => lockFileTag(r.family_id) === tag)?.family_id ?? null;
}

export function removeDevice(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM lock_devices WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function lockStatus(userId: string, sid: string | null): LockedNotesStatus {
  const expiresAt = unlockExpiry(userId, sid);
  return {
    hasPassword: hasLockPassword(userId),
    unlocked: !!expiresAt,
    expiresAt,
    idleMs: UNLOCK_IDLE_MS,
    lockedPages: db.prepare('SELECT COUNT(*) FROM pages WHERE locked_by = ? AND deleted_at IS NULL').pluck().get(userId) as number,
    ...lockoutState(userId),
    triesBeforeLockout: Math.max(0, LOCKOUT_AFTER - lockoutState(userId).failures),
    devices: (
      db.prepare('SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt FROM lock_devices WHERE user_id = ? AND expires_at > ? ORDER BY created_at').all(userId, new Date().toISOString()) as {
        id: string;
        label: string | null;
        createdAt: string;
        lastUsedAt: string | null;
        expiresAt: string;
      }[]
    ),
  };
}

// ── Reset (forgotten locked-notes password) ──

/** A 6-digit code for resetting the locked-notes password (the caller has checked the login password and emails it). */
export function startReset(userId: string): string {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare(
    `INSERT INTO lock_resets (user_id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
     ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
  ).run(userId, sha(`${userId}:${code}`), new Date(Date.now() + RESET_TTL_MS).toISOString());
  return code;
}

/** True (and the code is used up) if `code` is the user's live reset code. A few wrong tries void it. */
export function consumeResetCode(userId: string, code: unknown): boolean {
  const row = db.prepare('SELECT code_hash, expires_at, attempts FROM lock_resets WHERE user_id = ?').get(userId) as
    | { code_hash: string; expires_at: string; attempts: number }
    | undefined;
  if (!row || row.expires_at <= new Date().toISOString() || row.attempts >= RESET_MAX_ATTEMPTS) return false;
  const ok = typeof code === 'string' && /^\d{6}$/.test(code.trim()) && sha(`${userId}:${code.trim()}`) === row.code_hash;
  if (ok) db.prepare('DELETE FROM lock_resets WHERE user_id = ?').run(userId);
  else db.prepare('UPDATE lock_resets SET attempts = attempts + 1 WHERE user_id = ?').run(userId);
  return ok;
}

// ── Locking and unlocking pages ──

type TaskRow = Parameters<typeof rowToTask>[0];

/** Tell clients about the tasks on a page whose lock changed (others get them dropped or back, via TASK_VISIBLE). */
function republishTasks(pageId: string) {
  const rows = db.prepare('SELECT * FROM tasks WHERE page_id = ?').all(pageId) as TaskRow[];
  for (const r of rows) publish({ type: 'task', task: rowToTask(r) });
}

/** Lock a page: the caller (who must be able to manage it and have a locked-notes password) becomes its owner. */
export function lockPage(pageId: string, userId: string) {
  const a = pageAccess(pageId, userId);
  if (!a || a.trashed) throw new HttpError(404, 'Not found');
  if (a.locked) throw new HttpError(409, 'This page is already locked');
  if (!a.canManage) throw new HttpError(403, 'Only people who can edit its notebook can lock a page');
  if (!hasLockPassword(userId)) throw new HttpError(409, 'Set a locked-notes password first', 'no_lock_password');
  // Everyone who could open it until now (its owner too): their devices drop its offline copy and close its editor.
  const holders = (
    db
      .prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ? UNION SELECT user_id FROM page_shares WHERE page_id = ?')
      .all(a.workspaceId, pageId) as { user_id: string }[]
  ).map((r) => r.user_id);
  db.transaction(() => {
    db.prepare('UPDATE pages SET locked_by = ?, locked_at = ? WHERE id = ?').run(userId, now(), pageId);
    db.prepare("UPDATE pages_fts SET text = '' WHERE page_id = ?").run(pageId); // never in search while locked
  })();
  accessChanged(); // everyone else's sockets on it close; caches of who may read its files drop
  publish({ type: 'page-locked', workspaceId: a.workspaceId, pageId }, { userIds: holders });
  publish({ type: 'tree', workspaceId: a.workspaceId });
  republishTasks(pageId);
  return { workspaceId: a.workspaceId };
}

/** Remove the lock (the caller is its owner and gave the password): it is an ordinary page again. */
export function removeLock(pageId: string, userId: string) {
  const a = pageAccess(pageId, userId, { ignoreLock: true });
  if (!a) throw new HttpError(404, 'Not found');
  if (!a.locked) throw new HttpError(409, 'This page isn’t locked');
  db.transaction(() => {
    db.prepare('UPDATE pages SET locked_by = NULL, locked_at = NULL WHERE id = ?').run(pageId);
    const p = db.prepare('SELECT title, text, deleted_at FROM pages WHERE id = ?').get(pageId) as { title: string; text: string | null; deleted_at: string | null };
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
    if (!p.deleted_at) db.prepare('INSERT INTO pages_fts (page_id, title, text) VALUES (?, ?, ?)').run(pageId, p.title, p.text ?? '');
  })();
  accessChanged();
  publish({ type: 'tree', workspaceId: a.workspaceId });
  republishTasks(pageId);
}

/** What goes into pages_fts.text for a page: nothing while it is locked. */
export function searchableText(pageId: string, text: string): string {
  return db.prepare('SELECT locked_by FROM pages WHERE id = ?').pluck().get(pageId) ? '' : text;
}

// ── Tasks on locked pages ──

/** A task on a locked page as its owner sees it while locked: "Locked task", its due date and status, nothing else. */
export function redactTask(t: Task): Task {
  return { ...t, title: LOCKED_TASK_TITLE, description: '', tagIds: [], recurrence: t.recurrence, locked: true };
}

/**
 * Tasks as the current viewer may see them: those on a locked page come out redacted unless this sign-in has it
 * unlocked. (Tasks on someone else's locked page never reach here: TASK_VISIBLE drops them.)
 */
export function viewTasks<T extends Task>(tasks: T[], userId: string): T[] {
  const lockCache = new Map<string, string | null>();
  const lockedBy = (pageId: string) => {
    if (!lockCache.has(pageId)) lockCache.set(pageId, (db.prepare('SELECT locked_by FROM pages WHERE id = ?').pluck().get(pageId) as string | null) ?? null);
    return lockCache.get(pageId)!;
  };
  return tasks.map((t) => {
    if (!t.pageId) return t;
    const by = lockedBy(t.pageId);
    if (!by || lockOpen(by, userId)) return t;
    const r = redactTask(t) as T & { snippet?: string };
    delete r.snippet;
    return r;
  });
}

export function viewTask<T extends Task>(t: T, userId: string): T {
  return viewTasks([t], userId)[0];
}
