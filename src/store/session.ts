// Signing in and out.
import { endSession, get, post, refreshSession, startSession } from '../api.ts';
import { emptyTree, set } from './state.ts';
import { clearLocalUserData, isNetworkError, offlineCache } from '../lib/offlineCache.ts';
import { LAST_USER_KEY } from './cache.ts';
import { errorToast } from './toasts.ts';
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
    if (!s) {
      // No session, or the server rejected the refresh token: forget this device's copy.
      await clearLocalUserData();
      return false;
    }
    user = s.user;
    void offlineCache.set(LAST_USER_KEY, user);
  } catch (e) {
    if (!isNetworkError(e)) {
      // The server answered with an error (e.g. 5xx): say so rather than pretending to be offline.
      errorToast(e);
      return false;
    }
    user = await offlineCache.get<User>(LAST_USER_KEY);
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
  void offlineCache.set(LAST_USER_KEY, s.user);
  // Load workspaces before publishing the user, so the first signed-in render
  // already knows where to route (the /login route then redirects to /).
  const workspaces = await get<Workspace[]>('/workspaces');
  set({ user: s.user, workspaces });
  connectEvents();
}

export async function signOut() {
  try {
    disconnectEvents();
    await endSession();
  } finally {
    // Always wipe this device's copy of the user's data, even if a step above failed.
    await clearLocalUserData();
    platform.kv.remove('noteapp.lastWs');
    set({ user: null, workspaces: [], wsId: null, tree: emptyTree, tasks: {}, members: [], treeLoaded: false, tasksLoaded: false });
  }
}
