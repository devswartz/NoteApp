// Signing in and out.
import { endSession, get, post, refreshSession, startSession } from '../api.ts';
import { emptyTree, set } from './state.ts';
import { offlineCache } from '../lib/offlineCache.ts';
import { loadWorkspaces } from './workspace.ts';
import { connectEvents, disconnectEvents } from './events.ts';
import type { AuthSession, User, Workspace } from '../../shared/types.ts';
import { platform } from '../platform/index.ts';

/**
 * Restore a session from the stored refresh token. If the server can't be
 * reached, open in offline mode with the last cached user and data; the
 * events socket keeps retrying and the session refreshes once back online.
 */
export async function bootstrap(): Promise<boolean> {
  let user: User | null = null;
  try {
    const s = await refreshSession();
    if (!s) return false;
    user = s.user;
    void offlineCache.set('user', user);
  } catch {
    user = await offlineCache.get<User>('user');
    if (!user) return false;
    set({ online: false });
  }
  set({ user });
  try {
    await loadWorkspaces();
  } catch {
    /* no cached workspaces yet: the app shows its empty state until online */
  }
  connectEvents();
  return true;
}

export async function signIn(mode: 'login' | 'register', body: Record<string, string>) {
  const s = await post<AuthSession>(`/auth/${mode}`, body);
  await startSession(s);
  void offlineCache.set('user', s.user);
  // Load workspaces before publishing the user, so the first signed-in render
  // already knows where to route (the /login route then redirects to /).
  const workspaces = await get<Workspace[]>('/workspaces');
  set({ user: s.user, workspaces });
  connectEvents();
}

export async function signOut() {
  disconnectEvents();
  await endSession();
  await offlineCache.clear();
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
