// Multi-selection of task rows for bulk actions (list views only).
import { create } from 'zustand';

interface SelectionState {
  ids: Set<string>;
  /** Last row clicked without Shift: the anchor for Shift-click ranges. */
  anchor: string | null;
}

export const useSelection = create<SelectionState>(() => ({ ids: new Set(), anchor: null }));

/** Task ids in on-screen order. */
function visibleIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.tasks-page .task-row[data-task-id]')].map((el) => el.dataset.taskId!);
}

export const selection = {
  toggle(id: string) {
    useSelection.setState((s) => {
      const ids = new Set(s.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ids, anchor: id };
    });
  },
  /** Select every row between the anchor and `id` (inclusive), keeping the existing selection. */
  extendTo(id: string) {
    const { anchor, ids } = useSelection.getState();
    const order = visibleIds();
    const a = anchor ? order.indexOf(anchor) : -1;
    const b = order.indexOf(id);
    if (a < 0 || b < 0) return selection.toggle(id);
    const next = new Set(ids);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order[i]);
    useSelection.setState({ ids: next });
  },
  selectAll() {
    useSelection.setState({ ids: new Set(visibleIds()) });
  },
  clear() {
    if (useSelection.getState().ids.size) useSelection.setState({ ids: new Set(), anchor: null });
  },
  /** Drop ids that are no longer on screen (filter changed, task deleted, view switched). */
  prune() {
    const { ids } = useSelection.getState();
    if (!ids.size) return;
    const shown = new Set(visibleIds());
    const next = new Set([...ids].filter((id) => shown.has(id)));
    if (next.size !== ids.size) useSelection.setState({ ids: next });
  },
};
