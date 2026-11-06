// "Shared with me" (#98): pages someone shared with this user one by one (page_shares).
// Owner: Collaboration & Access.
//
// A shared page may live in a notebook the user can't see, or in a workspace they
// aren't a member of, so it isn't in the workspace tree. This small store keeps
// the list (GET /shared-pages, refreshed on the `shared-pages` live event) and,
// for pages from other workspaces, the tasks on them (GET /pages/:id/tasks), so
// their task references can render.
import { create } from 'zustand';
import { get } from '../../api.ts';
import { useStore } from '../../store.ts';
import type { SharedPage, Task } from '../../../shared/types.ts';

interface SharedState {
  pages: SharedPage[];
  loaded: boolean;
  /** Tasks on shared pages from workspaces other than the current one, by id. */
  tasks: Record<string, Task>;
}

export const useShared = create<SharedState>(() => ({ pages: [], loaded: false, tasks: {} }));

let inflight: Promise<void> | null = null;
export function loadSharedPages(): Promise<void> {
  inflight ??= get<SharedPage[]>('/shared-pages')
    .then((pages) => {
      useShared.setState((s) => {
        // Drop tasks of pages no longer shared with me.
        const ids = new Set(pages.map((p) => p.id));
        const tasks = Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => t.pageId && ids.has(t.pageId)));
        return { pages, loaded: true, tasks };
      });
    })
    .catch(() => {
      /* offline: keep what we had */
    })
    .finally(() => (inflight = null));
  return inflight;
}

export const sharedPage = (id: string) => useShared.getState().pages.find((p) => p.id === id);
export const isSharedPage = (id: string | null | undefined) => !!id && useShared.getState().pages.some((p) => p.id === id);

/** Load the tasks on a shared page that belongs to another workspace (the current one already has its own). */
export async function loadSharedPageTasks(pageId: string) {
  const list = await get<Task[]>(`/pages/${pageId}/tasks`);
  useShared.setState((s) => {
    const tasks = Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => t.pageId !== pageId));
    for (const t of list) tasks[t.id] = t;
    return { tasks };
  });
}

/** A live `task` event from another workspace: keep it if it lives on a page shared with me. Returns true if handled. */
export function sharedTaskEvent(task: Task): boolean {
  const has = !!useShared.getState().tasks[task.id];
  if (!isSharedPage(task.pageId) && !has) return false;
  useShared.setState((s) => {
    const tasks = { ...s.tasks };
    if (isSharedPage(task.pageId)) tasks[task.id] = task;
    else delete tasks[task.id]; // moved off the shared page
    return { tasks };
  });
  return true;
}

/** Rename locally (the page's own title input saves it). */
export function patchSharedPage(id: string, patch: Partial<Pick<SharedPage, 'title' | 'icon'>>) {
  useShared.setState((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
}

/** Where a shared page opens: in its own workspace if I'm a member, else inside the current (or first) workspace. */
export function sharedPagePath(workspaceId: string, pageId: string): string {
  const { workspaces, wsId } = useStore.getState();
  if (workspaces.some((w) => w.id === workspaceId)) return `/w/${workspaceId}/p/${pageId}`;
  const here = wsId && workspaces.some((w) => w.id === wsId) ? wsId : workspaces[0]?.id;
  return here ? `/w/${here}/p/${pageId}` : '/';
}

/** A task by id from the workspace store, or from a shared page in another workspace. */
export const useAnyTask = (id: string): Task | undefined => {
  const own = useStore((s) => s.tasks[id]);
  const shared = useShared((s) => s.tasks[id]);
  return own ?? shared;
};
