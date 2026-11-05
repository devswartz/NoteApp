// Read-through cache for offline use.
import { get } from '../api.ts';
import { isNetworkError, offlineCache } from '../lib/offlineCache.ts';

/**
 * Fetch from the API and keep a copy for offline use; when the server can't
 * be reached, fall back to the last copy (read-only). Server errors still throw.
 */
export async function cached<T>(key: string, path: string): Promise<T> {
  try {
    const data = await get<T>(path);
    void offlineCache.set(key, data);
    return data;
  } catch (e) {
    if (isNetworkError(e)) {
      const copy = await offlineCache.get<T>(key);
      if (copy !== null) return copy;
    }
    throw e;
  }
}
