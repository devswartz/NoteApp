// Page-level undo across a canvas page's undo managers (src/editor/pageUndo.ts): box geometry
// and box text share one history, most recent change first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { PageUndo } from '../src/editor/pageUndo.ts';

const GEOM = { canvas: 'geometry' };
const TEXT = { text: 'box' };

function setup() {
  const doc = new Y.Doc();
  const boxes = doc.getMap<number>('boxes');
  const text = doc.getText('box:a');
  const geom = new Y.UndoManager(boxes, { trackedOrigins: new Set([GEOM]), captureTimeout: 0 });
  const typing = new Y.UndoManager(text, { trackedOrigins: new Set([TEXT]), captureTimeout: 0 });
  const page = new PageUndo();
  page.add({ manager: () => geom });
  page.add({ manager: () => typing });
  const move = (x: number) => doc.transact(() => boxes.set('x', x), GEOM);
  const type = (s: string) => doc.transact(() => text.insert(text.length, s), TEXT);
  return { doc, boxes, text, geom, typing, page, move, type };
}

test('undo takes back the most recent change, whichever history holds it', () => {
  const { boxes, text, page, move, type } = setup();
  assert.equal(page.canUndo(), false);
  type('Hello');
  move(100); // a box moved while its text is being edited
  assert.equal(page.canUndo(), true);

  assert.equal(page.undo(), true);
  assert.equal(boxes.get('x'), undefined, 'the move is undone first');
  assert.equal(text.toString(), 'Hello');

  assert.equal(page.undo(), true);
  assert.equal(text.toString(), '', 'then the typing');
  assert.equal(page.canUndo(), false);
  assert.equal(page.undo(), false);
});

test('redo replays in order, most recently undone first', () => {
  const { boxes, text, page, move, type } = setup();
  move(10);
  type('A');
  page.undo(); // typing
  page.undo(); // move
  assert.equal(page.canRedo(), true);
  page.redo();
  assert.equal(boxes.get('x'), 10, 'the move comes back first');
  assert.equal(text.toString(), '');
  page.redo();
  assert.equal(text.toString(), 'A');
  assert.equal(page.canRedo(), false);
});

test('a new change anywhere ends redo everywhere', () => {
  const { page, move, type } = setup();
  move(10);
  page.undo();
  assert.equal(page.canRedo(), true);
  type('new text');
  assert.equal(page.canRedo(), false);
});

test('subscribers hear about every stack change; removed histories are no longer used', () => {
  const { page, move, type, geom } = setup();
  let calls = 0;
  const off = page.subscribe(() => calls++);
  move(5);
  assert.ok(calls > 0);
  const before = calls;
  page.undo();
  assert.ok(calls > before);
  off();

  const page2 = new PageUndo();
  const remove = page2.add({ manager: () => geom });
  type('x');
  move(7);
  assert.equal(page2.canUndo(), true);
  remove();
  assert.equal(page2.canUndo(), false);
});

test('remote changes are not undone', () => {
  const { doc, boxes, page, move } = setup();
  move(1);
  doc.transact(() => boxes.set('y', 2), 'remote');
  page.undo();
  assert.equal(boxes.get('x'), undefined);
  assert.equal(boxes.get('y'), 2);
  assert.equal(page.canUndo(), false);
});
