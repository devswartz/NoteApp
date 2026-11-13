// Finished work for the Status filter (Completed, or All after the open tasks): newest completion
// first, grouped by day, with paging. Used by every task view; each passes the filter that scopes it.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store.ts';
import { get } from '../../api.ts';
import { RowList } from '../../components/TaskRow.tsx';
import { addDays, toISODate, today } from '../../../shared/dates.ts';
import type { Task } from '../../../shared/types.ts';
import { longDate } from '../../lib/format.ts';
import { Loading, useViewFilter } from './common.tsx';
import { activeFilterKeys, byCompletion, isMine } from '../../lib/taskViews.ts';
import { useTaskView } from './taskViewState.ts';
import type { ReactNode } from 'react';

export type StatusScope = 'all' | 'mine' | 'today' | 'dated' | 'datedMine';

/**
 * What the Status filter adds to a view: Open (default) shows the view as it is; Completed replaces it with the
 * finished tasks that fit the view (newest first, by day); All shows the open view, then the finished ones.
 * `scope` says which finished tasks belong: Today's (mine, due today or earlier), My Tasks' (mine), a dated one
 * (Upcoming), or any (Team).
 */
export function WithStatus({ scope, children }: { scope: StatusScope; children: ReactNode }) {
  const status = useTaskView((s) => s.filters.status);
  const me = useStore((s) => s.user!.id);
  const viewFilter = useViewFilter();
  const filtering = useTaskView((s) => activeFilterKeys({ ...s.filters, status: 'open' }).length > 0);
  const filter = useMemo(() => {
    const t = today();
    const fits = (x: Task) =>
      scope === 'all' ? true : scope === 'mine' ? isMine(x, me) : scope === 'today' ? isMine(x, me) && !!x.dueDate && x.dueDate <= t : scope === 'dated' ? !!x.dueDate : isMine(x, me) && !!x.dueDate;
    return (list: Task[]) => viewFilter(list.filter(fits));
  }, [scope, me, viewFilter]);
  return (
    <>
      {status !== 'done' && children}
      {status !== 'open' && <CompletedList filter={filter} filtering={filtering} heading={status === 'any' ? 'Completed' : undefined} />}
    </>
  );
}

export function CompletedList({ filter, filtering, heading }: { filter: (list: Task[]) => Task[]; filtering: boolean; heading?: string }) {
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
    return filter([...map.values()].filter((t) => t.status === 'done' && t.completedAt)).sort(byCompletion);
  }, [items, live, filter]);
  if (!merged) return <Loading />;
  const groups = new Map<string, Task[]>();
  for (const t of merged) {
    const d = toISODate(new Date(t.completedAt!));
    groups.set(d, [...(groups.get(d) ?? []), t]);
  }
  return (
    <div className="completed-list" data-testid="completed-list">
      {heading && merged.length > 0 && <h2 className="completed-heading">{heading}</h2>}
      {[...groups.entries()].map(([d, list]) => (
        <section key={d} className="task-group">
          <h3 className="group-title">{d === today() ? 'Today' : d === addDays(today(), -1) ? 'Yesterday' : longDate(d)}</h3>
          <RowList tasks={list} />
        </section>
      ))}
      {!merged.length && !heading && <div className="empty">{filtering ? 'No completed tasks match these filters.' : 'Nothing completed yet.'}</div>}
      {more && items!.length > 0 && (
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
    </div>
  );
}
