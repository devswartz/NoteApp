// Windows and Linux: the desktop app has no window menu bar (macOS keeps its
// native menu, src-tauri/src/menu.rs). What the menu offered is reachable here:
//  - its keyboard accelerators, as ordinary shortcuts (shortcuts.ts);
//  - the actions that lived only in the menu, in the command palette (⌘K / Ctrl+K);
//  - the window theme: the title bar follows the app's light / dark / system setting.
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { registerCommands } from '../../hooks/useShortcuts.ts';
import { runMenuCommand } from './commands.ts';
import { DESKTOP_SHORTCUTS } from './shortcuts.ts';
import { showServerSetup } from './serverSetup.ts';

async function toggleFullscreen() {
  const win = getCurrentWindow();
  await win.setFullscreen(!(await win.isFullscreen()));
}

/** Registers the menu's accelerators and menu-only actions. Call once, before the app renders. */
export function registerMenulessCommands() {
  registerCommands([
    ...DESKTOP_SHORTCUTS.map(({ keys, command }) => ({
      id: `desktop.${command}`,
      title: command,
      keys,
      palette: false,
      help: false,
      run: () => void runMenuCommand(command),
    })),
    { id: 'app.changeServer', title: 'Change server…', group: 'General', keywords: 'url connect backend', run: () => void showServerSetup({ firstRun: false }) },
    {
      id: 'app.checkUpdates',
      title: 'Check for updates…',
      group: 'General',
      keywords: 'version upgrade',
      run: () => void import('./updates.ts').then((m) => m.checkForUpdates({ interactive: true })),
    },
    { id: 'app.fullscreen', title: 'Toggle full screen', group: 'General', keys: 'f11', allowInInput: true, run: toggleFullscreen },
  ]);
}

/** The CSS colour `--bg` resolves to, as [r, g, b] (any CSS colour syntax, not just hex). */
function appBackground(): [number, number, number] | null {
  const probe = document.createElement('span');
  probe.style.color = 'var(--bg)';
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
  probe.remove();
  return m && m.length >= 3 ? [Math.round(+m[0]), Math.round(+m[1]), Math.round(+m[2])] : null;
}

/**
 * Keeps the native title bar in step with the app: its theme preference (light,
 * dark or system) and its background colour, so Windows doesn't paint the title
 * bar in the accent colour.
 */
export async function startWindowThemeSync() {
  const { useTheme } = await import('../../store/ui.ts');
  let last = '';
  const push = () => {
    // Hybrid's title bar sits on the dark chrome; the Rust side knows light / dark / system.
    const pref = useTheme.getState().pref;
    const theme = pref === 'hybrid' ? 'dark' : pref;
    const background = appBackground();
    const key = `${theme} ${background}`;
    if (key === last) return;
    last = key;
    void invoke('set_window_theme', { theme, background }).catch(() => {});
  };
  push();
  // The store changes first and applyTheme() (which sets data-theme, and with it --bg) runs right after.
  useTheme.subscribe(() => queueMicrotask(push));
  new MutationObserver(push).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
