// Locked pages UI: the lock screen a locked page opens to, "Lock page" / "Remove lock", and Settings → Security →
// Locked notes. The rules (and every check) are on the server: server/locks.ts. Client state: src/lib/lockedNotes.ts.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Fingerprint, Lock, LockOpen, ScanFace } from 'lucide-react';
import { ApiError } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { Button, Input } from './ui.tsx';
import { confirmDialog, promptDialog } from './shell/dialogs.tsx';
import { platform } from '../platform/index.ts';
import {
  disableBiometrics,
  enableBiometrics,
  lockNow,
  lockPage,
  lockedNotesBio,
  refreshLockStatus,
  removeDevice,
  removePageLock,
  saveLockPassword,
  unlockWithBiometrics,
  unlockWithPassword,
  useLockedNotes,
} from '../lib/lockedNotes.ts';
import { post } from '../api.ts';

const MIN = 4;
const offeredKey = (userId: string) => `noteapp.lockedNotes.bioOffered.${userId}`;

const BioIcon = ({ method }: { method: string }) => (/face/i.test(method) ? <ScanFace size={16} /> : <Fingerprint size={16} />);

/** What this device offers for locked notes ("Face ID", "Touch ID", …), and whether it is set up for this user. */
function useBio(userId: string) {
  const bio = lockedNotesBio();
  const [state, setState] = useState<{ method: string | null; has: boolean } | null>(bio ? null : { method: null, has: false });
  const devices = useLockedNotes((s) => s.status?.devices.length ?? 0);
  useEffect(() => {
    if (!bio) return;
    let live = true;
    void Promise.all([bio.method(), bio.has(userId)]).then(([method, has]) => live && setState({ method, has }));
    return () => {
      live = false;
    };
  }, [bio, userId, devices]);
  return state;
}

/** Ask for a new locked-notes password twice. null if cancelled or they don't match. */
async function askNewPassword(title: string): Promise<string | null> {
  const pw = await promptDialog({
    title,
    label: 'Locked-notes password',
    message: `Separate from your sign-in password. You will need it to open locked pages. At least ${MIN} characters.`,
    password: true,
    autoComplete: 'new-password',
    confirmLabel: 'Next',
  });
  if (!pw) return null;
  if (pw.length < MIN) {
    toast(`Use at least ${MIN} characters`);
    return null;
  }
  const again = await promptDialog({ title, label: 'Type it again', password: true, autoComplete: 'new-password', confirmLabel: 'Save password' });
  if (again === null) return null;
  if (again !== pw) {
    toast('The passwords didn’t match');
    return null;
  }
  return pw;
}

/** After the first password unlock on a phone: offer Face ID / Touch ID for next time (once per user and device). */
async function offerBiometrics(userId: string) {
  const bio = lockedNotesBio();
  if (!bio || platform.kv.get(offeredKey(userId))) return;
  const [method, has] = await Promise.all([bio.method(), bio.has(userId)]);
  if (!method || has) return;
  platform.kv.set(offeredKey(userId), '1');
  if (!(await confirmDialog({ title: `Use ${method} for locked notes?`, message: `Next time, open locked pages with ${method} instead of typing the password.`, confirmLabel: `Use ${method}`, cancelLabel: 'Not now' }))) return;
  if (await enableBiometrics(userId, `${method} on this device`).catch(errorToast)) toast(`${method} is on for locked notes`);
}

/** Page menu: "Lock page". Creates the locked-notes password first if there is none. */
export async function lockPageFlow(pageId: string) {
  try {
    await lockPage(pageId);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'no_lock_password')) return errorToast(e);
    const pw = await askNewPassword('Create a locked-notes password');
    if (!pw) return;
    try {
      await saveLockPassword(pw);
      await lockPage(pageId);
    } catch (err) {
      return errorToast(err);
    }
  }
  void refreshLockStatus();
  toast('Page locked. Only you can open it, with your locked-notes password.');
}

/** Page menu: "Remove lock" (needs the password). */
export async function removeLockFlow(pageId: string) {
  const pw = await promptDialog({ title: 'Remove lock', label: 'Locked-notes password', message: 'The page becomes visible again to everyone who can open its notebook.', password: true, autoComplete: 'current-password', confirmLabel: 'Remove lock' });
  if (!pw) return;
  try {
    await removePageLock(pageId, pw);
    toast('Lock removed');
    void refreshLockStatus();
  } catch (e) {
    errorToast(e);
  }
}

/** What a locked page shows until this sign-in unlocks: its title, a password field and (on phones) Face ID / Touch ID. */
export function LockScreen({ title, onUnlocked }: { title: string; onUnlocked: () => void }) {
  const userId = useStore((s) => s.user!.id);
  const bio = useBio(userId);
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasPassword = useLockedNotes((s) => s.status?.hasPassword ?? true);

  const tryBio = async () => {
    setError(null);
    const r = await unlockWithBiometrics(userId).catch((e) => (errorToast(e), 'cancelled' as const));
    if (r === 'ok') onUnlocked();
    else if (r === 'revoked') setError('This device can no longer unlock locked notes. Use your password, then turn biometrics on again.');
    else if (r === 'unavailable') setError('Biometrics aren’t available right now. Use your password.');
  };
  // Phones set up for it ask for Face ID / Touch ID straight away.
  useEffect(() => {
    if (bio?.has) void tryBio();
  }, [bio?.has]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="lock-screen" role="region" aria-label="Locked page">
      <div className="lock-card">
        <div className="lock-badge" aria-hidden>
          <Lock size={26} />
        </div>
        <h1 className="lock-title">{title || 'Untitled'}</h1>
        <p className="muted">This page is locked. Enter your locked-notes password to open it.</p>
        <form
          className="lock-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pw) return;
            setBusy(true);
            setError(null);
            unlockWithPassword(pw)
              .then(() => {
                setPw('');
                onUnlocked();
                void offerBiometrics(userId);
              })
              .catch((err) => setError(err instanceof ApiError && err.status === 400 ? 'That password isn’t right.' : err instanceof Error ? err.message : 'Couldn’t unlock'))
              .finally(() => setBusy(false));
          }}
        >
          <Input
            label="Locked-notes password"
            type="password"
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoFocus={!bio?.has}
            error={error ?? undefined}
            disabled={!hasPassword}
          />
          <Button type="submit" variant="primary" loading={busy} disabled={!pw} icon={<LockOpen size={15} />}>
            Unlock
          </Button>
          {bio?.has && bio.method && (
            <Button variant="secondary" onClick={() => void tryBio()} icon={<BioIcon method={bio.method} />}>
              Unlock with {bio.method}
            </Button>
          )}
        </form>
        <p className="muted small">
          Unlocking opens all your locked pages until they lock again (after 5 minutes without activity).{' '}
          <Link to="../settings?s=security" relative="path">
            Forgot the password?
          </Link>
        </p>
      </div>
    </div>
  );
}

/** Settings → Security → Locked notes. */
export function LockedNotesSettings() {
  const user = useStore((s) => s.user!);
  const status = useLockedNotes((s) => s.status);
  const unlocked = useLockedNotes((s) => s.unlocked);
  const bio = useBio(user.id);
  const [busy, setBusy] = useState(false);
  useEffect(() => void refreshLockStatus(), []);
  if (!status) return null;

  const change = async () => {
    const current = status.hasPassword
      ? await promptDialog({ title: 'Change locked-notes password', label: 'Current locked-notes password', password: true, autoComplete: 'current-password', confirmLabel: 'Next' })
      : undefined;
    if (status.hasPassword && !current) return;
    const pw = await askNewPassword(status.hasPassword ? 'Change locked-notes password' : 'Create a locked-notes password');
    if (!pw) return;
    await saveLockPassword(pw, current ?? undefined)
      .then(() => toast(status.hasPassword ? 'Locked-notes password changed. Biometric unlock was turned off on every device.' : 'Locked-notes password set'))
      .catch(errorToast);
    await lockedNotesBio()?.forget(user.id);
  };

  const reset = async () => {
    const login = await promptDialog({
      title: 'Reset locked-notes password',
      label: 'Your sign-in password',
      message: `We’ll email a code to ${user.email}. Resetting sets a new password; it doesn’t unlock anything by itself.`,
      password: true,
      autoComplete: 'current-password',
      confirmLabel: 'Email me a code',
    });
    if (!login) return;
    try {
      await post('/locked-notes/reset/start', { password: login });
    } catch (e) {
      return errorToast(e);
    }
    const code = await promptDialog({ title: 'Enter the code', label: '6-digit code', message: `Sent to ${user.email}. It works for 15 minutes.`, confirmLabel: 'Next' });
    if (!code) return;
    const pw = await askNewPassword('New locked-notes password');
    if (!pw) return;
    try {
      await post('/locked-notes/reset', { code, newPassword: pw });
      await lockedNotesBio()?.forget(user.id);
      toast('Locked-notes password reset. Unlock with the new one.');
      await refreshLockStatus();
    } catch (e) {
      errorToast(e);
    }
  };

  return (
    <section className="card locked-notes-settings" aria-labelledby="locked-notes-title">
      <h3 className="card-title" id="locked-notes-title">
        Locked notes
      </h3>
      <p className="muted small card-desc">
        Lock a page from its ⋯ menu. Only you can open a locked page, with a password separate from your sign-in password; it disappears for
        everyone else in the workspace, admins included, and from search, tasks and connected AI apps.
      </p>
      <div className="setting-row">
        <div className="grow">
          <div className="setting-title">Locked-notes password</div>
          <div className="muted small">
            {status.hasPassword ? `Set · ${status.lockedPages} locked page${status.lockedPages === 1 ? '' : 's'}` : 'Not set yet. You’ll be asked to create one when you first lock a page.'}
          </div>
        </div>
        <Button size="sm" onClick={() => void change()}>
          {status.hasPassword ? 'Change…' : 'Create…'}
        </Button>
      </div>
      {status.hasPassword && (
        <div className="setting-row">
          <div className="grow">
            <div className="setting-title">{unlocked ? 'Unlocked on this device' : 'Locked'}</div>
            <div className="muted small">Locked pages lock again after 5 minutes without activity, when the app goes to the background, and when you sign out.</div>
          </div>
          <Button size="sm" disabled={!unlocked} icon={<Lock size={14} />} onClick={() => void lockNow()}>
            Lock now
          </Button>
        </div>
      )}
      {status.hasPassword && bio && (
        <div className="setting-row">
          <div className="grow">
            <div className="setting-title">Use {bio.method ?? 'Face ID / Touch ID'} for locked notes</div>
            <div className="muted small">
              {bio.method ? (unlocked || bio.has ? 'Open locked pages on this device without typing the password.' : 'Unlock your locked notes with the password first.') : 'Set up Face ID, Touch ID or a fingerprint on this device to use this.'}
            </div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={bio.has}
              disabled={!bio.method || busy || (!bio.has && !unlocked)}
              aria-label={`Use ${bio.method ?? 'biometrics'} for locked notes`}
              onChange={(e) => {
                setBusy(true);
                (e.target.checked ? enableBiometrics(user.id, `${bio.method} on this device`) : disableBiometrics(user.id))
                  .catch(errorToast)
                  .finally(() => setBusy(false));
              }}
            />
            <span className="switch-track" aria-hidden="true" />
          </label>
        </div>
      )}
      {status.devices.length > 0 && (
        <div className="setting-row">
          <div className="grow">
            <div className="setting-title">Devices that unlock with biometrics</div>
            <ul className="muted small locked-devices">
              {status.devices.map((d) => (
                <li key={d.id}>
                  {d.label ?? 'A device'} ·{' '}
                  <button type="button" className="link-btn" onClick={() => void removeDevice(d.id).then(refreshLockStatus)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {status.hasPassword && (
        <div className="setting-row">
          <div className="grow">
            <div className="setting-title">Forgot it?</div>
            <div className="muted small">Reset with your sign-in password and a code sent to your email. Your locked pages stay locked.</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void reset()}>
            Reset…
          </Button>
        </div>
      )}
    </section>
  );
}
