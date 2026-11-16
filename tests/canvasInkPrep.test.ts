// Ink groundwork (docs/PLAN_INK.md, phase I0): the screen↔page transform, pointer routing,
// the reserved `ink` map and the page format version. Nothing here changes behaviour yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { CANVAS_SCALE, canvasView, deltaToPage, lengthToPage, lengthToScreen, pointerKind, routePointer, toPage, toScreen } from '../src/editor/canvasGeom.ts';
import {
  INK_KEY,
  PAGE_FORMAT_KEY,
  PAGE_FORMAT_VERSION,
  dropInvalidInk,
  hasInk,
  inkSearchText,
  isNewerPageFormat,
  pageFormatVersion,
  pageFragments,
  pageInk,
  replaceInk,
  replacePageContent,
  upgradePageDoc,
} from '../shared/pageDoc.ts';

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `${JSON.stringify(a)} ≈ ${JSON.stringify(b)}`);
};

test('at scale 1, page = client minus the surface corner (what the canvas did before)', () => {
  assert.equal(CANVAS_SCALE, 1);
  const v = canvasView({ left: 230, top: 140 });
  assert.deepEqual(toPage(v, 530, 200), { x: 300, y: 60 });
  assert.deepEqual(toScreen(v, 300, 60), { x: 530, y: 200 });
  assert.deepEqual(deltaToPage(v, 12, -7), { dx: 12, dy: -7 });
  assert.equal(lengthToPage(v, 900), 900);
  assert.equal(lengthToScreen(v, 900), 900);
});

test('screen → page → screen round-trips at any scale', () => {
  for (const scale of [0.25, 0.5, 1, 1.5, 2, 3.75]) {
    const v = canvasView({ left: -125.5, top: 48.25 }, scale);
    for (const [cx, cy] of [
      [0, 0],
      [310.5, 1200],
      [-40, 7.125],
    ] as const) {
      const p = toPage(v, cx, cy);
      close(toScreen(v, p.x, p.y), { x: cx, y: cy });
    }
    close(toPage(v, ...(Object.values(toScreen(v, 640, 480)) as [number, number])), { x: 640, y: 480 });
    assert.equal(lengthToScreen(v, lengthToPage(v, 777)), 777);
  }
});

test('zoomed in, the same screen distance is a shorter page distance', () => {
  const v = canvasView({ left: 0, top: 0 }, 2);
  assert.deepEqual(toPage(v, 200, 100), { x: 100, y: 50 });
  assert.deepEqual(deltaToPage(v, 30, 10), { dx: 15, dy: 5 });
  assert.equal(lengthToPage(v, 1000), 500);
});

test('pointer kinds: pen, touch, and everything else is a mouse', () => {
  assert.equal(pointerKind({ pointerType: 'pen' }), 'pen');
  assert.equal(pointerKind({ pointerType: 'touch' }), 'touch');
  assert.equal(pointerKind({ pointerType: 'mouse' }), 'mouse');
  assert.equal(pointerKind({ pointerType: '' }), 'mouse');
  assert.equal(pointerKind({}), 'mouse'); // a plain MouseEvent
});

test('with the select tool every pointer goes to the box UI (today\'s behaviour)', () => {
  for (const kind of ['pen', 'touch', 'mouse'] as const) {
    assert.equal(routePointer(kind, { tool: 'select', canEdit: true }), 'ui');
    assert.equal(routePointer(kind, { tool: 'select', canEdit: true, fingerDrawing: true }), 'ui');
  }
});

test('the ink tool claims the pen; a finger only with finger drawing on; never for viewers', () => {
  assert.equal(routePointer('pen', { tool: 'ink', canEdit: true }), 'ink');
  assert.equal(routePointer('mouse', { tool: 'ink', canEdit: true }), 'ink');
  assert.equal(routePointer('touch', { tool: 'ink', canEdit: true }), 'ui'); // off by default: a finger scrolls
  assert.equal(routePointer('touch', { tool: 'ink', canEdit: true, fingerDrawing: true }), 'ink');
  assert.equal(routePointer('pen', { tool: 'ink', canEdit: false }), 'ui');
});

test('a page without ink has no strokes, and reading it writes nothing', () => {
  const doc = new Y.Doc();
  doc.getXmlFragment('box:a').insert(0, [new Y.XmlElement('paragraph')]);
  const before = Y.encodeStateAsUpdate(doc);
  assert.deepEqual(pageInk(doc), []);
  assert.equal(hasInk(doc), false);
  assert.equal(inkSearchText(doc), '');
  assert.equal(dropInvalidInk(doc), 0);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
});

test('ink is not page text: pageFragments ignores it', () => {
  const doc = new Y.Doc();
  doc.getMap(INK_KEY).set('s1', new Uint8Array([1, 2, 3]));
  assert.equal(pageFragments(doc).length, 1); // just `default`
  assert.equal(hasInk(doc), true);
  assert.deepEqual(pageInk(doc), [{ id: 's1', data: new Uint8Array([1, 2, 3]) }]);
});

test('entries that are not stroke blobs are skipped and can be dropped', () => {
  const doc = new Y.Doc();
  const ink = doc.getMap<unknown>(INK_KEY);
  ink.set('ok', new Uint8Array([9]));
  ink.set('text', 'not a stroke');
  ink.set('map', new Y.Map());
  assert.deepEqual(pageInk(doc).map((s) => s.id), ['ok']);
  assert.equal(dropInvalidInk(doc), 2);
  assert.deepEqual([...ink.keys()], ['ok']);
});

test('an app that does not know `ink` syncs the page without losing strokes', () => {
  const newer = new Y.Doc();
  newer.getMap(INK_KEY).set('s1', new Uint8Array([4, 5]));
  // An older app: loads the update, edits only text, sends its state back.
  const older = new Y.Doc();
  Y.applyUpdate(older, Y.encodeStateAsUpdate(newer));
  older.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
  const roundTrip = new Y.Doc();
  Y.applyUpdate(roundTrip, Y.encodeStateAsUpdate(older));
  assert.deepEqual(pageInk(roundTrip), [{ id: 's1', data: new Uint8Array([4, 5]) }]);
});

test('restoring a version restores its handwriting, and changes nothing when neither has any', () => {
  const page = new Y.Doc();
  page.getMap(INK_KEY).set('now', new Uint8Array([1]));
  const version = new Y.Doc();
  version.getMap(INK_KEY).set('then', new Uint8Array([2]));
  replaceInk(page, version);
  assert.deepEqual(pageInk(page), [{ id: 'then', data: new Uint8Array([2]) }]);

  const a = new Y.Doc();
  const b = new Y.Doc();
  b.getXmlFragment('box:x');
  const before = Y.encodeStateAsUpdate(a);
  replaceInk(a, b);
  assert.deepEqual(Y.encodeStateAsUpdate(a), before);

  // Through the restore used by version history.
  const target = new Y.Doc();
  const source = new Y.Doc();
  source.getMap(INK_KEY).set('v', new Uint8Array([7]));
  replacePageContent(target, source, 'canvas', () => 'id');
  assert.deepEqual(pageInk(target), [{ id: 'v', data: new Uint8Array([7]) }]);
});

test('page format: unversioned pages are 1, and upgrading them to 2 writes nothing', () => {
  const doc = new Y.Doc();
  doc.getXmlFragment('box:a').insert(0, [new Y.XmlElement('paragraph')]);
  const before = Y.encodeStateAsUpdate(doc);
  assert.equal(pageFormatVersion(doc), 1);
  assert.equal(PAGE_FORMAT_VERSION, 2);
  assert.equal(upgradePageDoc(doc), false);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert.equal(isNewerPageFormat(doc), false);
});

test('page format: a page from a newer app is recognised and left alone', () => {
  const doc = new Y.Doc();
  doc.getMap(PAGE_FORMAT_KEY).set('version', PAGE_FORMAT_VERSION + 1);
  assert.equal(isNewerPageFormat(doc), true);
  assert.equal(upgradePageDoc(doc), false);
  assert.equal(pageFormatVersion(doc), PAGE_FORMAT_VERSION + 1);
  doc.getMap(PAGE_FORMAT_KEY).set('version', 'junk');
  assert.equal(pageFormatVersion(doc), 1);
});
