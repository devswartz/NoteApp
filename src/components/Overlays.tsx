// App-wide overlays: toasts, keyboard shortcut help, offline banner.
import { X } from 'lucide-react';
import { dismissToast, ui, useStore } from '../store.ts';
import { useState } from 'react';
import { Kbd, Modal } from './ui.tsx';
import { formatKeys, isEnabled, useCommandList, type Command } from '../hooks/useShortcuts.ts';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone === 'error' ? 'is-error' : ''}`}>
          <span>{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-x" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

const GROUP_ORDER = ['General', 'Create', 'Navigation'];

function Keys({ keys }: { keys: string }) {
  return (
    <span className="shortcut-keys">
      {formatKeys(keys).map((k, i) => (k === 'then' ? <span key={i} className="muted small"> then </span> : <Kbd key={i}>{k}</Kbd>))}
    </span>
  );
}

/** Every registered shortcut, grouped by area (used by the `?` overlay and Settings). */
export function ShortcutList({ filter = '', columns = true }: { filter?: string; columns?: boolean }) {
  const commands = useCommandList();
  const groups = new Map<string, Command[]>();
  const needle = filter.trim().toLowerCase();
  for (const c of commands) {
    if (!c.keys || c.help === false || !isEnabled(c)) continue;
    if (needle && !`${c.title} ${c.group ?? ''}`.toLowerCase().includes(needle)) continue;
    const g = c.group ?? 'Other';
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
  return (
    <div className={columns ? 'shortcut-cols' : 'shortcut-stack'}>
      {ordered.map(([group, cmds]) => (
        <div key={group} className="shortcut-group">
          <h4>{group}</h4>
          {cmds.map((c) => (
            <div className="shortcut" key={c.id}>
              <span>{c.title}</span>
              <Keys keys={Array.isArray(c.keys) ? c.keys[0] : c.keys!} />
            </div>
          ))}
        </div>
      ))}
      <div className="shortcut-group">
        <h4>Quick add language</h4>
        <p className="muted small">
          Dates: <code>today</code>, <code>tomorrow</code>, <code>fri</code>, <code>next week</code>, <code>in 3 days</code>, <code>jan 15</code>
          <br />
          Time: <code>3pm</code>, <code>at 14:30</code> · Priority: <code>p1</code>–<code>p4</code>
          <br />
          Repeat: <code>every day</code>, <code>every weekday</code>, <code>every 2 weeks</code>, <code>monthly</code>
          <br />
          Assign: <code>@name</code> or <code>@me</code>
        </p>
      </div>
    </div>
  );
}

/** The `?` overlay, generated from the command registry. */
export function ShortcutsHelp() {
  const open = useStore((s) => s.shortcutsOpen);
  const [filter, setFilter] = useState('');
  return (
    <Modal open={open} onClose={() => ui.setShortcuts(false)} className="shortcuts" label="Keyboard shortcuts">
      <div className="shortcuts-head">
        <h2>Keyboard shortcuts</h2>
        <input className="input input-sm" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus aria-label="Filter shortcuts" />
      </div>
      <ShortcutList filter={filter} />
    </Modal>
  );
}

const rank = (g: string) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);

export function OfflineBanner() {
  const online = useStore((s) => s.online);
  if (online) return null;
  return <div className="offline-banner">You’re offline. Notes you’ve opened stay editable and will sync when you reconnect.</div>;
}
