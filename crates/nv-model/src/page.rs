//! Where a page's content lives in its Y.Doc (shared/pageDoc.ts, docs/PLAN_CANVAS.md):
//!   document pages: one fragment, `default`;
//!   canvas pages:   `boxes` (map: box id → map { x, y, w, z, wide? }) and one fragment per box, `box:<id>`;
//!   every page:     `pageSettings` (colour, rule lines), `ink` (stroke id → bytes) and
//!                   `pageFormat` ({ version }, written only when a format change needs it).

use std::cmp::Ordering;

use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, Map, OffsetKind, Options, Out, ReadTxn, Transact, Update};

use crate::js;
use crate::tree::{self, Node};

pub const DEFAULT_FIELD: &str = "default";
pub const BOXES_KEY: &str = "boxes";
pub const BOX_PREFIX: &str = "box:";
pub const PAGE_SETTINGS_KEY: &str = "pageSettings";
pub const INK_KEY: &str = "ink";
pub const PAGE_FORMAT_KEY: &str = "pageFormat";
/// 2: reserves `ink` (PLAN_INK).
pub const PAGE_FORMAT_VERSION: u32 = 2;
/// The largest stroke blob accepted (bytes).
pub const MAX_STROKE_BYTES: usize = 512 * 1024;

pub const PAGE_COLORS: [&str; 7] = ["none", "yellow", "green", "blue", "purple", "pink", "grey"];
pub const RULE_LINES: [&str; 3] = ["none", "lines", "grid"];

pub fn box_field(id: &str) -> String {
    format!("{BOX_PREFIX}{id}")
}

#[derive(Debug, Clone, PartialEq)]
pub struct BoxGeom {
    pub id: String,
    pub x: f64,
    pub y: f64,
    /// Width in page pixels; the height follows the content.
    pub w: f64,
    /// Stacking order: higher is in front.
    pub z: f64,
    /// The page's main text box, drawn across the page's full width.
    pub wide: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSettings {
    pub color: String,
    pub rules: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Canvas,
    Document,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InkStroke {
    pub id: String,
    pub data: Vec<u8>,
}

/// A content fragment: its root name and nodes.
#[derive(Debug, Clone, PartialEq)]
pub struct Fragment {
    pub name: String,
    /// The box id, or `None` for `default`.
    pub box_id: Option<String>,
    pub nodes: Vec<Node>,
}

#[derive(Debug)]
pub enum Error {
    Decode(String),
    Apply(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Decode(e) => write!(f, "not a Yjs update: {e}"),
            Error::Apply(e) => write!(f, "update could not be applied: {e}"),
        }
    }
}
impl std::error::Error for Error {}

/// A new Y.Doc that counts text positions the way Yjs in JS does (UTF-16).
pub fn new_doc() -> Doc {
    Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

/// A Y.Doc from a stored page (`Y.encodeStateAsUpdate`).
pub fn doc_from_update(update: &[u8]) -> Result<Doc, Error> {
    let doc = new_doc();
    let u = Update::decode_v1(update).map_err(|e| Error::Decode(e.to_string()))?;
    doc.transact_mut()
        .apply_update(u)
        .map_err(|e| Error::Apply(e.to_string()))?;
    Ok(doc)
}

fn finite(v: Option<&Any>, fallback: f64) -> f64 {
    js::as_number(v)
        .filter(|f| f.is_finite())
        .unwrap_or(fallback)
}

/// The boxes of a canvas page with their geometry (unknown or broken values defaulted), in map order.
pub fn box_geoms<T: ReadTxn>(txn: &T) -> Vec<BoxGeom> {
    let Some(boxes) = txn.get_map(BOXES_KEY) else {
        return Vec::new();
    };
    boxes
        .iter(txn)
        .map(|(id, v)| {
            // A Y.Map, or a plain object; anything else has no fields.
            let fields: Option<Any> = match &v {
                Out::YMap(m) => Some(m.to_json(txn)),
                Out::Any(a @ Any::Map(_)) => Some(a.clone()),
                _ => None,
            };
            let get = |k: &str| js::field(fields.as_ref(), k);
            BoxGeom {
                id: id.to_string(),
                x: finite(get("x"), 0.0),
                y: finite(get("y"), 0.0),
                w: finite(get("w"), 400.0),
                z: finite(get("z"), 0.0),
                wide: matches!(get("wide"), Some(Any::Bool(true))),
            }
        })
        .collect()
}

/// Reading order: top to bottom, then left to right (the id breaks exact ties).
pub fn reading_order(mut boxes: Vec<BoxGeom>) -> Vec<BoxGeom> {
    boxes.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap_or(Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(Ordering::Equal))
            .then_with(|| js::cmp_str(&a.id, &b.id))
    });
    boxes
}

/// The page's settings (defaults where unset or invalid).
pub fn page_settings<T: ReadTxn>(txn: &T) -> PageSettings {
    let map = txn.get_map(PAGE_SETTINGS_KEY);
    let pick = |k: &str, list: &[&str]| -> String {
        let v = map.as_ref().and_then(|m| m.get(txn, k));
        match v {
            Some(Out::Any(Any::String(s))) if list.contains(&&*s) => s.to_string(),
            _ => "none".into(),
        }
    };
    PageSettings {
        color: pick("color", &PAGE_COLORS),
        rules: pick("rules", &RULE_LINES),
    }
}

/// The format version stored in a page (1 when none is).
pub fn format_version<T: ReadTxn>(txn: &T) -> f64 {
    let v = txn
        .get_map(PAGE_FORMAT_KEY)
        .and_then(|m| m.get(txn, "version"));
    match v {
        Some(Out::Any(Any::Number(n))) => {
            let f = js::number(&n);
            if f.is_finite() && f == f.trunc() && f >= 1.0 {
                f
            } else {
                1.0
            }
        }
        _ => 1.0,
    }
}

/// Whether a value can be an ink entry: a byte blob of a sane size.
pub fn is_stroke_value(v: &Out) -> bool {
    matches!(v, Out::Any(Any::Buffer(b)) if !b.is_empty() && b.len() <= MAX_STROKE_BYTES)
}

/// The page's strokes (values that aren't stroke blobs are skipped), by id.
pub fn page_ink<T: ReadTxn>(txn: &T) -> Vec<InkStroke> {
    let Some(ink) = txn.get_map(INK_KEY) else {
        return Vec::new();
    };
    let mut out: Vec<InkStroke> = ink
        .iter(txn)
        .filter_map(|(id, v)| match v {
            Out::Any(Any::Buffer(ref b)) if is_stroke_value(&v) => Some(InkStroke {
                id: id.to_string(),
                data: b.to_vec(),
            }),
            _ => None,
        })
        .collect();
    out.sort_by(|a, b| js::cmp_str(&a.id, &b.id));
    out
}

/// A loaded page, read into owned values: everything the page-format readers need.
#[derive(Debug, Clone)]
pub struct Page {
    /// `boxGeoms` in map order.
    pub boxes: Vec<BoxGeom>,
    /// Every content fragment in reading order: `default` first, then the boxes.
    pub fragments: Vec<Fragment>,
    pub settings: PageSettings,
    pub format_version: f64,
    pub ink: Vec<InkStroke>,
    /// Whether `boxes` has any entry (geometry or not): `docKind`.
    has_box_entries: bool,
}

impl Page {
    pub fn from_update(update: &[u8]) -> Result<Page, Error> {
        Ok(Page::read(&doc_from_update(update)?))
    }

    pub fn read(doc: &Doc) -> Page {
        let txn = doc.transact();
        let boxes = box_geoms(&txn);
        let mut fragments = vec![Fragment {
            name: DEFAULT_FIELD.into(),
            box_id: None,
            nodes: tree::read_fragment(&txn, DEFAULT_FIELD),
        }];
        for b in reading_order(boxes.clone()) {
            let name = box_field(&b.id);
            fragments.push(Fragment {
                nodes: tree::read_fragment(&txn, &name),
                name,
                box_id: Some(b.id),
            });
        }
        Page {
            has_box_entries: txn.get_map(BOXES_KEY).is_some_and(|m| m.len(&txn) > 0),
            boxes,
            fragments,
            settings: page_settings(&txn),
            format_version: format_version(&txn),
            ink: page_ink(&txn),
        }
    }

    /// The layout the content is in: canvas if it has boxes, else document.
    pub fn kind(&self) -> DocKind {
        if self.has_box_entries {
            DocKind::Canvas
        } else {
            DocKind::Document
        }
    }

    pub fn reading_order(&self) -> Vec<BoxGeom> {
        reading_order(self.boxes.clone())
    }

    /// The fragment holding the page's main text: its first box in reading order (`default` without boxes).
    pub fn main_fragment(&self) -> &Fragment {
        self.fragments.get(1).unwrap_or(&self.fragments[0])
    }

    /// Was the page written by a newer app, in a format this one doesn't fully understand?
    pub fn is_newer_format(&self) -> bool {
        self.format_version > f64::from(PAGE_FORMAT_VERSION)
    }

    pub fn has_ink(&self) -> bool {
        !self.ink.is_empty()
    }
}
