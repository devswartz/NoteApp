// Page settings (page colour, rule lines) in a page's Y.Doc: read/write helpers, live sync,
// ignored as content, kept through the import path and version restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  BOXES_KEY,
  DEFAULT_PAGE_SETTINGS,
  PAGE_SETTINGS_KEY,
  boxField,
  convertPageDoc,
  newBoxMap,
  observePageSettings,
  pageFragments,
  pageSettingsAttrs,
  parsePageSettings,
  readPageSettings,
  replacePageContent,
  setPageSettings,
  type PageColor,
} from '../shared/pageDoc.ts';
import { sanitizeYDoc } from '../server/sanitizeDoc.ts';

let n = 0;
const ids = () => `s${++n}`;

function withBox(doc: Y.Doc, id: string, text: string) {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  p.insert(0, [t]);
  t.insert(0, text);
  doc.getXmlFragment(boxField(id)).insert(0, [p]);
  doc.getMap(BOXES_KEY).set(id, newBoxMap({ x: 0, y: 0, w: 400, z: 1 }));
}

test('defaults when unset; invalid values fall back', () => {
  const doc = new Y.Doc();
  assert.deepEqual(readPageSettings(doc), DEFAULT_PAGE_SETTINGS);
  doc.getMap(PAGE_SETTINGS_KEY).set('color', 'chartreuse');
  doc.getMap(PAGE_SETTINGS_KEY).set('rules', 42);
  assert.deepEqual(readPageSettings(doc), { color: 'none', rules: 'none' });
  assert.deepEqual(parsePageSettings(null), DEFAULT_PAGE_SETTINGS);
  assert.deepEqual(parsePageSettings(['blue']), DEFAULT_PAGE_SETTINGS);
  assert.deepEqual(parsePageSettings({ color: 'blue', rules: 'grid' }), { color: 'blue', rules: 'grid' });
});

test('setPageSettings writes valid values only, and stores none explicitly', () => {
  const doc = new Y.Doc();
  setPageSettings(doc, { color: 'green' });
  assert.deepEqual(readPageSettings(doc), { color: 'green', rules: 'none' });
  setPageSettings(doc, { rules: 'lines', color: 'nope' as PageColor });
  assert.deepEqual(readPageSettings(doc), { color: 'green', rules: 'lines' });
  setPageSettings(doc, { color: 'none' });
  assert.equal(doc.getMap(PAGE_SETTINGS_KEY).get('color'), 'none');
  assert.deepEqual(pageSettingsAttrs(doc), { rules: 'lines' });
  setPageSettings(doc, { rules: 'none' });
  assert.equal(pageSettingsAttrs(doc), null);
});

test('settings sync between docs and notify observers', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
  const seen: string[] = [];
  const stop = observePageSettings(b, (s) => seen.push(`${s.color}/${s.rules}`));
  setPageSettings(a, { color: 'purple', rules: 'grid' });
  assert.deepEqual(readPageSettings(b), { color: 'purple', rules: 'grid' });
  assert.deepEqual(seen, ['purple/grid']);
  stop();
  setPageSettings(a, { color: 'pink' });
  assert.equal(seen.length, 1);
});

test('not page content: pageFragments ignores it', () => {
  const doc = new Y.Doc();
  withBox(doc, 'b1', 'hello');
  const before = pageFragments(doc).length;
  setPageSettings(doc, { color: 'blue' });
  assert.equal(pageFragments(doc).length, before);
});

test('kept through the workspace import path (encode, sanitize, convert)', () => {
  const doc = new Y.Doc();
  withBox(doc, 'b1', 'hello');
  setPageSettings(doc, { color: 'yellow', rules: 'lines' });
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  sanitizeYDoc(copy, {});
  convertPageDoc(copy, 'canvas', ids);
  const again = new Y.Doc();
  Y.applyUpdate(again, Y.encodeStateAsUpdate(copy));
  assert.deepEqual(readPageSettings(again), { color: 'yellow', rules: 'lines' });
});

test('version restore brings back the version’s settings; an older version keeps the current ones', () => {
  const live = new Y.Doc();
  withBox(live, 'b1', 'now');
  setPageSettings(live, { color: 'blue', rules: 'grid' });

  const version = new Y.Doc();
  withBox(version, 'b2', 'then');
  setPageSettings(version, { color: 'none', rules: 'lines' });
  replacePageContent(live, version, 'canvas', ids);
  assert.deepEqual(readPageSettings(live), { color: 'none', rules: 'lines' });

  const old = new Y.Doc();
  withBox(old, 'b3', 'long ago');
  replacePageContent(live, old, 'canvas', ids);
  assert.deepEqual(readPageSettings(live), { color: 'none', rules: 'lines' });
});
