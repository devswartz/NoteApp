// The ink engine (crates/nv-ink, docs/PLAN_INK.md) as typed TypeScript. The WASM and its glue in
// ./generated/ are built by scripts/build-ink-wasm.sh and committed (CI checks they match the
// Rust source). Nothing here is in the main bundle: loadInk() imports the glue on first use, so
// pages without ink (and everyone with the ink flag off) never download it.
import type * as Wasm from './generated/nv_ink.js';

type WasmModule = typeof Wasm;

/** Tools as the blob stores them. */
export const TOOL = { pen: 0, highlighter: 1 } as const;
/** Header flags as the blob stores them. */
export const FLAG = { tilt: 1, pressure: 2 } as const;
/** Path commands from InkEngine.path (Float32Array): MOVE x y, LINE x y, CIRCLE cx cy r, CLOSE. */
export const OP = { move: 0, line: 1, circle: 2, close: 3 } as const;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A stroke's header. */
export interface StrokeInfo {
  version: number;
  tool: number;
  /** 0xRRGGBBAA */
  color: number;
  width: number;
  flags: number;
  created: number;
  count: number;
  /** Covers all the ink (width included); empty strokes have minX > maxX. */
  bounds: Bounds;
  z: string;
}

export interface StrokeStyle {
  tool: number;
  /** 0xRRGGBBAA */
  color: number;
  width: number;
  z: string;
  flags: number;
  created?: number;
}

/** A stroke being drawn (see InkEngine.builder). */
export interface StrokeBuilder {
  /** A pen sample: page px, pressure 0..1, altitude/azimuth radians, time ms. */
  push(x: number, y: number, pressure: number, altitude: number, azimuth: number, t: number): void;
  /** Path commands of the stroke so far plus predicted [x, y, pressure, …] samples. */
  preview(predicted?: number[]): Float32Array;
  count(): number;
  /** The finished blob (null without points). Frees the builder. */
  finish(): Uint8Array | null;
  /** Drop it without a blob. */
  cancel(): void;
}

export class InkEngine {
  constructor(private readonly m: WasmModule) {}

  /** The blob format version this engine writes. */
  get formatVersion(): number {
    return this.m.ink_format_version();
  }

  info(blob: Uint8Array): StrokeInfo | null {
    const h = this.m.ink_info(blob);
    if (!h) return null;
    return {
      version: h[0],
      tool: h[1],
      color: h[2],
      width: h[3],
      flags: h[4],
      created: h[5],
      count: h[6],
      bounds: { minX: h[7], minY: h[8], maxX: h[9], maxY: h[10] },
      z: this.m.ink_z(blob) ?? '',
    };
  }

  /** Whether the whole blob decodes (a stroke from a newer app may not). */
  valid(blob: Uint8Array): boolean {
    return this.m.ink_valid(blob);
  }

  /** Path commands (OP) of the stroke's outline; fill with the nonzero rule. */
  path(blob: Uint8Array): Float32Array | null {
    return this.m.ink_path(blob) ?? null;
  }

  /** The outline as an SVG path `d` (fill-rule nonzero). */
  svg(blob: Uint8Array): string | null {
    return this.m.ink_svg(blob) ?? null;
  }

  /** Points flat: x, y, pressure, altitude, azimuth, t. */
  points(blob: Uint8Array): Float32Array | null {
    return this.m.ink_points(blob) ?? null;
  }

  encode(style: StrokeStyle, points: ArrayLike<number>): Uint8Array {
    return this.m.ink_encode(style.tool, style.color >>> 0, style.width, style.z, style.flags, style.created ?? Date.now(), Float32Array.from(points));
  }

  hitPoint(blob: Uint8Array, x: number, y: number, r: number): boolean {
    return this.m.ink_hit_point(blob, x, y, r);
  }

  /** Whether a disc of radius r dragged along `track` (flat x, y) touches the ink. */
  hitPath(blob: Uint8Array, track: ArrayLike<number>, r: number): boolean {
    return this.m.ink_hit_path(blob, Float32Array.from(track), r);
  }

  hitLasso(blob: Uint8Array, poly: ArrayLike<number>, minFraction = 0.5): boolean {
    return this.m.ink_hit_lasso(blob, Float32Array.from(poly), minFraction);
  }

  /** The partial eraser: null when it misses the stroke, else the pieces left (maybe none). */
  erase(blob: Uint8Array, track: ArrayLike<number>, r: number): Uint8Array[] | null {
    const framed = this.m.ink_erase(blob, Float32Array.from(track), r);
    return framed ? unframe(framed) : null;
  }

  builder(style: StrokeStyle): StrokeBuilder {
    let b: Wasm.InkBuilder | null = new this.m.InkBuilder(style.tool, style.color >>> 0, style.width, style.z, style.flags, style.created ?? Date.now());
    const free = () => {
      b?.free();
      b = null;
    };
    return {
      push: (x, y, p, alt, az, t) => b?.push(x, y, p, alt, az, t),
      preview: (predicted = []) => b?.preview(Float32Array.from(predicted)) ?? new Float32Array(),
      count: () => b?.count() ?? 0,
      finish: () => {
        const out = b?.finish();
        free();
        return out && out.length ? out : null;
      },
      cancel: free,
    };
  }
}

/** Blobs framed as u32 count, then u32 length + bytes each (little-endian). */
export function unframe(framed: Uint8Array): Uint8Array[] {
  const v = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const n = v.getUint32(0, true);
  const out: Uint8Array[] = [];
  let at = 4;
  for (let i = 0; i < n; i++) {
    const len = v.getUint32(at, true);
    out.push(framed.slice(at + 4, at + 4 + len));
    at += 4 + len;
  }
  return out;
}

let engine: InkEngine | null = null;
let loading: Promise<InkEngine> | null = null;

/** The engine, loading the WASM on first use (browser). */
export function loadInk(): Promise<InkEngine> {
  if (engine) return Promise.resolve(engine);
  loading ??= import('./generated/nv_ink.js')
    .then(async (m) => {
      await m.default();
      return (engine = new InkEngine(m));
    })
    .catch((err) => {
      loading = null; // let a later call try again (offline, a deploy in between)
      throw err;
    });
  return loading;
}

/** The engine if it has loaded (print runs synchronously inside beforeprint). */
export const inkEngine = (): InkEngine | null => engine;

/** Load the engine from the WASM's bytes (Node: tests and, later, the server). */
export async function initInk(wasm: BufferSource): Promise<InkEngine> {
  const m = await import('./generated/nv_ink.js');
  m.initSync({ module: wasm });
  return (engine = new InkEngine(m));
}

/** 0xRRGGBBAA as CSS. */
export function cssColor(c: number): string {
  const r = (c >>> 24) & 255;
  const g = (c >>> 16) & 255;
  const b = (c >>> 8) & 255;
  const a = (c & 255) / 255;
  return a >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${Math.round(a * 1000) / 1000})`;
}

/** "#rrggbb" plus alpha 0..1 as 0xRRGGBBAA. */
export function packColor(hex: string, alpha = 1): number {
  const n = parseInt(hex.replace('#', ''), 16) || 0;
  return ((n << 8) | Math.round(Math.min(1, Math.max(0, alpha)) * 255)) >>> 0;
}
