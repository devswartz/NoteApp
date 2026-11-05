// Offers to reload when a new version of the app is ready (service worker on the web, updater in shells).
import { useEffect } from 'react';
import { platform } from '../platform/index.ts';
import { toast } from '../store.ts';

export function AppUpdates() {
  useEffect(
    () =>
      platform.appUpdates.subscribe((apply) =>
        toast('A new version is available', { sticky: true, action: { label: 'Reload', run: apply } }),
      ),
    [],
  );
  return null;
}
