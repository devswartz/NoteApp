// Writing ink to the page doc (src/ink/strokes.ts): one transaction per stroke or erase, z keys,
// the erase gesture's working set, and undo shared with the canvas's box changes (canvasUndoManager).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { BOXES_KEY, INK_KEY, newBoxMap, pageInk } from '../shared/pageDoc.ts';
import { EraseSession, FIRST_Z, INK_ORIGIN, commitErase, commitStroke, newStrokeId, topZ, zAfter, zCompare } from '../src/ink/strokes.ts';
import { GEOM_ORIGIN, canvasUndoManager } from '../src/editor/canvasUndo.ts';

const blob = (n: number) => new Uint8Array([1, n, n, n]);

test('z keys always grow, stay short, and order like strings', () => {
  let z = zAfter(null);
  assert.equal(z, FIRST_Z);
  const seen = [z];
  for (let i = 0; i < 5000; i++) {
    const next = zAfter(z);
    assert.ok(next > z, `${next} > ${z}`);
    z = next;
    seen.push(z);
  }
  assert.ok(z.length <= 4, z);
  assert.deepEqual([...seen].sort(), seen);
  // A key from somewhere else (not one of ours) still gets something after it.
  assert.ok(zAfter('zzz') > 'zzz');
  assert.ok(zAfter('a~') > 'a~');
  assert.ok(zAfter('az') > 'az');
  assert.equal(topZ(['a3', 'b10', 'a9']), 'b10');
  assert.equal(topZ([]), null);
  assert.ok(zCompare({ z: 'a1', id: 'x' }, { z: 'a1', id: 'y' }) < 0);
});

test('stroke ids are short and unique', () => {
  const ids = new Set(Array.from({ length: 2000 }, newStrokeId));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^[0-9a-z]{12}$/);
});

test('a stroke is one transaction, made with INK_ORIGIN', () => {
  const doc = new Y.Doc();
  const origins: unknown[] = [];
  doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
  const id = commitStroke(doc, blob(1));
  assert.deepEqual(origins, [INK_ORIGIN]);
  assert.deepEqual(pageInk(doc), [{ id, data: blob(1) }]);
});

test('an erase removes and adds in one transaction, skipping strokes already gone', () => {
  const doc = new Y.Doc();
  const a = commitStroke(doc, blob(1));
  const b = commitStroke(doc, blob(2));
  let n = 0;
  doc.on('afterTransaction', () => n++);
  const ids = commitErase(doc, [a, 'gone'], [blob(3), blob(4)]);
  assert.equal(n, 1);
  assert.equal(ids.length, 2);
  assert.deepEqual(new Set(pageInk(doc).map((s) => s.id)), new Set([b, ...ids]));
});

test('an erase gesture works on its own pieces until it commits', () => {
  const doc = new Y.Doc();
  const a = commitStroke(doc, blob(1));
  const b = commitStroke(doc, blob(2));
  const page = () => pageInk(doc).map((s) => [s.id, s.data] as [string, Uint8Array]);
  const s = new EraseSession();
  assert.equal(s.changed, false);
  assert.deepEqual(s.commit(doc), []);
  s.replace(a, [blob(5), blob(6)]); // partial eraser cut A in two
  const vis = s.visible(page());
  assert.equal(vis.length, 3);
  const piece = vis.find(([, d]) => d[1] === 5)![0];
  s.replace(piece, []); // then erased one of the pieces whole
  assert.deepEqual(s.visible(page()).map(([, d]) => d[1]).sort(), [2, 6]);
  assert.equal(pageInk(doc).length, 2, 'nothing written yet');
  const ids = s.commit(doc);
  assert.equal(ids.length, 1);
  assert.deepEqual(pageInk(doc).map((x) => x.data[1]).sort(), [2, 6]);
  assert.ok(pageInk(doc).some((x) => x.id === b));
});

test('undo takes back strokes, erases and box moves in order, one step each, and never a collaborator\'s stroke', () => {
  const doc = new Y.Doc();
  const um = canvasUndoManager(doc, 10_000); // a long capture window: steps are split by stopCapturing, as the canvas does
  const boxes = doc.getMap<unknown>(BOXES_KEY);
  doc.transact(() => boxes.set('b1', newBoxMap({ x: 0, y: 0, w: 300, z: 1 })), GEOM_ORIGIN);
  um.stopCapturing();
  const s1 = commitStroke(doc, blob(1));
  um.stopCapturing();
  const s2 = commitStroke(doc, blob(2));
  um.stopCapturing();
  // A collaborator's stroke arrives (a remote update has no INK_ORIGIN).
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
  remote.getMap(INK_KEY).set('theirs', blob(9));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), 'remote');
  commitErase(doc, [s1], [blob(7)]);
  um.stopCapturing();

  const ids = () => new Set(pageInk(doc).map((s) => s.id));
  assert.equal(ids().size, 3); // s2, the piece, theirs
  um.undo(); // the erase
  assert.ok(ids().has(s1) && ids().has(s2) && ids().has('theirs') && ids().size === 3);
  um.undo(); // s2
  assert.deepEqual(ids(), new Set([s1, 'theirs']));
  um.undo(); // s1
  assert.deepEqual(ids(), new Set(['theirs']));
  um.undo(); // the box
  assert.equal(boxes.size, 0);
  assert.deepEqual(ids(), new Set(['theirs']), 'their stroke stays');
  um.redo();
  um.redo();
  assert.equal(boxes.size, 1);
  assert.deepEqual(ids(), new Set([s1, 'theirs']));
});
