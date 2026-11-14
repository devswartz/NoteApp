// The offline copies of pages (y-indexeddb databases "noteapp-page-<id>", opened by src/editor/collab.ts), and keeping
// locked pages out of them (server/locks.ts). A locked page is never cached; when a page is locked every device that
// had it (its owner's and everyone else's) drops its copy and closes its editor; when locked notes lock again, the
// owner's devices drop any copies of their locked pages; and when a workspace's tree loads, copies of pages that are
// locked or no longer visible there are deleted.
import { platform } from '../platform/index.ts';
import type { Tree } from '../../shared/types.ts';

const dbName = (pageId: string) => `noteapp-page-${pageId}`;
/** pageId → workspace id of every page cached on this device (to know what to prune when a tree loads). */
const REGISTRY = 'noteapp.pageCaches';

function registry(): Record<string, string> {
  try {
    return JSON.parse(platform.kv.get(REGISTRY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
const saveRegistry = (r: Record<string, string>) => platform.kv.set(REGISTRY, JSON.stringify(r));

/** Pages that must not be cached right now (locked ones being shown). */
const noCache = new Set<string>();
/** Open editors' caches, closed before their database is deleted. */
const open = new Map<string, () => void>();

export const markNoCache = (pageId: string, on: boolean) => void (on ? noCache.add(pageId) : noCache.delete(pageId));
export const mayCache = (pageId: string) => !noCache.has(pageId);

/** An editor started caching `pageId`. `close` stops it (called before the copy is deleted). */
export function cacheOpened(pageId: string, wsId: string | null, close: () => void): () => void {
  if (wsId) {
    const r = registry();
    if (r[pageId] !== wsId) saveRegistry({ ...r, [pageId]: wsId });
  }
  open.set(pageId, close);
  return () => {
    if (open.get(pageId) === close) open.delete(pageId);
  };
}

/** Delete this device's offline copy of a page (closing an open editor's cache first). */
export async function dropPageCache(pageId: string): Promise<void> {
  markNoCache(pageId, true);
  const close = open.get(pageId);
  open.delete(pageId);
  try {
    close?.();
  } catch {
    /* already closed */
  }
  const r = registry();
  if (pageId in r) {
    delete r[pageId];
    saveRegistry(r);
  }
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName(pageId));
    req.onsuccess = req.onerror = () => resolve();
    req.onblocked = () => resolve(); // completes once the last connection closes
  });
}

/** After a workspace's tree loaded: drop copies of its locked pages, and of pages cached for it that it no longer shows. */
export async function prunePageCaches(wsId: string, tree: Tree): Promise<void> {
  const locked = tree.pages.filter((p) => p.locked).map((p) => p.id);
  for (const id of locked) markNoCache(id, true);
  const visible = new Set([...tree.pages.filter((p) => !p.locked).map((p) => p.id), ...(tree.trashedPages ?? []).map((p) => p.id)]);
  for (const id of visible) markNoCache(id, false); // e.g. its lock was removed
  const gone = Object.entries(registry())
    .filter(([id, ws]) => ws === wsId && !visible.has(id))
    .map(([id]) => id);
  await Promise.all([...new Set([...locked, ...gone])].map(dropPageCache));
}

/** Locked notes locked again: drop any copies of the user's locked pages on this device. */
export async function dropLockedPageCaches(tree: Tree): Promise<void> {
  await Promise.all(tree.pages.filter((p) => p.locked).map((p) => dropPageCache(p.id)));
}
