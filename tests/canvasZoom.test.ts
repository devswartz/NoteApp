// Zoomed canvas (the iPad's pinch zoom): screen ↔ page through the one CanvasView, with the surface
// scaled by a transform about its top-left (surfaceStyle) and the page scrolled. The pen, both
// erasers, the hit tests and the renderer all go through canvasView(rect, zoom) + toPage/toScreen,
// so a stroke is erased where it is drawn (Devon's 0.5.90 (111) round: it wasn't, under CSS zoom).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasView, deltaToPage, surfaceStyle, toPage, toScreen } from '../src/editor/canvasGeom.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

/** Where a surface's top-left is on screen: its place in the scroller's content, minus the scroll. */
const surfaceRect = (scroller: { left: number; top: number; scrollLeft: number; scrollTop: number }, offset: { x: number; y: number }) => ({
  left: scroller.left + offset.x - scroller.scrollLeft,
  top: scroller.top + offset.y - scroller.scrollTop,
});

test('screen → page → screen round-trips at any zoom with the page scrolled', () => {
  for (const zoom of [0.5, 1, 1.5, 2, 4]) {
    for (const scroll of [{ scrollLeft: 0, scrollTop: 0 }, { scrollLeft: 130, scrollTop: 2400 }]) {
      const rect = surfaceRect({ left: 0, top: 96, ...scroll }, { x: 40, y: 140 });
      const v = canvasView(rect, zoom);
      for (const [cx, cy] of [[0, 0], [300, 500], [1100, 800]] as const) {
        const p = toPage(v, cx, cy);
        const back = toScreen(v, p.x, p.y);
        near(back.x, cx);
        near(back.y, cy);
      }
      // A page point is drawn at the surface's top-left plus page × zoom (the transform about the top-left).
      const s = toScreen(v, 200, 300);
      near(s.x, rect.left + 200 * zoom);
      near(s.y, rect.top + 300 * zoom);
      // A drag of 20 screen px is 20 / zoom page px.
      near(deltaToPage(v, 20, 0).dx, 20 / zoom);
    }
  }
});

test('the pen and the eraser at one screen point hit one page point', () => {
  // Both sample through the same view: a stroke drawn at a point is erased at that point, at any zoom.
  const rect = surfaceRect({ left: 0, top: 96, scrollLeft: 0, scrollTop: 900 }, { x: 40, y: 140 });
  const v = canvasView(rect, 2);
  const pen = toPage(v, 420, 610);
  const eraser = toPage(v, 420, 610);
  assert.deepEqual(pen, eraser);
  near(pen.x, (420 - 40) / 2);
  near(pen.y, (610 - (96 + 140 - 900)) / 2);
});

test('the zoomed surface keeps its page size and takes up the zoomed space', () => {
  assert.deepEqual(surfaceStyle({ w: 1200, h: 3000 }, 1), { width: 1200, height: 3000 });
  const z = surfaceStyle({ w: 1200, h: 3000 }, 2);
  assert.equal(z.width, 1200, 'layout size unchanged: text never reflows');
  assert.equal(z.transform, 'scale(2)');
  assert.equal(z.transformOrigin, '0 0');
  assert.equal(1200 + (z.marginRight as number), 2400, 'scrolls as far as the zoomed page is wide');
  assert.equal(3000 + (z.marginBottom as number), 6000);
  const out = surfaceStyle({ w: 1200, h: 3000 }, 0.5);
  assert.equal(3000 + (out.marginBottom as number), 1500);
});
