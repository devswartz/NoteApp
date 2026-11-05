// All Tasks: search, filter, sort and group everything in the workspace.
import { useMemo, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { useStore } from '../../store.ts';
import { TaskGroups } from '../../components/TaskRow.tsx';
import { DEFAULT_FILTERS, applyFilters, groupBy, type Filters, type GroupKey, type SortKey } from '../../lib/taskViews.ts';
import { Loading, useOpen } from './common.tsx';

export function AllView() {
  const open = useOpen();
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.user!.id);
  const tree = useStore((s) => s.tree);
  const members = useStore((s) => s.members);
  const loaded = useStore((s) => s.tasksLoaded);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>('due');
  const [group, setGroup] = useState<GroupKey>('none');
  const [showFilters, setShowFilters] = useState(false);
  // "Open" reads from the open list so just-completed tasks linger for their check animation.
  const filtered = useMemo(
    () =>
      filters.status === 'open'
        ? applyFilters(open, { ...filters, status: 'any' }, me, tree)
        : applyFilters(Object.values(tasks), filters, me, tree),
    [open, tasks, filters, me, tree],
  );
  const groups = useMemo(() => groupBy(filtered, group, sort, { members, tree }), [filtered, group, sort, members, tree]);
  // Search text and status have their own controls in the toolbar; don't count them on the Filters button.
  const active = Object.entries(filters).filter(([k, v]) => k !== 'q' && k !== 'status' && v !== DEFAULT_FILTERS[k as keyof Filters]).length;
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
        <label className="select-label">
          Status
          <select className="input input-sm" value={filters.status} onChange={(e) => f('status', e.target.value as Filters['status'])}>
            <option value="open">Open</option>
            <option value="done">Completed</option>
            <option value="any">All</option>
          </select>
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
            <button className="btn-ghost btn-sm" onClick={() => setFilters((x) => ({ ...DEFAULT_FILTERS, q: x.q, status: x.status }))}>
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
