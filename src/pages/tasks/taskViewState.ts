// How the task views are filtered, sorted and grouped. Shared by the views (in-page controls on
// phones) and the ribbon (desktop and tablet), so both always show the same state.
// All Tasks: filters + sort + group (saved views store these). My Tasks: its grouping.
// Upcoming: mine or everyone. Reset when the workspace changes (filters name its teams and tags).
import { create } from 'zustand';
import { DEFAULT_FILTERS, type Filters, type GroupKey, type SortKey } from '../../lib/taskViews.ts';

export type MyGroup = 'due' | 'note' | 'priority';

interface TaskViewState {
  wsId: string | null;
  filters: Filters;
  sort: SortKey;
  group: GroupKey;
  myGroup: MyGroup;
  upcomingScope: 'mine' | 'all';
}

const initial = (wsId: string | null): TaskViewState => ({
  wsId,
  filters: DEFAULT_FILTERS,
  sort: 'due',
  group: 'none',
  myGroup: 'due',
  upcomingScope: 'mine',
});

export const useTaskView = create<TaskViewState>(() => initial(null));

export const taskView = {
  /** Start fresh for another workspace (no-op for the same one). */
  forWorkspace(wsId: string) {
    if (useTaskView.getState().wsId !== wsId) useTaskView.setState(initial(wsId));
  },
  setFilters: (f: Filters | ((f: Filters) => Filters)) => useTaskView.setState((s) => ({ filters: typeof f === 'function' ? f(s.filters) : f })),
  setSort: (sort: SortKey) => useTaskView.setState({ sort }),
  setGroup: (group: GroupKey) => useTaskView.setState({ group }),
  setMyGroup: (myGroup: MyGroup) => useTaskView.setState({ myGroup }),
  setUpcomingScope: (upcomingScope: 'mine' | 'all') => useTaskView.setState({ upcomingScope }),
  apply: (v: { filters: Filters; sort: SortKey; group: GroupKey }) => useTaskView.setState({ filters: v.filters, sort: v.sort, group: v.group }),
  /** A clean slate for All Tasks (keeps the other views' settings). */
  reset: () => useTaskView.setState({ filters: DEFAULT_FILTERS, sort: 'due', group: 'none' }),
};
