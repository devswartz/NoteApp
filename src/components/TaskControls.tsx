// Reusable task property pickers: due date, assignee, priority, recurrence.
import { useEffect, useState } from 'react';
import { CalendarDays, Flag, Repeat, Sun, Sunrise, CalendarClock, Ban, UserRound } from 'lucide-react';
import { useStore } from '../store.ts';
import { groupAssignees } from '../lib/assigneeGroups.ts';
import { loadPagePeople, useShared } from './sharing/sharedPages.ts';
import { addDays, parseISODate, today, toISODate, describeRecurrence } from '../../shared/dates.ts';
import type { Priority, Recurrence, Task } from '../../shared/types.ts';
import { Avatar, Dropdown, MenuItem, MenuLabel, MenuSeparator, useClosePopover } from './ui.tsx';
import { describeDue, dueTone, formatTime, initials } from '../lib/format.ts';
import { MiniCalendar } from './MiniCalendar.tsx';

export const PRIORITY_COLORS: Record<number, string> = {
  1: 'var(--p1)',
  2: 'var(--p2)',
  3: 'var(--p3)',
  4: 'var(--text-muted)',
};

function nextMonday() {
  const d = parseISODate(today());
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return toISODate(d);
}

export function DueMenu({ value, onChange }: { value: string | null; onChange: (d: string | null) => void }) {
  const close = useClosePopover();
  const t = today();
  const weekend = (() => {
    const d = parseISODate(t);
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
    return toISODate(d);
  })();
  return (
    <div className="menu">
      <MenuItem icon={<Sun size={15} />} hint={shortDay(t)} onSelect={() => onChange(t)} checked={value === t}>
        Today
      </MenuItem>
      <MenuItem icon={<Sunrise size={15} />} hint={shortDay(addDays(t, 1))} onSelect={() => onChange(addDays(t, 1))} checked={value === addDays(t, 1)}>
        Tomorrow
      </MenuItem>
      {weekend !== t && (
        <MenuItem icon={<CalendarDays size={15} />} hint={shortDay(weekend)} onSelect={() => onChange(weekend)} checked={value === weekend}>
          This weekend
        </MenuItem>
      )}
      <MenuItem icon={<CalendarClock size={15} />} hint={shortDay(nextMonday())} onSelect={() => onChange(nextMonday())} checked={value === nextMonday()}>
        Next week
      </MenuItem>
      {value && (
        <MenuItem icon={<Ban size={15} />} onSelect={() => onChange(null)}>
          No date
        </MenuItem>
      )}
      <MenuSeparator />
      {/* Built-in calendar, not <input type="date">: the native picker's month arrows change the value, which set the date and closed the menu. */}
      <MiniCalendar
        value={value}
        label="Due date"
        onSelect={(d) => {
          onChange(d);
          close();
        }}
      />
    </div>
  );
}

function shortDay(d: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(parseISODate(d));
}

type Person = { id: string; name: string; color: string; email: string; role?: string };

/**
 * Who a task can be assigned to (#98 follow-up). A task in the current workspace: its members, plus,
 * for a task on a page shared one by one, the people it is shared with. A task on a page shared
 * from another workspace: the people who can open that page (GET /pages/:id/people), nobody else.
 */
function useAssignable(task?: { pageId: string | null; workspaceId: string }, load = false): Person[] {
  const members = useStore((s) => s.members);
  const wsId = useStore((s) => s.wsId);
  const pageId = task?.pageId ?? null;
  const people = useShared((s) => (pageId ? s.people[pageId] : undefined));
  useEffect(() => {
    if (load && pageId) void loadPagePeople(pageId, true);
  }, [load, pageId]);
  if (task && task.workspaceId !== wsId)
    return (people ?? []).filter((p) => p.canEdit || !p.member).map((p) => ({ ...p, email: '' }));
  const grantees = (people ?? []).filter((p) => !p.member).map((p) => ({ ...p, email: '', role: 'member' }));
  return [...members, ...grantees];
}

/**
 * Pick an assignee. Me is pinned at the top, then everyone under their teams (subteams nested; a person in two teams is
 * under both; people in no team last) and Unassigned at the bottom. The headings are labels only. With `teamId`, that
 * team (and its subteams) comes first. Searching flattens the list and shows each person's teams in muted text.
 */
export function AssigneeMenu({
  value,
  onChange,
  teamId,
  task,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  teamId?: string | null;
  /** The task being assigned: on a shared page, the people it is shared with can be picked too. */
  task?: { pageId: string | null; workspaceId: string };
}) {
  const members = useAssignable(task, true);
  const me = useStore((s) => s.user?.id);
  const teams = useStore((s) => s.teams);
  const [q, setQ] = useState('');
  const pickable = members.filter((m) => m.role !== 'viewer' || m.id === value);
  const byId = new Map(pickable.map((m) => [m.id, m]));
  const { groups: all, teamsOf } = groupAssignees(teams, pickable.map((m) => ({ id: m.id, name: m.name })));
  // The task's own team (and its subteams) first.
  const own = (g: (typeof all)[number]) => !!teamId && (g.teamId === teamId || teams.find((t) => t.id === g.teamId)?.parentId === teamId);
  const groups = [...all.filter(own), ...all.filter((g) => !own(g))];
  const query = q.trim().toLowerCase();
  const item = (id: string, key: string, depth = 0, showTeams = false) => {
    const m = byId.get(id)!;
    return (
      <MenuItem key={key} icon={<Avatar user={m} size={18} />} onSelect={() => onChange(m.id)} checked={value === m.id}>
        <span style={depth ? { paddingLeft: depth * 12 } : undefined}>
          {m.name}
          {m.id === me && <span className="muted"> (you)</span>}
          {showTeams && teamsOf.get(m.id) && <span className="muted small"> · {teamsOf.get(m.id)!.join(', ')}</span>}
        </span>
      </MenuItem>
    );
  };
  const meMember = me ? byId.get(me) : undefined;
  const matches = query ? pickable.filter((m) => `${m.name} ${m.email} ${(teamsOf.get(m.id) ?? []).join(' ')}`.toLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name)) : [];
  return (
    <div className="menu">
      {members.length > 6 && (
        <div className="menu-pad">
          <input autoFocus className="input input-sm" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {query ? (
        <>
          {matches.map((m) => item(m.id, m.id, 0, true))}
          {!matches.length && <div className="menu-pad muted small">No matches.</div>}
        </>
      ) : (
        <>
          {meMember && item(meMember.id, `me-${meMember.id}`)}
          {groups.map((g) => (
            <div key={g.key} data-team-group={g.name || undefined}>
              {g.name ? <MenuLabel>{g.depth ? <span style={{ paddingLeft: 12 }}>{g.name}</span> : g.name}</MenuLabel> : <MenuLabel>Assign to</MenuLabel>}
              {g.direct.filter((id) => g.name || id !== me).map((id) => item(id, `${g.key}-${id}`, g.depth))}
            </div>
          ))}
        </>
      )}
      <MenuSeparator />
      <MenuItem icon={<UserRound size={15} />} onSelect={() => onChange(null)} checked={!value}>
        Unassigned
      </MenuItem>
    </div>
  );
}

export function PriorityMenu({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  return (
    <div className="menu">
      {([1, 2, 3, 4] as Priority[]).map((p) => (
        <MenuItem
          key={p}
          icon={<Flag size={15} color={PRIORITY_COLORS[p]} fill={p < 4 ? PRIORITY_COLORS[p] : 'none'} />}
          onSelect={() => onChange(p)}
          checked={value === p}
          hint={`p${p}`}
        >
          {p === 4 ? 'No priority' : `Priority ${p}`}
        </MenuItem>
      ))}
    </div>
  );
}

const RECURRENCE_PRESETS: { label: string; value: Recurrence | null }[] = [
  { label: 'Does not repeat', value: null },
  { label: 'Every day', value: { freq: 'day', interval: 1 } },
  { label: 'Every weekday', value: { freq: 'weekday' } },
  { label: 'Every week', value: { freq: 'week', interval: 1 } },
  { label: 'Every 2 weeks', value: { freq: 'week', interval: 2 } },
  { label: 'Every month', value: { freq: 'month', interval: 1 } },
  { label: 'Every year', value: { freq: 'year', interval: 1 } },
];

export function RecurrenceMenu({ value, onChange }: { value: Recurrence | null; onChange: (r: Recurrence | null) => void }) {
  const close = useClosePopover();
  const [n, setN] = useState(value && value.freq !== 'weekday' ? value.interval : 3);
  const [unit, setUnit] = useState<'day' | 'week' | 'month' | 'year'>(value && value.freq !== 'weekday' ? value.freq : 'day');
  const same = (a: Recurrence | null, b: Recurrence | null) => JSON.stringify(a) === JSON.stringify(b);
  return (
    <div className="menu">
      {RECURRENCE_PRESETS.map((p) => (
        <MenuItem key={p.label} icon={<Repeat size={15} />} onSelect={() => onChange(p.value)} checked={same(value, p.value)}>
          {p.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <form
        className="menu-pad row gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (n >= 1) onChange({ freq: unit, interval: n });
          close();
        }}
      >
        <span className="muted small">Every</span>
        <input type="number" min={1} max={365} className="input input-sm" style={{ width: 56 }} value={n} onChange={(e) => setN(Number(e.target.value))} />
        <select className="input input-sm" value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
          <option value="day">days</option>
          <option value="week">weeks</option>
          <option value="month">months</option>
          <option value="year">years</option>
        </select>
        <button className="btn btn-sm">Set</button>
      </form>
    </div>
  );
}

/** Compact due-date chip that opens the date menu. */
export function DueChip({ task, onChange, readOnly }: { task: Task; onChange: (d: string | null) => void; readOnly?: boolean }) {
  const tone = task.status === 'done' ? 'none' : dueTone(task.dueDate);
  const label = (
    <>
      <CalendarDays size={13} />
      {task.dueDate ? describeDue(task.dueDate) : null}
      {task.dueTime ? ` ${formatTime(task.dueTime)}` : null}
      {task.recurrence && <Repeat size={11} aria-label={describeRecurrence(task.recurrence)} />}
    </>
  );
  if (readOnly) return task.dueDate ? <span className={`chip due-${tone}`}>{label}</span> : null;
  return (
    <Dropdown
      trigger={label}
      buttonClass={`chip chip-btn chip-due due-${tone} ${task.dueDate ? '' : 'chip-empty'}`}
      title={task.dueDate ? `Due ${describeDue(task.dueDate)}` : 'Set due date'}
    >
      <DueMenu value={task.dueDate} onChange={onChange} />
    </Dropdown>
  );
}

export function AssigneeChip({ task, onChange, readOnly }: { task: Task; onChange: (id: string | null) => void; readOnly?: boolean }) {
  const people = useAssignable(task);
  const member = people.find((m) => m.id === task.assigneeId);
  // Assigned to someone outside the workspace (a page share): learn their name from the page.
  const unknown = !!task.assigneeId && !member && !!task.pageId;
  useEffect(() => {
    if (unknown) void loadPagePeople(task.pageId!);
  }, [unknown, task.pageId]);
  // The accessible name starts with the visible initials ("label in name", WCAG 2.5.3).
  const label = member ? `${initials(member.name)} – assigned to ${member.name}` : 'Unassigned';
  const avatar = <Avatar user={member} size={20} title={label} />;
  if (readOnly) return member ? avatar : null;
  return (
    <Dropdown trigger={avatar} buttonClass={`avatar-btn ${member ? '' : 'avatar-btn-empty'}`} title={member ? label : 'Assign'} placement="bottom-end">
      <AssigneeMenu value={task.assigneeId} onChange={onChange} task={task} />
    </Dropdown>
  );
}

export function TaskCheckbox({ task, onToggle, disabled }: { task: Task; onToggle: () => void; disabled?: boolean }) {
  const done = task.status === 'done';
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? 'Mark as not done' : 'Complete task'}
      disabled={disabled}
      className={`task-check ${done ? 'is-done' : ''} p${task.priority}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** Compact priority flag that opens the priority menu. Hidden for "no priority" until hover. */
export function PriorityChip({ task, onChange, readOnly }: { task: Task; onChange: (p: Priority) => void; readOnly?: boolean }) {
  const p = task.priority;
  const label = <Flag size={13} color={PRIORITY_COLORS[p]} fill={p < 4 ? PRIORITY_COLORS[p] : 'none'} aria-label={p < 4 ? `Priority ${p}` : 'No priority'} />;
  if (readOnly) return p < 4 ? <span className="chip">{label}</span> : null;
  return (
    <Dropdown trigger={label} buttonClass={`chip chip-btn ${p < 4 ? '' : 'chip-empty'}`} title={p < 4 ? `Priority ${p}` : 'Set priority'}>
      <PriorityMenu value={p} onChange={onChange} />
    </Dropdown>
  );
}
