// Debug: fill a page with test ink and text boxes (the pen toolbar's debug menu, iPad prototype
// I2 in docs/PLAN_INK.md), for checking pan/zoom drift and speed on a heavy page. Deterministic,
// so two runs make the same page. Strokes are short handwriting-like squiggles in lines, laid over
// a grid of text boxes so any drift between ink and text shows at once.
import type * as Y from 'yjs';
import { INK_KEY, boxGeoms } from '../../shared/pageDoc.ts';
import { FLAG, TOOL, type InkEngine } from './engine.ts';
import { INK_ORIGIN, newStrokeId, topZ, zAfter } from './strokes.ts';

/** A small seeded random generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FillOptions {
  strokes?: number;
  boxes?: number;
  /** Width of the area filled (page px). */
  width?: number;
}

/** Points (flat x, y, pressure, altitude, azimuth, t) of one squiggle "word" at (x, y). */
export function squiggle(x: number, y: number, w: number, rand: () => number): number[] {
  const n = 10 + Math.floor(rand() * 10);
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const px = x + f * w;
    const py = y + Math.sin(f * Math.PI * (2 + rand() * 3)) * (5 + rand() * 4);
    const pressure = 0.3 + 0.5 * Math.sin(f * Math.PI);
    pts.push(px, py, pressure, 1.2, 0.4, i * 12);
  }
  return pts;
}

/** A text box to add: where, and its blocks (as canvasDoc's writeBoxes takes them). */
export interface TestBox {
  x: number;
  y: number;
  w: number;
  z: number;
  content: { type: string; content?: { type: string; text: string }[] }[];
}

/**
 * Adds text boxes (through `addBoxes`, the editor's writeBoxes) until the page has `boxes`, and
 * `strokes` pen strokes over the same area. Returns how many of each it added.
 */
export function fillTestPage(doc: Y.Doc, engine: InkEngine, addBoxes: (boxes: TestBox[]) => void, opts: FillOptions = {}): { boxes: number; strokes: number } {
  const want = opts.strokes ?? 3000;
  const boxCount = opts.boxes ?? 50;
  const width = opts.width ?? 1100;
  const rand = rng(42);

  const have = boxGeoms(doc).length;
  const cols = 3;
  const newBoxes: TestBox[] = Array.from({ length: Math.max(0, boxCount - have) }, (_, i) => {
    const n = have + i;
    return {
      x: 40 + (n % cols) * 370,
      y: 40 + Math.floor(n / cols) * 200,
      w: 320,
      z: 0,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `Test box ${n + 1}: the quick brown fox jumps over the lazy dog. Ink should stay on these words while you pan and zoom.` }] }],
    };
  });
  if (newBoxes.length) addBoxes(newBoxes);

  const ink = doc.getMap<unknown>(INK_KEY);
  const zs: string[] = [];
  ink.forEach((v) => {
    if (v instanceof Uint8Array) {
      const z = engine.info(v)?.z;
      if (z) zs.push(z);
    }
  });
  let z = topZ(zs);
  const colors = [0x1f2328ff, 0x1d4ed8ff, 0xdc2626ff];
  doc.transact(() => {
    let x = 20;
    let y = 30;
    for (let i = 0; i < want; i++) {
      const w = 20 + rand() * 40;
      if (x + w > width) {
        x = 20;
        y += 28;
      }
      z = zAfter(z);
      const color = colors[Math.floor(i / 400) % colors.length]!;
      const blob = engine.encode({ tool: TOOL.pen, color, width: 2, z, flags: FLAG.pressure, created: Date.now() }, squiggle(x, y, w, rand));
      ink.set(newStrokeId(), blob);
      x += w + 8 + rand() * 10;
    }
  }, INK_ORIGIN);
  return { boxes: newBoxes.length, strokes: want };
}
