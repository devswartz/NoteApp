// The ink engine's TypeScript wrapper (src/ink/engine.ts) over the committed WASM build of
// crates/nv-ink, and the print SVG (src/ink/svg.ts). The Rust crate has its own unit and property
// tests (cargo test); these check the JS boundary: types, framing, freeing, and the SVG.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FLAG, OP, TOOL, cssColor, initInk, packColor, unframe, type InkEngine, type StrokeStyle } from '../src/ink/engine.ts';
import { inkSvg } from '../src/ink/svg.ts';

let ink: InkEngine;
before(async () => {
  ink = await initInk(readFileSync(new URL('../src/ink/generated/nv_ink_bg.wasm', import.meta.url)));
});

const BLACK = packColor('#1f2328');
const style: StrokeStyle = { tool: TOOL.pen, color: BLACK, width: 2, z: 'a0', flags: FLAG.pressure, created: 1_763_000_000_000 };

/** A stroke drawn through the builder like the pen does: a straight line from (x0, y) to (x1, y). */
function line(x0: number, x1: number, y = 50, s = style): Uint8Array {
  const b = ink.builder(s);
  for (let i = 0; i <= 40; i++) b.push(x0 + ((x1 - x0) * i) / 40, y, 0.5, Math.PI / 2, 0, i * 4);
  const blob = b.finish();
  assert.ok(blob);
  return blob;
}

test('a stroke built from pen samples decodes with its style and bounds', () => {
  const blob = line(10, 110);
  const info = ink.info(blob)!;
  assert.equal(info.version, ink.formatVersion);
  assert.equal(info.tool, TOOL.pen);
  assert.equal(info.color, BLACK);
  assert.equal(info.width, 2);
  assert.equal(info.flags, FLAG.pressure);
  assert.equal(info.created, 1_763_000_000_000);
  assert.equal(info.z, 'a0');
  assert.ok(info.count >= 2 && info.count <= 41);
  // The ink reaches 1 px (half the width at pressure 0.5) around the line.
  assert.ok(Math.abs(info.bounds.minX - 9) < 0.3 && Math.abs(info.bounds.maxY - 51) < 0.3, JSON.stringify(info.bounds));
  assert.ok(ink.valid(blob));
  // Compact: ~5 bytes per point plus a small header.
  assert.ok(blob.length < 40 + info.count * 6, `${blob.length} bytes for ${info.count} points`);
});

test('encode and points round-trip within the 1/8 px grid', () => {
  const pts = [0, 0, 0.5, 1, 2, 0, 10.06, 3.3, 0.9, 1, 2, 16];
  const blob = ink.encode({ ...style, flags: FLAG.pressure | FLAG.tilt }, pts);
  const back = ink.points(blob)!;
  assert.equal(back.length, 12);
  for (let i = 0; i < 12; i++) assert.ok(Math.abs(back[i]! - pts[i]!) < 0.07, `${i}: ${back[i]} vs ${pts[i]}`);
});

test('path commands are well formed and the outline covers the line', () => {
  const blob = line(0, 100);
  const ops = ink.path(blob)!;
  let i = 0;
  let circles = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op === OP.move || op === OP.line) i += 3;
    else if (op === OP.circle) {
      circles++;
      i += 4;
    } else {
      assert.equal(op, OP.close);
      i += 1;
    }
  }
  assert.equal(i, ops.length);
  assert.ok(circles >= 2, 'round caps at both ends');
  assert.ok(ink.svg(blob)!.startsWith('M'));
});

test('hit tests: point, eraser track, lasso', () => {
  const blob = line(0, 100);
  assert.ok(ink.hitPoint(blob, 50, 50.5, 0));
  assert.ok(!ink.hitPoint(blob, 50, 60, 2));
  assert.ok(ink.hitPoint(blob, 50, 60, 9.5));
  assert.ok(ink.hitPath(blob, [50, 20, 50, 80], 1));
  assert.ok(!ink.hitPath(blob, [120, 20, 120, 80], 1));
  assert.ok(ink.hitLasso(blob, [-10, 40, 110, 40, 110, 60, -10, 60]));
  assert.ok(!ink.hitLasso(blob, [-10, 40, 30, 40, 30, 60, -10, 60], 0.5));
});

test('the partial eraser splits a stroke in two, or reports a miss', () => {
  const blob = line(0, 100);
  assert.equal(ink.erase(blob, [50, 0], 4), null);
  const pieces = ink.erase(blob, [50, 20, 50, 80], 4)!;
  assert.equal(pieces.length, 2);
  const [a, b] = pieces.map((p) => ink.info(p)!);
  // Cut where the eraser (r 4) meets the ink (r 1): the centre line ends at 45 and 55, its round caps reach 46 and 54.
  assert.ok(Math.abs(a.bounds.maxX - 46) < 0.3 && Math.abs(b.bounds.minX - 54) < 0.3, `${a.bounds.maxX} ${b.bounds.minX}`);
  assert.equal(a.color, BLACK);
  assert.deepEqual(ink.erase(blob, [-10, 50, 110, 50], 4), []);
});

test('blobs that are not strokes are refused, never thrown on', () => {
  for (const bad of [new Uint8Array(), new Uint8Array([9, 9, 9]), new Uint8Array([1, 0, 0, 0, 0, 255, 32])]) {
    assert.equal(ink.info(bad), null);
    assert.equal(ink.path(bad), null);
    assert.equal(ink.valid(bad), false);
    assert.equal(ink.hitPoint(bad, 0, 0, 10), false);
    assert.equal(ink.erase(bad, [0, 0], 10), null);
  }
});

test('a builder with no samples gives nothing, and a cancelled one is freed', () => {
  assert.equal(ink.builder(style).finish(), null);
  const b = ink.builder(style);
  b.push(1, 1, 0.5, 1, 0, 0);
  b.cancel();
  assert.equal(b.finish(), null);
  assert.equal(b.count(), 0);
});

test('unframe reads the eraser framing', () => {
  const framed = new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 7, 2, 0, 0, 0, 8, 9]);
  assert.deepEqual(unframe(framed).map((u) => [...u]), [[7], [8, 9]]);
});

test('colours pack as 0xRRGGBBAA', () => {
  assert.equal(packColor('#ff8000', 1), 0xff8000ff);
  assert.equal(packColor('#ff8000', 0.35) & 255, 89);
  assert.equal(cssColor(0xff8000ff), 'rgb(255 128 0)');
  assert.equal(cssColor(0xff800080), 'rgb(255 128 0 / 0.502)');
});

test('print SVG: highlighters first, pens on top, colours as stored, scaled to fit', () => {
  const pen = line(0, 100, 50);
  const hl = line(0, 100, 52, { ...style, tool: TOOL.highlighter, color: packColor('#facc15', 0.35), width: 16, z: 'a5' });
  const svg = inkSvg(ink, [
    { id: 'p', data: pen },
    { id: 'h', data: hl },
    { id: 'junk', data: new Uint8Array([7]) },
  ])!;
  assert.match(svg, /^<svg [^>]*viewBox="/);
  const paths = [...svg.matchAll(/<path d="[^"]+" fill="(#[0-9a-f]{6})"( fill-opacity="([\d.]+)")?\/>/g)];
  assert.equal(paths.length, 2);
  assert.equal(paths[0]![1], '#facc15');
  assert.equal(paths[0]![3], '0.35');
  assert.equal(paths[1]![1], '#1f2328');
  assert.ok(!/script|on\w+=/i.test(svg));
  const narrow = inkSvg(ink, [{ id: 'p', data: line(0, 2000) }], { maxWidth: 670 })!;
  assert.match(narrow, /width="670"/);
  assert.equal(inkSvg(ink, []), null);
});
