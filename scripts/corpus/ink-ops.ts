// A reference for the native core's ink calls (crates/nv-core/src/ink.rs, crates/nv-model/src/ink.rs):
// today's web ink code does the same edits to the `settings-and-ink` corpus page and what it leaves
// behind is committed in tests/corpus/ink-ops/. `crates/nv-core/tests/ink_ops.rs` makes the edits
// through the Rust calls and must end with the same stroke blobs, byte for byte, after every step.
//   node --import tsx scripts/corpus/ink-ops.ts
//
// What is the web's own code, run here as it is: the engine (src/ink/engine.ts over the committed
// WASM of crates/nv-ink: the builder with its smoothing, `erase`, `hitPath`, `hitLasso`, `encode`,
// `points`, `info`), `commitStroke` / `commitErase` / `EraseSession` / `zAfter` / `topZ`
// (src/ink/strokes.ts), `pageInk` (shared/pageDoc.ts).
// Copied (their bodies live in React files): the layer rule of `InkRenderer.zKeys` (render.ts) and
// the per-move loop of `eraseGesture` (InkSurface.tsx, the part that is not the renderer).
// Not the web's (it has no lasso, move or recolour UI yet, PLAN_INK I5): step 5 moves strokes the
// way a move would, by decoding the points with the engine, shifting them and encoding again, and
// step 6 asks the engine's `hitLasso` (default fraction 0.5) which strokes a polygon selects.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { INK_KEY, pageInk } from '../../shared/pageDoc.ts';
import { FLAG, TOOL, initInk, packColor, type InkEngine } from '../../src/ink/engine.ts';
import { EraseSession, commitErase, commitStroke, topZ, zAfter } from '../../src/ink/strokes.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/corpus');
const WASM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/ink/generated/nv_ink_bg.wasm');
const CREATED = 1_760_000_000_000;
const ERASER_RADIUS = 8; // src/ink/inkTool.ts

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

const ink = await initInk(fs.readFileSync(WASM));
const doc = new Y.Doc();
doc.clientID = 2;
Y.applyUpdate(doc, fs.readFileSync(path.join(ROOT, 'cases/settings-and-ink/page.bin')));

/** Every blob in the `ink` map as base64, sorted (ids are random, so a state is compared as a set). */
const state = () =>
  [...doc.getMap<unknown>(INK_KEY).values()]
    .filter((v): v is Uint8Array => v instanceof Uint8Array)
    .map(b64)
    .sort();

// Copied from InkRenderer.zKeys (src/ink/render.ts): the z keys of the strokes on a layer, over
// the strokes the engine can read completely (InkRenderer.put).
function zKeys(tool: number): string[] {
  const out: string[] = [];
  for (const { data } of pageInk(doc)) {
    const info = ink.info(data);
    if (!info || !ink.valid(data)) continue;
    if ((info.tool === TOOL.highlighter) === (tool === TOOL.highlighter)) out.push(info.z);
  }
  return out;
}

interface Add {
  tool: number;
  color: number;
  width: number;
  flags: number;
  samples: number[][];
}
/** The web's strokeGesture: a builder fed the samples, z after the top key of its layer, committed. */
function addStroke(a: Add) {
  const b = ink.builder({ tool: a.tool, color: a.color, width: a.width, z: zAfter(topZ(zKeys(a.tool))), flags: a.flags, created: CREATED });
  for (const s of a.samples) b.push(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!);
  const blob = b.finish();
  if (!blob) throw new Error('no points');
  commitStroke(doc, blob);
  return blob;
}

// Copied from eraseGesture's `apply` (src/ink/InkSurface.tsx), the renderer's info replaced by the engine's.
function erase(track: number[], partial: boolean) {
  const session = new EraseSession();
  const rad = ERASER_RADIUS;
  const xs = track.filter((_, i) => i % 2 === 0);
  const ys = track.filter((_, i) => i % 2 === 1);
  const box = { minX: Math.min(...xs) - rad, minY: Math.min(...ys) - rad, maxX: Math.max(...xs) + rad, maxY: Math.max(...ys) + rad };
  for (const [id, blob] of session.visible(pageInk(doc).map((s) => [s.id, s.data] as [string, Uint8Array]))) {
    if (!ink.valid(blob)) continue;
    const b = ink.info(blob)?.bounds;
    if (!b || b.minX > box.maxX || box.minX > b.maxX || b.minY > box.maxY || box.minY > b.maxY) continue;
    if (partial) {
      const pieces = ink.erase(blob, track, rad);
      if (pieces) session.replace(id, pieces);
    } else if (ink.hitPath(blob, track, rad)) session.replace(id);
  }
  session.commit(doc);
}

const samples = (n: number, f: (i: number) => number[], t0 = 1000, dt = 8) => Array.from({ length: n }, (_, i) => [...f(i), Math.PI / 2, 0, t0 + i * dt]);
const BLUE = packColor('#1d4ed8');
const RED = packColor('#dc2626');
const YELLOW = packColor('#facc15', 0.35);

const steps: Record<string, unknown>[] = [];
const before = state();

// 1. A blue pen stroke: an arc with varying pressure (60 samples, 8 ms apart).
const arc = {
  tool: TOOL.pen,
  color: BLUE,
  width: 2.5,
  flags: FLAG.pressure,
  samples: samples(60, (i) => [100 + i * 5, 200 + 50 * Math.sin(i / 9), 0.2 + 0.7 * Math.abs(Math.sin(i / 11))]),
};
const blobA = addStroke(arc);
steps.push({ op: 'add', input: arc, blob: b64(blobA), after: state() });

// 2. A yellow highlighter across it (its own z layer).
const marker = { tool: TOOL.highlighter, color: YELLOW, width: 18, flags: 0, samples: samples(30, (i) => [100 + i * 10, 300, 0.5]) };
const blobB = addStroke(marker);
steps.push({ op: 'add', input: marker, blob: b64(blobB), after: state() });

// 3. A red pen stroke: a vertical line (z one after the arc's).
const line = { tool: TOOL.pen, color: RED, width: 4, flags: FLAG.pressure | FLAG.tilt, samples: samples(40, (i) => [500, 100 + i * 7.5, 0.3 + i / 100]) };
const blobC = addStroke(line);
steps.push({ op: 'add', input: line, blob: b64(blobC), after: state() });

// 4a. The partial eraser along a vertical track that crosses the arc and the highlighter.
const trackPartial = [250, 150, 250, 320];
erase(trackPartial, true);
steps.push({ op: 'erase', partial: true, track: trackPartial, radius: ERASER_RADIUS, after: state() });
// 4b. The stroke eraser across the red line.
const trackWhole = [480, 250, 520, 250];
erase(trackWhole, false);
steps.push({ op: 'erase', partial: false, track: trackWhole, radius: ERASER_RADIUS, after: state() });

// 5. Move the pieces of the arc that lie left of x = 250 by (30, -12.5) (not a web feature, see the header).
const dx = 30;
const dy = -12.5;
const moving = pageInk(doc).filter((s) => {
  const info = ink.info(s.data);
  return info && ink.valid(s.data) && info.tool === TOOL.pen && info.color === BLUE && info.bounds.maxX < 250;
});
const shifted = moving.map((s) => {
  const info = ink.info(s.data)!;
  const pts = Array.from(ink.points(s.data)!);
  for (let i = 0; i < pts.length; i += 6) {
    pts[i] = pts[i]! + dx;
    pts[i + 1] = pts[i + 1]! + dy;
  }
  return ink.encode({ tool: info.tool, color: info.color, width: info.width, z: info.z, flags: info.flags, created: info.created }, pts);
});
commitErase(
  doc,
  moving.map((s) => s.id),
  shifted,
);
steps.push({ op: 'move', dx, dy, of: moving.map((s) => b64(s.data)), after: state() });

// 6. Lasso: which readable strokes a polygon selects (at least half their points inside), for two polygons.
const lassos = [
  { polygon: [60, 120, 300, 120, 300, 340, 60, 340], minFraction: 0.5 },
  { polygon: [90, 130, 200, 130, 200, 260, 90, 260], minFraction: 0.5 },
  { polygon: [90, 130, 200, 130, 200, 260, 90, 260], minFraction: 0.01 },
];
for (const l of lassos) {
  const selected = pageInk(doc)
    .filter((s) => ink.valid(s.data) && ink.hitLasso(s.data, l.polygon, l.minFraction))
    .map((s) => b64(s.data))
    .sort();
  steps.push({ op: 'lasso', ...l, selected });
}

const out = path.join(ROOT, 'ink-ops');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'after.bin'), Y.encodeStateAsUpdate(doc));
fs.writeFileSync(
  path.join(out, 'expected.json'),
  JSON.stringify(
    {
      about:
        'The settings-and-ink page after the web ink code added a pen arc, a highlighter and a red line, partial-erased the arc and highlighter along one track, stroke-erased the red line, then moved the left pieces of the arc by (30, -12.5) (an engine decode/shift/encode: the web has no move yet) and ran three lasso hit tests. Strokes are compared as blobs (base64); ids are random so each state is the sorted list of every blob in the ink map, including the corpus page\'s own opaque ones. Made by scripts/corpus/ink-ops.ts.',
      engineFormatVersion: ink.formatVersion,
      created: CREATED,
      before,
      steps,
    },
    null,
    2,
  ) + '\n',
);
console.log('ink-ops: wrote tests/corpus/ink-ops');
