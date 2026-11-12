// All Tasks: search, filter, sort and group everything in the workspace, and save the result as a view.
// Filters, sort and group live in ./taskViewState.ts: on desktop and tablet the ribbon sets them
// (src/components/shell/SectionRibbons.tsx); phones have no ribbon, so the controls are here.
import { useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bookmark, BookmarkPlus, MoreHorizontal, Users } from 'lucide-react';
import { useStore } from '../../store.ts';
import { TaskGroups } from '../../components/TaskRow.tsx';
import { Dropdown, MenuItem, MenuSeparator, useIsMobile } from '../../components/ui.tsx';
import { confirmDialog, promptDialog } from '../../components/shell/dialogs.tsx';
import { applyFilters, groupBy, type Filters, type GroupKey, type SortKey } from '../../lib/taskViews.ts';
import { Loading, useOpen } from './common.tsx';
import { FilterChips, FilterSummary } from './FilterChips.tsx';
import { createSavedView, deleteSavedView, sameView, updateSavedView, useSavedViews, type SavedView } from './savedViews.ts';
import { taskView, useTaskView } from './taskViewState.ts';

type SetParams = (p: Record<string, string>, o: { replace: boolean }) => void;

/** Ask for a name and save the current filters as a view, then open it (?view=). */
export async function saveCurrentView(wsId: string, setParams: SetParams) {
  const name = (await promptDialog({ title: 'Save view', label: 'Name', confirmLabel: 'Save' }))?.trim();
  if (!name) return;
  const { filters, sort, group } = useTaskView.getState();
  const v = await createSavedView(wsId, { name: name.slice(0, 60), filters, sort, group });
  if (v) setParams({ view: v.id }, { replace: true });
}

/** Update / rename / share / delete a saved view (its menu in the page's tabs and in the ribbon). */
export function SavedViewActions({ v, wsId, isCurrent, isAdmin }: { v: SavedView; wsId: string; isCurrent: boolean; isAdmin: boolean }) {
  return (
    <>
      {!isCurrent && (
        <MenuItem
          onSelect={() => {
            const { filters, sort, group } = useTaskView.getState();
            void updateSavedView(wsId, v.id, { filters, sort, group });
          }}
        >
          Update to current filters
        </MenuItem>
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
    </>
  );
}

export const useIsWsAdmin = () => useStore((s) => ['owner', 'admin'].includes(s.workspaces.find((w) => w.id === s.wsId)?.role ?? ''));

export const SORT_OPTIONS: [SortKey, string][] = [
  ['due', 'Due date'],
  ['priority', 'Priority'],
  ['created', 'Newest'],
  ['title', 'Name'],
];
export const GROUP_OPTIONS: [GroupKey, string][] = [
  ['none', 'None'],
  ['due', 'Due date'],
  ['assignee', 'Assignee'],
  ['team', 'Team'],
  ['note', 'Page'],
  ['priority', 'Priority'],
];

export function AllView() {
  const open = useOpen();
  const tasks = useStore((s) => s.tasks);
  const me = useStore((s) => s.user!.id);
  const tree = useStore((s) => s.tree);
  const members = useStore((s) => s.members);
  const teams = useStore((s) => s.teams);
  const loaded = useStore((s) => s.tasksLoaded);
  const wsId = useStore((s) => s.wsId!);
  const isAdmin = useIsWsAdmin();
  const isMobile = useIsMobile();
  const filters = useTaskView((s) => s.filters);
  const sort = useTaskView((s) => s.sort);
  const group = useTaskView((s) => s.group);
  const views = useSavedViews(wsId);
  const [params, setParams] = useSearchParams();
  const viewParam = params.get('view');
  const current = views.find((v) => sameView(v, filters, sort, group));

  // ?view=<id> opens a saved view (links from the Tasks panel and the ribbon); applied once the views have loaded.
  // Only when the link changes: later edits to the filters (or a live reload of the views) mustn't snap back.
  const target = viewParam ? views.find((v) => v.id === viewParam) : undefined;
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!target || applied.current === target.id) return;
    applied.current = target.id;
    taskView.apply(target);
  }, [target]);
  // ?new=1 (the Tasks panel's "New view") starts from a clean slate to build a view.
  const newParam = params.get('new');
  useEffect(() => {
    if (!newParam) return;
    applied.current = null;
    taskView.reset();
  }, [newParam]);

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
  const f = <K extends keyof Filters>(k: K, v: Filters[K]) => taskView.setFilters((x) => ({ ...x, [k]: v }));
  const select = (v: SavedView) => {
    taskView.apply(v);
    applied.current = v.id;
    setParams({ view: v.id }, { replace: true });
  };
  if (!loaded) return <Loading />;
  return (
    <>
      {isMobile && views.length > 0 && (
        <div className="saved-views" role="tablist" aria-label="Saved views">
          {views.map((v) => (
            <span key={v.id} className={`chip saved-view ${current?.id === v.id ? 'chip-active' : ''}`}>
              <button role="tab" aria-selected={current?.id === v.id} onClick={() => select(v)} title={v.shared ? 'Shared with everyone in the workspace' : 'Only you see this view'}>
                {v.shared ? <Users size={12} /> : <Bookmark size={12} />} {v.name}
              </button>
              {(v.ownerId === me || isAdmin) && (
                <Dropdown buttonClass="saved-view-x" title={`Options for ${v.name}`} trigger={<MoreHorizontal size={13} />}>
                  <div className="menu">
                    <SavedViewActions v={v} wsId={wsId} isCurrent={current?.id === v.id} isAdmin={isAdmin} />
                  </div>
                </Dropdown>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="toolbar wrap">
        <input className="input" style={{ flex: '1 1 200px' }} placeholder="Filter tasks…" aria-label="Search tasks" value={filters.q} onChange={(e) => f('q', e.target.value)} />
        {isMobile && (
          <>
            {!current && (
              <button className="btn btn-secondary" title="Save these filters as a view" onClick={() => void saveCurrentView(wsId, setParams)}>
                <BookmarkPlus size={15} /> Save view
              </button>
            )}
            <label className="select-label">
              Sort
              <select className="input input-sm" value={sort} onChange={(e) => taskView.setSort(e.target.value as SortKey)}>
                {SORT_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="select-label">
              Group
              <select className="input input-sm" value={group} onChange={(e) => taskView.setGroup(e.target.value as GroupKey)}>
                {GROUP_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
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
          </>
        )}
      </div>
      {isMobile && <FilterChips filters={filters} onChange={taskView.setFilters} />}
      <div className="muted small result-count">
        {filtered.length} task{filtered.length === 1 ? '' : 's'}
        {!isMobile && <FilterSummary filters={filters} viewName={current?.name} />}
      </div>
      <TaskGroups groups={groups} emptyText="No tasks match these filters." addable={false} />
    </>
  );
}
