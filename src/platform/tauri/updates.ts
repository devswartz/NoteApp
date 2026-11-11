// Auto-update from GitHub Releases (Tauri updater plugin). Only builds signed
// in CI have an updater configured (see docs/DESKTOP.md); others do nothing.
import { invoke } from '@tauri-apps/api/core';
import { ask, message } from './dialogs.ts';

// Checked every time the app opens (and from the menu); the check is one small request.

export async function checkForUpdates({ interactive }: { interactive: boolean }) {
  const enabled = await invoke<boolean>('updater_enabled').catch(() => false);
  if (!enabled) {
    if (interactive) await message('Automatic updates aren’t set up for this build.');
    return;
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) {
      if (interactive) await message('You’re up to date.');
      return;
    }
    if (!(await ask(`Version ${update.version} is available. Install it and restart now?`, 'Install and restart'))) return;
    await update.downloadAndInstall();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    if (interactive) await message(`Couldn’t check for updates: ${e instanceof Error ? e.message : String(e)}`);
  }
}
