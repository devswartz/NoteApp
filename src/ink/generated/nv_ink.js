/* @ts-self-types="./nv_ink.d.ts" */

/**
 * A stroke being drawn: feed it pen samples, draw its preview, then finish it into a blob.
 */
export class InkBuilder {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InkBuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_inkbuilder_free(ptr, 0);
    }
    /**
     * How many points are kept so far.
     * @returns {number}
     */
    count() {
        const ret = wasm.inkbuilder_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The finished stroke as a blob (empty when it has no points). The builder is spent.
     * @returns {Uint8Array}
     */
    finish() {
        const ret = wasm.inkbuilder_finish(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * `color` is 0xRRGGBBAA; `created` ms since the epoch; `flags` from the blob format (pressure, tilt).
     * @param {number} tool
     * @param {number} color
     * @param {number} width
     * @param {string} z
     * @param {number} flags
     * @param {number} created
     */
    constructor(tool, color, width, z, flags, created) {
        const val2 = +tool;
        const val3 = +color;
        const val4 = +width;
        const val5 = +flags;
        const val6 = +created;
        const ptr0 = passStringToWasm0(z, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.inkbuilder_new(val2, val3, val4, ptr0, len0, val5, val6);
        this.__wbg_ptr = ret;
        InkBuilderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Path commands (see ink_path) of the stroke so far plus predicted samples (flat x, y, pressure).
     * @param {Float32Array | number[]} predicted
     * @returns {Float32Array}
     */
    preview(predicted) {
        const ptr0 = passArrayF32ToWasm0(predicted, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.inkbuilder_preview(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * One pen sample: page px, pressure 0..=1, altitude and azimuth in radians, time in ms.
     * @param {number} x
     * @param {number} y
     * @param {number} pressure
     * @param {number} altitude
     * @param {number} azimuth
     * @param {number} t
     */
    push(x, y, pressure, altitude, azimuth, t) {
        wasm.inkbuilder_push(this.__wbg_ptr, x, y, pressure, altitude, azimuth, t);
    }
}
if (Symbol.dispose) InkBuilder.prototype[Symbol.dispose] = InkBuilder.prototype.free;

/**
 * A blob from points (flat as ink_points gives them).
 * @param {number} tool
 * @param {number} color
 * @param {number} width
 * @param {string} z
 * @param {number} flags
 * @param {number} created
 * @param {Float32Array | number[]} points
 * @returns {Uint8Array}
 */
export function ink_encode(tool, color, width, z, flags, created, points) {
    const val3 = +tool;
    const val4 = +color;
    const val5 = +width;
    const val6 = +flags;
    const val7 = +created;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passStringToWasm0(z, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF32ToWasm0(points, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.ink_encode(val3, val4, val5, ptr0, len0, val6, val7, ptr1, len1);
    var v8 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v8;
}

/**
 * The partial eraser: undefined when the eraser misses the stroke; otherwise the pieces left as
 * blobs, framed: u32 count, then per piece a u32 length and its bytes (little-endian).
 * @param {Uint8Array | number[]} data
 * @param {Float32Array | number[]} track
 * @param {number} r
 * @returns {Uint8Array | undefined}
 */
export function ink_erase(data, track, r) {
    const val3 = +r;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF32ToWasm0(track, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.ink_erase(ptr0, len0, ptr1, len1, val3);
    let v4;
    if (ret[0] !== 0) {
        v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v4;
}

/**
 * The blob format version this engine writes.
 * @returns {number}
 */
export function ink_format_version() {
    const ret = wasm.ink_format_version();
    return ret;
}

/**
 * Whether a lasso (flat x, y) holds at least `min_fraction` of the stroke's points.
 * @param {Uint8Array | number[]} data
 * @param {Float32Array | number[]} poly
 * @param {number} min_fraction
 * @returns {boolean}
 */
export function ink_hit_lasso(data, poly, min_fraction) {
    const val3 = +min_fraction;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF32ToWasm0(poly, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.ink_hit_lasso(ptr0, len0, ptr1, len1, val3);
    return ret !== 0;
}

/**
 * Whether a disc of radius r dragged along `track` (flat x, y) touches the stroke's ink.
 * @param {Uint8Array | number[]} data
 * @param {Float32Array | number[]} track
 * @param {number} r
 * @returns {boolean}
 */
export function ink_hit_path(data, track, r) {
    const val3 = +r;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF32ToWasm0(track, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.ink_hit_path(ptr0, len0, ptr1, len1, val3);
    return ret !== 0;
}

/**
 * Whether a disc of radius r at (x, y) touches the stroke's ink.
 * @param {Uint8Array | number[]} data
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @returns {boolean}
 */
export function ink_hit_point(data, x, y, r) {
    const val2 = +x;
    const val3 = +y;
    const val4 = +r;
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ink_hit_point(ptr0, len0, val2, val3, val4);
    return ret !== 0;
}

/**
 * Header fields: [version, tool, rgba, width, flags, created, count, minX, minY, maxX, maxY]
 * with the box covering the ink (width included).
 * @param {Uint8Array | number[]} data
 * @returns {Float64Array | undefined}
 */
export function ink_info(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ink_info(ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    }
    return v2;
}

/**
 * The stroke as path commands: 0 x y = move, 1 x y = line, 2 cx cy r = whole circle, 3 = close.
 * Fill with the nonzero rule.
 * @param {Uint8Array | number[]} data
 * @returns {Float32Array | undefined}
 */
export function ink_path(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ink_path(ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    }
    return v2;
}

/**
 * The points, flat: x, y, pressure, altitude, azimuth, t per point.
 * @param {Uint8Array | number[]} data
 * @returns {Float32Array | undefined}
 */
export function ink_points(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ink_points(ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    }
    return v2;
}

/**
 * The stroke as an SVG path `d` (fill-rule nonzero).
 * @param {Uint8Array | number[]} data
 * @returns {string | undefined}
 */
export function ink_svg(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ink_svg(ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v2;
}

/**
 * The stroke as triangles (x, y per vertex) for the GPU.
 * @param {Uint8Array | number[]} data
 * @returns {Float32Array | undefined}
 */
export function ink_triangles(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ink_triangles(ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    }
    return v2;
}

/**
 * Whether the whole blob decodes.
 * @param {Uint8Array | number[]} data
 * @returns {boolean}
 */
export function ink_valid(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ink_valid(ptr0, len0);
    return ret !== 0;
}

/**
 * The z key.
 * @param {Uint8Array | number[]} data
 * @returns {string | undefined}
 */
export function ink_z(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ink_z(ptr0, len0);
    let v2;
    if (ret[0] !== 0) {
        v2 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v2;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./nv_ink_bg.js": import0,
    };
}

const InkBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_inkbuilder_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('nv_ink_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
