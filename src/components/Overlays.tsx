// App-wide overlays: toasts, keyboard shortcut help, offline banner.
import { X } from 'lucide-react';
import { dismissToast, ui, useStore } from '../store.ts';
import { Kbd, Modal, MOD } from './ui.tsx';

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

const SHORTCUTS: [string, string[]][] = [
  ['Search / command palette', [MOD, 'K']],
  ['Quick add task', ['Q']],
  ['New page in current section', ['N']],
  ['Toggle sidebar', [MOD, '\\']],
  ['Go to Today', ['G', 'T']],
  ['Go to My Tasks', ['G', 'M']],
  ['Go to Upcoming', ['G', 'U']],
  ['Go to Team', ['G', 'E']],
  ['Go to All Tasks', ['G', 'A']],
  ['Go to Calendar', ['G', 'C']],
  ['Go to Completed', ['G', 'D']],
  ['Settings', ['G', 'S']],
  ['Show shortcuts', ['?']],
];

const EDITOR_SHORTCUTS: [string, string[]][] = [
  ['Insert block menu', ['/']],
  ['New task', ['[', ']', 'Space']],
  ['Turn line into task', [MOD, '↵']],
  ['Bold / Italic / Underline', [MOD, 'B / I / U']],
  ['Heading 1–3', ['#', 'Space']],
  ['Bulleted / numbered list', ['-', 'or', '1.']],
  ['Undo / Redo', [MOD, 'Z / ⇧Z']],
];

export function ShortcutsHelp() {
  const open = useStore((s) => s.shortcutsOpen);
  return (
    <Modal open={open} onClose={() => ui.setShortcuts(false)} className="shortcuts" label="Keyboard shortcuts">
      <h2>Keyboard shortcuts</h2>
      <div className="shortcut-cols">
        <div>
          <h4>Navigation</h4>
          {SHORTCUTS.map(([label, keys]) => (
            <div className="shortcut" key={label}>
              <span>{label}</span>
              <span>{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
            </div>
          ))}
        </div>
        <div>
          <h4>In a note</h4>
          {EDITOR_SHORTCUTS.map(([label, keys]) => (
            <div className="shortcut" key={label}>
              <span>{label}</span>
              <span>{keys.map((k, i) => (k === 'or' ? <span key={i} className="muted small"> or </span> : <Kbd key={i}>{k}</Kbd>))}</span>
            </div>
          ))}
          <h4 style={{ marginTop: 20 }}>Quick add language</h4>
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
    </Modal>
  );
}

export function OfflineBanner() {
  const online = useStore((s) => s.online);
  if (online) return null;
  return <div className="offline-banner">You’re offline. Notes you’ve opened stay editable and will sync when you reconnect.</div>;
}
