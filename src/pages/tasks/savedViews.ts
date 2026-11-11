// Saved views for All Tasks: named filter + sort + group presets, stored per
// workspace on this device (platform.kv). A server-side copy can come later.
import { useEffect, useState } from 'react';
import { platform } from '../../platform/index.ts';
import { DEFAULT_FILTERS, type Filters, type GroupKey, type SortKey } from '../../lib/taskViews.ts';

export interface SavedView {
  id: string;
  name: string;
  filters: Filters;
  sort: SortKey;
  group: GroupKey;
}

const key = (wsId: string) => `noteapp.taskViews.${wsId}`;
const SORTS: SortKey[] = ['due', 'priority', 'created', 'title'];
const GROUPS: GroupKey[] = ['none', 'due', 'assignee', 'note', 'priority'];

/** Parse stored JSON defensively: unknown fields dropped, missing ones defaulted. */
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
    const filters = { ...DEFAULT_FILTERS };
    for (const k of Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]) {
      if (typeof v.filters?.[k] === 'string') (filters as Record<string, string>)[k] = v.filters[k];
    }
    out.push({
      id: v.id,
      name: v.name.slice(0, 60),
      filters,
      sort: SORTS.includes(v.sort) ? v.sort : 'due',
      group: GROUPS.includes(v.group) ? v.group : 'none',
    });
  }
  return out;
}

export function loadSavedViews(wsId: string): SavedView[] {
  return parseSavedViews(platform.kv.get(key(wsId)));
}

export function storeSavedViews(wsId: string, views: SavedView[]) {
  platform.kv.set(key(wsId), JSON.stringify(views));
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();

/**
 * The saved views of a workspace, kept current when they change (the Tasks
 * panel lists them). Track 1 moves them to the server behind this same signature.
 */
export function useSavedViews(wsId: string): SavedView[] {
  const [views, setViews] = useState(() => loadSavedViews(wsId));
  useEffect(() => {
    const reload = () => setViews(loadSavedViews(wsId));
    reload();
    listeners.add(reload);
    return () => void listeners.delete(reload);
  }, [wsId]);
  return views;
}

/** Link that opens All Tasks with a saved view applied. */
export function savedViewPath(wsId: string, viewId: string): string {
  return `/w/${wsId}/tasks/all?view=${encodeURIComponent(viewId)}`;
}

export function sameView(v: SavedView, filters: Filters, sort: SortKey, group: GroupKey) {
  return v.sort === sort && v.group === group && (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).every((k) => v.filters[k] === filters[k]);
}
