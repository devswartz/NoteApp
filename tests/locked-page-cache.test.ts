// Offline copies of locked pages (src/lib/pageCache.ts): never cached, dropped (with the open editor's cache closed)
// when a page is locked, when locked notes lock again, and when a tree no longer shows a page or shows it locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PageMeta, Tree } from '../shared/types.ts';

// A browser-ish environment: localStorage (platform.kv) and an indexedDB that records deletions.
const ls = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) },
};
const deleted: string[] = [];
(globalThis as Record<string, unknown>).indexedDB = {
  deleteDatabase(name: string) {
    deleted.push(name);
    const req: Record<string, unknown> = {};
    queueMicrotask(() => (req.onsuccess as (() => void) | undefined)?.());
    return req;
  },
};

const { cacheOpened, dropLockedPageCaches, dropPageCache, markNoCache, mayCache, prunePageCaches } = await import('../src/lib/pageCache.ts');

const page = (id: string, locked = false): PageMeta => ({ id, sectionId: 's', title: id, icon: null, kind: 'canvas', position: 1, updatedAt: '', updatedBy: null, ...(locked ? { locked } : {}) });
const tree = (pages: PageMeta[]): Tree => ({ notebooks: [], sections: [], pages });

test('dropping a page closes its open cache first, deletes its database and stops caching it', async () => {
  let closed = 0;
  cacheOpened('p1', 'w1', () => closed++);
  assert.equal(mayCache('p1'), true);
  await dropPageCache('p1');
  assert.equal(closed, 1);
  assert.ok(deleted.includes('noteapp-page-p1'));
  assert.equal(mayCache('p1'), false, 'not cached again while it stays locked');
});

test('a tree load drops locked pages and pages of that workspace it no longer shows; visible ones may be cached again', async () => {
  deleted.length = 0;
  cacheOpened('a', 'w2', () => {});
  cacheOpened('b', 'w2', () => {});
  cacheOpened('c', 'w2', () => {});
  cacheOpened('x', 'other-ws', () => {});
  markNoCache('a', true);
  await prunePageCaches('w2', tree([page('a'), page('b', true)])); // c is gone, b is locked
  assert.deepEqual(deleted.sort(), ['noteapp-page-b', 'noteapp-page-c']);
  assert.equal(mayCache('a'), true, 'a visible page (its lock removed) may be cached again');
  assert.equal(mayCache('b'), false);
  // Another workspace's tree doesn't touch this one's copies.
  deleted.length = 0;
  await prunePageCaches('w3', tree([]));
  assert.deepEqual(deleted, []);
});

test('relocking drops copies of the user’s locked pages', async () => {
  deleted.length = 0;
  await dropLockedPageCaches(tree([page('k1', true), page('k2')]));
  assert.deepEqual(deleted, ['noteapp-page-k1']);
});
