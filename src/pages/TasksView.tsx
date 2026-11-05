import { useEffect, useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, SlidersHorizontal, X } from 'lucide-react';
import { useStore, ui, updateTask } from '../store.ts';
import { get } from '../api.ts';
import { TaskGroups, TaskRow } from '../components/TaskRow.tsx';
import { Avatar } from '../components/ui.tsx';
import {
  DEFAULT_FILTERS,
  VIEWS,
  applyFilters,
  groupBy,
  isMine,
  memberStats,
  sortTasks,
  todayGroups,
  upcomingGroups,
  visibleOpen,
  type Filters,
  type GroupKey,
  type SortKey,
  type ViewId,
} from '../lib/taskViews.ts';
import { addDays, parseISODate, toISODate, today } from '../../shared/dates.ts';
import type { Task } from '../../shared/types.ts';
import { longDate } from '../lib/format.ts';

export function TasksView() {
  const { view } = useParams() as { view: ViewId };
  if (!VIEWS.some((v) => v.id === view)) return <Navigate to="../today" replace />;
  const label = VIEWS.find((v) => v.id === view)!.label;
  return (
    <div className="tasks-page">
      {view === 'calendar' ? (
        <CalendarView />
      ) : (
        <div className="tasks-inner">
          <header className="view-head">
            <h1>{label}</h1>
            <ViewSubtitle view={view} />
          </header>
          {view === 'today' && <TodayView />}
          {view === 'my' && <MyView />}
          {view === 'upcoming' && <UpcomingView />}
          {view === 'team' && <TeamView />}
          {view === 'all' && <AllView />}
          {view === 'completed' && <CompletedView />}
        </div>
      )}
    </div>
  );
}

function ViewSubtitle({ view }: { view: ViewId }) {
  const text: Partial<Record<ViewId, string>> = {
    today: 'Due today and overdue, assigned to you.',
    my: 'Everything assigned to you — from every note.',
    upcoming: 'What’s coming up over the next two weeks.',
    team: 'Who’s working on what across the workspace.',
    all: 'Every task in the workspace. Filter, sort and group.',
    completed: 'Recently finished work.',
  };
  return <p className="muted">{text[view]}</p>;
}

function useOpen() {
  const tasks = useStore((s) => s.tasks);
  const lingering = useStore((s) => s.lingering);
  return useMemo(() => visibleOpen(tasks, lingering), [tasks, lingering]);
}

function Loading() {
  return <div className="muted pad">Loading tasks…</div>;
}

function TodayView() {
  const open = useOpen();
  const me = useStore((s) => s.user!.id);
  const loaded = useStore((s) => s.tasksLoaded);
  const groups = useMemo(() => todayGroups(open, me), [open, me]);
  if (!loaded) return <Loading />;
  const empty = groups.every((g) => !g.tasks.length);
  return (
    <>
      <TaskGroups groups={groups} emptyText="" />
      {empty && (
        <div className="empty-state">
          <div className="empty-emoji">☀️</div>
          <strong>You’re all caught up</strong>
          <p className="muted">Nothing due today. Enjoy it — or plan ahead in Upcoming.</p>
        </div>
      )}
    </>
  );
}

function MyView() {
  const open = useOpen();
  const me = useStore((s) => s.user!.id);
  const tree = useStore((s) => s.tree);
  const members = useStore((s) => s.members);
  const loaded = useStore((s) => s.tasksLoaded);
  const [group, setGroup] = useState<GroupKey>('due');
  const groups = useMemo(
    () => groupBy(open.filter((t) => isMine(t, me)), group, 'due', { members, tree }),
    [open, me, group, members, tree],
  );
  if (!loaded) return <Loading />;
  return (
    <>
      <div className="toolbar">
        <Segmented
          value={group}
          onChange={setGroup}
          options={[
            ['due', 'By date'],
            ['note', 'By note'],
            ['priority', 'By priority'],
          ]}
        />
      </div>
      <TaskGroups groups={groups.length ? groups : [{ key: 'none', label: '', tasks: [] }]} emptyText="No tasks assigned to you." />
    </>
  );
}

function UpcomingView() {
  const open = useOpen();
  const me = useStore((s) => s.user!.id);
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const loaded = useStore((s) => s.tasksLoaded);
  const groups = useMemo(() => upcomingGroups(scope === 'mine' ? open.filter((t) => isMine(t, me)) : open), [open, me, scope]);
  if (!loaded) return <Loading />;
  return (
    <>
      <div className="toolbar">
        <Segmented value={scope} onChange={setScope} options={[['mine', 'Mine'], ['all', 'Everyone']]} />
      </div>
      <TaskGroups groups={groups} emptyText="Nothing scheduled." />
    </>
  );
}

function TeamView() {
  const tasks = useStore((s) => s.tasks);
  const members = useStore((s) => s.members);
  const open = useOpen();
  const loaded = useStore((s) => s.tasksLoaded);
  const [focus, setFocus] = useState<string | null | 'all'>('all');
  const all = useMemo(() => Object.values(tasks), [tasks]);
  const people: { id: string | null; name: string; color?: string }[] = [
    ...members.filter((m) => m.role !== 'viewer' || all.some((t) => t.assigneeId === m.id)),
    { id: null, name: 'Unassigned' },
  ];
  if (!loaded) return <Loading />;
  const shown = focus === 'all' ? people : people.filter((p) => p.id === focus);
  return (
    <>
      <div className="team-grid">
        {people.map((p) => {
          const s = memberStats(all, p.id);
          const total = s.open + s.doneThisWeek;
          return (
            <button
              key={p.id ?? 'none'}
              className={`team-card ${focus === p.id ? 'is-active' : ''}`}
              onClick={() => setFocus(focus === p.id ? 'all' : p.id)}
            >
              <div className="row gap-8">
                {p.id ? <Avatar user={p as { name: string; color: string }} size={28} /> : <Avatar user={null} size={28} />}
                <strong className="truncate">{p.name}</strong>
              </div>
              <div className="team-stats">
                <span>
                  <b>{s.open}</b> open
                </span>
                {s.overdue > 0 && (
                  <span className="danger">
                    <b>{s.overdue}</b> overdue
                  </span>
                )}
                <span>
                  <b>{s.doneThisWeek}</b> done this week
                </span>
              </div>
              <div className="progress">
                <div style={{ width: total ? `${(s.doneThisWeek / total) * 100}%` : 0 }} />
              </div>
            </button>
          );
        })}
      </div>
      {shown.map((p) => {
        const list = sortTasks(open.filter((t) => t.assigneeId === p.id));
        if (focus === 'all' && !list.length) return null;
        return (
          <section key={p.id ?? 'none'} className="task-group">
            <h3 className="group-title">
              {p.name}
              <span className="group-count">{list.length || ''}</span>
            </h3>
            {list.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
            {!list.length && <p className="muted small pad">No open tasks.</p>}
          </section>
        );
      })}
    </>
  );
}

function AllView() {
  const open = useOpen();
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.user!.id);
  const tree = useStore((s) => s.tree);
  const members = useStore((s) => s.members);
  const loaded = useStore((s) => s.tasksLoaded);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>('due');
  const [group, setGroup] = useState<GroupKey>('none');
  const [showDone, setShowDone] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const source = showDone ? Object.values(tasks) : open;
  const filtered = useMemo(() => applyFilters(source, filters, me, tree), [source, filters, me, tree]);
  const groups = useMemo(() => groupBy(filtered, group, sort, { members, tree }), [filtered, group, sort, members, tree]);
  const active = Object.entries(filters).filter(([k, v]) => v !== DEFAULT_FILTERS[k as keyof Filters]).length;
  const f = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((x) => ({ ...x, [k]: v }));
  if (!loaded) return <Loading />;
  return (
    <>
      <div className="toolbar wrap">
        <input className="input" style={{ flex: '1 1 200px' }} placeholder="Filter tasks…" value={filters.q} onChange={(e) => f('q', e.target.value)} />
        <button className={`btn btn-secondary ${active ? 'is-active' : ''}`} onClick={() => setShowFilters((v) => !v)}>
          <SlidersHorizontal size={15} /> Filters{active ? ` · ${active}` : ''}
        </button>
        <label className="select-label">
          Sort
          <select className="input input-sm" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="due">Due date</option>
            <option value="priority">Priority</option>
            <option value="created">Newest</option>
            <option value="title">Name</option>
          </select>
        </label>
        <label className="select-label">
          Group
          <select className="input input-sm" value={group} onChange={(e) => setGroup(e.target.value as GroupKey)}>
            <option value="none">None</option>
            <option value="due">Due date</option>
            <option value="assignee">Assignee</option>
            <option value="note">Note</option>
            <option value="priority">Priority</option>
          </select>
        </label>
        <label className="check-label">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show completed
        </label>
      </div>
      {showFilters && (
        <div className="filters">
          <label>
            Assignee
            <select className="input input-sm" value={filters.assignee} onChange={(e) => f('assignee', e.target.value)}>
              <option value="any">Anyone</option>
              <option value="me">Me</option>
              <option value="unassigned">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due
            <select className="input input-sm" value={filters.due} onChange={(e) => f('due', e.target.value as Filters['due'])}>
              <option value="any">Any time</option>
              <option value="overdue">Overdue</option>
              <option value="today">Today or earlier</option>
              <option value="week">Next 7 days</option>
              <option value="none">No date</option>
            </select>
          </label>
          <label>
            Priority
            <select className="input input-sm" value={filters.priority} onChange={(e) => f('priority', e.target.value as Filters['priority'])}>
              <option value="any">Any</option>
              <option value="1">P1</option>
              <option value="2">P2</option>
              <option value="3">P3</option>
              <option value="4">None</option>
            </select>
          </label>
          <label>
            Source
            <select className="input input-sm" value={filters.source} onChange={(e) => f('source', e.target.value as Filters['source'])}>
              <option value="any">Anywhere</option>
              <option value="notes">In notes</option>
              <option value="standalone">Standalone</option>
            </select>
          </label>
          <label>
            Notebook
            <select className="input input-sm" value={filters.notebookId} onChange={(e) => f('notebookId', e.target.value)}>
              <option value="any">Any</option>
              {tree.notebooks.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          {active > 0 && (
            <button className="btn-ghost btn-sm" onClick={() => setFilters(DEFAULT_FILTERS)}>
              <X size={14} /> Clear
            </button>
          )}
        </div>
      )}
      <div className="muted small result-count">
        {filtered.length} task{filtered.length === 1 ? '' : 's'}
      </div>
      <TaskGroups groups={groups} emptyText="No tasks match these filters." addable={false} />
    </>
  );
}

function CompletedView() {
  const wsId = useStore((s) => s.wsId);
  const live = useStore((s) => s.tasks);
  const [items, setItems] = useState<Task[] | null>(null);
  const [more, setMore] = useState(true);
  useEffect(() => {
    setItems(null);
    get<Task[]>(`/workspaces/${wsId}/tasks/completed`).then((r) => {
      setItems(r);
      setMore(r.length === 100);
    });
  }, [wsId]);
  // Merge with live store so un-completing / new completions reflect instantly.
  const merged = useMemo(() => {
    if (!items) return null;
    const map = new Map(items.map((t) => [t.id, live[t.id] ?? t]));
    for (const t of Object.values(live)) if (t.status === 'done') map.set(t.id, t);
    return [...map.values()].filter((t) => t.status === 'done').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  }, [items, live]);
  if (!merged) return <Loading />;
  const groups = new Map<string, Task[]>();
  for (const t of merged) {
    const d = toISODate(new Date(t.completedAt!));
    groups.set(d, [...(groups.get(d) ?? []), t]);
  }
  return (
    <>
      {[...groups.entries()].map(([d, list]) => (
        <section key={d} className="task-group">
          <h3 className="group-title">{d === today() ? 'Today' : d === addDays(today(), -1) ? 'Yesterday' : longDate(d)}</h3>
          {list.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </section>
      ))}
      {!merged.length && <div className="empty">Nothing completed yet.</div>}
      {more && merged.length > 0 && (
        <button
          className="btn btn-secondary"
          onClick={() => {
            const last = items![items!.length - 1];
            get<Task[]>(`/workspaces/${wsId}/tasks/completed?before=${encodeURIComponent(last.completedAt!)}`).then((r) => {
              setItems((x) => [...(x ?? []), ...r]);
              setMore(r.length === 100);
            });
          }}
        >
          Load more
        </button>
      )}
    </>
  );
}

// ───────────── Calendar ─────────────

function CalendarView() {
  const open = useOpen();
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.user!.id);
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [showDone, setShowDone] = useState(false);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dropDay, setDropDay] = useState<string | null>(null);

  const list = (showDone ? Object.values(tasks) : open).filter((t) => t.dueDate && (scope === 'all' || isMine(t, me)));
  const byDay = new Map<string, Task[]>();
  for (const t of sortTasks(list)) byDay.set(t.dueDate!, [...(byDay.get(t.dueDate!) ?? []), t]);

  // 6-week grid starting on Monday.
  const start = new Date(month);
  start.setDate(1 - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => toISODate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
  const t = today();
  const title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(month);
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2024, 0, 1 + i)));

  return (
    <div className="calendar">
      <header className="cal-head">
        <h1>{title}</h1>
        <div className="row gap-6">
          <button className="btn btn-secondary btn-sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
            Today
          </button>
          <button className="btn-ghost icon-btn" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
            <ChevronLeft size={18} />
          </button>
          <button className="btn-ghost icon-btn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="row gap-10" style={{ marginLeft: 'auto' }}>
          <label className="check-label">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Completed
          </label>
          <Segmented value={scope} onChange={setScope} options={[['mine', 'Mine'], ['all', 'Everyone']]} />
        </div>
      </header>
      <div className="cal-grid cal-weekdays">
        {weekdays.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="cal-grid cal-days">
        {days.map((d) => {
          const inMonth = parseISODate(d).getMonth() === month.getMonth();
          const items = byDay.get(d) ?? [];
          return (
            <div
              key={d}
              className={`cal-day ${inMonth ? '' : 'is-out'} ${d === t ? 'is-today' : ''} ${d < t ? 'is-past' : ''} ${dropDay === d ? 'is-drop' : ''}`}
              onDragOver={(e) => {
                if (canEdit && e.dataTransfer.types.includes('application/x-task')) {
                  e.preventDefault();
                  setDropDay(d);
                }
              }}
              onDragLeave={() => setDropDay((x) => (x === d ? null : x))}
              onDrop={(e) => {
                setDropDay(null);
                const id = e.dataTransfer.getData('application/x-task');
                if (id) void updateTask(id, { dueDate: d });
              }}
              onDoubleClick={() => canEdit && ui.openQuickAdd({ dueDate: d })}
            >
              <div className="cal-date">
                <span>{parseISODate(d).getDate()}</span>
                {canEdit && (
                  <button className="btn-ghost icon-btn sm cal-add" title="Add task" onClick={() => ui.openQuickAdd({ dueDate: d })}>
                    <Plus size={13} />
                  </button>
                )}
              </div>
              <div className="cal-items">
                {items.slice(0, 4).map((x) => (
                  <div
                    key={x.id}
                    className={`cal-task p${x.priority} ${x.status === 'done' ? 'is-done' : ''} ${x.dueDate! < t && x.status === 'open' ? 'is-overdue' : ''}`}
                    draggable={canEdit}
                    onDragStart={(e) => e.dataTransfer.setData('application/x-task', x.id)}
                    onClick={() => ui.openTask(x.id)}
                    title={x.title}
                  >
                    {x.dueTime && <span className="cal-time">{x.dueTime}</span>}
                    {x.title || 'Untitled'}
                  </div>
                ))}
                {items.length > 4 && <div className="cal-more muted small">+{items.length - 4} more</div>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted small pad">Drag tasks between days to reschedule. Double-click a day to add a task.</p>
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="segmented" role="tablist">
      {options.map(([v, l]) => (
        <button key={v} role="tab" aria-selected={value === v} className={value === v ? 'is-active' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}
