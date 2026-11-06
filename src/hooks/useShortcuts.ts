// Central registry for commands and keyboard shortcuts.
//
// Any area can register commands; the command palette (⌘K), the `?` help
// overlay and the global key listener all read from here, and the desktop
// shell can build its native menu from `listCommands()` + `runCommand(id)`.
//
//   useCommands(() => [
//     { id: 'tasks.newTask', title: 'New task', group: 'Tasks', keys: 'q', run: () => ui.openQuickAdd() },
//   ], [deps]);
//
// Key syntax: space-separated steps for sequences ("g t"); "+" joins modifiers
// within a step ("mod+k", "mod+shift+p", "alt+1"). `mod` is ⌘ on Apple
// platforms and Ctrl elsewhere. Single characters match `event.key`
// case-insensitively ("?" matches shift+/ on any layout).
//
// Precedence: a handler closer to the focused element wins. The global listener
// is on `window` and ignores any event that was already `preventDefault()`ed,
// so a component that handles a key itself just calls `e.preventDefault()`.
// Example: the editor claims Mod-K for "insert link" while focus is in it.
// ProseMirror's keymap runs on the editor element first and returns true
// (which preventDefaults), so the ⌘K palette steps aside; outside the editor
// ⌘K opens the palette as usual. Editable elements are detected with
// `el.isContentEditable`, not a [contenteditable="true"] selector.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { create } from 'zustand';

export interface Command {
  /** Unique, namespaced: 'nav.today', 'tasks.new', 'editor.toggleBold'. */
  id: string;
  title: string;
  /** Heading in the palette and the help overlay. */
  group?: string;
  /** Shortcut(s); see the key syntax above. */
  keys?: string | string[];
  icon?: ReactNode;
  /** Extra words the palette matches on. */
  keywords?: string;
  /** Omit for help-only entries (shortcuts handled elsewhere, e.g. in the editor). */
  run?: () => void | Promise<void>;
  /** Hidden and disabled when this returns false. */
  when?: () => boolean;
  /** Fire even while typing in an input or editor (default: only for mod+ shortcuts). */
  allowInInput?: boolean;
  /** Fire even while a modal / palette is open (default false). */
  global?: boolean;
  /** Show in the command palette (default: true when it has `run`). */
  palette?: boolean;
  /** Show in the `?` overlay (default: true when it has keys). */
  help?: boolean;
}

interface RegistryState {
  commands: Command[];
}

const useRegistry = create<RegistryState>(() => ({ commands: [] }));

/** Register commands; returns an unregister function. Later registrations win on duplicate ids. */
export function registerCommands(cmds: Command[]): () => void {
  const ids = new Set(cmds.map((c) => c.id));
  useRegistry.setState((s) => ({ commands: [...s.commands.filter((c) => !ids.has(c.id)), ...cmds] }));
  return () => useRegistry.setState((s) => ({ commands: s.commands.filter((c) => !cmds.includes(c)) }));
}

/** Register commands for the lifetime of a component. */
export function useCommands(factory: () => Command[], deps: unknown[]) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => registerCommands(factory()), deps);
}

export const listCommands = () => useRegistry.getState().commands.filter(isEnabled);
export const useCommandList = () => useRegistry((s) => s.commands);

export function runCommand(id: string): boolean {
  const c = useRegistry.getState().commands.find((x) => x.id === id);
  if (!c?.run || !isEnabled(c)) return false;
  void c.run();
  return true;
}

export function isEnabled(c: Command): boolean {
  try {
    return !c.when || c.when();
  } catch {
    return false;
  }
}

// ───────────── Key matching ─────────────

export const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

interface Step {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export function parseKeys(keys: string): Step[] {
  return keys
    .trim()
    .split(/\s+/)
    .map((step) => {
      const parts = step.toLowerCase().split('+');
      const key = parts.pop() || '+';
      return { key, mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt') };
    });
}

const KEY_ALIASES: Record<string, string> = { esc: 'escape', enter: 'enter', space: ' ', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' };

function stepMatches(step: Step, e: KeyboardEvent): boolean {
  const mod = isApple ? e.metaKey : e.ctrlKey;
  if (step.mod !== mod || step.alt !== e.altKey) return false;
  const want = KEY_ALIASES[step.key] ?? step.key;
  const got = e.key.toLowerCase();
  // Symbols like "?" already imply shift; only check shift for letters and named keys.
  const symbol = want.length === 1 && !/[a-z0-9]/.test(want);
  if (!symbol && step.shift !== e.shiftKey) return false;
  return got === want || (want.length === 1 && e.code.toLowerCase() === `key${want}`);
}

/** Display labels for a shortcut: "mod+shift+k" → ["⌘", "⇧", "K"]; "g t" → ["G", "then", "T"]. */
export function formatKeys(keys: string): string[] {
  const out: string[] = [];
  parseKeys(keys).forEach((s, i) => {
    if (i > 0) out.push('then');
    if (s.mod) out.push(isApple ? '⌘' : 'Ctrl');
    if (s.alt) out.push(isApple ? '⌥' : 'Alt');
    if (s.shift) out.push(isApple ? '⇧' : 'Shift');
    const named: Record<string, string> = { escape: 'Esc', enter: '↵', ' ': 'Space', space: 'Space', arrowup: '↑', arrowdown: '↓', backspace: '⌫', '\\': '\\' };
    out.push(named[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1)));
  });
  return out;
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

const SEQUENCE_TIMEOUT = 1200;

/**
 * Installs the one global key listener. `isBlocked()` reports whether a modal
 * is open (non-`global` commands are skipped then). Mount once, in the app shell.
 */
export function useShortcutListener(isBlocked: () => boolean) {
  useEffect(() => {
    let pending: { steps: Step[]; at: number } | null = null;

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || ['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return;
      const typing = isTyping(e);
      const blocked = isBlocked();
      const candidates = useRegistry
        .getState()
        .commands.filter((c) => c.run && c.keys)
        .flatMap((c) => (Array.isArray(c.keys) ? c.keys : [c.keys!]).map((k) => ({ c, steps: parseKeys(k) })))
        .filter(({ c, steps }) => {
          const hasMod = steps[0].mod || steps[0].alt;
          if (typing && !(c.allowInInput ?? hasMod)) return false;
          if (blocked && !c.global) return false;
          return true;
        });

      const sofar = pending && Date.now() - pending.at < SEQUENCE_TIMEOUT ? pending.steps.length : 0;
      if (!sofar) pending = null;

      // Continue a sequence ("g" then "t").
      if (sofar) {
        const prefix = pending!.steps;
        const next = candidates.filter(
          ({ steps }) => steps.length > sofar && prefix.every((p, i) => p === steps[i] || sameStep(p, steps[i])) && stepMatches(steps[sofar], e),
        );
        const done = next.find(({ steps, c }) => steps.length === sofar + 1 && isEnabled(c));
        if (done) {
          e.preventDefault();
          pending = null;
          void done.c.run!();
          return;
        }
        if (next.length) {
          e.preventDefault();
          pending = { steps: next[0].steps.slice(0, sofar + 1), at: Date.now() };
          return;
        }
        pending = null;
      }

      const single = candidates.find(({ steps, c }) => steps.length === 1 && stepMatches(steps[0], e) && isEnabled(c));
      if (single) {
        e.preventDefault();
        void single.c.run!();
        return;
      }
      const starts = candidates.find(({ steps }) => steps.length > 1 && stepMatches(steps[0], e));
      if (starts) pending = { steps: starts.steps.slice(0, 1), at: Date.now() };
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isBlocked]);
}

function sameStep(a: Step, b: Step) {
  return a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;
}
