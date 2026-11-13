// Shared bits for the task dashboard views.
import { useMemo } from 'react';
import { useStore } from '../../store.ts';
import { useShared } from '../../components/sharing/sharedPages.ts';
import { activeFilterKeys, applyFilters, visibleOpen } from '../../lib/taskViews.ts';
import type { Task } from '../../../shared/types.ts';
import { useTaskView } from './taskViewState.ts';

/**
 * Open tasks for the dashboard views: this workspace's, plus tasks assigned to me on pages shared
 * with me from workspaces I'm not working in (#98 follow-up), which show under their page.
 */
export function useOpen() {
  const own = useStore((s) => s.tasks);
  const shared = useShared((s) => s.tasks);
  const me = useStore((s) => s.user?.id);
  const wsId = useStore((s) => s.wsId);
  const lingering = useStore((s) => s.lingering);
  return useMemo(() => {
    const mine = Object.values(shared).filter((t) => t.assigneeId === me && t.workspaceId !== wsId && !own[t.id]);
    const tasks = mine.length ? { ...Object.fromEntries(mine.map((t) => [t.id, t])), ...own } : own;
    return visibleOpen(tasks, lingering);
  }, [own, shared, me, wsId, lingering]);
}

/**
 * The filters the ribbon (or, on phones, the filter bar) has set, applied on top of a view's own list.
 * Search text is All tasks' own, and Status is applied by WithStatus (CompletedView.tsx), so both are ignored here.
 * Returns the list untouched when no filter is on.
 */
export function useViewFilter(): <T extends Task>(list: T[]) => T[] {
  const filters = useTaskView((s) => s.filters);
  const me = useStore((s) => s.user!.id);
  const tree = useStore((s) => s.tree);
  const teams = useStore((s) => s.teams);
  return useMemo(() => {
    if (!activeFilterKeys(filters).length) return (list) => list;
    const f = { ...filters, q: '', status: 'any' as const };
    return (list) => applyFilters(list, f, me, tree, teams) as typeof list;
  }, [filters, me, tree, teams]);
}

export function Loading() {
  return <div className="muted pad">Loading tasks…</div>;
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
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
