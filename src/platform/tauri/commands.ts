// Runs app-menu and tray items. Their ids are command ids from the web app's
// command registry (src/hooks/useShortcuts.ts). If a command isn't registered
// on the current screen (e.g. signed out), navigation items fall back to plain
// navigation.
import { runCommand } from '../../hooks/useShortcuts.ts';
import { fallbackPath } from './paths.ts';

/** Navigates the main window without a router handle (React Router listens to popstate). */
export function navigateTo(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function runMenuCommand(id: string): boolean {
  if (runCommand(id)) return true;
  const path = fallbackPath(id, location.pathname);
  if (!path) return false;
  navigateTo(path);
  return true;
}
