// Completed: finished work grouped by day, with paging and uncomplete.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store.ts';
import { get } from '../../api.ts';
import { RowList } from '../../components/TaskRow.tsx';
import { addDays, toISODate, today } from '../../../shared/dates.ts';
import type { Task } from '../../../shared/types.ts';
import { longDate } from '../../lib/format.ts';
import { Loading } from './common.tsx';

export function CompletedView() {
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
          <RowList tasks={list} />
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
