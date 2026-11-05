// Read-through cache for offline use, kept per user so a shared device never
// shows one person's data to another.
import { get } from '../api.ts';
import { isNetworkError, offlineCache } from '../lib/offlineCache.ts';
import { st } from './state.ts';

/** The last signed-in user on this device, so an offline cold start knows whose cache to open. */
export const LAST_USER_KEY = 'lastUser';

/**
 * Fetch from the API and keep a copy for offline use; when the server can't
 * be reached, fall back to the last copy (read-only). Server errors still throw.
 */
export async function cached<T>(key: string, path: string): Promise<T> {
  const userId = st().user?.id;
  const k = userId ? `u:${userId}:${key}` : null;
  try {
    const data = await get<T>(path);
    if (k) void offlineCache.set(k, data);
    return data;
  } catch (e) {
    if (k && isNetworkError(e)) {
      const copy = await offlineCache.get<T>(k);
      if (copy !== null) return copy;
    }
    throw e;
  }
}
