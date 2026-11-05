// Settings toggle for the optional biometric app lock. Only shown when the
// platform adapter provides `appLock` (the Capacitor shell; see Mobile's
// src/platform/capacitor.ts). Turning it on asks for one successful unlock.
import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { platform } from '../../platform/index.ts';
import { errorToast } from '../../store.ts';

interface AppLock {
  method(): Promise<string | null>;
  enabled(): boolean;
  setEnabled(on: boolean): Promise<boolean>;
  subscribe(cb: (enabled: boolean) => void): () => void;
}

const appLock = (): AppLock | null => ((platform as unknown as { appLock?: AppLock }).appLock ?? null);

export function AppLockSettings() {
  const lock = appLock();
  const [method, setMethod] = useState<string | null | undefined>(undefined);
  const [on, setOn] = useState(() => lock?.enabled() ?? false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!lock) return;
    lock.method().then(setMethod, () => setMethod(null));
    return lock.subscribe(setOn);
  }, [lock]);
  if (!lock || method === undefined) return null;

  return (
    <div className="setting-row">
      <Lock size={16} className="muted" />
      <div className="grow">
        <div className="setting-title">Lock with {method ?? 'biometrics'}</div>
        <div className="muted small">
          {method
            ? 'Asks to unlock when the app opens or has been in the background for more than a minute.'
            : 'Set up Face ID, a fingerprint or a passcode on this device to use this.'}
        </div>
      </div>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={!method || busy}
          aria-label={`Lock with ${method ?? 'biometrics'}`}
          onChange={(e) => {
            setBusy(true);
            lock
              .setEnabled(e.target.checked)
              .then(setOn, errorToast)
              .finally(() => setBusy(false));
          }}
        />
        <span className="switch-track" aria-hidden="true" />
      </label>
    </div>
  );
}

/** Whether this platform offers an app lock (to decide whether to show the setting). */
export const hasAppLock = () => appLock() !== null;
