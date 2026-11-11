// Calendar: month and week layouts. Drag a task onto another day to reschedule it;
// drag one from the "No date" tray to schedule it.
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { ui, updateTask, useStore } from '../../store.ts';
import { isMine, sortTasks, teamScope } from '../../lib/taskViews.ts';
import { useIsMobile } from '../../components/ui.tsx';
import { addDays, parseISODate, toISODate, today } from '../../../shared/dates.ts';
import type { Task } from '../../../shared/types.ts';
import { formatTime } from '../../lib/format.ts';
import { Segmented, useOpen } from './common.tsx';

export type Mode = 'month' | 'week';
const DRAG_TYPE = 'application/x-task';

/** Monday on or before `d`. */
export function weekStart(d: string): string {
  return addDays(d, -((parseISODate(d).getDay() + 6) % 7));
}

/** The 42 days (6 weeks, Monday first) shown for the month containing `d`. */
export function monthGrid(d: string): string[] {
  const first = d.slice(0, 8) + '01';
  const start = weekStart(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** The date the calendar shows (?d=, default today); the Calendar panel's mini month sets it. */
export const calendarDate = (params: URLSearchParams) => {
  const d = params.get('d');
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today();
};
/** Assignee filter (?who=): 'mine' (default), 'all', 'none' (unassigned) or a user id. */
export const calendarWho = (params: URLSearchParams) => params.get('who') || 'mine';
/** Month (default) or week (?mode=week). The calendar has no day layout. */
export const calendarMode = (params: URLSearchParams): Mode => (params.get('mode') === 'week' ? 'week' : 'month');
/** Tag filter (?tags=id,id): tasks with any of these tags. */
export const calendarTags = (params: URLSearchParams) => (params.get('tags') ?? '').split(',').filter(Boolean);
/** Team filter (?team=id, or 'none'); a team includes its subteams. */
export const calendarTeam = (params: URLSearchParams) => params.get('team');

/** The date one month or week before (n = -1) or after (n = 1) `cursor`. */
export function stepCalendar(cursor: string, mode: Mode, n: number): string {
  if (mode === 'week') return addDays(cursor, 7 * n);
  const d = parseISODate(cursor);
  return toISODate(new Date(d.getFullYear(), d.getMonth() + n, 1));
}

/** Show `d` (today drops the param); optionally switch to week. Shared by the page and the ribbon. */
export const setCalendarDate = (p: URLSearchParams, d: string, toMode?: Mode) => {
  if (d === today()) p.delete('d');
  else p.set('d', d);
  if (toMode === 'week') p.set('mode', 'week');
  return p;
};
export const setCalendarMode = (p: URLSearchParams, m: Mode) => {
  if (m === 'week') p.set('mode', 'week');
  else p.delete('mode');
  return p;
};

export function CalendarView() {
  const open = useOpen();
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.user!.id);
  const teams = useStore((s) => s.teams);
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  // Desktop and tablet: Today, ◀ ▶ and Week / Month are in the ribbon (src/components/shell/SectionRibbons.tsx).
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const mode = calendarMode(params);
  const scope = calendarWho(params);
  const tagsParam = params.get('tags') ?? '';
  const teamParam = calendarTeam(params);
  const [showDone, setShowDone] = useState(false);
  const cursor = calendarDate(params);
  const setCursor = (d: string, toMode?: Mode) => setParams((p) => setCalendarDate(p, d, toMode), { replace: true });
  const [dropDay, setDropDay] = useState<string | null>(null);
  const t = today();

  const inScope = useMemo(() => {
    const tags = tagsParam.split(',').filter(Boolean);
    const team = teamParam && teamParam !== 'none' ? teamScope(teamParam, true, teams) : null;
    return (x: Task) =>
      (scope === 'all' ? true : scope === 'mine' ? isMine(x, me) : scope === 'none' ? !x.assigneeId : x.assigneeId === scope) &&
      (!tags.length || x.tagIds.some((id) => tags.includes(id))) &&
      (!teamParam || (teamParam === 'none' ? !x.teamId : !!x.teamId && team!.has(x.teamId)));
  }, [scope, me, tagsParam, teamParam, teams]);
  const byDay = useMemo(() => {
    const list = (showDone ? Object.values(tasks) : open).filter((x) => x.dueDate && inScope(x));
    const map = new Map<string, Task[]>();
    for (const x of sortTasks(list)) map.set(x.dueDate!, [...(map.get(x.dueDate!) ?? []), x]);
    return map;
  }, [tasks, open, showDone, inScope]);
  const undated = useMemo(() => sortTasks(open.filter((x) => !x.dueDate && x.status === 'open' && inScope(x)), 'priority'), [open, inScope]);

  const days = mode === 'month' ? monthGrid(cursor) : Array.from({ length: 7 }, (_, i) => addDays(weekStart(cursor), i));
  const month = parseISODate(cursor).getMonth();
  const step = (n: number) => setCursor(stepCalendar(cursor, mode, n));
  const title =
    mode === 'month'
      ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(parseISODate(cursor))
      : weekTitle(days[0], days[6]);
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2024, 0, 1 + i)));

  const drop = (e: React.DragEvent, day: string | null) => {
    e.preventDefault();
    setDropDay(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const task = id ? tasks[id] : undefined;
    if (!task || task.dueDate === day) return;
    void updateTask(id, day ? { dueDate: day } : { dueDate: null, dueTime: null });
  };
  const dropTarget = (day: string | null) =>
    canEdit
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropDay(day ?? 'none');
          },
          onDragLeave: () => setDropDay((x) => (x === (day ?? 'none') ? null : x)),
          onDrop: (e: React.DragEvent) => drop(e, day),
        }
      : {};

  const chip = (x: Task, full = false) => (
    <div
      key={x.id}
      className={`cal-task p${x.priority} ${x.status === 'done' ? 'is-done' : ''} ${x.dueDate && x.dueDate < t && x.status === 'open' ? 'is-overdue' : ''} ${full ? 'is-full' : ''}`}
      draggable={canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, x.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => ui.openTask(x.id)}
      onKeyDown={(e) => e.key === 'Enter' && ui.openTask(x.id)}
      role="button"
      tabIndex={0}
      title={x.title}
    >
      {x.dueTime && <span className="cal-time">{formatTime(x.dueTime)}</span>}
      {x.title || 'Untitled'}
    </div>
  );

  const limit = mode === 'month' ? 4 : Infinity;
  return (
    <div className={`calendar cal-${mode}`}>
      <header className="cal-head">
        <h1>{title}</h1>
        {isMobile && (
          <div className="row gap-6">
            <button className="btn btn-secondary btn-sm" onClick={() => setCursor(today())}>
              Today
            </button>
            <button className="btn-ghost icon-btn" aria-label={`Previous ${mode}`} onClick={() => step(-1)}>
              <ChevronLeft size={18} />
            </button>
            <button className="btn-ghost icon-btn" aria-label={`Next ${mode}`} onClick={() => step(1)}>
              <ChevronRight size={18} />
            </button>
          </div>
        )}
        <div className="row gap-10 wrap" style={{ marginLeft: 'auto' }}>
          <label className="check-label">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Completed
          </label>
          {isMobile && (
            <Segmented value={mode} onChange={(m) => setParams((p) => setCalendarMode(p, m), { replace: true })} options={[['month', 'Month'], ['week', 'Week']]} />
          )}
        </div>
      </header>
      <div className="cal-body">
        <div className="cal-main">
          <div className="cal-grid cal-weekdays">
            {weekdays.map((w, i) => (
              <div key={w}>
                {w}
                {mode === 'week' && <span className={`cal-wdate ${days[i] === t ? 'is-today' : ''}`}>{parseISODate(days[i]).getDate()}</span>}
              </div>
            ))}
          </div>
          <div className="cal-grid cal-days">
            {days.map((d) => {
              const items = byDay.get(d) ?? [];
              const out = mode === 'month' && parseISODate(d).getMonth() !== month;
              return (
                <div
                  key={d}
                  className={`cal-day ${out ? 'is-out' : ''} ${d === t ? 'is-today' : ''} ${d < t ? 'is-past' : ''} ${dropDay === d ? 'is-drop' : ''}`}
                  {...dropTarget(d)}
                  onDoubleClick={(e) => canEdit && e.target === e.currentTarget && ui.openQuickAdd({ dueDate: d })}
                  // Touch screens have no double-click. In Month the chips are too small to tap, so a
                  // tap anywhere on a day opens that week as an agenda; in Week a tap on a day adds.
                  onClick={(e) => {
                    if (!isTouch()) return;
                    if (mode === 'month') {
                      setCursor(d, 'week');
                    } else if (canEdit && e.target === e.currentTarget) ui.openQuickAdd({ dueDate: d });
                  }}
                  data-date={d}
                >
                  <div className="cal-date">
                    <span>{mode === 'month' ? parseISODate(d).getDate() : <span className="cal-mobile-label">{weekdayLabel(d)}</span>}</span>
                    {canEdit && (
                      <button className="btn-ghost icon-btn sm cal-add" title="Add task" onClick={() => ui.openQuickAdd({ dueDate: d })}>
                        <Plus size={13} />
                      </button>
                    )}
                  </div>
                  <div className="cal-items">
                    {items.slice(0, limit).map((x) => chip(x, mode === 'week'))}
                    {items.length > limit && (
                      <button
                        className="cal-more muted small"
                        onClick={() => {
                          setCursor(d, 'week');
                        }}
                      >
                        +{items.length - limit} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {canEdit && (
          <aside className={`cal-tray ${dropDay === 'none' ? 'is-drop' : ''}`} {...dropTarget(null)} aria-label="Tasks without a date">
            <h3 className="group-title">
              No date <span className="group-count">{undated.length || ''}</span>
            </h3>
            <div className="cal-items">{undated.map((x) => chip(x, true))}</div>
            {!undated.length && <p className="muted small">Drop a task here to clear its date.</p>}
          </aside>
        )}
      </div>
      <p className="muted small pad cal-hint-pointer">Drag tasks between days to reschedule. Double-click a day to add a task.</p>
      <p className="muted small pad cal-hint-touch">
        {mode === 'month' ? 'Tap a day to see its tasks.' : 'Tap a day to add a task. Tap a task to change its date.'}
      </p>
    </div>
  );
}

const isTouch = () => window.matchMedia('(hover: none), (max-width: 760px)').matches;

function weekTitle(a: string, b: string) {
  const da = parseISODate(a);
  const db = parseISODate(b);
  const md = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const y = new Intl.DateTimeFormat(undefined, { year: 'numeric' });
  return `${md.format(da)} – ${md.format(db)}, ${y.format(db)}`;
}

function weekdayLabel(d: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(parseISODate(d));
}
