// Pure geometry for canvas pages (docs/PLAN_CANVAS.md): where new boxes go, clamping
// moves and resizes, how big the surface is, keyboard order and stacking. No DOM here,
// so it is unit-tested (tests/canvasGeom.test.ts).
import { readingOrder, type BoxGeom } from '../../shared/pageDoc.ts';

export const BOX_MIN_W = 120;
export const BOX_MAX_W = 2400;
export const BOX_DEFAULT_W = 360;
/** Furthest a box may sit from the origin; keeps a stray drag from making a huge page. */
export const MAX_COORD = 20_000;
/** Empty room kept right of and below the furthest box, so there's space to click and grow. */
export const SURFACE_PAD_X = 240;
export const SURFACE_PAD_Y = 320;
/** Arrow keys move a selected box this far (Shift: NUDGE_FINE for fine placement). */
export const NUDGE = 10;
export const NUDGE_FINE = 1;
/** A new box starts this far above the click, so the first line lands where you clicked. */
export const CLICK_OFFSET_Y = 12;
/** Height assumed for a box that hasn't been measured yet (not mounted). */
export const UNMEASURED_H = 48;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A position on the page: whole pixels, never negative, never absurdly far out. */
export function clampPos(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(clamp(x, 0, MAX_COORD)), y: Math.round(clamp(y, 0, MAX_COORD)) };
}

export function clampWidth(w: number): number {
  return Math.round(clamp(w, BOX_MIN_W, BOX_MAX_W));
}

/** Highest z in use (0 for an empty page). */
export function topZ(boxes: Pick<BoxGeom, 'z'>[]): number {
  return boxes.reduce((m, b) => Math.max(m, b.z), 0);
}

/** The z to give `id` so it is in front, or null if it already is (alone at the top). */
export function frontZ(boxes: Pick<BoxGeom, 'id' | 'z'>[], id: string): number | null {
  const me = boxes.find((b) => b.id === id);
  if (!me) return null;
  const top = topZ(boxes);
  const tied = boxes.some((b) => b.id !== id && b.z === top);
  return me.z === top && !tied ? null : top + 1;
}

/** Geometry for a box created by clicking at (x, y) in surface coordinates. */
export function boxAtClick(boxes: Pick<BoxGeom, 'z'>[], x: number, y: number, width = BOX_DEFAULT_W): Omit<BoxGeom, 'id'> {
  return { ...clampPos(x, y - CLICK_OFFSET_Y), w: clampWidth(width), z: topZ(boxes) + 1 };
}

/** Geometry for a box added below everything else (e.g. "Add a task to this page" with no box yet). */
export function boxBelow(boxes: BoxGeom[], heights: Record<string, number>, left = 0): Omit<BoxGeom, 'id'> {
  const bottom = boxes.reduce((m, b) => Math.max(m, b.y + (heights[b.id] ?? UNMEASURED_H)), 0);
  return { ...clampPos(left, boxes.length ? bottom + 24 : 0), w: BOX_DEFAULT_W, z: topZ(boxes) + 1 };
}

/**
 * Size of the surface: at least the viewport, and big enough for every box plus room to grow.
 * A wide box (drawn at the page's width, see wideWidth) adds no room to its right.
 */
export function surfaceSize(boxes: BoxGeom[], heights: Record<string, number>, minW: number, minH: number): { w: number; h: number } {
  let w = minW;
  let h = minH;
  for (const b of boxes) {
    w = Math.max(w, b.x + b.w + (b.wide ? 0 : SURFACE_PAD_X));
    h = Math.max(h, b.y + (heights[b.id] ?? UNMEASURED_H) + SURFACE_PAD_Y);
  }
  return { w: Math.ceil(w), h: Math.ceil(h) };
}

/** The box after (dir 1) or before (dir -1) `id` in reading order; null at either end. With no current box, the first or last. */
export function adjacentBox<T extends Pick<BoxGeom, 'id' | 'x' | 'y'>>(boxes: T[], id: string | null, dir: 1 | -1): T | null {
  const order = readingOrder(boxes);
  if (!order.length) return null;
  const i = id === null ? -1 : order.findIndex((b) => b.id === id);
  if (i < 0) return dir === 1 ? order[0]! : order[order.length - 1]!;
  return order[i + dir] ?? null;
}

/** New position for a box nudged with an arrow key, or null if the key isn't an arrow. */
export function nudge(b: Pick<BoxGeom, 'x' | 'y'>, key: string, fine: boolean): { x: number; y: number } | null {
  const step = fine ? NUDGE_FINE : NUDGE;
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const v = d[key];
  return v ? clampPos(b.x + v[0], b.y + v[1]) : null;
}

/** One rule-line unit (px): the line spacing of a page with rule lines on (the CSS --rule). */
export const RULE_UNIT = 28;

/** A y position on the rule-line grid: the nearest whole unit, never negative. */
export function snapY(y: number, unit = RULE_UNIT): number {
  return Math.max(0, Math.round(y / unit) * unit);
}

/** Arrow-key nudge on a ruled page: up/down a whole line (on the grid), sideways as usual. */
export function nudgeOnGrid(b: Pick<BoxGeom, 'x' | 'y'>, key: string, fine: boolean, unit = RULE_UNIT): { x: number; y: number } | null {
  if (key === 'ArrowUp' || key === 'ArrowDown') return clampPos(b.x, snapY(snapY(b.y, unit) + (key === 'ArrowUp' ? -unit : unit), unit));
  return nudge(b, key, fine);
}

/**
 * The width a wide box (the page's main box) is drawn at: everything right of it, to the
 * right edge of the visible surface (OneNote-style full width), never under BOX_MIN_W.
 * `avail` is the surface's visible width (0 when not measured yet: `fallback` is used).
 */
export function wideWidth(x: number, avail: number, fallback: number): number {
  if (avail <= 0) return fallback;
  return Math.max(BOX_MIN_W, Math.floor(avail - x));
}

/** A short random box id (the `box:<id>` fragment name). */
export function newBoxId(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((n) => n.toString(36).padStart(2, '0').slice(-2)).join('');
}

// ───────────── Screen ↔ page coordinates (docs/PLAN_INK.md, phase I0) ─────────────
// Every conversion between where the pointer is on screen (client pixels) and where that is on
// the page (page pixels: the space `boxes` and, later, ink strokes are stored in) goes through
// a CanvasView. The scale is fixed at 1 today; pinch zoom (PLAN_INK, phase I4) only has to
// change the scale here and draw the surface with the same transform.

/** How the page is shown: page (0, 0) is at client (originX, originY), and one page pixel is `scale` screen pixels. */
export interface CanvasView {
  scale: number;
  originX: number;
  originY: number;
}

/** The only zoom there is for now. */
export const CANVAS_SCALE = 1;

/** The view of a surface whose top-left corner is at `rect` on screen (its getBoundingClientRect()). */
export function canvasView(rect: { left: number; top: number }, scale = CANVAS_SCALE): CanvasView {
  return { scale, originX: rect.left, originY: rect.top };
}

/** A client (screen) point → page pixels. */
export function toPage(v: CanvasView, clientX: number, clientY: number): { x: number; y: number } {
  return { x: (clientX - v.originX) / v.scale, y: (clientY - v.originY) / v.scale };
}

/** A page point → client (screen) pixels. */
export function toScreen(v: CanvasView, x: number, y: number): { x: number; y: number } {
  return { x: v.originX + x * v.scale, y: v.originY + y * v.scale };
}

/**
 * The canvas surface's box: `size` in page px, shown at `zoom` (the iPad's pinch zoom) with a
 * transform about its top-left, so boxes and ink scale as one layer and nothing re-lays out. The
 * margins make the space it takes up (the scroll area) the zoomed size. The view of such a surface
 * is canvasView(its getBoundingClientRect(), zoom).
 */
export function surfaceStyle(size: { w: number; h: number }, zoom: number): Record<string, string | number> {
  const w = lengthToScreen({ scale: CANVAS_SCALE }, size.w);
  const h = lengthToScreen({ scale: CANVAS_SCALE }, size.h);
  if (zoom === 1) return { width: w, height: h };
  return { width: w, height: h, transform: `scale(${zoom})`, transformOrigin: '0 0', marginRight: w * (zoom - 1), marginBottom: h * (zoom - 1) };
}

/** A pointer movement on screen → the same movement on the page (a drag). */
export function deltaToPage(v: Pick<CanvasView, 'scale'>, dx: number, dy: number): { dx: number; dy: number } {
  return { dx: dx / v.scale, dy: dy / v.scale };
}

/** A length on screen (the visible width or height of the viewport) → page pixels. */
export const lengthToPage = (v: Pick<CanvasView, 'scale'>, len: number) => len / v.scale;
/** A length on the page (the surface's size) → screen pixels. */
export const lengthToScreen = (v: Pick<CanvasView, 'scale'>, len: number) => len * v.scale;

// ───────────── Pointer routing (docs/PLAN_INK.md, phase I0) ─────────────
// Every pointer that goes down on the canvas is classified here, and the router decides who
// handles it. Today there is only the select tool, so everything goes to the existing UI
// handlers (click to create a box, drag, resize, type). The ink tool (PLAN_INK, phase I3) will
// claim pen input, and finger input only when finger drawing is on (off by default).

export type PointerKind = 'pen' | 'touch' | 'mouse';
/** The active canvas tool. Only 'select' exists so far. */
export type CanvasTool = 'select' | 'ink';
/** Who handles a pointer: the existing box UI, or the ink layer. */
export type PointerRoute = 'ui' | 'ink';

/** pen / touch / mouse from a pointer event's pointerType ('' or unknown, and plain mouse events, count as mouse). */
export function pointerKind(e: { pointerType?: string }): PointerKind {
  return e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse';
}

export interface PointerRouting {
  tool: CanvasTool;
  /** Draw with a finger too (a setting, off by default like Notability). */
  fingerDrawing?: boolean;
  /** Only people who can edit the page may draw on it. */
  canEdit: boolean;
}

/** Who gets a pointer that goes down on the canvas. */
export function routePointer(kind: PointerKind, r: PointerRouting): PointerRoute {
  if (r.tool !== 'ink' || !r.canEdit) return 'ui';
  if (kind === 'pen' || kind === 'mouse') return 'ink';
  return r.fingerDrawing ? 'ink' : 'ui'; // a finger scrolls and zooms unless finger drawing is on
}
