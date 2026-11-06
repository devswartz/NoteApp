// Keyboard shortcuts that only the macOS native menu used to provide. Windows and
// Linux have no menu bar any more (see menuless.ts), so these are registered as
// ordinary shortcuts instead. ⌘K and ⌘\ are not listed: the web app already
// handles them itself (components/shell/commands.tsx). Pure data, so tests can
// import it without Vite.

export interface DesktopShortcut {
  /** Key syntax of src/hooks/useShortcuts.ts. */
  keys: string;
  /** A command id from the command registry (falls back to plain navigation for nav.*). */
  command: string;
}

export const DESKTOP_SHORTCUTS: DesktopShortcut[] = [
  { keys: 'mod+n', command: 'pages.new' },
  { keys: 'mod+shift+t', command: 'tasks.new' },
  { keys: 'mod+1', command: 'nav.today' },
  { keys: 'mod+2', command: 'nav.upcoming' },
  { keys: 'mod+3', command: 'nav.my' },
  { keys: 'mod+4', command: 'nav.team' },
  { keys: 'mod+5', command: 'nav.all' },
  { keys: 'mod+6', command: 'nav.calendar' },
  { keys: 'mod+7', command: 'nav.completed' },
  { keys: 'mod+8', command: 'nav.notes' },
  { keys: 'mod+,', command: 'nav.settings' },
  { keys: 'mod+/', command: 'app.shortcuts' },
];
