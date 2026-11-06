// Per-task write ordering (src/store/taskWrites.ts, BUG-6). Owner: Tasks & Dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskWrites } from '../src/store/taskWrites.ts';

type Patch = { title?: string; priority?: number };
type T = { id: string; title: string; priority?: number };

/** A promise the test resolves or rejects by hand, so each race is deterministic. */
function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a patch sent while the create is in flight waits for it; queued patches merge into one', async () => {
  const w = new TaskWrites<T, Patch>();
  const log: string[] = [];
  const create = deferred<T>();
  const created = w.create('a', () => (log.push('POST'), create.promise));
  const sends: Patch[] = [];
  const u1 = w.update('a', { title: 'Call the' }, async (p) => (log.push('PATCH'), sends.push({ ...p }), { id: 'a', title: p.title!, priority: p.priority }));
  const u2 = w.update('a', { title: 'Call the plumber' }, async () => assert.fail('merged into the first'));
  const u3 = w.update('a', { priority: 1 }, async () => assert.fail('merged into the first'));
  await tick();
  assert.deepEqual(log, ['POST'], 'nothing else is sent before the create answers');
  assert.deepEqual(w.overlay('a'), { title: 'Call the plumber', priority: 1 }, 'unsaved fields are known');

  create.resolve({ id: 'a', title: '' });
  await created;
  const [r1, r2, r3] = await Promise.all([u1, u2, u3]);
  assert.deepEqual(log, ['POST', 'PATCH'], 'one PATCH after the POST');
  assert.deepEqual(sends, [{ title: 'Call the plumber', priority: 1 }]);
  assert.equal(r1?.title, 'Call the plumber');
  assert.equal(r2, r1);
  assert.equal(r3, r1);
  assert.equal(w.overlay('a'), undefined, 'nothing unsaved once answered');
  await tick();
  assert.equal(w.pending('a'), false);
});

test('a delete during the create is sent after it, and drops patches still waiting', async () => {
  const w = new TaskWrites<T, Patch>();
  const log: string[] = [];
  const create = deferred<T>();
  const created = w.create('b', () => (log.push('POST'), create.promise));
  const u = w.update('b', { title: 'x' }, async () => (log.push('PATCH'), { id: 'b', title: 'x' }));
  const removed = w.remove('b', async () => void log.push('DELETE'));
  assert.equal(w.isDeleted('b'), true, 'deleted locally at once');
  await tick();
  assert.deepEqual(log, ['POST']);
  create.resolve({ id: 'b', title: '' });
  await created;
  assert.equal(await u, null, 'the patch is dropped');
  await removed;
  assert.deepEqual(log, ['POST', 'DELETE'], 'DELETE follows POST; no PATCH');
  assert.equal(w.isDeleted('b'), true, 'stays deleted, so a late echo cannot re-insert it');
});

test('after a failed create nothing queued behind it is sent', async () => {
  const w = new TaskWrites<T, Patch>();
  const log: string[] = [];
  const create = deferred<T>();
  const created = w.create('c', () => (log.push('POST'), create.promise));
  const u = w.update('c', { title: 'y' }, async () => (log.push('PATCH'), { id: 'c', title: 'y' }));
  const removed = w.remove('c', async () => void log.push('DELETE'));
  create.reject(new Error('offline'));
  await assert.rejects(created, /offline/);
  assert.equal(await u, null);
  await removed;
  assert.deepEqual(log, ['POST']);
});

test('undo then redo (delete, then create with the same id) keeps the task', async () => {
  const w = new TaskWrites<T, Patch>();
  const log: string[] = [];
  const first = deferred<T>();
  const c1 = w.create('d', () => (log.push('POST 1'), first.promise));
  const removed = w.remove('d', async () => void log.push('DELETE'));
  const c2 = w.create('d', async () => (log.push('POST 2'), { id: 'd', title: 'again' }));
  assert.equal(w.isDeleted('d'), false, 'created again: no longer deleted');
  first.resolve({ id: 'd', title: '' });
  await c1;
  await removed;
  assert.equal((await c2).title, 'again');
  assert.deepEqual(log, ['POST 1', 'POST 2'], 'the superseded DELETE is skipped');
});

test('writes for a task with nothing pending go straight out; other tasks are not held up', async () => {
  const w = new TaskWrites<T, Patch>();
  const log: string[] = [];
  const slow = deferred<T>();
  void w.create('slow', () => (log.push('POST slow'), slow.promise));
  const r = await w.update('e', { title: 'z' }, async (p) => (log.push('PATCH e'), { id: 'e', title: p.title! }));
  assert.equal(r?.title, 'z');
  assert.deepEqual(log, ['POST slow', 'PATCH e']);
  slow.resolve({ id: 'slow', title: '' });
});

test('patches to an existing task are serialized, so a later one never lands first', async () => {
  const w = new TaskWrites<T, Patch>();
  const order: string[] = [];
  const first = deferred<T>();
  const p1 = w.update('f', { priority: 2 }, (p) => (order.push(`send ${p.priority}`), first.promise));
  await tick(); // the first PATCH is in flight now, so the next one can't merge into it
  const p2 = w.update('f', { priority: 3 }, async (p) => (order.push(`send ${p.priority}`), { id: 'f', title: '', priority: 3 }));
  await tick();
  assert.deepEqual(order, ['send 2'], 'the second waits for the first');
  first.resolve({ id: 'f', title: '', priority: 2 });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['send 2', 'send 3']);
});

test('a failed delete can be undone', async () => {
  const w = new TaskWrites<T, Patch>();
  await assert.rejects(
    w.remove('g', async () => {
      throw new Error('500');
    }),
  );
  w.undelete('g');
  assert.equal(w.isDeleted('g'), false);
});
