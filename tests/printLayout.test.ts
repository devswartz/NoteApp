// Printing canvas pages: grouping boxes into printed rows (src/print/printLayout.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBoxHeight, printRows, type PrintBox } from '../src/print/printLayout.ts';

const box = (id: string, x: number, y: number, w: number, h: number, wide?: boolean): PrintBox => ({ id, x, y, w, h, ...(wide ? { wide } : {}) });
const A4 = 670;

test('a single box prints full width', () => {
  assert.deepEqual(printRows([box('a', 300, 40, 400, 100)], A4), [{ ids: ['a'], widths: [1] }]);
});

test('boxes beside each other print as columns, left to right, sized by their canvas widths', () => {
  const rows = printRows([box('right', 520, 10, 300, 200), box('left', 0, 0, 500, 120)], A4);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].ids, ['left', 'right']);
  assert.ok(Math.abs(rows[0].widths[0] - 500 / 800) < 1e-9);
  assert.ok(Math.abs(rows[0].widths.reduce((s, w) => s + w, 0) - 1) < 1e-9);
});

test('boxes whose vertical ranges do not overlap are separate rows in reading order', () => {
  const rows = printRows([box('b', 0, 300, 400, 100), box('a', 500, 0, 400, 100)], A4);
  assert.deepEqual(rows.map((r) => r.ids), [['a'], ['b']]);
});

test('a box that overlaps another sideways (stacked on the canvas) starts a new row', () => {
  const rows = printRows([box('a', 0, 0, 400, 300), box('b', 200, 100, 400, 100)], A4);
  assert.deepEqual(rows.map((r) => r.ids), [['a'], ['b']]);
});

test('columns too narrow for paper are stacked one under the other', () => {
  // Four side-by-side boxes: 4 × 200px + gaps does not fit 670px.
  const four = [0, 1, 2, 3].map((i) => box(`c${i}`, i * 320, i * 5, 300, 200));
  const rows = printRows(four, A4);
  assert.deepEqual(rows.map((r) => r.ids), [['c0'], ['c1'], ['c2'], ['c3']]);
  // A thin sidebar next to a big box: its share would be under the minimum, so stacked too.
  const lopsided = printRows([box('main', 0, 0, 1400, 400), box('side', 1420, 0, 150, 100)], A4);
  assert.deepEqual(lopsided.map((r) => r.ids), [['main'], ['side']]);
});

test('wide boxes always print alone', () => {
  const rows = printRows([box('wide', 0, 0, 686, 400, true), box('note', 800, 20, 300, 100)], A4);
  assert.deepEqual(rows.map((r) => r.ids), [['wide'], ['note']]);
});

test('three columns that fit stay side by side; a later row is separate', () => {
  const rows = printRows(
    [box('a', 0, 0, 300, 150), box('b', 320, 0, 300, 150), box('c', 640, 30, 300, 150), box('d', 0, 400, 900, 100)],
    A4,
  );
  assert.deepEqual(rows.map((r) => r.ids), [['a', 'b', 'c'], ['d']]);
});

test('estimated heights grow with the content', () => {
  assert.ok(estimateBoxHeight([{ type: 'paragraph' }]) < estimateBoxHeight([{ type: 'paragraph' }, { type: 'image' }]));
  assert.ok(estimateBoxHeight([{ type: 'bulletList', content: [{}, {}, {}] }]) > estimateBoxHeight([{ type: 'bulletList', content: [{}] }]));
});
