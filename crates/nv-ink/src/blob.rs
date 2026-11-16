//! The stroke blob: how one stroke is stored as a value in a page's `ink` Y.Map
//! (docs/PLAN_INK.md, "Storage"). Versioned, little-endian, compact.
//!
//! ```text
//! header
//!   u8      format version (FORMAT_VERSION)
//!   u8      tool (tool::PEN, tool::HIGHLIGHTER, ...)
//!   [u8; 4] colour, RGBA
//!   uvar    base width, 1/16 page px
//!   uvar    z key length, then that many bytes of UTF-8 (a fractional index)
//!   u8      flags (flags::TILT, flags::PRESSURE)
//!   svar x4 bounding box of the ink, curve and width included (min x, min y, max x, max y), 1/8 page px
//!   uvar    point count
//!   uvar    creation time, ms since the Unix epoch
//! points, each
//!   svar    x, then y: 1/8 page px, the first absolute, then the change from the point before
//!   u8      pressure, 0..=255
//!   u8, u8  altitude (0..=255 over 0..=pi/2) and azimuth (0..=255 over 0..2pi), only with flags::TILT
//!   uvar    ms since the point before (the first: since the stroke began)
//! ```
//!
//! `uvar` is an unsigned LEB128 varint, `svar` a zigzag-encoded one. A typical point is 4-6 bytes.
//! Decoding never panics: anything malformed is a [`DecodeError`].

use core::f32::consts::{FRAC_PI_2, TAU};

/// The blob format this crate writes. Decoding rejects any other version.
pub const FORMAT_VERSION: u8 = 1;
/// Coordinates are stored in 1/COORD_SCALE page pixels.
pub const COORD_SCALE: f32 = 8.0;
/// The base width is stored in 1/WIDTH_SCALE page pixels.
pub const WIDTH_SCALE: f32 = 16.0;
/// The most points one stroke may have (a very long scribble is a few thousand).
pub const MAX_POINTS: usize = 1 << 16;
/// The longest z key kept (bytes).
pub const MAX_Z_LEN: usize = 255;
/// Coordinates are clamped to +-MAX_COORD page px (far beyond the canvas's own limit).
pub const MAX_COORD: f32 = 1_000_000.0;

/// What drew a stroke. Unknown values are kept as they are (a newer app's tool).
pub mod tool {
    pub const PEN: u8 = 0;
    pub const HIGHLIGHTER: u8 = 1;
}

/// Header flags. Unknown bits are kept as they are.
pub mod flags {
    /// Points carry altitude and azimuth.
    pub const TILT: u8 = 1;
    /// The pressure came from the device (a mouse stroke has a constant 0.5).
    pub const PRESSURE: u8 = 2;
}

/// One input point of a stroke, in page pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f32,
    pub y: f32,
    /// 0..=1 (0.5 when the device has none).
    pub pressure: f32,
    /// Radians from the page: pi/2 is upright (the value without tilt).
    pub altitude: f32,
    /// Radians, 0..2pi.
    pub azimuth: f32,
    /// ms since the stroke began.
    pub t: u32,
}

impl Point {
    pub fn new(x: f32, y: f32, pressure: f32) -> Point {
        Point {
            x,
            y,
            pressure,
            altitude: FRAC_PI_2,
            azimuth: 0.0,
            t: 0,
        }
    }
}

/// A whole stroke: style plus points. Strokes are immutable once stored (PLAN_INK).
#[derive(Clone, Debug, PartialEq)]
pub struct Stroke {
    pub tool: u8,
    pub color: [u8; 4],
    /// Base width in page px (the width at pressure 0.5).
    pub width: f32,
    /// Fractional-index z key: strokes draw in key order.
    pub z: String,
    pub flags: u8,
    /// ms since the Unix epoch.
    pub created: u64,
    pub points: Vec<Point>,
}

/// An axis-aligned box in page px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BBox {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
}

impl BBox {
    pub const EMPTY: BBox = BBox {
        min_x: f32::INFINITY,
        min_y: f32::INFINITY,
        max_x: f32::NEG_INFINITY,
        max_y: f32::NEG_INFINITY,
    };
    pub fn is_empty(&self) -> bool {
        self.min_x > self.max_x || self.min_y > self.max_y
    }
    pub fn add(&mut self, x: f32, y: f32) {
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
    }
    pub fn inflate(&self, by: f32) -> BBox {
        BBox {
            min_x: self.min_x - by,
            min_y: self.min_y - by,
            max_x: self.max_x + by,
            max_y: self.max_y + by,
        }
    }
    pub fn intersects(&self, o: &BBox) -> bool {
        !self.is_empty()
            && !o.is_empty()
            && self.min_x <= o.max_x
            && o.min_x <= self.max_x
            && self.min_y <= o.max_y
            && o.min_y <= self.max_y
    }
}

/// Why a blob didn't decode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// It ended early.
    Truncated,
    /// A format version this crate doesn't know (a newer app wrote it).
    UnknownVersion(u8),
    /// More points than MAX_POINTS, or more than the bytes could hold.
    TooManyPoints,
    /// The z key isn't UTF-8 or is too long.
    BadZ,
    /// A varint or coordinate out of range.
    Overflow,
    /// Bytes left over after the last point.
    Trailing,
}

/// The header alone: what culling and the stroke list need without decoding points.
#[derive(Clone, Debug, PartialEq)]
pub struct Header {
    pub version: u8,
    pub tool: u8,
    pub color: [u8; 4],
    pub width: f32,
    pub z: String,
    pub flags: u8,
    /// Bounding box of the ink: the fitted curve with its width (empty strokes: all zero).
    pub bbox: BBox,
    pub count: usize,
    pub created: u64,
}

fn q_coord(v: f32) -> i64 {
    let v = if v.is_finite() {
        v.clamp(-MAX_COORD, MAX_COORD)
    } else {
        0.0
    };
    (v * COORD_SCALE).round() as i64
}
fn q_unit(v: f32) -> u8 {
    let v = if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.5
    };
    (v * 255.0).round() as u8
}
fn q_width(w: f32) -> u64 {
    let w = if w.is_finite() { w } else { 1.0 };
    (w * WIDTH_SCALE).round().clamp(1.0, 65_535.0) as u64
}
fn q_altitude(a: f32) -> u8 {
    let a = if a.is_finite() {
        a.clamp(0.0, FRAC_PI_2)
    } else {
        FRAC_PI_2
    };
    (a / FRAC_PI_2 * 255.0).round() as u8
}
fn q_azimuth(a: f32) -> u8 {
    let a = if a.is_finite() {
        a.rem_euclid(TAU)
    } else {
        0.0
    };
    ((a / TAU * 256.0).round() as u32 % 256) as u8
}

/// The z key as stored: at most MAX_Z_LEN bytes, cut at a character boundary.
pub fn stored_z(z: &str) -> &str {
    if z.len() <= MAX_Z_LEN {
        return z;
    }
    let mut end = MAX_Z_LEN;
    while !z.is_char_boundary(end) {
        end -= 1;
    }
    &z[..end]
}

fn put_uvar(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}
fn put_svar(out: &mut Vec<u8>, v: i64) {
    put_uvar(out, ((v << 1) ^ (v >> 63)) as u64);
}

/// The stroke as a blob.
pub fn encode(s: &Stroke) -> Vec<u8> {
    let tilt = s.flags & flags::TILT != 0;
    let mut out = Vec::with_capacity(40 + s.points.len() * if tilt { 7 } else { 5 });
    out.push(FORMAT_VERSION);
    out.push(s.tool);
    out.extend_from_slice(&s.color);
    put_uvar(&mut out, q_width(s.width));
    let z = stored_z(&s.z);
    put_uvar(&mut out, z.len() as u64);
    out.extend_from_slice(z.as_bytes());
    out.push(s.flags);
    let points = &s.points[..s.points.len().min(MAX_POINTS)];
    let q: Vec<(i64, i64)> = points
        .iter()
        .map(|p| (q_coord(p.x), q_coord(p.y)))
        .collect();
    // The box covers the ink as it will be drawn from the stored (quantised) values: the fitted
    // curve can swing outside its points, and the width reaches further still.
    let stored: Vec<Point> = points
        .iter()
        .zip(&q)
        .map(|(p, &(x, y))| {
            Point::new(
                x as f32 / COORD_SCALE,
                y as f32 / COORD_SCALE,
                q_unit(p.pressure) as f32 / 255.0,
            )
        })
        .collect();
    let width = q_width(s.width) as f32 / WIDTH_SCALE;
    let mut bb = BBox::EMPTY;
    for sm in crate::geom::samples_of(s.tool, width, &stored) {
        bb.add(sm.x - sm.r, sm.y - sm.r);
        bb.add(sm.x + sm.r, sm.y + sm.r);
    }
    let lim = MAX_COORD * COORD_SCALE;
    let (x0, y0, x1, y1) = if bb.is_empty() {
        (0, 0, 0, 0)
    } else {
        let lo = |v: f32| (v * COORD_SCALE).floor().clamp(-lim, lim) as i64;
        let hi = |v: f32| (v * COORD_SCALE).ceil().clamp(-lim, lim) as i64;
        (lo(bb.min_x), lo(bb.min_y), hi(bb.max_x), hi(bb.max_y))
    };
    for v in [x0, y0, x1, y1] {
        put_svar(&mut out, v);
    }
    put_uvar(&mut out, points.len() as u64);
    put_uvar(&mut out, s.created);
    let (mut px, mut py, mut pt) = (0i64, 0i64, 0u32);
    for (p, &(x, y)) in points.iter().zip(&q) {
        put_svar(&mut out, x - px);
        put_svar(&mut out, y - py);
        (px, py) = (x, y);
        out.push(q_unit(p.pressure));
        if tilt {
            out.push(q_altitude(p.altitude));
            out.push(q_azimuth(p.azimuth));
        }
        let t = p.t.max(pt); // time never runs backwards
        put_uvar(&mut out, (t - pt) as u64);
        pt = t;
    }
    out
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> Result<u8, DecodeError> {
        let v = *self.b.get(self.i).ok_or(DecodeError::Truncated)?;
        self.i += 1;
        Ok(v)
    }
    fn bytes(&mut self, n: usize) -> Result<&[u8], DecodeError> {
        let end = self.i.checked_add(n).ok_or(DecodeError::Truncated)?;
        let s = self.b.get(self.i..end).ok_or(DecodeError::Truncated)?;
        self.i = end;
        Ok(s)
    }
    fn uvar(&mut self) -> Result<u64, DecodeError> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.u8()?;
            let bits = (b & 0x7f) as u64;
            if shift == 63 && bits > 1 {
                return Err(DecodeError::Overflow);
            }
            v |= bits << shift;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(DecodeError::Overflow)
    }
    fn svar(&mut self) -> Result<i64, DecodeError> {
        let u = self.uvar()?;
        Ok(((u >> 1) as i64) ^ -((u & 1) as i64))
    }
    fn left(&self) -> usize {
        self.b.len() - self.i
    }
}

fn coord(v: i64) -> Result<f32, DecodeError> {
    let lim = (MAX_COORD * COORD_SCALE) as i64;
    if !(-lim..=lim).contains(&v) {
        return Err(DecodeError::Overflow);
    }
    Ok(v as f32 / COORD_SCALE)
}

fn read_header(r: &mut Reader) -> Result<Header, DecodeError> {
    let version = r.u8()?;
    if version != FORMAT_VERSION {
        return Err(DecodeError::UnknownVersion(version));
    }
    let tool = r.u8()?;
    let c = r.bytes(4)?;
    let color = [c[0], c[1], c[2], c[3]];
    let wq = r.uvar()?;
    if wq == 0 || wq > 65_535 {
        return Err(DecodeError::Overflow);
    }
    let zl = r.uvar()?;
    if zl > MAX_Z_LEN as u64 {
        return Err(DecodeError::BadZ);
    }
    let z = core::str::from_utf8(r.bytes(zl as usize)?)
        .map_err(|_| DecodeError::BadZ)?
        .to_string();
    let flags = r.u8()?;
    let mut bb = [0f32; 4];
    for v in &mut bb {
        *v = coord(r.svar()?)?;
    }
    let count = r.uvar()?;
    if count > MAX_POINTS as u64 {
        return Err(DecodeError::TooManyPoints);
    }
    let created = r.uvar()?;
    Ok(Header {
        version,
        tool,
        color,
        width: wq as f32 / WIDTH_SCALE,
        z,
        flags,
        bbox: BBox {
            min_x: bb[0],
            min_y: bb[1],
            max_x: bb[2],
            max_y: bb[3],
        },
        count: count as usize,
        created,
    })
}

/// Just the header (cheap: no points are read).
pub fn decode_header(blob: &[u8]) -> Result<Header, DecodeError> {
    read_header(&mut Reader { b: blob, i: 0 })
}

/// A blob back into a stroke.
pub fn decode(blob: &[u8]) -> Result<Stroke, DecodeError> {
    let mut r = Reader { b: blob, i: 0 };
    let h = read_header(&mut r)?;
    let tilt = h.flags & flags::TILT != 0;
    // Each point takes at least 4 bytes (6 with tilt): refuse counts the blob can't hold before allocating.
    let min = if tilt { 6 } else { 4 };
    if h.count.saturating_mul(min) > r.left() {
        return Err(DecodeError::TooManyPoints);
    }
    let mut points = Vec::with_capacity(h.count);
    let (mut x, mut y, mut t) = (0i64, 0i64, 0u64);
    for _ in 0..h.count {
        x = x.checked_add(r.svar()?).ok_or(DecodeError::Overflow)?;
        y = y.checked_add(r.svar()?).ok_or(DecodeError::Overflow)?;
        let pressure = r.u8()? as f32 / 255.0;
        let (altitude, azimuth) = if tilt {
            (
                r.u8()? as f32 / 255.0 * FRAC_PI_2,
                r.u8()? as f32 / 256.0 * TAU,
            )
        } else {
            (FRAC_PI_2, 0.0)
        };
        t = t.checked_add(r.uvar()?).ok_or(DecodeError::Overflow)?;
        if t > u32::MAX as u64 {
            return Err(DecodeError::Overflow);
        }
        points.push(Point {
            x: coord(x)?,
            y: coord(y)?,
            pressure,
            altitude,
            azimuth,
            t: t as u32,
        });
    }
    if r.left() != 0 {
        return Err(DecodeError::Trailing);
    }
    Ok(Stroke {
        tool: h.tool,
        color: h.color,
        width: h.width,
        z: h.z,
        flags: h.flags,
        created: h.created,
        points,
    })
}

/// The stroke as it reads back after storing (every value quantised the way the blob holds it).
pub fn quantised(s: &Stroke) -> Stroke {
    // encode only writes values decode accepts, so this can't fail.
    decode(&encode(s)).unwrap_or_else(|_| s.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Stroke {
        Stroke {
            tool: tool::PEN,
            color: [10, 20, 30, 255],
            width: 2.5,
            z: "a0".into(),
            flags: flags::PRESSURE | flags::TILT,
            created: 1_763_000_000_000,
            points: (0..20)
                .map(|i| Point {
                    x: 10.0 + i as f32 * 1.3,
                    y: 50.0 - i as f32 * 0.7,
                    pressure: i as f32 / 20.0,
                    altitude: 0.9,
                    azimuth: 2.0,
                    t: i * 4,
                })
                .collect(),
        }
    }

    #[test]
    fn round_trip() {
        let s = sample();
        let b = encode(&s);
        let d = decode(&b).unwrap();
        assert_eq!(d.points.len(), 20);
        assert_eq!(d.z, "a0");
        assert_eq!(d.color, s.color);
        assert_eq!(encode(&d), b);
        for (a, b) in s.points.iter().zip(&d.points) {
            assert!((a.x - b.x).abs() <= 0.0625 && (a.y - b.y).abs() <= 0.0625);
            assert!((a.pressure - b.pressure).abs() <= 0.5 / 255.0 + 1e-6);
            assert_eq!(a.t, b.t);
        }
    }

    #[test]
    fn compact() {
        let b = encode(&Stroke {
            flags: flags::PRESSURE,
            ..sample()
        });
        // 20 points of small moves: 2 + 1 + 1 bytes of x, y, pressure plus 1 of time.
        assert!(b.len() < 30 + 20 * 5, "{} bytes", b.len());
    }

    #[test]
    fn header_alone() {
        let h = decode_header(&encode(&sample())).unwrap();
        assert_eq!(h.count, 20);
        // The ink reaches past the first point by its radius there (pressure 0: 0.35 of half the width).
        assert!(
            (h.bbox.min_x - (10.0 - 2.5 / 2.0 * 0.35)).abs() < 0.2,
            "{:?}",
            h.bbox
        );
        assert!(h.bbox.max_x > 10.0 + 19.0 * 1.3);
    }

    #[test]
    fn rejects() {
        let b = encode(&sample());
        assert_eq!(decode(&[]), Err(DecodeError::Truncated));
        assert_eq!(decode(&[2]), Err(DecodeError::UnknownVersion(2)));
        assert_eq!(decode(&b[..b.len() - 1]), Err(DecodeError::Truncated));
        let mut more = b.clone();
        more.push(0);
        assert_eq!(decode(&more), Err(DecodeError::Trailing));
        // A huge point count with no bytes behind it is refused before allocating.
        let mut big = encode(&Stroke {
            points: vec![],
            ..sample()
        });
        let n = big.len();
        big.truncate(n - 7); // created (6 bytes) + count (1)
        put_uvar(&mut big, MAX_POINTS as u64);
        put_uvar(&mut big, 0);
        assert_eq!(decode(&big), Err(DecodeError::TooManyPoints));
    }

    #[test]
    fn long_z_is_cut_at_a_char_boundary() {
        let z = "é".repeat(200);
        let d = decode(&encode(&Stroke {
            z: z.clone(),
            ..sample()
        }))
        .unwrap();
        assert!(d.z.len() <= MAX_Z_LEN && z.starts_with(&d.z));
    }
}
