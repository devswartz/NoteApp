// Locked pages, client side (server/locks.ts has the rules; the server enforces them). One locked-notes password per
// account unlocks all of the user's locked pages on this sign-in until they lock again: after UNLOCK idle time
// without activity, when the app goes to the background (mobile), on sign-out, or with "Lock now".
// On iOS/Android a device secret kept behind Face ID / Touch ID can stand in for the password (platform.lockedNotesBio).
import { create } from 'zustand';
import { ApiError, del, get, post } from '../api.ts';
import { platform } from '../platform/index.ts';
import type { LockedNotesBio } from '../platform/capacitor.ts';
import type { LockedNotesStatus } from '../../shared/types.ts';

interface LockState {
  status: LockedNotesStatus | null;
  /** This sign-in has the user's locked pages unlocked. */
  unlocked: boolean;
}

export const useLockedNotes = create<LockState>(() => ({ status: null, unlocked: false }));

const DEFAULT_IDLE_MS = 5 * 60_000;
const KEEPALIVE_MS = 60_000;

/** The biometric glue, on the mobile shells only. */
export function lockedNotesBio(): LockedNotesBio | null {
  return (platform as unknown as { lockedNotesBio?: LockedNotesBio }).lockedNotesBio ?? null;
}

function setUnlocked(unlocked: boolean) {
  if (useLockedNotes.getState().unlocked === unlocked) return;
  useLockedNotes.setState({ unlocked });
  if (unlocked) lastActivity = Date.now();
}

export async function refreshLockStatus(): Promise<LockedNotesStatus | null> {
  try {
    const status = await get<LockedNotesStatus>('/locked-notes');
    useLockedNotes.setState({ status, unlocked: status.unlocked });
    return status;
  } catch {
    return null;
  }
}

/** Unlock with the locked-notes password. Throws ApiError (400 wrong password, 429 too many tries). */
export async function unlockWithPassword(password: string) {
  await post('/locked-notes/unlock', { password });
  setUnlocked(true);
  void refreshLockStatus();
}

export type BioUnlock = 'ok' | 'none' | 'cancelled' | 'unavailable' | 'revoked';

/** Unlock with Face ID / Touch ID, when this device was set up for it. */
export async function unlockWithBiometrics(userId: string): Promise<BioUnlock> {
  const bio = lockedNotesBio();
  if (!bio) return 'none';
  const r = await bio.read(userId);
  if (r.result !== 'ok') return r.result;
  try {
    await post('/locked-notes/unlock', { deviceId: r.cred.deviceId, secret: r.cred.secret });
  } catch (e) {
    // The password was changed or reset (or the device removed): this device has to be set up again.
    if (e instanceof ApiError && e.status === 401) {
      await bio.forget(userId);
      return 'revoked';
    }
    throw e;
  }
  setUnlocked(true);
  void refreshLockStatus();
  return 'ok';
}

/**
 * After a password unlock: keep a device secret behind Face ID / Touch ID. Needs an unlocked sign-in (the server
 * refuses otherwise). Returns false if the user cancelled the biometric check.
 */
export async function enableBiometrics(userId: string, label: string): Promise<boolean> {
  const bio = lockedNotesBio();
  if (!bio) return false;
  const cred = await post<{ id: string; secret: string }>('/locked-notes/devices', { label });
  const saved = await bio.save(userId, { deviceId: cred.id, secret: cred.secret }).catch(() => false);
  if (!saved) await removeDevice(cred.id);
  void refreshLockStatus();
  return saved;
}

/** Stop using biometrics on this device (and forget the secret on the server). */
export async function disableBiometrics(userId: string) {
  const bio = lockedNotesBio();
  const r = bio ? await bio.read(userId).catch(() => null) : null;
  await bio?.forget(userId);
  if (r?.result === 'ok') await removeDevice(r.cred.deviceId);
  void refreshLockStatus();
}

export async function removeDevice(id: string) {
  await del(`/locked-notes/devices/${id}`).catch(() => {});
}

/** Lock again now (this sign-in). */
export async function lockNow() {
  setUnlocked(false);
  await post('/locked-notes/lock').catch(() => {});
}

/** Set the locked-notes password (or change it: `current` is then required). Unlocks this sign-in. */
export async function saveLockPassword(password: string, current?: string) {
  await post('/locked-notes/password', current === undefined ? { password } : { password, currentPassword: current });
  setUnlocked(true);
  await refreshLockStatus();
}

/** Lock a page (the server says 409 no_lock_password when there is no locked-notes password yet). */
export const lockPage = (pageId: string) => post(`/pages/${pageId}/lock`);
export const removePageLock = (pageId: string, password: string) => post(`/pages/${pageId}/lock/remove`, { password });

// ── Relocking: idle time, background, keepalive ──

let lastActivity = Date.now();
let lastKeepAlive = 0;
let started = false;

/** Note activity: keeps the unlock alive (server keepalive at most once a minute). */
export function lockActivity() {
  lastActivity = Date.now();
  if (!useLockedNotes.getState().unlocked) return;
  if (lastActivity - lastKeepAlive < KEEPALIVE_MS) return;
  lastKeepAlive = lastActivity;
  post<{ unlocked: boolean }>('/locked-notes/keepalive')
    .then((r) => !r.unlocked && setUnlocked(false))
    .catch(() => {});
}

/** Mount once for the signed-in app. Returns a cleanup. */
export function startLockWatch(): () => void {
  if (started || typeof window === 'undefined') return () => {};
  started = true;
  void refreshLockStatus();
  const events = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;
  const onAct = () => lockActivity();
  for (const e of events) window.addEventListener(e, onAct, { passive: true, capture: true });
  const onBackground = () => {
    if (useLockedNotes.getState().unlocked) void lockNow();
  };
  window.addEventListener('noteapp:background', onBackground);
  const timer = setInterval(() => {
    const s = useLockedNotes.getState();
    if (!s.unlocked) return;
    const idle = s.status?.idleMs ?? DEFAULT_IDLE_MS;
    if (Date.now() - lastActivity >= idle) void lockNow();
  }, 5_000);
  return () => {
    started = false;
    for (const e of events) window.removeEventListener(e, onAct, { capture: true });
    window.removeEventListener('noteapp:background', onBackground);
    clearInterval(timer);
    useLockedNotes.setState({ status: null, unlocked: false });
  };
}
