// Small IndexedDB key-value cache for data shown read-only while offline
// (workspaces, tree, tasks, members). Every call fails soft: no IndexedDB, a
// full disk or a private window just means no offline copy.
const DB = 'noteapp-cache';
const STORE = 'kv';

let dbp: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve((req.result as T) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export const offlineCache = {
  get: <T>(key: string) => run<T>('readonly', (s) => s.get(key)),
  set: (key: string, value: unknown) => run('readwrite', (s) => s.put(value, key)).then(() => undefined),
  /** Drop everything (on sign-out). */
  clear: () => run('readwrite', (s) => s.clear()).then(() => undefined),
};

/** True for errors that mean "couldn't reach the server" rather than "the server said no". */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine);
}
