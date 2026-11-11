// Rule lines on: boxes snap to the line grid (src/editor/canvasGeom.ts) and every block is
// rounded up to whole units (src/editor/ruleGrid.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeOnGrid, RULE_UNIT, snapY } from '../src/editor/canvasGeom.ts';
import { gridPads, padToUnit } from '../src/editor/ruleGrid.ts';

test('snapY rounds to the nearest whole unit, never negative', () => {
  assert.equal(RULE_UNIT, 28);
  assert.equal(snapY(0), 0);
  assert.equal(snapY(13), 0);
  assert.equal(snapY(14), 28);
  assert.equal(snapY(100), 112);
  assert.equal(snapY(-20), 0);
  assert.equal(snapY(50, 20), 60);
});

test('nudgeOnGrid moves a line at a time up and down, sideways as usual', () => {
  assert.deepEqual(nudgeOnGrid({ x: 10, y: 56 }, 'ArrowDown', false), { x: 10, y: 84 });
  assert.deepEqual(nudgeOnGrid({ x: 10, y: 60 }, 'ArrowUp', false), { x: 10, y: 28 });
  assert.deepEqual(nudgeOnGrid({ x: 10, y: 0 }, 'ArrowUp', false), { x: 10, y: 0 });
  assert.deepEqual(nudgeOnGrid({ x: 10, y: 56 }, 'ArrowRight', true), { x: 11, y: 56 });
  assert.equal(nudgeOnGrid({ x: 10, y: 56 }, 'a', false), null);
});

test('padToUnit fills up to the next whole unit, ignoring sub-pixel noise', () => {
  assert.equal(padToUnit(56, 28), 0);
  assert.equal(padToUnit(56.3, 28), 0);
  assert.equal(padToUnit(55.7, 28), 0);
  assert.equal(padToUnit(60, 28), 24);
  assert.equal(padToUnit(83, 28), 1);
  assert.equal(padToUnit(10, 0), 0);
});

test('gridPads accounts for margins above that change', () => {
  // A 54px heading, then a 28px line, then an 84.3px table, then a line.
  assert.deepEqual(gridPads([{ bottom: 54, pad: 0 }, { bottom: 82, pad: 0 }, { bottom: 166.3, pad: 0 }, { bottom: 194.3, pad: 0 }], 28), [2, 0, 0, 0]);
  // Pads already in place: nothing changes.
  assert.deepEqual(gridPads([{ bottom: 54, pad: 2 }, { bottom: 84, pad: 0 }], 28), [2, 0]);
  // The heading's stale pad of 12 shrinks to 2: the blocks below move up 10 before they're padded.
  assert.deepEqual(gridPads([{ bottom: 54, pad: 12 }, { bottom: 94, pad: 0 }, { bottom: 140, pad: 0 }], 28), [2, 0, 10]);
});
