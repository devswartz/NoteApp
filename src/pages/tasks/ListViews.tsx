// Today, My Tasks, Upcoming and Team views.
import { useMemo, useState } from 'react';
import { useStore } from '../../store.ts';
import { TaskGroups, TaskRow } from '../../components/TaskRow.tsx';
import { Avatar } from '../../components/ui.tsx';
import { groupBy, isMine, memberStats, sortTasks, todayGroups, upcomingGroups, type GroupKey } from '../../lib/taskViews.ts';
import { Loading, Segmented, useOpen } from './common.tsx';

export function TodayView() {
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

export function MyView() {
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

export function UpcomingView() {
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

export function TeamView() {
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
