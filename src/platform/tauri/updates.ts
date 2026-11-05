// Auto-update from GitHub Releases (Tauri updater plugin). Only builds signed
// in CI have an updater configured (see docs/DESKTOP.md); others do nothing.
import { invoke } from '@tauri-apps/api/core';
import { ask, message } from './dialogs.ts';

const LAST_CHECK = 'noteapp.desktop.lastUpdateCheck';
const DAY = 24 * 60 * 60_000;

export async function checkForUpdates({ interactive }: { interactive: boolean }) {
  const enabled = await invoke<boolean>('updater_enabled').catch(() => false);
  if (!enabled) {
    if (interactive) await message('Automatic updates aren’t set up for this build.');
    return;
  }
  const { platform } = await import('../index.ts');
  if (!interactive) {
    const last = Number(platform.kv.get(LAST_CHECK) ?? 0);
    if (Date.now() - last < DAY) return;
  }
  platform.kv.set(LAST_CHECK, String(Date.now()));
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
