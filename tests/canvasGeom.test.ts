// Canvas pages, phase 2: the pure geometry behind the desktop canvas editor
// (src/editor/canvasGeom.ts): placing, clamping, surface size, keyboard order, stacking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOX_DEFAULT_W,
  BOX_MAX_W,
  BOX_MIN_W,
  CLICK_OFFSET_Y,
  MAX_COORD,
  NUDGE,
  SURFACE_PAD_X,
  SURFACE_PAD_Y,
  UNMEASURED_H,
  adjacentBox,
  boxAtClick,
  boxBelow,
  clampPos,
  clampWidth,
  frontZ,
  newBoxId,
  nudge,
  surfaceSize,
  topZ,
  wideWidth,
} from '../src/editor/canvasGeom.ts';

const box = (id: string, x: number, y: number, w = 300, z = 1) => ({ id, x, y, w, z });

test('positions are whole pixels inside the page', () => {
  assert.deepEqual(clampPos(10.6, 20.2), { x: 11, y: 20 });
  assert.deepEqual(clampPos(-40, -1), { x: 0, y: 0 });
  assert.deepEqual(clampPos(1e9, 5), { x: MAX_COORD, y: 5 });
});

test('widths stay between the minimum and maximum', () => {
  assert.equal(clampWidth(10), BOX_MIN_W);
  assert.equal(clampWidth(500.4), 500);
  assert.equal(clampWidth(1e6), BOX_MAX_W);
});

test('a clicked box starts at the click, in front of the others', () => {
  const g = boxAtClick([box('a', 0, 0, 300, 4), box('b', 0, 0, 300, 2)], 120, 200);
  assert.deepEqual(g, { x: 120, y: 200 - CLICK_OFFSET_Y, w: BOX_DEFAULT_W, z: 5 });
  assert.equal(boxAtClick([], 5, 3).y, 0, 'never above the top');
  assert.equal(boxAtClick([], 0, 0).z, 1);
});

test('a box added below goes under the lowest box', () => {
  const boxes = [box('a', 40, 0), box('b', 300, 100)];
  assert.deepEqual(boxBelow(boxes, { a: 50, b: 80 }), { x: 0, y: 204, w: BOX_DEFAULT_W, z: 2 });
  assert.equal(boxBelow(boxes, {}).y, 100 + UNMEASURED_H + 24, 'unmeasured boxes count with a default height');
  assert.equal(boxBelow([], {}).y, 0);
});

test('the surface fills the viewport and grows to fit boxes', () => {
  assert.deepEqual(surfaceSize([], {}, 800, 600), { w: 800, h: 600 });
  const s = surfaceSize([box('a', 900, 1000, 400)], { a: 120 }, 800, 600);
  assert.deepEqual(s, { w: 900 + 400 + SURFACE_PAD_X, h: 1000 + 120 + SURFACE_PAD_Y });
  // A wide box spans the page: no extra room to its right (no sideways scrolling).
  assert.equal(surfaceSize([{ ...box('w', 0, 0, 1000), wide: true }], {}, 1000, 600).w, 1000);
});

test('a wide box is drawn across the page to the right edge, within the room there is', () => {
  assert.equal(wideWidth(0, 1400, 686), 1400);
  assert.equal(wideWidth(200, 1400, 686), 1200);
  assert.equal(wideWidth(0, 500, 686), 500, 'narrow window: the space there is');
  assert.equal(wideWidth(1350, 1400, 686), BOX_MIN_W);
  assert.equal(wideWidth(0, 0, 686), 686, 'not measured yet');
});

test('Tab order is reading order: top to bottom, then left to right', () => {
  const boxes = [box('c', 0, 300), box('b', 400, 0), box('a', 0, 0)];
  assert.equal(adjacentBox(boxes, 'a', 1)?.id, 'b');
  assert.equal(adjacentBox(boxes, 'b', 1)?.id, 'c');
  assert.equal(adjacentBox(boxes, 'c', 1), null, 'past the last box');
  assert.equal(adjacentBox(boxes, 'c', -1)?.id, 'b');
  assert.equal(adjacentBox(boxes, 'a', -1), null);
  assert.equal(adjacentBox(boxes, null, 1)?.id, 'a');
  assert.equal(adjacentBox(boxes, null, -1)?.id, 'c');
  assert.equal(adjacentBox([], null, 1), null);
});

test('arrow keys nudge a box, never off the page', () => {
  assert.deepEqual(nudge({ x: 50, y: 50 }, 'ArrowRight', false), { x: 50 + NUDGE, y: 50 });
  assert.deepEqual(nudge({ x: 50, y: 50 }, 'ArrowUp', true), { x: 50, y: 49 });
  assert.deepEqual(nudge({ x: 0, y: 3 }, 'ArrowLeft', false), { x: 0, y: 3 });
  assert.equal(nudge({ x: 0, y: 0 }, 'Enter', false), null);
});

test('bringing a box to front only writes when it is not already alone on top', () => {
  const boxes = [box('a', 0, 0, 300, 1), box('b', 0, 0, 300, 3)];
  assert.equal(topZ(boxes), 3);
  assert.equal(topZ([]), 0);
  assert.equal(frontZ(boxes, 'a'), 4);
  assert.equal(frontZ(boxes, 'b'), null);
  assert.equal(frontZ([box('a', 0, 0, 300, 2), box('b', 0, 0, 300, 2)], 'a'), 3, 'a tie is not in front');
  assert.equal(frontZ(boxes, 'missing'), null);
});

test('box ids are short, distinct and safe in a fragment name', () => {
  const ids = new Set(Array.from({ length: 200 }, newBoxId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-z0-9]{16}$/);
});
