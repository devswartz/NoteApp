//! The C ABI used by the iPad app (`ffi` feature; header in `include/nv_ink.h`, Swift wrapper in
//! apps/mobile/ios/App/NvInk). A plain C ABI rather than uniffi: the surface is a dozen functions
//! over flat numbers and byte buffers, the hot path (a pen sample, a preview per frame) passes
//! pointers with no serialisation, and there is no code generator or extra crate to keep in step.
//!
//! Ownership: a builder is created by `nv_ink_builder_new` and released by `nv_ink_builder_finish`
//! or `nv_ink_builder_free`. Every `NvBuf` / `NvFloats` handed out is released with
//! `nv_ink_buf_free` / `nv_ink_floats_free`. Blobs passed in are borrowed for the call only.

use crate::blob::{self, decode, encode, Point, Stroke};
use crate::smooth::{OneEuroConfig, StrokeBuilder};
use crate::{erase, geom, hit};
use std::ffi::{c_char, CStr};
use std::slice;

/// Bytes owned by Rust (a blob, or framed blobs).
#[repr(C)]
pub struct NvBuf {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

/// Floats owned by Rust (path commands or triangles).
#[repr(C)]
pub struct NvFloats {
    pub ptr: *mut f32,
    pub len: usize,
    pub cap: usize,
}

impl NvBuf {
    fn from(v: Vec<u8>) -> NvBuf {
        let mut v = std::mem::ManuallyDrop::new(v);
        NvBuf {
            ptr: v.as_mut_ptr(),
            len: v.len(),
            cap: v.capacity(),
        }
    }
    const EMPTY: NvBuf = NvBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
        cap: 0,
    };
}

impl NvFloats {
    fn from(v: Vec<f32>) -> NvFloats {
        let mut v = std::mem::ManuallyDrop::new(v);
        NvFloats {
            ptr: v.as_mut_ptr(),
            len: v.len(),
            cap: v.capacity(),
        }
    }
    const EMPTY: NvFloats = NvFloats {
        ptr: std::ptr::null_mut(),
        len: 0,
        cap: 0,
    };
}

/// # Safety
/// `ptr` must point to `len` readable items (or be null with `len == 0`).
unsafe fn view<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        slice::from_raw_parts(ptr, len)
    }
}

fn pairs(flat: &[f32]) -> Vec<[f32; 2]> {
    flat.chunks_exact(2).map(|c| [c[0], c[1]]).collect()
}

/// Frees a buffer from this library (a null/empty one is fine).
///
/// # Safety
/// `b` must come from this library and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_buf_free(b: NvBuf) {
    if !b.ptr.is_null() {
        drop(Vec::from_raw_parts(b.ptr, b.len, b.cap));
    }
}

/// Frees floats from this library (a null/empty one is fine).
///
/// # Safety
/// `f` must come from this library and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_floats_free(f: NvFloats) {
    if !f.ptr.is_null() {
        drop(Vec::from_raw_parts(f.ptr, f.len, f.cap));
    }
}

/// The blob format version this engine writes.
#[no_mangle]
pub extern "C" fn nv_ink_format_version() -> u8 {
    blob::FORMAT_VERSION
}

/// A stroke being drawn. Opaque to C.
pub struct NvInkBuilder(StrokeBuilder);

/// A new stroke. `color` is 0xRRGGBBAA, `z` a NUL-terminated UTF-8 z key, `created` ms since the epoch.
///
/// # Safety
/// `z` must be null or a NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_builder_new(
    tool: u8,
    color: u32,
    width: f32,
    z: *const c_char,
    flags: u8,
    created: f64,
) -> *mut NvInkBuilder {
    let z = if z.is_null() {
        String::new()
    } else {
        CStr::from_ptr(z).to_string_lossy().into_owned()
    };
    let created = if created.is_finite() && created > 0.0 {
        created as u64
    } else {
        0
    };
    Box::into_raw(Box::new(NvInkBuilder(StrokeBuilder::new(
        tool,
        color.to_be_bytes(),
        width,
        z,
        flags,
        created,
        OneEuroConfig::default(),
    ))))
}

/// One pen sample: page px, pressure 0..=1, altitude and azimuth in radians, time in ms.
///
/// # Safety
/// `b` must be a live builder.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn nv_ink_builder_push(
    b: *mut NvInkBuilder,
    x: f32,
    y: f32,
    pressure: f32,
    altitude: f32,
    azimuth: f32,
    t: f64,
) {
    if let Some(b) = b.as_mut() {
        b.0.push(x, y, pressure, altitude, azimuth, t);
    }
}

/// How many points the builder keeps so far.
///
/// # Safety
/// `b` must be a live builder.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_builder_count(b: *const NvInkBuilder) -> usize {
    b.as_ref().map_or(0, |b| b.0.stroke.points.len())
}

/// The stroke so far plus `n_pred` predicted samples (flat x, y, pressure) as triangles (x, y per
/// vertex) for the GPU. Fill them opaque; a see-through tool gets its alpha from the layer, so
/// overlapping triangles never darken.
///
/// # Safety
/// `b` must be a live builder; `predicted` must hold `3 * n_pred` floats.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_builder_preview_triangles(
    b: *const NvInkBuilder,
    predicted: *const f32,
    n_pred: usize,
) -> NvFloats {
    let Some(b) = b.as_ref() else {
        return NvFloats::EMPTY;
    };
    let pred: Vec<[f32; 3]> = view(predicted, n_pred * 3)
        .chunks_exact(3)
        .map(|c| [c[0], c[1], c[2]])
        .collect();
    let pts = b.0.preview(&pred);
    NvFloats::from(geom::triangles(&geom::pieces(&geom::samples_of(
        b.0.stroke.tool,
        b.0.stroke.width,
        &pts,
    ))))
}

/// Finishes the stroke into a blob (empty when it has no points) and releases the builder.
///
/// # Safety
/// `b` must be a live builder; it is gone afterwards.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_builder_finish(b: *mut NvInkBuilder) -> NvBuf {
    if b.is_null() {
        return NvBuf::EMPTY;
    }
    let s = Box::from_raw(b).0.finish();
    if s.points.is_empty() {
        NvBuf::EMPTY
    } else {
        NvBuf::from(encode(&s))
    }
}

/// Releases a builder without finishing it.
///
/// # Safety
/// `b` must be a live builder (or null); it is gone afterwards.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_builder_free(b: *mut NvInkBuilder) {
    if !b.is_null() {
        drop(Box::from_raw(b));
    }
}

/// Header fields into `out` (11 doubles): version, tool, rgba, width, flags, created, count,
/// minX, minY, maxX, maxY (the box covers the ink, width included). False when the header doesn't decode.
///
/// # Safety
/// `data` must hold `len` bytes; `out` must have room for 11 doubles.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_info(data: *const u8, len: usize, out: *mut f64) -> bool {
    let Ok(h) = blob::decode_header(view(data, len)) else {
        return false;
    };
    if out.is_null() {
        return false;
    }
    let b = crate::ink_bounds(&h);
    let v = [
        h.version as f64,
        h.tool as f64,
        u32::from_be_bytes(h.color) as f64,
        h.width as f64,
        h.flags as f64,
        h.created as f64,
        h.count as f64,
        b.min_x as f64,
        b.min_y as f64,
        b.max_x as f64,
        b.max_y as f64,
    ];
    slice::from_raw_parts_mut(out, v.len()).copy_from_slice(&v);
    true
}

/// The z key's UTF-8 bytes (empty when the header doesn't decode).
///
/// # Safety
/// `data` must hold `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_z(data: *const u8, len: usize) -> NvBuf {
    match blob::decode_header(view(data, len)) {
        Ok(h) => NvBuf::from(h.z.into_bytes()),
        Err(_) => NvBuf::EMPTY,
    }
}

/// The stroke as path commands (as ink_path on the web: 0 x y move, 1 x y line, 2 cx cy r circle,
/// 3 close; fill nonzero). Empty when the blob doesn't decode.
///
/// # Safety
/// `data` must hold `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_path(data: *const u8, len: usize) -> NvFloats {
    match decode(view(data, len)) {
        Ok(s) => NvFloats::from(geom::path_ops(&geom::pieces(&geom::samples(&s)))),
        Err(_) => NvFloats::EMPTY,
    }
}

/// The stroke as triangles (x, y per vertex). Empty when the blob doesn't decode.
///
/// # Safety
/// `data` must hold `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_triangles(data: *const u8, len: usize) -> NvFloats {
    match decode(view(data, len)) {
        Ok(s) => NvFloats::from(geom::triangles(&geom::pieces(&geom::samples(&s)))),
        Err(_) => NvFloats::EMPTY,
    }
}

/// Whether a disc of radius r dragged along `track` (n points, flat x, y) touches the stroke's ink.
///
/// # Safety
/// `data` must hold `len` bytes; `track` must hold `2 * n` floats.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_hit_path(
    data: *const u8,
    len: usize,
    track: *const f32,
    n: usize,
    r: f32,
) -> bool {
    decode(view(data, len))
        .is_ok_and(|s| hit::hit_path(&geom::samples(&s), &pairs(view(track, n * 2)), r))
}

/// The partial eraser. Returns false when it misses the stroke (`out` untouched). Otherwise true,
/// with the pieces left in `out`, framed as on the web: u32 count, then per piece a u32 length and
/// its bytes (little-endian). No pieces (count 0) means the whole stroke went.
///
/// # Safety
/// `data` must hold `len` bytes; `track` must hold `2 * n` floats; `out` must be writable.
#[no_mangle]
pub unsafe extern "C" fn nv_ink_erase(
    data: *const u8,
    len: usize,
    track: *const f32,
    n: usize,
    r: f32,
    out: *mut NvBuf,
) -> bool {
    let Ok(s) = decode(view(data, len)) else {
        return false;
    };
    let Some(pieces) = erase::erase_split(&s, &pairs(view(track, n * 2)), r) else {
        return false;
    };
    let mut v = Vec::new();
    v.extend_from_slice(&(pieces.len() as u32).to_le_bytes());
    for p in &pieces {
        let b = encode(p);
        v.extend_from_slice(&(b.len() as u32).to_le_bytes());
        v.extend_from_slice(&b);
    }
    if let Some(out) = out.as_mut() {
        *out = NvBuf::from(v);
    }
    true
}

/// A blob from points (flat x, y, pressure, altitude, azimuth, t per point; n points).
///
/// # Safety
/// `z` must be null or NUL-terminated; `points` must hold `6 * n` floats.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn nv_ink_encode(
    tool: u8,
    color: u32,
    width: f32,
    z: *const c_char,
    flags: u8,
    created: f64,
    points: *const f32,
    n: usize,
) -> NvBuf {
    let z = if z.is_null() {
        String::new()
    } else {
        CStr::from_ptr(z).to_string_lossy().into_owned()
    };
    let points = view(points, n * 6)
        .chunks_exact(6)
        .map(|c| Point {
            x: c[0],
            y: c[1],
            pressure: c[2],
            altitude: c[3],
            azimuth: c[4],
            t: c[5].max(0.0) as u32,
        })
        .collect();
    NvBuf::from(encode(&Stroke {
        tool,
        color: color.to_be_bytes(),
        width,
        z,
        flags,
        created: if created.is_finite() && created > 0.0 {
            created as u64
        } else {
            0
        },
        points,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn bytes(b: &NvBuf) -> Vec<u8> {
        view(b.ptr, b.len).to_vec()
    }

    #[test]
    fn builder_round_trip_matches_the_rust_api() {
        unsafe {
            let z = c"a0";
            let b = nv_ink_builder_new(0, 0x1f2328ff, 2.5, z.as_ptr(), 2, 1.0e12);
            for i in 0..40 {
                let f = i as f32;
                nv_ink_builder_push(
                    b,
                    10.0 + f * 3.0,
                    20.0 + (f * 0.3).sin() * 8.0,
                    0.5,
                    1.2,
                    0.3,
                    i as f64 * 8.0,
                );
            }
            assert!(nv_ink_builder_count(b) > 1);
            let pred = [140.0f32, 22.0, 0.5];
            let tris = nv_ink_builder_preview_triangles(b, pred.as_ptr(), 1);
            assert!(tris.len > 0 && tris.len % 6 == 0);
            nv_ink_floats_free(tris);
            let blob = nv_ink_builder_finish(b);
            let data = bytes(&blob);
            let s = decode(&data).expect("decodes");
            assert_eq!(s.z, "a0");

            let mut info = [0f64; 11];
            assert!(nv_ink_info(blob.ptr, blob.len, info.as_mut_ptr()));
            assert_eq!(info[1], 0.0);
            assert_eq!(info[2], 0x1f2328ff as f64);
            assert!(info[9] > info[7]);
            let z = nv_ink_z(blob.ptr, blob.len);
            assert_eq!(bytes(&z), b"a0");
            nv_ink_buf_free(z);

            let path = nv_ink_path(blob.ptr, blob.len);
            assert_eq!(
                view(path.ptr, path.len),
                geom::path_ops(&geom::pieces(&geom::samples(&s))).as_slice()
            );
            nv_ink_floats_free(path);

            let track = [60.0f32, 0.0, 60.0, 60.0];
            assert!(nv_ink_hit_path(blob.ptr, blob.len, track.as_ptr(), 2, 4.0));
            let far = [900.0f32, 900.0];
            assert!(!nv_ink_hit_path(blob.ptr, blob.len, far.as_ptr(), 1, 4.0));

            let mut out = NvBuf::EMPTY;
            assert!(nv_ink_erase(
                blob.ptr,
                blob.len,
                track.as_ptr(),
                2,
                4.0,
                &mut out
            ));
            let framed = bytes(&out);
            assert_eq!(u32::from_le_bytes(framed[0..4].try_into().unwrap()), 2);
            nv_ink_buf_free(out);
            let mut out = NvBuf::EMPTY;
            assert!(!nv_ink_erase(
                blob.ptr,
                blob.len,
                far.as_ptr(),
                1,
                4.0,
                &mut out
            ));

            nv_ink_buf_free(blob);
        }
    }

    #[test]
    fn bad_input_is_harmless() {
        unsafe {
            let junk = [1u8, 2, 3];
            let mut info = [0f64; 11];
            assert!(!nv_ink_info(junk.as_ptr(), junk.len(), info.as_mut_ptr()));
            let p = nv_ink_path(junk.as_ptr(), junk.len());
            assert!(p.ptr.is_null());
            nv_ink_floats_free(p);
            let empty =
                nv_ink_builder_finish(nv_ink_builder_new(0, 0, 1.0, std::ptr::null(), 0, 0.0));
            assert_eq!(empty.len, 0);
            nv_ink_buf_free(empty);
            nv_ink_builder_free(std::ptr::null_mut());
        }
    }

    #[test]
    fn encode_matches() {
        unsafe {
            let pts = [
                0.0f32, 0.0, 0.5, 1.5, 0.0, 0.0, 10.0, 5.0, 0.5, 1.5, 0.0, 16.0,
            ];
            let b = nv_ink_encode(0, 0xff0000ff, 2.0, c"a1".as_ptr(), 0, 5.0, pts.as_ptr(), 2);
            let s = decode(&bytes(&b)).unwrap();
            assert_eq!(s.points.len(), 2);
            assert_eq!(s.color, [0xff, 0, 0, 0xff]);
            nv_ink_buf_free(b);
        }
    }
}
