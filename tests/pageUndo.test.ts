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

test('a box text history outlives its editor: redo after the box is undone away and back (F9)', async () => {
  const { ySyncPluginKey } = await import('@tiptap/y-tiptap');
  const doc = new Y.Doc();
  const boxes = doc.getMap<number>('boxes');
  const geom = new Y.UndoManager(boxes, { trackedOrigins: new Set([GEOM]), captureTimeout: 0 });
  const page = new PageUndo();
  page.add({ manager: () => geom });
  const frag = doc.getXmlFragment('box:b');
  const typing = page.textUndo(doc, 'box:b', () => boxes.has('b'));
  typing.captureTimeout = 0;
  assert.equal(page.textUndo(doc, 'box:b'), typing, 'one history per box');
  const text = () => frag.toString();

  doc.transact(() => boxes.set('b', 1), GEOM); // create the box
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('Bravo')]);
    frag.insert(0, [p]);
  }, ySyncPluginKey); // type in it
  // The editor unmounts (y-tiptap destroys "its" manager): the history stays, still on the page.
  typing.destroy();

  page.undo(); // typing
  assert.equal(text(), '');
  page.undo(); // the box
  assert.equal(boxes.has('b'), false);
  assert.equal(page.canUndo(), false);
  page.redo(); // the box comes back
  assert.equal(boxes.has('b'), true);
  assert.equal(page.redo(), true); // and its text
  assert.match(text(), /Bravo/);
  assert.equal(page.canRedo(), false);

  // A box someone else removed: its text history is passed over.
  doc.transact(() => boxes.delete('b'), 'remote');
  assert.equal(typing.undoStack.length, 1);
  page.undo(); // the box's creation, not its (invisible) text
  assert.match(text(), /Bravo/);
  assert.equal(page.canUndo(), false, 'nothing left on boxes that exist');

  doc.destroy(); // page closed: histories let go
  assert.equal(page.canUndo(), false);
});
