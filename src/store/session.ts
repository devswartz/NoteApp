// Signing in and out.
import { endSession, get, post, refreshSession, startSession } from '../api.ts';
import { emptyTree, set } from './state.ts';
import { loadWorkspaces } from './workspace.ts';
import { connectEvents, disconnectEvents } from './events.ts';
import type { AuthSession, Workspace } from '../../shared/types.ts';
import { platform } from '../platform/index.ts';

/** Restore a session from the stored refresh token. */
export async function bootstrap(): Promise<boolean> {
  try {
    const s = await refreshSession();
    if (!s) return false;
    set({ user: s.user });
    await loadWorkspaces();
    connectEvents();
    return true;
  } catch {
    // Offline or server down: stay signed out for now (the refresh token is kept).
    return false;
  }
}

export async function signIn(mode: 'login' | 'register', body: Record<string, string>) {
  const s = await post<AuthSession>(`/auth/${mode}`, body);
  await startSession(s);
  // Load workspaces before publishing the user, so the first signed-in render
  // already knows where to route (the /login route then redirects to /).
  const workspaces = await get<Workspace[]>('/workspaces');
  set({ user: s.user, workspaces });
  connectEvents();
}

export async function signOut() {
  disconnectEvents();
  await endSession();
  // Clear locally cached note content.
  try {
    const dbs = await indexedDB.databases?.();
    for (const d of dbs ?? []) if (d.name?.startsWith('noteapp-page-')) indexedDB.deleteDatabase(d.name);
  } catch {
    /* ignore */
  }
  platform.kv.remove('noteapp.lastWs');
  set({ user: null, workspaces: [], wsId: null, tree: emptyTree, tasks: {}, members: [], treeLoaded: false, tasksLoaded: false });
}
