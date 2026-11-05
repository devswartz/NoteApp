// Signing in and out.
import { ApiError, get, getToken, post, setToken } from '../api.ts';
import { emptyTree, set } from './state.ts';
import { loadWorkspaces } from './workspace.ts';
import { connectEvents, disconnectEvents } from './events.ts';
import type { User, Workspace } from '../../shared/types.ts';

export async function bootstrap(): Promise<boolean> {
  if (!getToken()) return false;
  try {
    const user = await get<User>('/me');
    set({ user });
    await loadWorkspaces();
    connectEvents();
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setToken(null);
    return false;
  }
}

export async function signIn(mode: 'login' | 'register', body: Record<string, string>) {
  const r = await post<{ token: string; user: User }>(`/auth/${mode}`, body);
  setToken(r.token);
  // Load workspaces before publishing the user, so the first signed-in render
  // already knows where to route (the /login route then redirects to /).
  const workspaces = await get<Workspace[]>('/workspaces');
  set({ user: r.user, workspaces });
  connectEvents();
}

export async function signOut() {
  setToken(null);
  disconnectEvents();
  // Clear locally cached note content.
  try {
    const dbs = await indexedDB.databases?.();
    for (const d of dbs ?? []) if (d.name?.startsWith('noteapp-page-')) indexedDB.deleteDatabase(d.name);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem('noteapp.lastWs');
  } catch {
    /* ignore */
  }
  set({ user: null, workspaces: [], wsId: null, tree: emptyTree, tasks: {}, members: [], treeLoaded: false, tasksLoaded: false });
}
