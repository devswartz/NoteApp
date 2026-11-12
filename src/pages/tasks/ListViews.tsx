// Today, My Tasks, Upcoming and Team views.
import { useMemo, useState } from 'react';
import { useStore } from '../../store.ts';
import { RowList, TaskGroups } from '../../components/TaskRow.tsx';
import { Avatar, useIsMobile } from '../../components/ui.tsx';
import { activeFilterKeys, groupBy, isMine, memberStats, productivity, sortTasks, todayGroups, upcomingGroups } from '../../lib/taskViews.ts';
import { taskView, useTaskView } from './taskViewState.ts';
import { addDays, parseISODate, today } from '../../../shared/dates.ts';
import { Loading, Segmented, useOpen, useViewFilter } from './common.tsx';

export function TodayView() {
  const open = useOpen();
  const me = useStore((s) => s.user!.id);
  const loaded = useStore((s) => s.tasksLoaded);
  const filter = useViewFilter();
  const filtering = useTaskView((s) => activeFilterKeys(s.filters).length > 0);
  const groups = useMemo(() => todayGroups(filter(open), me), [open, me, filter]);
  if (!loaded) return <Loading />;
  const empty = groups.every((g) => !g.tasks.length);
  return (
    <>
      <ProductivityStrip />
      <TaskGroups groups={groups} emptyText="" />
      {empty && filtering && <div className="empty">No tasks due today match these filters.</div>}
      {empty && !filtering && (
        <div className="empty-state">
          <div className="empty-emoji">☀️</div>
          <strong>You’re all caught up</strong>
          <p className="muted">Nothing due today. Enjoy it — or plan ahead in Upcoming.</p>
        </div>
      )}
    </>
  );
}

export function MyView() {
  const open = useOpen();
  const me = useStore((s) => s.user!.id);
  const tree = useStore((s) => s.tree);
  const members = useStore((s) => s.members);
  const loaded = useStore((s) => s.tasksLoaded);
  // Grouping is in the ribbon on desktop and tablet (./taskViewState.ts); phones get the switch here.
  const group = useTaskView((s) => s.myGroup);
  const isMobile = useIsMobile();
  const filter = useViewFilter();
  const groups = useMemo(
    () => groupBy(filter(open.filter((t) => isMine(t, me))), group, 'due', { members, tree }),
    [open, me, group, members, tree, filter],
  );
  if (!loaded) return <Loading />;
  return (
    <>
      {isMobile && (
        <div className="toolbar">
          <Segmented
            value={group}
            onChange={taskView.setMyGroup}
            options={[
              ['due', 'By date'],
              ['note', 'By page'],
              ['priority', 'By priority'],
            ]}
          />
        </div>
      )}
      <TaskGroups groups={groups.length ? groups : [{ key: 'none', label: '', tasks: [] }]} emptyText="No tasks assigned to you." />
    </>
  );
}

export function UpcomingView() {
  const open = useOpen();
  const me = useStore((s) => s.user!.id);
  const scope = useTaskView((s) => s.upcomingScope);
  const isMobile = useIsMobile();
  const loaded = useStore((s) => s.tasksLoaded);
  const filter = useViewFilter();
  const groups = useMemo(() => upcomingGroups(filter(scope === 'mine' ? open.filter((t) => isMine(t, me)) : open)), [open, me, scope, filter]);
  if (!loaded) return <Loading />;
  return (
    <>
      {isMobile && (
        <div className="toolbar">
          <Segmented value={scope} onChange={taskView.setUpcomingScope} options={[['mine', 'Mine'], ['all', 'Everyone']]} />
        </div>
      )}
      <TaskGroups groups={groups} emptyText="Nothing scheduled." />
    </>
  );
}

export function TeamView() {
  const [by, setBy] = useState<'person' | 'team'>('person');
  const hasTeams = useStore((s) => s.teams.length > 0);
  return (
    <>
      {hasTeams && (
        <div className="toolbar">
          <Segmented value={by} onChange={setBy} options={[['person', 'By person'], ['team', 'By team']]} />
        </div>
      )}
      {by === 'team' && hasTeams ? <ByTeam /> : <ByPerson />}
    </>
  );
}

/** Open tasks grouped by their team (subteams as "Team › Subteam"), then "No team". */
function ByTeam() {
  const open = useOpen();
  const members = useStore((s) => s.members);
  const tree = useStore((s) => s.tree);
  const teams = useStore((s) => s.teams);
  const loaded = useStore((s) => s.tasksLoaded);
  const filter = useViewFilter();
  const groups = useMemo(() => groupBy(filter(open), 'team', 'due', { members, tree, teams }), [open, members, tree, teams, filter]);
  if (!loaded) return <Loading />;
  return <TaskGroups groups={groups.length ? groups : [{ key: 'none', label: '', tasks: [] }]} emptyText="No open tasks." />;
}

function ByPerson() {
  const tasks = useStore((s) => s.tasks);
  const members = useStore((s) => s.members);
  const open = useOpen();
  const filter = useViewFilter();
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
        const list = sortTasks(filter(open.filter((t) => t.assigneeId === p.id)));
        if (focus === 'all' && !list.length) return null;
        return (
          <section key={p.id ?? 'none'} className="task-group">
            <h3 className="group-title">
              {p.name}
              <span className="group-count">{list.length || ''}</span>
            </h3>
            <RowList tasks={list} />
            {!list.length && <p className="muted small pad">No open tasks.</p>}
          </section>
        );
      })}
    </>
  );
}

/** Done today, what's left, completion streak and the last 7 days. */
function ProductivityStrip() {
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.user!.id);
  const p = useMemo(() => productivity(Object.values(tasks), me), [tasks, me]);
  const total = p.doneToday + p.left;
  const max = Math.max(1, ...p.week);
  const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  const t = today();
  return (
    <div className="prod-strip" aria-label="Your progress">
      <div className="prod-stat">
        <b>{p.doneToday}</b>
        <span>done today</span>
      </div>
      <div className="prod-stat">
        <b>{p.left}</b>
        <span>left</span>
      </div>
      <div className="prod-stat" title="Days in a row with at least one completed task">
        <b>
          {p.streak}
          {p.streak >= 30 ? '+' : ''}
        </b>
        <span>day streak{p.streak >= 3 ? ' 🔥' : ''}</span>
      </div>
      <div className="prod-week" aria-label="Completed per day, last 7 days">
        {p.week.map((n, i) => {
          const d = addDays(t, i - 6);
          return (
            <div key={d} className="prod-day" title={`${n} completed`}>
              <div className="prod-bar">
                <div style={{ height: `${(n / max) * 100}%` }} className={d === t ? 'is-today' : ''} />
              </div>
              <span>{dayName.format(parseISODate(d))}</span>
            </div>
          );
        })}
      </div>
      {total > 0 && (
        <div className="progress prod-progress" title={`${p.doneToday} of ${total} for today`}>
          <div style={{ width: `${(p.doneToday / total) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
