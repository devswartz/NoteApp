//! Ink on a live page: read the strokes, add one, erase, move, delete, and hit-test for the
//! lasso, with `nv-ink` doing the geometry and `nv_model::ink` writing the page's `ink` map the
//! way the web does (`src/ink/strokes.ts`, `InkSurface.tsx`). Each call is **one local edit** on
//! the live document, so it goes out through LiveDoc's update observer and the offline queue like
//! typing and box calls do. See docs/rewrite/status/core.md, "For apple: ink".
//!
//! What the web does, and so what this does (the web has no lasso, move or recolour UI yet,
//! PLAN_INK phase I5; those calls here are new and are described as such):
//! - A stroke is built from pen samples by nv-ink's `StrokeBuilder` (a one-euro filter on x and y,
//!   points closer than half a pixel dropped, the last one kept) and stored as a blob (`nv_ink::encode`).
//!   Its z key is `zAfter(topZ(z keys of the strokes on its layer))`; the layer is highlighters
//!   (tool 1) apart from everything else.
//! - The stroke eraser deletes every stroke the eraser's disc (radius 8 on the web) touches along
//!   its track (`hit_path`); the partial eraser cuts them (`erase_split`) and adds the pieces
//!   with **new ids** (strokes are immutable). Both are one transaction (`commitErase`).
//! - Strokes this build can't decode (a newer app's) are not drawn, not hit-tested and never
//!   rewritten; `read` still lists them (`readable: false`, with their bytes).

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use nv_ink::blob::{flags, MAX_POINTS};
use nv_ink::smooth::{OneEuroConfig, StrokeBuilder};
use nv_ink::{decode, decode_header, encode, erase as nv_erase, geom, hit, BBox, Point, Stroke};
use nv_model::ink as model;
use nv_model::yrs::Doc;

use crate::{new_box_id, CoreError, LivePage};

/// The stroke eraser's radius on the web (`ERASER_RADIUS`, page px).
pub const ERASER_RADIUS: f32 = 8.0;
/// The lasso rule the engine's wrapper defaults to (`hitLasso(..., minFraction = 0.5)`): at least
/// half a stroke's points inside the polygon.
pub const LASSO_MIN_FRACTION: f32 = 0.5;

/// Why an ink call failed.
#[derive(Debug, Clone, PartialEq, uniffi::Error)]
pub enum InkError {
    /// A number was NaN or infinite, a radius was not above 0, or a flat list had the wrong length.
    Invalid { message: String },
    /// `close()` was called on the page: edits aren't sent any more, so none are made.
    Closed,
}

impl std::fmt::Display for InkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InkError::Invalid { message } => write!(f, "invalid ink value: {message}"),
            InkError::Closed => write!(f, "the page is closed"),
        }
    }
}
impl std::error::Error for InkError {}

/// A rectangle in page points (the ink's bounds, width included).
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct InkBounds {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
}

/// One stroke of a page. Coordinates are page points from the page origin, the same as boxes.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InkStrokeInfo {
    pub id: String,
    /// This build can decode the whole blob. When false (a newer app's stroke, or damaged bytes)
    /// only `data` is reliable: keep it, don't draw it, don't rewrite it.
    pub readable: bool,
    /// 0 pen, 1 highlighter; other values are a newer app's tool (drawn like a pen).
    pub tool: u8,
    /// 0xRRGGBBAA as stored (a highlighter's alpha is in it).
    pub color: u32,
    /// Base width in points (the width at pressure 0.5).
    pub width: f32,
    /// The fractional-index z key: strokes draw in key order, then id order.
    pub z: String,
    /// Header flags: bit 0 tilt recorded, bit 1 pressure came from the device. Unknown bits kept.
    pub flags: u8,
    /// Creation time, ms since the Unix epoch.
    pub created_ms: u64,
    pub point_count: u32,
    /// The ink including its width (what to cull and hit-test against); `None` for no points.
    pub bounds: Option<InkBounds>,
    /// The stored points, flat, six values each: x, y, pressure (0...1), altitude, azimuth (radians),
    /// t (ms since the stroke began). Empty when not `readable`.
    pub points: Vec<f32>,
    /// The stored blob, exactly as in the page's `ink` map.
    pub data: Vec<u8>,
}

/// What an erase did.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InkEraseResult {
    /// Strokes deleted (hit whole, or cut).
    pub removed: Vec<String>,
    /// The pieces the partial eraser left, new ids.
    pub added: Vec<String>,
}

/// A stroke that moved: strokes are immutable, so a move is a delete and an add with a new id.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InkMovedStroke {
    pub old_id: String,
    pub new_id: String,
}

// ---------------------------------------------------------------- pure logic (no page, no socket)

const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/// The first z key (`FIRST_Z`).
pub const FIRST_Z: &str = "a0";

/// `zAfter`: a key after `z` in string order (`FIRST_Z` after nothing), the web's fractional index.
pub fn z_after(z: Option<&str>) -> String {
    let Some(z) = z.filter(|z| !z.is_empty()) else {
        return FIRST_Z.to_string();
    };
    let chars: Vec<char> = z.chars().collect();
    let head = chars[0] as u32;
    let len = head.wrapping_sub(0x61) as usize + 1;
    let ours = (0x61..=0x7a).contains(&head)
        && z.encode_utf16().count() == len + 1
        && chars[1..]
            .iter()
            .all(|c| c.is_ascii() && DIGITS.contains(&(*c as u8)));
    if !ours {
        return format!("{z}V");
    }
    let mut digits: Vec<u8> = chars[1..].iter().map(|c| *c as u8).collect();
    for i in (0..digits.len()).rev() {
        let d = DIGITS.iter().position(|&c| c == digits[i]).unwrap();
        if d < DIGITS.len() - 1 {
            digits[i] = DIGITS[d + 1];
            return format!("{}{}", chars[0], String::from_utf8(digits).unwrap());
        }
        digits[i] = b'0';
    }
    if head == 0x7a {
        return format!("{z}V");
    }
    format!("{}1{}", char::from_u32(head + 1).unwrap(), "0".repeat(len))
}

/// `topZ`: the highest key (JS string order), if any.
pub fn top_z<'a>(keys: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    keys.fold(None, |top: Option<&str>, k| match top {
        Some(t) if nv_model::js::cmp_str(k, t).is_le() => Some(t),
        _ => Some(k),
    })
}

/// A new stroke id: 12 base-36 characters from 6 random bytes (`newStrokeId`).
pub fn new_stroke_id() -> String {
    new_box_id()[..12].to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn is_highlighter(tool: u8) -> bool {
    tool == nv_ink::blob::tool::HIGHLIGHTER
}

/// A stroke of the page, with its decoded form when this build can read it.
struct Entry {
    id: String,
    data: Vec<u8>,
    stroke: Option<Stroke>,
}

fn entries(doc: &Doc) -> Vec<Entry> {
    model::ink_blobs(doc)
        .into_iter()
        .map(|(id, data)| Entry {
            stroke: decode(&data).ok(),
            id,
            data,
        })
        .collect()
}

fn bounds_of(b: &BBox) -> Option<InkBounds> {
    (!b.is_empty()).then_some(InkBounds {
        min_x: b.min_x,
        min_y: b.min_y,
        max_x: b.max_x,
        max_y: b.max_y,
    })
}

fn info_of(e: &Entry) -> InkStrokeInfo {
    let header = decode_header(&e.data).ok();
    let bbox = header.as_ref().map_or(BBox::EMPTY, nv_ink::ink_bounds);
    match &e.stroke {
        Some(s) => InkStrokeInfo {
            id: e.id.clone(),
            readable: true,
            tool: s.tool,
            color: u32::from_be_bytes(s.color),
            width: s.width,
            z: s.z.clone(),
            flags: s.flags,
            created_ms: s.created,
            point_count: s.points.len() as u32,
            bounds: bounds_of(&bbox),
            points: s
                .points
                .iter()
                .flat_map(|p| [p.x, p.y, p.pressure, p.altitude, p.azimuth, p.t as f32])
                .collect(),
            data: e.data.clone(),
        },
        None => InkStrokeInfo {
            id: e.id.clone(),
            readable: false,
            tool: header.as_ref().map_or(0, |h| h.tool),
            color: header.as_ref().map_or(0, |h| u32::from_be_bytes(h.color)),
            width: header.as_ref().map_or(0.0, |h| h.width),
            z: header.as_ref().map(|h| h.z.clone()).unwrap_or_default(),
            flags: header.as_ref().map_or(0, |h| h.flags),
            created_ms: header.as_ref().map_or(0, |h| h.created),
            point_count: 0,
            bounds: None,
            points: Vec::new(),
            data: e.data.clone(),
        },
    }
}

/// The page's strokes, in drawing order (z key, then id), unreadable ones included.
pub fn read_strokes(doc: &Doc) -> Vec<InkStrokeInfo> {
    let mut v: Vec<InkStrokeInfo> = entries(doc).iter().map(info_of).collect();
    v.sort_by(|a, b| {
        nv_model::js::cmp_str(&a.z, &b.z).then_with(|| nv_model::js::cmp_str(&a.id, &b.id))
    });
    v
}

/// The z key for a new stroke of `tool`: after the highest key on its layer.
pub fn next_z(doc: &Doc, tool: u8) -> String {
    let es = entries(doc);
    let top = top_z(
        es.iter()
            .filter_map(|e| e.stroke.as_ref())
            .filter(|s| is_highlighter(s.tool) == is_highlighter(tool))
            .map(|s| s.z.as_str()),
    );
    z_after(top)
}

/// What a new stroke is made with.
#[derive(Debug, Clone, Copy)]
pub struct StrokeStyle {
    pub tool: u8,
    pub color: u32,
    pub width: f32,
    /// The device gives pressure (a pen); a mouse has a constant 0.5.
    pub pressure: bool,
    /// The device gives tilt.
    pub tilt: bool,
}

impl StrokeStyle {
    fn flags(&self) -> u8 {
        (if self.pressure { flags::PRESSURE } else { 0 })
            | (if self.tilt { flags::TILT } else { 0 })
    }
    fn builder(&self) -> StrokeBuilder {
        StrokeBuilder::new(
            self.tool,
            self.color.to_be_bytes(),
            self.width,
            String::new(),
            self.flags(),
            0,
            OneEuroConfig::default(),
        )
    }
}

/// Run raw pen samples (flat: x, y, pressure, altitude, azimuth, t in ms; any clock that only
/// runs forwards) through the capture smoothing. `None` when they leave no points.
pub fn smooth_samples(style: &StrokeStyle, samples: &[f64]) -> Result<Option<Stroke>, InkError> {
    let mut b = style.builder();
    push_samples(&mut b, samples)?;
    Ok(finish_builder(b))
}

fn push_samples(b: &mut StrokeBuilder, samples: &[f64]) -> Result<(), InkError> {
    if samples.len() % 6 != 0 {
        return Err(InkError::Invalid {
            message: "samples must be six numbers each: x, y, pressure, altitude, azimuth, t"
                .into(),
        });
    }
    for c in samples.chunks_exact(6) {
        b.push(
            c[0] as f32,
            c[1] as f32,
            c[2] as f32,
            c[3] as f32,
            c[4] as f32,
            c[5],
        );
    }
    Ok(())
}

fn finish_builder(b: StrokeBuilder) -> Option<Stroke> {
    let s = b.finish();
    (!s.points.is_empty()).then_some(s)
}

/// Add a finished stroke under `id` with `created` and the next z of its layer; returns the blob
/// written. One transaction.
pub fn add_stroke(doc: &Doc, mut stroke: Stroke, id: &str, created: u64) -> Vec<u8> {
    stroke.points.truncate(MAX_POINTS);
    stroke.z = next_z(doc, stroke.tool);
    stroke.created = created;
    let blob = encode(&stroke);
    model::commit_ink(doc, &[], &[(id.to_string(), blob.clone())]);
    blob
}

fn pairs(flat: &[f32], what: &str) -> Result<Vec<[f32; 2]>, InkError> {
    if flat.len() % 2 != 0 || flat.iter().any(|v| !v.is_finite()) {
        return Err(InkError::Invalid {
            message: format!("{what} must be finite x, y pairs"),
        });
    }
    Ok(flat.chunks_exact(2).map(|c| [c[0], c[1]]).collect())
}

fn radius_ok(r: f32) -> Result<f32, InkError> {
    if r.is_finite() && r > 0.0 {
        Ok(r)
    } else {
        Err(InkError::Invalid {
            message: "the radius must be above 0".into(),
        })
    }
}

fn track_box(track: &[[f32; 2]], by: f32) -> BBox {
    let mut b = BBox::EMPTY;
    track.iter().for_each(|p| b.add(p[0], p[1]));
    b.inflate(by)
}

fn ink_box(e: &Entry) -> BBox {
    decode_header(&e.data)
        .ok()
        .map_or(BBox::EMPTY, |h| nv_ink::ink_bounds(&h))
}

/// The stroke eraser's rule: ids of the readable strokes a disc of radius `r` dragged along
/// `track` touches.
pub fn hit_path_ids(doc: &Doc, track: &[[f32; 2]], r: f32) -> Vec<String> {
    let reach = track_box(track, r);
    entries(doc)
        .into_iter()
        .filter(|e| ink_box(e).intersects(&reach))
        .filter_map(|e| {
            let s = e.stroke.as_ref()?;
            hit::hit_path(&geom::samples(s), track, r).then(|| e.id.clone())
        })
        .collect()
}

/// Ids of the readable strokes a disc of radius `r` at (x, y) touches (a tap, a hover).
pub fn hit_point_ids(doc: &Doc, x: f32, y: f32, r: f32) -> Vec<String> {
    entries(doc)
        .into_iter()
        .filter_map(|e| {
            let s = e.stroke.as_ref()?;
            hit::hit_point(&geom::samples(s), x, y, r).then(|| e.id.clone())
        })
        .collect()
}

/// The lasso rule: ids of the readable strokes with at least `min_fraction` of their points
/// inside the polygon (and at least one), `hit_lasso` of the engine.
pub fn hit_lasso_ids(doc: &Doc, poly: &[[f32; 2]], min_fraction: f32) -> Vec<String> {
    entries(doc)
        .into_iter()
        .filter_map(|e| {
            let s = e.stroke.as_ref()?;
            hit::hit_lasso(&s.points, poly, min_fraction).then(|| e.id.clone())
        })
        .collect()
}

/// One erase gesture, in one transaction: with `partial` every touched stroke is cut and its
/// pieces added (new ids from `new_id`); otherwise every touched stroke goes.
pub fn erase(
    doc: &Doc,
    track: &[[f32; 2]],
    r: f32,
    partial: bool,
    new_id: &mut dyn FnMut() -> String,
) -> InkEraseResult {
    let reach = track_box(track, r);
    let mut removed = Vec::new();
    let mut added = Vec::new();
    for e in entries(doc) {
        let Some(s) = &e.stroke else { continue };
        if !ink_box(&e).intersects(&reach) {
            continue;
        }
        if partial {
            if let Some(pieces) = nv_erase::erase_split(s, track, r) {
                removed.push(e.id.clone());
                added.extend(pieces.iter().map(|p| (new_id(), encode(p))));
            }
        } else if hit::hit_path(&geom::samples(s), track, r) {
            removed.push(e.id.clone());
        }
    }
    let gone = model::commit_ink(doc, &removed, &added);
    InkEraseResult {
        removed: gone,
        added: added.into_iter().map(|(id, _)| id).collect(),
    }
}

/// Move strokes by (`dx`, `dy`): each readable one is deleted and added again shifted, with a new
/// id and the same z key, in one transaction. Missing and unreadable strokes are skipped.
pub fn translate(
    doc: &Doc,
    ids: &[String],
    dx: f32,
    dy: f32,
    new_id: &mut dyn FnMut() -> String,
) -> Vec<InkMovedStroke> {
    let all = entries(doc);
    let mut removed: Vec<String> = Vec::new();
    let mut added = Vec::new();
    let mut moved = Vec::new();
    for id in ids {
        if removed.contains(id) {
            continue;
        }
        let Some(s) = all
            .iter()
            .find(|e| &e.id == id)
            .and_then(|e| e.stroke.as_ref())
        else {
            continue;
        };
        let shifted = Stroke {
            points: s
                .points
                .iter()
                .map(|p| Point {
                    x: p.x + dx,
                    y: p.y + dy,
                    ..*p
                })
                .collect(),
            ..s.clone()
        };
        let nid = new_id();
        removed.push(id.clone());
        added.push((nid.clone(), encode(&shifted)));
        moved.push(InkMovedStroke {
            old_id: id.clone(),
            new_id: nid,
        });
    }
    model::commit_ink(doc, &removed, &added);
    moved
}

/// Delete strokes by id (ones that are gone already are skipped); returns the ids deleted.
/// Unreadable strokes can be deleted too: that is the user's choice.
pub fn delete(doc: &Doc, ids: &[String]) -> Vec<String> {
    model::commit_ink(doc, ids, &[])
}

fn outline_of(data: &[u8]) -> Option<Vec<geom::Piece>> {
    let s = decode(data).ok()?;
    Some(geom::pieces(&geom::samples(&s)))
}

// ---------------------------------------------------------------- the API

/// A stroke being drawn: feed it the pen's samples as they come, draw `preview` under the pen,
/// and give it to `LivePage::add_ink_stroke` when the pen lifts (or just drop it to cancel).
/// It does the web's capture smoothing (a one-euro filter, close points dropped).
#[derive(uniffi::Object)]
pub struct InkStrokeBuilder {
    inner: Mutex<Option<StrokeBuilder>>,
}

#[uniffi::export]
impl InkStrokeBuilder {
    /// `color` is 0xRRGGBBAA; `width` the base width in points (pen 1.5, 2.5, 4; highlighter 12,
    /// 18, 26 on the web); `pressure` and `tilt` say what the device gives (Apple Pencil: both;
    /// a finger or mouse: neither, and the stroke has an even pressure).
    #[uniffi::constructor]
    pub fn new(tool: u8, color: u32, width: f32, pressure: bool, tilt: bool) -> Arc<Self> {
        let style = StrokeStyle {
            tool,
            color,
            width,
            pressure,
            tilt,
        };
        Arc::new(InkStrokeBuilder {
            inner: Mutex::new(Some(style.builder())),
        })
    }

    /// One sample: x, y in page points; pressure 0...1; altitude and azimuth in radians
    /// (pi/2 and 0 without tilt); time in ms on any clock that only runs forwards.
    pub fn push(&self, x: f32, y: f32, pressure: f32, altitude: f32, azimuth: f32, t_ms: f64) {
        if let Some(b) = self.inner.lock().unwrap().as_mut() {
            b.push(x, y, pressure, altitude, azimuth, t_ms);
        }
    }

    /// Many samples at once (coalesced touches), flat, six numbers each as `push` takes them.
    pub fn push_many(&self, samples: Vec<f64>) -> Result<(), InkError> {
        match self.inner.lock().unwrap().as_mut() {
            Some(b) => push_samples(b, &samples),
            None => Ok(()),
        }
    }

    /// How many points are kept so far.
    pub fn point_count(&self) -> u32 {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .map_or(0, |b| b.stroke.points.len() as u32)
    }

    /// The outline to draw now (path commands, see `ink_outline_ops`) of the stroke so far plus
    /// `predicted` samples (flat x, y, pressure), which are not kept.
    pub fn preview(&self, predicted: Vec<f32>) -> Vec<f32> {
        let guard = self.inner.lock().unwrap();
        let Some(b) = guard.as_ref() else {
            return Vec::new();
        };
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
}

/// The path commands of a stroke's outline, flat: `0 x y` move, `1 x y` line, `2 cx cy r` a whole
/// circle (a round end or joint), `3` close. Fill all of it with the nonzero rule: overlaps are
/// painted once, which keeps a translucent highlighter even. Empty for a blob that isn't readable.
#[uniffi::export]
pub fn ink_outline_ops(data: Vec<u8>) -> Vec<f32> {
    outline_of(&data).map_or_else(Vec::new, |p| geom::path_ops(&p))
}

/// The outline as an SVG path `d` (fill-rule nonzero); empty when the blob isn't readable.
#[uniffi::export]
pub fn ink_outline_svg(data: Vec<u8>) -> String {
    outline_of(&data).map_or_else(String::new, |p| geom::svg_path(&p))
}

/// The outline as triangles, flat x, y per vertex (three vertices each), for a GPU.
#[uniffi::export]
pub fn ink_outline_triangles(data: Vec<u8>) -> Vec<f32> {
    outline_of(&data).map_or_else(Vec::new, |p| geom::triangles(&p))
}

/// The strokes of a page document (a Yjs update), in drawing order.
#[uniffi::export]
pub fn read_ink(document: Vec<u8>) -> Result<Vec<InkStrokeInfo>, CoreError> {
    let doc = nv_model::doc_from_update(&document)?;
    Ok(read_strokes(&doc))
}

impl LivePage {
    fn ink_edit<R>(&self, f: impl FnOnce(&Doc) -> Result<R, InkError>) -> Result<R, InkError> {
        if self.is_closed() {
            return Err(InkError::Closed);
        }
        f(self.doc())
    }

    fn add_finished(&self, stroke: Option<Stroke>) -> Result<Option<InkStrokeInfo>, InkError> {
        self.ink_edit(|doc| {
            let Some(stroke) = stroke else {
                return Ok(None);
            };
            let id = new_stroke_id();
            add_stroke(doc, stroke, &id, now_ms());
            Ok(info_for(doc, &id))
        })
    }
}

fn info_for(doc: &Doc, id: &str) -> Option<InkStrokeInfo> {
    model::ink_blob(doc, id).map(|data| {
        info_of(&Entry {
            stroke: decode(&data).ok(),
            id: id.to_string(),
            data,
        })
    })
}

#[uniffi::export]
impl LivePage {
    /// The page's strokes in drawing order (z key, then id), with their points. Strokes made by a
    /// newer app that this build can't read are listed too, `readable: false`: keep them.
    pub fn ink_strokes(&self) -> Vec<InkStrokeInfo> {
        read_strokes(self.doc())
    }

    /// One stroke's outline as path commands (see `ink_outline_ops`); empty when it isn't there.
    pub fn ink_outline(&self, id: String) -> Vec<f32> {
        model::ink_blob(self.doc(), &id).map_or_else(Vec::new, ink_outline_ops)
    }

    /// Add the stroke a builder has made, when the pen lifts: one edit, the web's way (the z key
    /// after the highest on its layer, a new id, the time now). `None` when the builder has no
    /// points (nothing is written). Call it **once per stroke**, not per point.
    pub fn add_ink_stroke(
        &self,
        builder: Arc<InkStrokeBuilder>,
    ) -> Result<Option<InkStrokeInfo>, InkError> {
        let finished = builder
            .inner
            .lock()
            .unwrap()
            .take()
            .and_then(finish_builder);
        self.add_finished(finished)
    }

    /// `add_ink_stroke` from raw samples in one go (flat: x, y, pressure, altitude, azimuth, t ms;
    /// six numbers each), for a stroke that was captured without a builder.
    pub fn add_ink_stroke_from_samples(
        &self,
        tool: u8,
        color: u32,
        width: f32,
        pressure: bool,
        tilt: bool,
        samples: Vec<f64>,
    ) -> Result<Option<InkStrokeInfo>, InkError> {
        let style = StrokeStyle {
            tool,
            color,
            width,
            pressure,
            tilt,
        };
        let finished = smooth_samples(&style, &samples)?;
        self.add_finished(finished)
    }

    /// The eraser: delete every stroke a disc of `radius` (the web uses 8) touches while it is
    /// dragged along `track` (flat x, y; one pair is a tap). With `partial` the strokes are cut
    /// and what is left is added as new strokes; otherwise whole strokes go. One edit; call it
    /// when the gesture ends (or per move, each call is an edit of its own).
    pub fn erase_ink(
        &self,
        track: Vec<f32>,
        radius: f32,
        partial: bool,
    ) -> Result<InkEraseResult, InkError> {
        let track = pairs(&track, "the eraser track")?;
        let r = radius_ok(radius)?;
        self.ink_edit(|doc| Ok(erase(doc, &track, r, partial, &mut new_stroke_id)))
    }

    /// Move strokes by (`dx`, `dy`) points. They get **new ids** (returned with the old ones) and
    /// keep their z. Strokes that are gone or not readable are skipped. One edit.
    pub fn move_ink_strokes(
        &self,
        ids: Vec<String>,
        dx: f32,
        dy: f32,
    ) -> Result<Vec<InkMovedStroke>, InkError> {
        if !dx.is_finite() || !dy.is_finite() {
            return Err(InkError::Invalid {
                message: "the offset is not a number".into(),
            });
        }
        self.ink_edit(|doc| Ok(translate(doc, &ids, dx, dy, &mut new_stroke_id)))
    }

    /// Delete strokes by id; returns the ids that were there. One edit.
    pub fn delete_ink_strokes(&self, ids: Vec<String>) -> Result<Vec<String>, InkError> {
        self.ink_edit(|doc| Ok(delete(doc, &ids)))
    }

    /// The lasso: ids of the strokes with at least `min_fraction` (the web's engine uses 0.5, at
    /// least one point) of their points inside the polygon (flat x, y, even-odd rule).
    pub fn ink_hit_lasso(
        &self,
        polygon: Vec<f32>,
        min_fraction: f32,
    ) -> Result<Vec<String>, InkError> {
        let poly = pairs(&polygon, "the lasso")?;
        if !min_fraction.is_finite() {
            return Err(InkError::Invalid {
                message: "min_fraction is not a number".into(),
            });
        }
        Ok(hit_lasso_ids(self.doc(), &poly, min_fraction))
    }

    /// What the stroke eraser would delete: ids of the strokes a disc of `radius` touches along
    /// `track` (flat x, y). Read only, for showing the strokes about to go.
    pub fn ink_hit_path(&self, track: Vec<f32>, radius: f32) -> Result<Vec<String>, InkError> {
        let track = pairs(&track, "the track")?;
        Ok(hit_path_ids(self.doc(), &track, radius_ok(radius)?))
    }

    /// Ids of the strokes a disc of `radius` at (x, y) touches (a tap to select one). Read only.
    pub fn ink_hit_point(&self, x: f32, y: f32, radius: f32) -> Result<Vec<String>, InkError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(InkError::Invalid {
                message: "the point is not a number".into(),
            });
        }
        Ok(hit_point_ids(self.doc(), x, y, radius_ok(radius)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn z_keys_follow_the_webs_za_after() {
        // Values from `zAfter` in src/ink/strokes.ts.
        for (from, to) in [
            (None, "a0"),
            (Some("a0"), "a1"),
            (Some("a9"), "aA"),
            (Some("aA"), "aB"),
            (Some("az"), "b10"),
            (Some("b10"), "b11"),
            (Some("bzz"), "c100"),
            (
                Some("zzzzzzzzzzzzzzzzzzzzzzzzzz"),
                "zzzzzzzzzzzzzzzzzzzzzzzzzzV",
            ),
            (Some("a"), "aV"),
            (Some("X1"), "X1V"),
            (Some("a0V"), "a0VV"),
            (Some("\u{e9}"), "\u{e9}V"),
        ] {
            assert_eq!(z_after(from), to, "after {from:?}");
            if let Some(f) = from {
                assert!(nv_model::js::cmp_str(f, to).is_lt());
            }
        }
        assert_eq!(top_z(["a1", "a0", "b10", "a9"].into_iter()), Some("b10"));
        assert_eq!(top_z(std::iter::empty()), None);
    }

    #[test]
    fn stroke_ids_look_like_the_webs() {
        let id = new_stroke_id();
        assert_eq!(id.len(), 12);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()));
        assert_ne!(id, new_stroke_id());
    }
}
