// All Tasks: search, filter, sort and group everything in the workspace, and save the result as a view.
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bookmark, BookmarkPlus, MoreHorizontal, Users } from 'lucide-react';
import { useStore } from '../../store.ts';
import { TaskGroups } from '../../components/TaskRow.tsx';
import { Dropdown, MenuItem, MenuSeparator } from '../../components/ui.tsx';
import { confirmDialog, promptDialog } from '../../components/shell/dialogs.tsx';
import { DEFAULT_FILTERS, applyFilters, groupBy, type Filters, type GroupKey, type SortKey } from '../../lib/taskViews.ts';
import { Loading, useOpen } from './common.tsx';
import { FilterChips } from './FilterChips.tsx';
import { createSavedView, deleteSavedView, sameView, updateSavedView, useSavedViews, type SavedView } from './savedViews.ts';

export function AllView() {
  const open = useOpen();
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.user!.id);
  const tree = useStore((s) => s.tree);
  const members = useStore((s) => s.members);
  const teams = useStore((s) => s.teams);
  const loaded = useStore((s) => s.tasksLoaded);
  const wsId = useStore((s) => s.wsId!);
  const isAdmin = useStore((s) => ['owner', 'admin'].includes(s.workspaces.find((w) => w.id === s.wsId)?.role ?? ''));
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortKey>('due');
  const [group, setGroup] = useState<GroupKey>('none');
  const views = useSavedViews(wsId);
  const [params, setParams] = useSearchParams();
  const viewParam = params.get('view');
  const current = views.find((v) => sameView(v, filters, sort, group));

  const apply = (v: SavedView) => {
    setFilters(v.filters);
    setSort(v.sort);
    setGroup(v.group);
  };
  // ?view=<id> opens a saved view (links from the Tasks panel); applied once the views have loaded.
  // Only when the link changes: later edits to the filters (or a live reload of the views) mustn't snap back.
  const target = viewParam ? views.find((v) => v.id === viewParam) : undefined;
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!target || applied.current === target.id) return;
    applied.current = target.id;
    apply(target);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  // ?new=1 (the Tasks panel's "New view") starts from a clean slate to build a view.
  const newParam = params.get('new');
  useEffect(() => {
    if (!newParam) return;
    applied.current = null;
    setFilters(DEFAULT_FILTERS);
    setSort('due');
    setGroup('none');
  }, [newParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filtering thousands of tasks shouldn't block typing in the search box.
  const deferred = useDeferredValue(filters);
  // "Open" reads from the open list so just-completed tasks linger for their check animation.
  const filtered = useMemo(
    () =>
      deferred.status === 'open'
        ? applyFilters(open, { ...deferred, status: 'any' }, me, tree, teams)
        : applyFilters(Object.values(tasks), deferred, me, tree, teams),
    [open, tasks, deferred, me, tree, teams],
  );
  const groups = useMemo(() => groupBy(filtered, group, sort, { members, tree, teams }), [filtered, group, sort, members, tree, teams]);
  const f = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((x) => ({ ...x, [k]: v }));
  const select = (v: SavedView) => {
    apply(v);
    applied.current = v.id;
    setParams({ view: v.id }, { replace: true });
  };
  const save = async () => {
    const name = (await promptDialog({ title: 'Save view', label: 'Name', confirmLabel: 'Save' }))?.trim();
    if (!name) return;
    const v = await createSavedView(wsId, { name: name.slice(0, 60), filters, sort, group });
    if (!v) return;
    applied.current = v.id;
    setParams({ view: v.id }, { replace: true });
  };
  if (!loaded) return <Loading />;
  return (
    <>
      {views.length > 0 && (
        <div className="saved-views" role="tablist" aria-label="Saved views">
          {views.map((v) => (
            <span key={v.id} className={`chip saved-view ${current?.id === v.id ? 'chip-active' : ''}`}>
              <button role="tab" aria-selected={current?.id === v.id} onClick={() => select(v)} title={v.shared ? 'Shared with everyone in the workspace' : 'Only you see this view'}>
                {v.shared ? <Users size={12} /> : <Bookmark size={12} />} {v.name}
              </button>
              {(v.ownerId === me || isAdmin) && (
                <Dropdown buttonClass="saved-view-x" title={`Options for ${v.name}`} trigger={<MoreHorizontal size={13} />}>
                  <div className="menu">
                    {current?.id !== v.id && (
                      <MenuItem onSelect={() => void updateSavedView(wsId, v.id, { filters, sort, group })}>Update to current filters</MenuItem>
                    )}
                    <MenuItem
                      onSelect={async () => {
                        const name = (await promptDialog({ title: 'Rename view', label: 'Name', initial: v.name, confirmLabel: 'Rename' }))?.trim();
                        if (name && name !== v.name) void updateSavedView(wsId, v.id, { name: name.slice(0, 60) });
                      }}
                    >
                      Rename…
                    </MenuItem>
                    {isAdmin && (
                      <MenuItem checked={v.shared} onSelect={() => void updateSavedView(wsId, v.id, { shared: !v.shared })}>
                        Shared with workspace
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem
                      danger
                      onSelect={async () => {
                        if (await confirmDialog({ title: 'Delete view?', message: `Delete the saved view “${v.name}”${v.shared ? ' for everyone' : ''}?`, confirmLabel: 'Delete', danger: true }))
                          void deleteSavedView(wsId, v.id);
                      }}
                    >
                      Delete view
                    </MenuItem>
                  </div>
                </Dropdown>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="toolbar wrap">
        <input className="input" style={{ flex: '1 1 200px' }} placeholder="Filter tasks…" aria-label="Search tasks" value={filters.q} onChange={(e) => f('q', e.target.value)} />
        {!current && (
          <button className="btn btn-secondary" title="Save these filters as a view" onClick={() => void save()}>
            <BookmarkPlus size={15} /> Save view
          </button>
        )}
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
            <option value="team">Team</option>
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
      <FilterChips filters={filters} onChange={setFilters} />
      <div className="muted small result-count">
        {filtered.length} task{filtered.length === 1 ? '' : 's'}
      </div>
      <TaskGroups groups={groups} emptyText="No tasks match these filters." addable={false} />
    </>
  );
}
