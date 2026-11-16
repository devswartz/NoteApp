//! The JS API (wasm-bindgen), wrapped by src/ink/engine.ts. Blobs go in and out as Uint8Array,
//! geometry as Float32Array. Anything that takes a blob returns undefined for one that doesn't decode.

use crate::blob::{self, decode, encode, Point, Stroke};
use crate::smooth::{OneEuroConfig, StrokeBuilder};
use crate::{erase, geom, hit};
use wasm_bindgen::prelude::*;

fn rgba(c: u32) -> [u8; 4] {
    c.to_be_bytes()
}

fn pairs(flat: &[f32]) -> Vec<[f32; 2]> {
    flat.chunks_exact(2).map(|c| [c[0], c[1]]).collect()
}

fn created_ms(v: f64) -> u64 {
    if v.is_finite() && v > 0.0 {
        v as u64
    } else {
        0
    }
}

/// A stroke being drawn: feed it pen samples, draw its preview, then finish it into a blob.
#[wasm_bindgen]
pub struct InkBuilder {
    inner: Option<StrokeBuilder>,
}

#[wasm_bindgen]
impl InkBuilder {
    /// `color` is 0xRRGGBBAA; `created` ms since the epoch; `flags` from the blob format (pressure, tilt).
    #[wasm_bindgen(constructor)]
    pub fn new(tool: u8, color: u32, width: f32, z: String, flags: u8, created: f64) -> InkBuilder {
        InkBuilder {
            inner: Some(StrokeBuilder::new(
                tool,
                rgba(color),
                width,
                z,
                flags,
                created_ms(created),
                OneEuroConfig::default(),
            )),
        }
    }

    /// One pen sample: page px, pressure 0..=1, altitude and azimuth in radians, time in ms.
    pub fn push(&mut self, x: f32, y: f32, pressure: f32, altitude: f32, azimuth: f32, t: f64) {
        if let Some(b) = &mut self.inner {
            b.push(x, y, pressure, altitude, azimuth, t);
        }
    }

    /// How many points are kept so far.
    pub fn count(&self) -> usize {
        self.inner.as_ref().map_or(0, |b| b.stroke.points.len())
    }

    /// Path commands (see ink_path) of the stroke so far plus predicted samples (flat x, y, pressure).
    pub fn preview(&self, predicted: &[f32]) -> Vec<f32> {
        let Some(b) = &self.inner else { return vec![] };
        let pred: Vec<[f32; 3]> = predicted
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect();
        let pts = b.preview(&pred);
        geom::path_ops(&geom::pieces(&geom::samples_of(
            b.stroke.tool,
            b.stroke.width,
            &pts,
        )))
    }

    /// The finished stroke as a blob (empty when it has no points). The builder is spent.
    pub fn finish(&mut self) -> Vec<u8> {
        match self.inner.take().map(StrokeBuilder::finish) {
            Some(s) if !s.points.is_empty() => encode(&s),
            _ => vec![],
        }
    }
}

/// Header fields: [version, tool, rgba, width, flags, created, count, minX, minY, maxX, maxY]
/// with the box covering the ink (width included).
#[wasm_bindgen]
pub fn ink_info(data: &[u8]) -> Option<Vec<f64>> {
    let h = blob::decode_header(data).ok()?;
    let b = crate::ink_bounds(&h);
    Some(vec![
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
    ])
}

/// The z key.
#[wasm_bindgen]
pub fn ink_z(data: &[u8]) -> Option<String> {
    blob::decode_header(data).ok().map(|h| h.z)
}

/// Whether the whole blob decodes.
#[wasm_bindgen]
pub fn ink_valid(data: &[u8]) -> bool {
    decode(data).is_ok()
}

/// The points, flat: x, y, pressure, altitude, azimuth, t per point.
#[wasm_bindgen]
pub fn ink_points(data: &[u8]) -> Option<Vec<f32>> {
    let s = decode(data).ok()?;
    Some(
        s.points
            .iter()
            .flat_map(|p| [p.x, p.y, p.pressure, p.altitude, p.azimuth, p.t as f32])
            .collect(),
    )
}

/// A blob from points (flat as ink_points gives them).
#[wasm_bindgen]
pub fn ink_encode(
    tool: u8,
    color: u32,
    width: f32,
    z: String,
    flags: u8,
    created: f64,
    points: &[f32],
) -> Vec<u8> {
    let points = points
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
    encode(&Stroke {
        tool,
        color: rgba(color),
        width,
        z,
        flags,
        created: created_ms(created),
        points,
    })
}

/// The stroke as path commands: 0 x y = move, 1 x y = line, 2 cx cy r = whole circle, 3 = close.
/// Fill with the nonzero rule.
#[wasm_bindgen]
pub fn ink_path(data: &[u8]) -> Option<Vec<f32>> {
    let s = decode(data).ok()?;
    Some(geom::path_ops(&geom::pieces(&geom::samples(&s))))
}

/// The stroke as an SVG path `d` (fill-rule nonzero).
#[wasm_bindgen]
pub fn ink_svg(data: &[u8]) -> Option<String> {
    let s = decode(data).ok()?;
    Some(geom::svg_path(&geom::pieces(&geom::samples(&s))))
}

/// The stroke as triangles (x, y per vertex) for the GPU.
#[wasm_bindgen]
pub fn ink_triangles(data: &[u8]) -> Option<Vec<f32>> {
    let s = decode(data).ok()?;
    Some(geom::triangles(&geom::pieces(&geom::samples(&s))))
}

/// Whether a disc of radius r at (x, y) touches the stroke's ink.
#[wasm_bindgen]
pub fn ink_hit_point(data: &[u8], x: f32, y: f32, r: f32) -> bool {
    decode(data).is_ok_and(|s| hit::hit_point(&geom::samples(&s), x, y, r))
}

/// Whether a disc of radius r dragged along `track` (flat x, y) touches the stroke's ink.
#[wasm_bindgen]
pub fn ink_hit_path(data: &[u8], track: &[f32], r: f32) -> bool {
    decode(data).is_ok_and(|s| hit::hit_path(&geom::samples(&s), &pairs(track), r))
}

/// Whether a lasso (flat x, y) holds at least `min_fraction` of the stroke's points.
#[wasm_bindgen]
pub fn ink_hit_lasso(data: &[u8], poly: &[f32], min_fraction: f32) -> bool {
    decode(data).is_ok_and(|s| hit::hit_lasso(&s.points, &pairs(poly), min_fraction))
}

/// The partial eraser: undefined when the eraser misses the stroke; otherwise the pieces left as
/// blobs, framed: u32 count, then per piece a u32 length and its bytes (little-endian).
#[wasm_bindgen]
pub fn ink_erase(data: &[u8], track: &[f32], r: f32) -> Option<Vec<u8>> {
    let s = decode(data).ok()?;
    let pieces = erase::erase_split(&s, &pairs(track), r)?;
    let mut out = Vec::new();
    out.extend_from_slice(&(pieces.len() as u32).to_le_bytes());
    for p in &pieces {
        let b = encode(p);
        out.extend_from_slice(&(b.len() as u32).to_le_bytes());
        out.extend_from_slice(&b);
    }
    Some(out)
}

/// The blob format version this engine writes.
#[wasm_bindgen]
pub fn ink_format_version() -> u8 {
    blob::FORMAT_VERSION
}
