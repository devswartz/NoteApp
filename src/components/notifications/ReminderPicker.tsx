// Reminders for one task (yours): list, add (relative to the due date or at a
// fixed time) and remove. Self-contained; loads and saves through the API.
//
//   <ReminderPicker task={task} />
//
// Relative reminders follow the task when its due date moves or a recurring
// task rolls forward. Tasks with a date but no time use your default reminder
// time (Settings → Notifications).
import { useCallback, useEffect, useState } from 'react';
import { Bell, Plus, Trash2 } from 'lucide-react';
import { notificationsApi } from './api.ts';
import type { Reminder, ReminderSpec, Task } from '../../../shared/types.ts';
import './notifications.css';

const RELATIVE: { label: string; minutes: number }[] = [
  { label: 'At due time', minutes: 0 },
  { label: '10 minutes before', minutes: 10 },
  { label: '30 minutes before', minutes: 30 },
  { label: '1 hour before', minutes: 60 },
  { label: '1 day before', minutes: 1440 },
  { label: '2 days before', minutes: 2880 },
  { label: '1 week before', minutes: 10080 },
];

export function describeReminder(r: ReminderSpec): string {
  if (r.kind === 'at') return formatInstant(r.at);
  const preset = RELATIVE.find((p) => p.minutes === r.minutes);
  if (preset) return preset.label;
  const m = r.minutes;
  if (m % 1440 === 0) return `${m / 1440} days before`;
  if (m % 60 === 0) return `${m / 60} hours before`;
  return `${m} minutes before`;
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReminderPicker({ task, disabled, onError }: { task: Pick<Task, 'id' | 'dueDate' | 'dueTime' | 'status' | 'updatedAt'>; disabled?: boolean; onError?: (e: unknown) => void }) {
  const [list, setList] = useState<Reminder[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'before' | 'at'>(task.dueDate ? 'before' : 'at');
  const [minutes, setMinutes] = useState(task.dueTime ? 30 : 0);
  const [at, setAt] = useState(() => toLocalInput(new Date(Date.now() + 3600_000)));
  const fail = useCallback((e: unknown) => (onError ? onError(e) : console.error(e)), [onError]);

  // Reload when the task changes (due date moved, rolled forward…).
  useEffect(() => {
    let live = true;
    notificationsApi
      .reminders(task.id)
      .then((r) => live && setList(r))
      .catch((e) => live && (setList([]), fail(e)));
    return () => {
      live = false;
    };
  }, [task.id, task.updatedAt, fail]);

  const add = async () => {
    const spec: ReminderSpec = mode === 'before' ? { kind: 'before', minutes } : { kind: 'at', at: new Date(at).toISOString() };
    try {
      const r = await notificationsApi.addReminder(task.id, spec);
      setList((xs) => [...(xs ?? []), r]);
      setAdding(false);
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (id: string) => {
    const prev = list;
    setList((xs) => xs?.filter((x) => x.id !== id) ?? null);
    try {
      await notificationsApi.deleteReminder(id);
    } catch (e) {
      setList(prev);
      fail(e);
    }
  };

  return (
    <div className="rm">
      {list === null && <span className="muted small">Loading…</span>}
      {list?.map((r) => (
        <div key={r.id} className={`rm-item ${r.nextFireAt ? '' : 'rm-idle'}`}>
          <Bell size={13} />
          <span className="rm-label">{describeReminder(r)}</span>
          {!r.nextFireAt && (
            <span className="muted small" title={r.lastFiredAt ? `Sent ${formatInstant(r.lastFiredAt)}` : 'Needs a due date'}>
              {r.lastFiredAt ? 'sent' : task.status === 'done' ? 'done' : r.kind === 'before' && !task.dueDate ? 'no due date' : ''}
            </span>
          )}
          {!disabled && (
            <button type="button" className="icon-btn btn-ghost" aria-label="Remove reminder" title="Remove reminder" onClick={() => void remove(r.id)}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ))}
      {!disabled && !adding && (
        <button type="button" className="btn btn-ghost btn-sm rm-add" onClick={() => setAdding(true)}>
          <Plus size={14} /> {list?.length ? 'Add another' : 'Add reminder'}
        </button>
      )}
      {adding && (
        <form
          className="rm-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
          onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setAdding(false))}
        >
          <div className="segmented">
            <button type="button" className={mode === 'before' ? 'is-active' : ''} disabled={!task.dueDate} title={task.dueDate ? undefined : 'Set a due date first'} onClick={() => setMode('before')}>
              Before due
            </button>
            <button type="button" className={mode === 'at' ? 'is-active' : ''} onClick={() => setMode('at')}>
              At a time
            </button>
          </div>
          {mode === 'before' ? (
            <select className="input input-sm" aria-label="When" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} autoFocus>
              {RELATIVE.map((p) => (
                <option key={p.minutes} value={p.minutes}>
                  {p.label}
                </option>
              ))}
            </select>
          ) : (
            <input type="datetime-local" className="input input-sm" aria-label="Reminder time" value={at} onChange={(e) => setAt(e.target.value)} autoFocus />
          )}
          <button type="submit" className="btn btn-primary btn-sm">
            Add
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
