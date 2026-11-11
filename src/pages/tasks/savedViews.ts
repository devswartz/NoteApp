// Saved views for All Tasks: named filter + sort + group presets, stored on the server
// (task_views, migration 014) so they follow the user to every device. Personal by
// default; owners and admins can share one with the whole workspace.
//
// Views that older versions kept on this device (platform.kv) are uploaded the first
// time the views of that workspace load, then removed from the device.
//
// Stable interface for other areas (the Tasks side panel lists these):
//   useSavedViews(wsId) → SavedView[]   (each has id, name, shared, …)
//   savedViewPath(wsId, viewId) → the URL that opens the view in All Tasks
import { useEffect } from 'react';
import { create } from 'zustand';
import { del, patch, post } from '../../api.ts';
import { platform } from '../../platform/index.ts';
import { cached } from '../../store/cache.ts';
import { errorToast } from '../../store/toasts.ts';
import { normalizeFilters, type Filters, type GroupKey, type SortKey } from '../../lib/taskViews.ts';
import { groupOf, parseSavedViews, sortOf, type SavedView } from './savedViewsCore.ts';
import type { TaskView } from '../../../shared/types.ts';

const deviceKey = (wsId: string) => `noteapp.taskViews.${wsId}`;

export { parseSavedViews, sameView, savedViewPath, type SavedView } from './savedViewsCore.ts';
function fromServer(v: TaskView): SavedView {
  return {
    id: v.id,
    name: v.name,
    filters: normalizeFilters(v.query?.filters),
    sort: sortOf(v.query?.sort),
    group: groupOf(v.query?.group),
    shared: v.shared,
    ownerId: v.ownerId,
    position: v.position,
  };
}

const useViews = create<{ byWs: Record<string, SavedView[] | undefined> }>(() => ({ byWs: {} }));
const inFlight = new Map<string, Promise<void>>();

/** Upload views an older version kept on this device; ids make it safe to retry. */
async function uploadDeviceViews(wsId: string) {
  const local = parseSavedViews(platform.kv.get(deviceKey(wsId)));
  if (!local.length) return false;
  for (const v of local) {
    try {
      await post(`/workspaces/${wsId}/task-views`, { id: v.id, name: v.name, query: { filters: v.filters, sort: v.sort, group: v.group } });
    } catch (e) {
      // 409: that id is someone else's (another account on this device): skip it. Anything else: try again next time.
      if ((e as { status?: number }).status !== 409) return false;
    }
  }
  platform.kv.remove(deviceKey(wsId));
  return true;
}

/** (Re)load a workspace's views from the server. */
export function loadSavedViews(wsId: string): Promise<void> {
  const running = inFlight.get(wsId);
  if (running) return running;
  const p = (async () => {
    try {
      await uploadDeviceViews(wsId).catch(() => false);
      const list = await cached<TaskView[]>(`task-views:${wsId}`, `/workspaces/${wsId}/task-views`);
      useViews.setState((s) => ({ byWs: { ...s.byWs, [wsId]: list.map(fromServer).sort((a, b) => a.position - b.position) } }));
    } catch {
      // Offline with nothing cached: no views yet.
      useViews.setState((s) => ({ byWs: { ...s.byWs, [wsId]: s.byWs[wsId] ?? [] } }));
    } finally {
      inFlight.delete(wsId);
    }
  })();
  inFlight.set(wsId, p);
  return p;
}

/** Live event: views changed on the server. Reloads only workspaces already loaded. */
export function savedViewsChanged(wsId: string | null) {
  if (wsId && useViews.getState().byWs[wsId] !== undefined) void loadSavedViews(wsId);
}

const EMPTY: SavedView[] = [];

/** The signed-in user's saved views in a workspace (their own and shared ones), in order. Loads on first use. */
export function useSavedViews(wsId: string): SavedView[] {
  const views = useViews((s) => s.byWs[wsId]);
  useEffect(() => {
    if (wsId && views === undefined) void loadSavedViews(wsId);
  }, [wsId, views]);
  return views ?? EMPTY;
}

const setLocal = (wsId: string, fn: (list: SavedView[]) => SavedView[]) =>
  useViews.setState((s) => ({ byWs: { ...s.byWs, [wsId]: fn(s.byWs[wsId] ?? []) } }));

export async function createSavedView(wsId: string, v: { name: string; filters: Filters; sort: SortKey; group: GroupKey; shared?: boolean }): Promise<SavedView | null> {
  try {
    const created = fromServer(
      await post<TaskView>(`/workspaces/${wsId}/task-views`, { name: v.name, shared: !!v.shared, query: { filters: v.filters, sort: v.sort, group: v.group } }),
    );
    setLocal(wsId, (list) => [...list.filter((x) => x.id !== created.id), created]);
    return created;
  } catch (e) {
    errorToast(e);
    return null;
  }
}

export async function updateSavedView(
  wsId: string,
  id: string,
  p: Partial<{ name: string; shared: boolean; position: number; filters: Filters; sort: SortKey; group: GroupKey }>,
) {
  const body: Record<string, unknown> = {};
  if (p.name !== undefined) body.name = p.name;
  if (p.shared !== undefined) body.shared = p.shared;
  if (p.position !== undefined) body.position = p.position;
  if (p.filters && p.sort && p.group) body.query = { filters: p.filters, sort: p.sort, group: p.group };
  try {
    const updated = fromServer(await patch<TaskView>(`/task-views/${id}`, body));
    setLocal(wsId, (list) => list.map((x) => (x.id === id ? updated : x)).sort((a, b) => a.position - b.position));
  } catch (e) {
    errorToast(e);
  }
}

export async function deleteSavedView(wsId: string, id: string) {
  const before = useViews.getState().byWs[wsId];
  setLocal(wsId, (list) => list.filter((x) => x.id !== id));
  try {
    await del(`/task-views/${id}`);
  } catch (e) {
    useViews.setState((s) => ({ byWs: { ...s.byWs, [wsId]: before } }));
    errorToast(e);
  }
}

