// Drawing a page's ink on the web (docs/PLAN_INK.md, "Web, Mac, Android"): Canvas2D, nv-ink
// geometry, and tile caching. Finished strokes are drawn into 256 px tiles once; scrolling only
// copies tiles onto the visible canvases, and a stroke that changes redraws just the tiles it
// touches. Two layers: highlighters under the text boxes, pens over them. A third canvas holds
// the stroke being drawn (src/ink/InkSurface.tsx).
import * as Y from 'yjs';
import { INK_KEY } from '../../shared/pageDoc.ts';
import { OP, TOOL, cssColor, type Bounds, type InkEngine, type StrokeInfo } from './engine.ts';
import { zCompare } from './strokes.ts';

export const TILE = 256;
/** Painted beyond the visible area, so a fast scroll doesn't show an unpainted edge. */
export const OVERSCAN = 384;
/** Tiles kept per layer before the least recently used go. */
export const MAX_TILES = 160;

/** Path commands (engine.path) as a Path2D (fill it with the nonzero rule). */
export function opsToPath(ops: Float32Array, path: Path2D = new Path2D()): Path2D {
  for (let i = 0; i < ops.length; ) {
    const op = ops[i];
    if (op === OP.move) {
      path.moveTo(ops[i + 1]!, ops[i + 2]!);
      i += 3;
    } else if (op === OP.line) {
      path.lineTo(ops[i + 1]!, ops[i + 2]!);
      i += 3;
    } else if (op === OP.circle) {
      const [x, y, r] = [ops[i + 1]!, ops[i + 2]!, ops[i + 3]!];
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, Math.PI * 2);
      path.closePath();
      i += 4;
    } else {
      path.closePath();
      i += 1;
    }
  }
  return path;
}

const isDark = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';

/**
 * The colour a stroke is drawn in. In the dark theme, near-black ink is drawn near-white (as
 * OneNote does), so it stays readable; print and export use the stored colour.
 */
export function displayColor(color: number, dark = isDark()): string {
  if (dark) {
    const r = (color >>> 24) & 255;
    const g = (color >>> 16) & 255;
    const b = (color >>> 8) & 255;
    if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.25) return cssColor(((0xe6e6e6 << 8) | (color & 255)) >>> 0);
  }
  return cssColor(color);
}

const intersects = (a: Bounds, b: Bounds) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

interface Entry {
  id: string;
  blob: Uint8Array;
  info: StrokeInfo;
  path?: Path2D;
}

type LayerName = 'under' | 'over';
const layerOf = (info: StrokeInfo): LayerName => (info.tool === TOOL.highlighter ? 'under' : 'over');

type TileCanvas = OffscreenCanvas | HTMLCanvasElement;
function makeCanvas(w: number, h: number): TileCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** The visible part of the surface, in page px, snapped out to whole tiles. */
interface Window {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface InkCanvases {
  under: HTMLCanvasElement;
  over: HTMLCanvasElement;
  live: HTMLCanvasElement;
}

export class InkRenderer {
  private entries = new Map<string, Entry>();
  private sorted: Record<LayerName, Entry[]> | null = null;
  private tiles: Record<LayerName, Map<string, TileCanvas | null>> = { under: new Map(), over: new Map() };
  /** Strokes an erase gesture has taken away (not yet written). */
  private hidden = new Set<string>();
  /** Pieces an erase gesture has made (not yet written). */
  private extra = new Map<string, Entry>();
  private win: Window | null = null;
  private dpr = 1;
  private dark = isDark();
  private frame = 0;
  private dirty = true;
  private readonly map: Y.Map<unknown>;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly engine: InkEngine,
    doc: Y.Doc,
    private readonly surface: HTMLElement,
    private readonly canvases: InkCanvases,
  ) {
    this.map = doc.getMap<unknown>(INK_KEY);
    this.map.forEach((v, id) => this.put(id, v));
    const observe = (ev: Y.YMapEvent<unknown>) => {
      for (const id of ev.keysChanged) this.put(id, this.map.get(id));
      this.schedule();
    };
    this.map.observe(observe);
    this.offs.push(() => this.map.unobserve(observe));
    const onScroll = () => this.schedule();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    this.offs.push(() => {
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
    });
    const ro = new ResizeObserver(onScroll);
    ro.observe(surface);
    this.offs.push(() => ro.disconnect());
    // The theme decides how black ink is drawn: repaint everything when it changes.
    const mo = new MutationObserver(() => {
      if (isDark() === this.dark) return;
      this.dark = isDark();
      this.dropTiles();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.offs.push(() => mo.disconnect());
    this.schedule();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.offs.forEach((f) => f());
    this.entries.clear();
    this.dropTiles();
  }

  /** The strokes on the page now (ids and blobs), as the eraser sees them. */
  strokes(): [string, Uint8Array][] {
    return [...this.entries.values()].map((e) => [e.id, e.blob]);
  }

  /** Header info of a stroke the renderer knows (page strokes and an erase gesture's pieces). */
  info(id: string): StrokeInfo | null {
    return (this.entries.get(id) ?? this.extra.get(id))?.info ?? null;
  }

  /** z keys of the strokes on a layer (for the next stroke's key). */
  zKeys(tool: number): string[] {
    const want: LayerName = tool === TOOL.highlighter ? 'under' : 'over';
    return [...this.entries.values()].filter((e) => layerOf(e.info) === want).map((e) => e.info.z);
  }

  /** Show an erase gesture's work in progress: these strokes hidden, these pieces added. */
  setOverlay(hidden: Set<string>, extra: Map<string, Uint8Array>) {
    const touched: Entry[] = [];
    for (const id of new Set([...this.hidden, ...hidden])) {
      if (this.hidden.has(id) !== hidden.has(id)) {
        const e = this.entries.get(id);
        if (e) touched.push(e);
      }
    }
    for (const [id, e] of this.extra) if (extra.get(id) !== e.blob) touched.push(e);
    const next = new Map<string, Entry>();
    for (const [id, blob] of extra) {
      const had = this.extra.get(id);
      if (had && had.blob === blob) next.set(id, had);
      else {
        const info = this.engine.info(blob);
        if (!info) continue;
        const e = { id, blob, info };
        next.set(id, e);
        touched.push(e);
      }
    }
    this.hidden = new Set(hidden);
    this.extra = next;
    this.sorted = null;
    touched.forEach((e) => this.invalidate(layerOf(e.info), e.info.bounds));
    this.schedule();
  }

  /** Draw the stroke being made (path commands), or clear it. Highlighters show under the text. */
  drawLive(ops: Float32Array | null, color = 0, tool: number = TOOL.pen) {
    const c = this.canvases.live;
    const ctx = c.getContext('2d');
    const w = this.win;
    if (!ctx || !w) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    c.dataset.tool = tool === TOOL.highlighter ? 'highlighter' : 'pen';
    if (!ops || !ops.length) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, -w.x0 * this.dpr, -w.y0 * this.dpr);
    ctx.fillStyle = displayColor(color, this.dark);
    ctx.fill(opsToPath(ops), 'nonzero');
  }

  /** Repaint on the next frame. */
  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private put(id: string, v: unknown) {
    const old = this.entries.get(id);
    if (old) this.invalidate(layerOf(old.info), old.info.bounds);
    this.entries.delete(id);
    this.sorted = null;
    if (!(v instanceof Uint8Array)) return;
    const info = this.engine.info(v);
    // A stroke this engine can't read (a newer app's format) is left alone, not drawn.
    if (!info || !this.engine.valid(v)) return;
    const e: Entry = { id, blob: v, info };
    this.entries.set(id, e);
    this.invalidate(layerOf(info), info.bounds);
  }

  private layer(name: LayerName): Entry[] {
    if (!this.sorted) {
      const all = [...this.entries.values()].filter((e) => !this.hidden.has(e.id)).concat([...this.extra.values()]);
      all.sort((a, b) => zCompare({ z: a.info.z, id: a.id }, { z: b.info.z, id: b.id }));
      this.sorted = { under: all.filter((e) => layerOf(e.info) === 'under'), over: all.filter((e) => layerOf(e.info) === 'over') };
    }
    return this.sorted[name];
  }

  private invalidate(layer: LayerName, b: Bounds) {
    if (b.minX > b.maxX) return;
    for (let ty = Math.floor(b.minY / TILE); ty <= Math.floor(b.maxY / TILE); ty++)
      for (let tx = Math.floor(b.minX / TILE); tx <= Math.floor(b.maxX / TILE); tx++) this.tiles[layer].delete(`${tx},${ty}`);
    this.dirty = true;
  }

  private dropTiles() {
    this.tiles.under.clear();
    this.tiles.over.clear();
    this.dirty = true;
    this.schedule();
  }

  /** The visible part of the surface (page px, whole tiles), or null when none of it is. */
  private visible(): Window | null {
    const r = this.surface.getBoundingClientRect();
    const w = this.surface.clientWidth;
    const h = this.surface.clientHeight;
    const x0 = Math.max(0, -r.left - OVERSCAN);
    const y0 = Math.max(0, -r.top - OVERSCAN);
    const x1 = Math.min(w, window.innerWidth - r.left + OVERSCAN);
    const y1 = Math.min(h, window.innerHeight - r.top + OVERSCAN);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x0: Math.floor(x0 / TILE) * TILE, y0: Math.floor(y0 / TILE) * TILE, x1: Math.min(w, Math.ceil(x1 / TILE) * TILE), y1: Math.min(h, Math.ceil(y1 / TILE) * TILE) };
  }

  private paint() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.tiles.under.clear();
      this.tiles.over.clear();
      this.dirty = true;
    }
    const win = this.visible();
    const same = win && this.win && win.x0 === this.win.x0 && win.y0 === this.win.y0 && win.x1 === this.win.x1 && win.y1 === this.win.y1;
    if (same && !this.dirty) return;
    this.dirty = false;
    const moved = !same;
    this.win = win;
    for (const c of [this.canvases.under, this.canvases.over, this.canvases.live]) {
      if (!win) {
        c.style.display = 'none';
        continue;
      }
      c.style.display = '';
      if (moved) {
        const bw = Math.round((win.x1 - win.x0) * dpr);
        const bh = Math.round((win.y1 - win.y0) * dpr);
        c.style.left = `${win.x0}px`;
        c.style.top = `${win.y0}px`;
        c.style.width = `${win.x1 - win.x0}px`;
        c.style.height = `${win.y1 - win.y0}px`;
        if (c.width !== bw || c.height !== bh) {
          c.width = bw;
          c.height = bh;
        }
      }
    }
    if (!win) return;
    this.paintLayer('under', win);
    this.paintLayer('over', win);
  }

  private paintLayer(name: LayerName, win: Window) {
    const c = this.canvases[name];
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const strokes = this.layer(name);
    if (!strokes.length) return;
    for (let ty = win.y0 / TILE; ty * TILE < win.y1; ty++)
      for (let tx = win.x0 / TILE; tx * TILE < win.x1; tx++) {
        const t = this.tile(name, tx, ty, strokes);
        if (t) ctx.drawImage(t, Math.round((tx * TILE - win.x0) * this.dpr), Math.round((ty * TILE - win.y0) * this.dpr));
      }
  }

  private tile(name: LayerName, tx: number, ty: number, strokes: Entry[]): TileCanvas | null {
    const key = `${tx},${ty}`;
    const cache = this.tiles[name];
    if (cache.has(key)) {
      const t = cache.get(key)!;
      cache.delete(key); // most recently used goes last
      cache.set(key, t);
      return t;
    }
    const box: Bounds = { minX: tx * TILE, minY: ty * TILE, maxX: (tx + 1) * TILE, maxY: (ty + 1) * TILE };
    const inTile = strokes.filter((e) => intersects(e.info.bounds, box));
    let canvas: TileCanvas | null = null;
    if (inTile.length) {
      const px = Math.ceil(TILE * this.dpr);
      canvas = makeCanvas(px, px);
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (ctx) {
        ctx.setTransform(this.dpr, 0, 0, this.dpr, -box.minX * this.dpr, -box.minY * this.dpr);
        for (const e of inTile) {
          e.path ??= opsToPath(this.engine.path(e.blob) ?? new Float32Array());
          ctx.fillStyle = displayColor(e.info.color, this.dark);
          ctx.fill(e.path, 'nonzero');
        }
      }
    }
    cache.set(key, canvas);
    while (cache.size > MAX_TILES) cache.delete(cache.keys().next().value!);
    return canvas;
  }
}
