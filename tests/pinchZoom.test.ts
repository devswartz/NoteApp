// Pinch zoom by the page (src/ink/pinchZoom.ts): during the pinch the picture follows the fingers,
// and after it the page is scrolled so what was under the fingers stays there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ZOOM, MIN_ZOOM, clampZoom, pinchTransform, scrollAfterPinch } from '../src/ink/pinchZoom.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('the transform draws every point scaled about the start focal and moved to the fingers', () => {
  const origin = { x: 40, y: 120 };
  const f0 = { x: 300, y: 400 };
  const f1 = { x: 330, y: 380 };
  const s = 1.8;
  const m = pinchTransform(origin, f0, f1, s);
  for (const q of [origin, f0, { x: 700, y: 900 }]) {
    // transform-origin 0 0 at `origin`: a point at local p = q - origin is drawn at origin + (m.x, m.y) + s * p.
    const drawn = { x: origin.x + m.x + s * (q.x - origin.x), y: origin.y + m.y + s * (q.y - origin.y) };
    near(drawn.x, f1.x + s * (q.x - f0.x));
    near(drawn.y, f1.y + s * (q.y - f0.y));
  }
  assert.deepEqual(pinchTransform(origin, f0, f0, 1), { x: 0, y: 0, scale: 1 }, 'no pinch, no change');
});

test('after the pinch, the page point that was under the fingers is under them again', () => {
  const before = { x: 40, y: 100 };
  const f0 = { x: 300, y: 400 };
  const f1 = { x: 320, y: 420 };
  const z0 = 1;
  const z1 = 2;
  const after = { x: 40, y: 100 }; // the surface hasn't moved on screen with the new layout (yet)
  const d = scrollAfterPinch(before, z0, after, z1, f0, f1);
  const page = { x: (f0.x - before.x) / z0, y: (f0.y - before.y) / z0 };
  // Scrolling by d moves the surface by -d.
  near(after.x - d.x + page.x * z1, f1.x);
  near(after.y - d.y + page.y * z1, f1.y);
});

test('zoom stays between 0.5x and 4x', () => {
  assert.equal(clampZoom(10), MAX_ZOOM);
  assert.equal(clampZoom(0.1), MIN_ZOOM);
  assert.equal(clampZoom(1.5), 1.5);
});
