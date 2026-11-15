// Offers new versions of the app. Web: a new service worker is waiting ("Reload"). Desktop: the updater.
// iPhone/iPad: a newer version is on the App Store ("Update" opens it, src/platform/storeUpdates.ts),
// and when this version is below the server's minimum, a screen that blocks the app until it's updated.
import { useEffect, useState } from 'react';
import { platform } from '../platform/index.ts';
import { toast } from '../store.ts';
import { APP_NAME } from '../../shared/config.ts';
import { Button } from './ui.tsx';

export function AppUpdates() {
  const [required, setRequired] = useState<(() => void) | null>(null);
  useEffect(() => {
    const fromStore = platform.kind === 'capacitor';
    const offAvailable = platform.appUpdates.subscribe((apply) =>
      toast(fromStore ? `A new version of ${APP_NAME} is on the App Store` : 'A new version is available', {
        sticky: true,
        action: { label: fromStore ? 'Update' : 'Reload', run: apply },
      }),
    );
    const offRequired = platform.appUpdates.subscribeRequired?.((open) => setRequired(() => open));
    return () => {
      offAvailable();
      offRequired?.();
    };
  }, []);
  if (!required) return null;
  return (
    <div className="auth update-required" role="alertdialog" aria-modal="true" aria-labelledby="update-required-title">
      <div className="auth-card">
        <div className="auth-logo">
          <img className="auth-icon" src="/icon.svg" alt="" width={34} height={34} />
          <span>{APP_NAME}</span>
        </div>
        <h1 id="update-required-title">Update required</h1>
        <p className="muted">
          This version of {APP_NAME} is no longer supported. Update from the App Store to keep using it. Your notes are safe on
          the server.
        </p>
        <Button variant="primary" size="lg" onClick={required}>
          Open the App Store
        </Button>
      </div>
    </div>
  );
}
