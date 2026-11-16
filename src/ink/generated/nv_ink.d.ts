/* tslint:disable */
/* eslint-disable */

/**
 * A stroke being drawn: feed it pen samples, draw its preview, then finish it into a blob.
 */
export class InkBuilder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * How many points are kept so far.
     */
    count(): number;
    /**
     * The finished stroke as a blob (empty when it has no points). The builder is spent.
     */
    finish(): Uint8Array;
    /**
     * `color` is 0xRRGGBBAA; `created` ms since the epoch; `flags` from the blob format (pressure, tilt).
     */
    constructor(tool: number, color: number, width: number, z: string, flags: number, created: number);
    /**
     * Path commands (see ink_path) of the stroke so far plus predicted samples (flat x, y, pressure).
     */
    preview(predicted: Float32Array | number[]): Float32Array;
    /**
     * One pen sample: page px, pressure 0..=1, altitude and azimuth in radians, time in ms.
     */
    push(x: number, y: number, pressure: number, altitude: number, azimuth: number, t: number): void;
}

/**
 * A blob from points (flat as ink_points gives them).
 */
export function ink_encode(tool: number, color: number, width: number, z: string, flags: number, created: number, points: Float32Array | number[]): Uint8Array;

/**
 * The partial eraser: undefined when the eraser misses the stroke; otherwise the pieces left as
 * blobs, framed: u32 count, then per piece a u32 length and its bytes (little-endian).
 */
export function ink_erase(data: Uint8Array | number[], track: Float32Array | number[], r: number): Uint8Array | undefined;

/**
 * The blob format version this engine writes.
 */
export function ink_format_version(): number;

/**
 * Whether a lasso (flat x, y) holds at least `min_fraction` of the stroke's points.
 */
export function ink_hit_lasso(data: Uint8Array | number[], poly: Float32Array | number[], min_fraction: number): boolean;

/**
 * Whether a disc of radius r dragged along `track` (flat x, y) touches the stroke's ink.
 */
export function ink_hit_path(data: Uint8Array | number[], track: Float32Array | number[], r: number): boolean;

/**
 * Whether a disc of radius r at (x, y) touches the stroke's ink.
 */
export function ink_hit_point(data: Uint8Array | number[], x: number, y: number, r: number): boolean;

/**
 * Header fields: [version, tool, rgba, width, flags, created, count, minX, minY, maxX, maxY]
 * with the box covering the ink (width included).
 */
export function ink_info(data: Uint8Array | number[]): Float64Array | undefined;

/**
 * The stroke as path commands: 0 x y = move, 1 x y = line, 2 cx cy r = whole circle, 3 = close.
 * Fill with the nonzero rule.
 */
export function ink_path(data: Uint8Array | number[]): Float32Array | undefined;

/**
 * The points, flat: x, y, pressure, altitude, azimuth, t per point.
 */
export function ink_points(data: Uint8Array | number[]): Float32Array | undefined;

/**
 * The stroke as an SVG path `d` (fill-rule nonzero).
 */
export function ink_svg(data: Uint8Array | number[]): string | undefined;

/**
 * The stroke as triangles (x, y per vertex) for the GPU.
 */
export function ink_triangles(data: Uint8Array | number[]): Float32Array | undefined;

/**
 * Whether the whole blob decodes.
 */
export function ink_valid(data: Uint8Array | number[]): boolean;

/**
 * The z key.
 */
export function ink_z(data: Uint8Array | number[]): string | undefined;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_inkbuilder_free: (a: number, b: number) => void;
    readonly ink_encode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly ink_erase: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly ink_format_version: () => number;
    readonly ink_hit_lasso: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly ink_hit_path: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly ink_hit_point: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly ink_info: (a: number, b: number) => [number, number];
    readonly ink_path: (a: number, b: number) => [number, number];
    readonly ink_points: (a: number, b: number) => [number, number];
    readonly ink_svg: (a: number, b: number) => [number, number];
    readonly ink_triangles: (a: number, b: number) => [number, number];
    readonly ink_valid: (a: number, b: number) => number;
    readonly ink_z: (a: number, b: number) => [number, number];
    readonly inkbuilder_count: (a: number) => number;
    readonly inkbuilder_finish: (a: number) => [number, number];
    readonly inkbuilder_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly inkbuilder_preview: (a: number, b: number, c: number) => [number, number];
    readonly inkbuilder_push: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
