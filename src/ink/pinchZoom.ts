// Pinch zoom of a canvas page on the iPad (docs/PLAN_INK.md, I2), done by the page itself.
// WebKit's gesture events (gesturestart / gesturechange / gestureend, with a scale and the centre
// of the fingers) drive it: during the pinch the canvas viewport is scaled with a CSS transform (one
// composited picture: text and ink can't separate), and when the fingers lift the surface is laid
// out at the new zoom (CSS zoom, sharp text and ink) and scrolled so the page stays under the
// fingers. The maths is plain functions (tests/pinchZoom.test.ts).

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

interface Pt {
  x: number;
  y: number;
}

/**
 * The transform (transform-origin 0 0) for an element whose top-left is at `origin` on screen, so
 * that what was at `focalStart` is drawn scaled by `scale` about it and moved to `focalNow`:
 * a screen point q is drawn at focalNow + scale * (q - focalStart).
 */
export function pinchTransform(origin: Pt, focalStart: Pt, focalNow: Pt, scale: number): { x: number; y: number; scale: number } {
  return {
    x: focalNow.x + scale * (origin.x - focalStart.x) - origin.x,
    y: focalNow.y + scale * (origin.y - focalStart.y) - origin.y,
    scale,
  };
}

/**
 * How far to scroll after the page is laid out at the new zoom, so the page point that was under
 * `focalStart` is under `focalEnd`. `surfaceBefore` / `surfaceAfter`: the surface's top-left on
 * screen before the pinch and after the new layout (before scrolling); zooms before and after.
 */
export function scrollAfterPinch(surfaceBefore: Pt, zoomBefore: number, surfaceAfter: Pt, zoomAfter: number, focalStart: Pt, focalEnd: Pt): Pt {
  const page = { x: (focalStart.x - surfaceBefore.x) / zoomBefore, y: (focalStart.y - surfaceBefore.y) / zoomBefore };
  // Where the surface must be on screen: focalEnd - page * zoomAfter. Scrolling by d moves it by -d.
  return { x: surfaceAfter.x - (focalEnd.x - page.x * zoomAfter), y: surfaceAfter.y - (focalEnd.y - page.y * zoomAfter) };
}

/** WebKit's GestureEvent (not in TypeScript's DOM types). */
type GestureEvent = Event & { scale: number; clientX: number; clientY: number };

export interface PinchTarget {
  /** The page scroller. */
  scroller: HTMLElement;
  /** What scales during the gesture (the canvas viewport). */
  viewport: HTMLElement;
  /** The canvas surface (laid out at the zoom). */
  surface: HTMLElement;
  zoom: () => number;
  /** Lay the surface out at `zoom` now (synchronously), e.g. flushSync(() => setZoom(z)). */
  apply: (zoom: number) => void;
  /** What happened, in words (the status readout). */
  onDebug?: (text: string) => void;
}

/** Pinch zoom on the scroller via WebKit gesture events. Returns the cleanup. */
export function listenPinchZoom(t: PinchTarget): () => void {
  let start: { focal: Pt; zoom: number; viewport: Pt; surface: Pt; overflow: string } | null = null;
  let last = { focal: { x: 0, y: 0 }, scale: 1 };
  const onStart = (ev: Event) => {
    const e = ev as GestureEvent;
    if (!t.scroller.contains(e.target as Node)) return;
    e.preventDefault(); // no page zoom of the whole app
    const v = t.viewport.getBoundingClientRect();
    const s = t.surface.getBoundingClientRect();
    start = { focal: { x: e.clientX, y: e.clientY }, zoom: t.zoom(), viewport: { x: v.left, y: v.top }, surface: { x: s.left, y: s.top }, overflow: t.scroller.style.overflow };
    last = { focal: start.focal, scale: 1 };
    t.scroller.style.overflow = 'hidden'; // the picture follows the fingers; no scrolling underneath meanwhile
    t.viewport.style.transformOrigin = '0 0';
    t.viewport.style.willChange = 'transform';
    t.onDebug?.('pinch started');
  };
  const onChange = (ev: Event) => {
    const e = ev as GestureEvent;
    if (!start) return;
    e.preventDefault();
    const scale = clampZoom(start.zoom * e.scale) / start.zoom;
    last = { focal: { x: e.clientX, y: e.clientY }, scale };
    const m = pinchTransform(start.viewport, start.focal, last.focal, scale);
    t.viewport.style.transform = `translate(${m.x}px, ${m.y}px) scale(${m.scale})`;
  };
  const onEnd = (ev: Event) => {
    if (!start) return;
    ev.preventDefault();
    const s0 = start;
    start = null;
    const zoom = clampZoom(s0.zoom * last.scale);
    t.viewport.style.transform = '';
    t.viewport.style.willChange = '';
    t.scroller.style.overflow = s0.overflow;
    t.apply(zoom);
    const after = t.surface.getBoundingClientRect();
    const d = scrollAfterPinch(s0.surface, s0.zoom, { x: after.left, y: after.top }, zoom, s0.focal, last.focal);
    t.scroller.scrollLeft += d.x;
    t.scroller.scrollTop += d.y;
    t.onDebug?.(`pinch: zoom ${zoom.toFixed(2)}`);
  };
  const opts = { passive: false } as const;
  t.scroller.addEventListener('gesturestart', onStart, opts);
  t.scroller.addEventListener('gesturechange', onChange, opts);
  t.scroller.addEventListener('gestureend', onEnd, opts);
  return () => {
    t.scroller.removeEventListener('gesturestart', onStart);
    t.scroller.removeEventListener('gesturechange', onChange);
    t.scroller.removeEventListener('gestureend', onEnd);
  };
}
