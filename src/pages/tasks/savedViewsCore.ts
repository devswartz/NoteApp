// Pure parts of saved views (no API or platform imports, so unit tests can load them).
import { normalizeFilters, sameFilters, type Filters, type GroupKey, type SortKey } from '../../lib/taskViews.ts';

export interface SavedView {
  id: string;
  name: string;
  filters: Filters;
  sort: SortKey;
  group: GroupKey;
  /** Every member of the workspace sees it. */
  shared: boolean;
  ownerId: string;
  position: number;
}

const SORTS: SortKey[] = ['due', 'priority', 'created', 'title'];
const GROUPS: GroupKey[] = ['none', 'due', 'assignee', 'note', 'priority', 'team'];
export const sortOf = (v: unknown): SortKey => (SORTS.includes(v as SortKey) ? (v as SortKey) : 'due');
export const groupOf = (v: unknown): GroupKey => (GROUPS.includes(v as GroupKey) ? (v as GroupKey) : 'none');

/** The URL that opens a saved view in All Tasks. */
export function savedViewPath(wsId: string, viewId: string): string {
  return `/w/${wsId}/tasks/all?view=${encodeURIComponent(viewId)}`;
}

/** Parse device-stored views (the old format) defensively: unknown fields dropped, missing ones defaulted. */
export function parseSavedViews(raw: string | null): SavedView[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: SavedView[] = [];
  for (const v of data) {
    if (!v || typeof v !== 'object' || typeof v.name !== 'string' || typeof v.id !== 'string') continue;
    out.push({ id: v.id, name: v.name.slice(0, 60), filters: normalizeFilters(v.filters), sort: sortOf(v.sort), group: groupOf(v.group), shared: false, ownerId: '', position: out.length });
  }
  return out;
}

export function sameView(v: SavedView, filters: Filters, sort: SortKey, group: GroupKey) {
  return v.sort === sort && v.group === group && sameFilters(v.filters, filters);
}

/**
 * The saved view All Tasks is showing, for its heading: the one the link (?view=) names, even after
 * its filters were edited; otherwise one the current filters match exactly (not a view that is just
 * "no filters", which plain All Tasks would otherwise be mistaken for).
 */
export function openedView(views: SavedView[], viewParam: string | null, filters: Filters, sort: SortKey, group: GroupKey): SavedView | undefined {
  const named = viewParam ? views.find((v) => v.id === viewParam) : undefined;
  if (named) return named;
  return views.find((v) => sameView(v, filters, sort, group) && !sameView(v, normalizeFilters(null), 'due', 'none'));
}
