// A reference for the native core's box calls (crates/nv-model/src/boxes.rs): today's web code
// does the same five edits to the `canvas-boxes` corpus page, and what it leaves behind is
// committed in tests/corpus/box-ops/. `crates/nv-model/tests/box_ops.rs` does them through the
// Rust calls and must end with the same `boxes` map and fragments.
//   node --import tsx scripts/corpus/box-ops.ts
// What is the web's own code: `newBoxMap` (shared/pageDoc.ts), `boxAtClick`, `frontZ`,
// `clampPos`/`clampWidth` (src/editor/canvasGeom.ts), `boxGeoms`, `pageFragments`. `setGeom` and
// `removeBox` live inside CanvasEditor.tsx (React), so their bodies are copied here (marked).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { BOXES_KEY, boxField, boxGeoms, newBoxMap, pageFragments, type BoxGeom } from '../../shared/pageDoc.ts';
import { boxAtClick, clampPos, clampWidth, frontZ } from '../../src/editor/canvasGeom.ts';
import { nodeJson } from './expect.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/corpus');

// Copied from src/editor/CanvasEditor.tsx `setGeom` (line ~188).
function setGeom(doc: Y.Doc, id: string, fields: Partial<Omit<BoxGeom, 'id'>>) {
  const m = doc.getMap<unknown>(BOXES_KEY).get(id);
  if (!(m instanceof Y.Map)) return;
  doc.transact(() => {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) {
        if (m.has(k)) m.delete(k);
      } else if (m.get(k) !== v) m.set(k, v);
    }
  });
}

// Copied from `removeBox` (the box and its content, one transaction).
function removeBox(doc: Y.Doc, id: string) {
  const map = doc.getMap<unknown>(BOXES_KEY);
  if (!map.has(id)) return;
  const frag = doc.getXmlFragment(boxField(id));
  doc.transact(() => {
    map.delete(id);
    if (frag.length) frag.delete(0, frag.length);
  });
}

const doc = new Y.Doc();
doc.clientID = 2;
Y.applyUpdate(doc, fs.readFileSync(path.join(ROOT, 'cases/canvas-boxes/page.bin')));

// 1. A click at (300, 212) with the default width: x 300, y 200, in front (createBox).
const g = boxAtClick(boxGeoms(doc), 300, 212);
doc.transact(() => doc.getMap<unknown>(BOXES_KEY).set('new1', newBoxMap(g)));
// 2. Drag box `a` to (111, 222.6) (clampPos, then setGeom).
setGeom(doc, 'a', clampPos(111, 222.6));
// 3. Drag the wide box's edge to 500 (setGeom with `wide: undefined`).
setGeom(doc, 'top', { w: clampWidth(500), wide: undefined });
// 4. Bring `c` to front (frontZ, then setGeom).
const z = frontZ(boxGeoms(doc), 'c');
if (z !== null) setGeom(doc, 'c', { z });
// 5. Remove the empty box.
removeBox(doc, 'empty');

const out = path.join(ROOT, 'box-ops');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'after.bin'), Y.encodeStateAsUpdate(doc));
const frags = pageFragments(doc).map((f, i) => ({ index: i, content: f.toArray().map(nodeJson) }));
fs.writeFileSync(
  path.join(out, 'expected.json'),
  JSON.stringify(
    {
      about:
        'The canvas-boxes page after the web code made a box at a click (300,212), moved a to (111,222.6), set the wide box top to width 500, brought c to front and removed empty. boxes = the raw `boxes` map as JSON.',
      boxes: doc.getMap(BOXES_KEY).toJSON(),
      geoms: boxGeoms(doc).sort((a, b) => (a.id < b.id ? -1 : 1)),
      fragmentCount: frags.length,
    },
    null,
    2,
  ) + '\n',
);
console.log('box-ops: wrote tests/corpus/box-ops');
