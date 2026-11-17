// Two- and three-finger taps (undo / redo) from pointer events (src/ink/fingerTaps.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FingerTaps, TAP_MS, listenFingerTaps } from '../src/ink/fingerTaps.ts';

test('two fingers down and up quickly without moving: a two-finger tap; three: three', () => {
  const t = new FingerTaps();
  t.start(1, 100, 100, 0);
  t.start(2, 200, 100, 20);
  t.move(1, 103, 102);
  assert.equal(t.end(1, 120), null, 'not until the last finger lifts');
  assert.equal(t.end(2, 140), 2);
  t.start(5, 0, 0, 1000);
  t.start(6, 50, 0, 1000);
  t.start(7, 100, 0, 1010);
  t.end(5, 1100);
  t.end(6, 1110);
  assert.equal(t.end(7, 1120), 3);
});

test('not a tap: one finger, too slow, moved (a scroll), cancelled (a pinch), or four fingers', () => {
  const t = new FingerTaps();
  t.start(1, 0, 0, 0);
  assert.equal(t.end(1, 50), null);
  t.start(1, 0, 0, 0);
  t.start(2, 50, 0, 0);
  t.end(1, TAP_MS + 10);
  assert.equal(t.end(2, TAP_MS + 20), null);
  t.start(1, 0, 0, 0);
  t.start(2, 50, 0, 0);
  t.move(2, 50, 40);
  t.end(1, 100);
  assert.equal(t.end(2, 100), null);
  t.start(1, 0, 0, 0);
  t.start(2, 50, 0, 0);
  t.end(1, 100, true);
  assert.equal(t.end(2, 100), null);
  for (const id of [1, 2, 3, 4]) t.start(id, id * 10, 0, 0);
  for (const id of [1, 2, 3]) t.end(id, 100);
  assert.equal(t.end(4, 100), null);
  assert.equal(t.end(99, 100), null, 'an unknown pointer is ignored');
});

test('the listener uses touch pointers only (a pen or mouse never taps) and reports finger counts', () => {
  const handlers = new Map<string, (e: Event) => void>();
  const root = {
    addEventListener: (k: string, fn: (e: Event) => void) => handlers.set(k, fn),
    removeEventListener: (k: string) => handlers.delete(k),
  } as unknown as Document;
  const taps: number[] = [];
  const counts: number[] = [];
  const stop = listenFingerTaps(root, (n) => taps.push(n), (n) => counts.push(n));
  const fire = (type: string, id: number, pointerType = 'touch', t = 0) => handlers.get(type)!({ type, pointerId: id, pointerType, clientX: id * 40, clientY: 10, timeStamp: t } as unknown as Event);
  fire('pointerdown', 1);
  fire('pointerdown', 2, 'touch', 10);
  fire('pointerup', 1, 'touch', 60);
  fire('pointerup', 2, 'touch', 80);
  fire('pointerdown', 3, 'pen');
  fire('pointerdown', 4, 'mouse');
  fire('pointerup', 3, 'pen', 30);
  fire('pointerup', 4, 'mouse', 30);
  assert.deepEqual(taps, [2]);
  assert.deepEqual(counts, [1, 2]);
  stop();
  assert.equal(handlers.size, 0);
});
