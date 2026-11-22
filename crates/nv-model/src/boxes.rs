//! Writing a canvas page's boxes (docs/PLAN_CANVAS.md), the way today's web app does, so a
//! box made here looks to the web like one the web made, and the other way round.
//!
//! What the web writes (`src/editor/CanvasEditor.tsx` `createBox`/`setGeom`/`removeBox`,
//! `shared/pageDoc.ts` `newBoxMap`, `src/editor/canvasGeom.ts`):
//! - A box is a **nested Y.Map** in the `boxes` map, under its id: `x`, `y`, `w`, `z` as numbers
//!   and `wide: true` only when set (never `false`). Moving or resizing sets those keys on that
//!   map (only when the value differs); resizing deletes `wide`.
//! - A new box has **no content**: its `box:<id>` fragment is empty (no nodes) until an editor
//!   opens it, and the editor adds the empty paragraph then (`nv_editor` does the same).
//! - Ids are 16 base-36 characters: 8 random bytes, each as two characters
//!   (`newBoxId` in `src/editor/canvasGeom.ts`).
//! - Positions are whole numbers 0..=20000, widths whole numbers 120..=2400 (`clampPos`,
//!   `clampWidth`); "in front" is one above the highest z, and a box already alone on top stays
//!   (`frontZ`).
//! - Deleting removes the `boxes` entry and empties the fragment, in one transaction.
//!
//! Every call is one transaction with no origin: a local edit, which a live page sends.

use yrs::types::map::MapRef;
use yrs::{Any, Doc, Map, MapPrelim, Out, Transact, TransactionMut, WriteTxn, XmlFragment};

use crate::js;
use crate::page::{box_field, box_geoms, BoxGeom, BOXES_KEY};
use crate::tree::{Insert, Node};

pub const BOX_MIN_W: f64 = 120.0;
pub const BOX_MAX_W: f64 = 2400.0;
pub const MAX_COORD: f64 = 20_000.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoxError {
    /// The page has no box with this id.
    NoSuchBox(String),
    /// A box with this id is already there.
    Exists(String),
    /// A number was NaN or infinite, or the id was empty or has a `:` or space.
    Invalid(String),
    /// The box holds something (`delete_box` only removes empty boxes).
    NotEmpty(String),
}

impl std::fmt::Display for BoxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BoxError::NoSuchBox(id) => write!(f, "no box {id:?} on this page"),
            BoxError::Exists(id) => write!(f, "box {id:?} already exists"),
            BoxError::Invalid(m) => write!(f, "invalid box value: {m}"),
            BoxError::NotEmpty(id) => write!(f, "box {id:?} is not empty"),
        }
    }
}
impl std::error::Error for BoxError {}

/// A box id from 8 random bytes, as `newBoxId` makes it: each byte in base 36, two characters
/// (`n.toString(36).padStart(2, '0').slice(-2)`).
pub fn box_id_from(random: [u8; 8]) -> String {
    random
        .iter()
        .map(|&n| {
            let digit = |d: u8| char::from_digit(u32::from(d), 36).unwrap();
            let (hi, lo) = (n / 36, n % 36);
            if hi == 0 {
                format!("0{}", digit(lo))
            } else {
                format!("{}{}", digit(hi), digit(lo))
            }
        })
        .collect()
}

/// `Math.round`: halves go up.
fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

fn finite(v: f64, what: &str) -> Result<f64, BoxError> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(BoxError::Invalid(format!("{what} is not a number")))
    }
}

/// `clampPos`: whole pixels, 0..=20000.
pub fn clamp_pos(v: f64) -> f64 {
    round(v.clamp(0.0, MAX_COORD))
}

/// `clampWidth`: whole pixels, 120..=2400.
pub fn clamp_width(w: f64) -> f64 {
    round(w.clamp(BOX_MIN_W, BOX_MAX_W))
}

fn check_id(id: &str) -> Result<(), BoxError> {
    if id.is_empty() || id.contains(|c: char| c == ':' || c.is_whitespace()) {
        return Err(BoxError::Invalid(format!("bad box id {id:?}")));
    }
    Ok(())
}

fn geometry(g: &BoxGeom) -> MapPrelim {
    let mut fields = vec![
        ("x", Any::from(g.x)),
        ("y", Any::from(g.y)),
        ("w", Any::from(g.w)),
        ("z", Any::from(g.z)),
    ];
    if g.wide {
        fields.push(("wide", Any::Bool(true)));
    }
    MapPrelim::from_iter(fields.into_iter().map(|(k, v)| (k.to_string(), v)))
}

/// The box's geometry map, made a Y.Map first if it was written as a plain object.
fn geometry_map(txn: &mut TransactionMut, id: &str) -> Result<MapRef, BoxError> {
    let boxes = txn.get_or_insert_map(BOXES_KEY);
    match boxes.get(txn, id) {
        Some(Out::YMap(m)) => Ok(m),
        Some(Out::Any(Any::Map(_))) => {
            // The web's `setGeom` leaves these alone; a native edit keeps the geometry it read.
            let g = box_geoms(txn).into_iter().find(|b| b.id == id).unwrap();
            Ok(boxes.insert(txn, id, geometry(&g)))
        }
        _ => Err(BoxError::NoSuchBox(id.to_string())),
    }
}

/// `setGeom`'s write: a value is set only when it differs.
fn set_num(txn: &mut TransactionMut, m: &MapRef, key: &str, v: f64) {
    let now = match m.get(txn, key) {
        Some(Out::Any(a)) => js::as_number(Some(&a)),
        _ => None,
    };
    if now != Some(v) {
        m.insert(txn, key, v);
    }
}

/// Add a box with its top-left at (`x`, `y`), `w` wide, stacked at `z`; its content is empty.
/// Position and width are clamped like the web's. One transaction.
pub fn create_box(doc: &Doc, id: &str, x: f64, y: f64, w: f64, z: f64) -> Result<(), BoxError> {
    check_id(id)?;
    let g = BoxGeom {
        id: id.to_string(),
        x: clamp_pos(finite(x, "x")?),
        y: clamp_pos(finite(y, "y")?),
        w: clamp_width(finite(w, "width")?),
        z: finite(z, "z")?,
        wide: false,
    };
    let mut txn = doc.transact_mut();
    let boxes = txn.get_or_insert_map(BOXES_KEY);
    if boxes.contains_key(&txn, id) {
        return Err(BoxError::Exists(id.to_string()));
    }
    boxes.insert(&mut txn, id, geometry(&g));
    // The fragment starts empty, as the web's `createBox` leaves it.
    txn.get_or_insert_xml_fragment(box_field(id));
    Ok(())
}

/// Move a box (clamped). One transaction.
pub fn move_box(doc: &Doc, id: &str, x: f64, y: f64) -> Result<(), BoxError> {
    let (x, y) = (clamp_pos(finite(x, "x")?), clamp_pos(finite(y, "y")?));
    let mut txn = doc.transact_mut();
    let m = geometry_map(&mut txn, id)?;
    set_num(&mut txn, &m, "x", x);
    set_num(&mut txn, &m, "y", y);
    Ok(())
}

/// Set a box's width (clamped); a wide box stops being wide, as when the web drags its edge.
pub fn resize_box(doc: &Doc, id: &str, w: f64) -> Result<(), BoxError> {
    let w = clamp_width(finite(w, "width")?);
    let mut txn = doc.transact_mut();
    let m = geometry_map(&mut txn, id)?;
    set_num(&mut txn, &m, "w", w);
    if m.contains_key(&txn, "wide") {
        m.remove(&mut txn, "wide");
    }
    Ok(())
}

/// The z a box needs to be in front (`frontZ`), or `None` if it already is (alone at the top).
pub fn front_z(boxes: &[BoxGeom], id: &str) -> Option<f64> {
    let me = boxes.iter().find(|b| b.id == id)?;
    let top = boxes.iter().fold(0.0_f64, |m, b| m.max(b.z));
    let tied = boxes.iter().any(|b| b.id != id && b.z == top);
    if me.z == top && !tied {
        None
    } else {
        Some(top + 1.0)
    }
}

/// Put a box in front of all others; returns its z (unchanged, and nothing written, when it
/// already is). One transaction.
pub fn bring_to_front(doc: &Doc, id: &str) -> Result<f64, BoxError> {
    let mut txn = doc.transact_mut();
    let boxes = box_geoms(&txn);
    let Some(me) = boxes.iter().find(|b| b.id == id) else {
        return Err(BoxError::NoSuchBox(id.to_string()));
    };
    let Some(z) = front_z(&boxes, id) else {
        return Ok(me.z);
    };
    let m = geometry_map(&mut txn, id)?;
    set_num(&mut txn, &m, "z", z);
    Ok(z)
}

/// `fragmentIsEmpty`: no nodes, or only paragraphs holding no text.
pub fn fragment_is_empty(nodes: &[Node]) -> bool {
    nodes.iter().all(|n| match n {
        Node::Element(e) if e.tag == "paragraph" => e.children.iter().all(|c| match c {
            Node::Text(runs) => runs
                .iter()
                .all(|r| matches!(&r.insert, Insert::Text(t) if t.is_empty())),
            _ => false,
        }),
        _ => false,
    })
}

/// Remove a box: its `boxes` entry and its content, in one transaction. Without `force` only
/// an empty box goes (`NotEmpty` otherwise, nothing written). With `force` the content goes too,
/// as when the web deletes a selected box; tasks on its lines are the caller's to delete.
pub fn delete_box(doc: &Doc, id: &str, force: bool) -> Result<(), BoxError> {
    let mut txn = doc.transact_mut();
    let boxes = txn.get_or_insert_map(BOXES_KEY);
    if !boxes.contains_key(&txn, id) {
        return Err(BoxError::NoSuchBox(id.to_string()));
    }
    let name = box_field(id);
    if !force && !fragment_is_empty(&crate::tree::read_fragment(&txn, &name)) {
        return Err(BoxError::NotEmpty(id.to_string()));
    }
    boxes.remove(&mut txn, id);
    let frag = txn.get_or_insert_xml_fragment(name);
    let len = frag.len(&txn);
    if len > 0 {
        frag.remove_range(&mut txn, 0, len);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::new_doc;
    use crate::Page;
    use yrs::types::ToJson;
    use yrs::ReadTxn;
    use yrs::{XmlElementPrelim, XmlTextPrelim};

    fn geom(doc: &Doc, id: &str) -> BoxGeom {
        Page::read(doc)
            .boxes
            .into_iter()
            .find(|b| b.id == id)
            .unwrap_or_else(|| panic!("no box {id}"))
    }

    fn type_in(doc: &Doc, id: &str, text: &str) {
        let mut txn = doc.transact_mut();
        let frag = txn.get_or_insert_xml_fragment(box_field(id));
        let p = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        p.push_back(&mut txn, XmlTextPrelim::new(text));
    }

    #[test]
    fn ids_are_sixteen_base36_characters() {
        assert_eq!(box_id_from([0; 8]), "0000000000000000");
        assert_eq!(
            box_id_from([35, 36, 255, 1, 0, 0, 0, 0]),
            "0Z10730100000000".to_lowercase()
        );
        assert_eq!(box_id_from([255; 8]).len(), 16);
    }

    #[test]
    fn create_reads_back_with_its_geometry_and_empty_content() {
        let doc = new_doc();
        create_box(&doc, "a", 10.4, 20.5, 360.0, 3.0).unwrap();
        let page = Page::read(&doc);
        assert_eq!(
            page.boxes,
            [BoxGeom {
                id: "a".into(),
                x: 10.0,
                y: 21.0,
                w: 360.0,
                z: 3.0,
                wide: false
            }]
        );
        assert_eq!(page.kind(), crate::DocKind::Canvas);
        assert!(page.fragments[1].nodes.is_empty());
        assert_eq!(page.fragments[1].box_id.as_deref(), Some("a"));
        assert_eq!(
            create_box(&doc, "a", 0.0, 0.0, 360.0, 1.0),
            Err(BoxError::Exists("a".into()))
        );
        assert!(matches!(
            create_box(&doc, "", 0.0, 0.0, 360.0, 1.0),
            Err(BoxError::Invalid(_))
        ));
        assert!(matches!(
            create_box(&doc, "b", f64::NAN, 0.0, 360.0, 1.0),
            Err(BoxError::Invalid(_))
        ));
    }

    #[test]
    fn create_clamps_like_the_web() {
        let doc = new_doc();
        create_box(&doc, "a", -5.0, 99_999.0, 10.0, 1.0).unwrap();
        create_box(&doc, "b", 0.0, 0.0, 9000.0, 1.0).unwrap();
        assert_eq!(
            (geom(&doc, "a").x, geom(&doc, "a").y, geom(&doc, "a").w),
            (0.0, 20_000.0, 120.0)
        );
        assert_eq!(geom(&doc, "b").w, 2400.0);
    }

    #[test]
    fn move_changes_only_the_position() {
        let doc = new_doc();
        create_box(&doc, "a", 0.0, 0.0, 300.0, 2.0).unwrap();
        move_box(&doc, "a", 120.0, 340.0).unwrap();
        let g = geom(&doc, "a");
        assert_eq!((g.x, g.y, g.w, g.z), (120.0, 340.0, 300.0, 2.0));
        assert_eq!(
            move_box(&doc, "nope", 1.0, 1.0),
            Err(BoxError::NoSuchBox("nope".into()))
        );
    }

    #[test]
    fn resize_sets_the_width_and_clears_wide() {
        let doc = new_doc();
        {
            // A wide box, as the web writes one (`newBoxMap` with wide: true).
            let mut txn = doc.transact_mut();
            let boxes = txn.get_or_insert_map(BOXES_KEY);
            boxes.insert(
                &mut txn,
                "main",
                MapPrelim::from([
                    ("x", Any::from(0.0)),
                    ("y", Any::from(0.0)),
                    ("w", Any::from(686.0)),
                    ("z", Any::from(1.0)),
                    ("wide", Any::Bool(true)),
                ]),
            );
        }
        assert!(geom(&doc, "main").wide);
        resize_box(&doc, "main", 500.0).unwrap();
        let g = geom(&doc, "main");
        assert_eq!((g.w, g.wide), (500.0, false));
        // `wide` is removed, not set to false.
        let txn = doc.transact();
        let json = txn.get_map(BOXES_KEY).unwrap().to_json(&txn);
        let Any::Map(boxes) = json else { panic!() };
        let Any::Map(main) = &boxes["main"] else {
            panic!()
        };
        assert!(!main.contains_key("wide"));
    }

    #[test]
    fn a_plain_object_entry_becomes_a_map_on_edit() {
        let doc = new_doc();
        {
            let mut txn = doc.transact_mut();
            let boxes = txn.get_or_insert_map(BOXES_KEY);
            boxes.insert(
                &mut txn,
                "p",
                Any::from_json(r#"{"x":1,"y":2,"w":300,"z":4,"wide":true}"#).unwrap(),
            );
        }
        move_box(&doc, "p", 7.0, 8.0).unwrap();
        let g = geom(&doc, "p");
        assert_eq!((g.x, g.y, g.w, g.z, g.wide), (7.0, 8.0, 300.0, 4.0, true));
    }

    #[test]
    fn front_goes_one_above_the_top_and_stays_when_already_there() {
        let doc = new_doc();
        create_box(&doc, "a", 0.0, 0.0, 300.0, 1.0).unwrap();
        create_box(&doc, "b", 0.0, 0.0, 300.0, 4.0).unwrap();
        create_box(&doc, "c", 0.0, 0.0, 300.0, 2.0).unwrap();
        assert_eq!(bring_to_front(&doc, "a").unwrap(), 5.0);
        assert_eq!(geom(&doc, "a").z, 5.0);
        // Already alone on top: nothing is written.
        let before = doc.transact().state_vector();
        assert_eq!(bring_to_front(&doc, "a").unwrap(), 5.0);
        assert_eq!(doc.transact().state_vector(), before);
        // A tie at the top is not in front.
        create_box(&doc, "d", 0.0, 0.0, 300.0, 5.0).unwrap();
        assert_eq!(bring_to_front(&doc, "a").unwrap(), 6.0);
        assert_eq!(
            bring_to_front(&doc, "zz"),
            Err(BoxError::NoSuchBox("zz".into()))
        );
        // On a page where every z is 0 or below, the first is 1.
        let doc = new_doc();
        create_box(&doc, "n", 0.0, 0.0, 300.0, -3.0).unwrap();
        assert_eq!(bring_to_front(&doc, "n").unwrap(), 1.0);
    }

    #[test]
    fn delete_removes_an_empty_box_and_refuses_one_with_text() {
        let doc = new_doc();
        create_box(&doc, "a", 0.0, 0.0, 300.0, 1.0).unwrap();
        create_box(&doc, "b", 0.0, 50.0, 300.0, 2.0).unwrap();
        type_in(&doc, "a", "keep me");
        // An empty paragraph (what an editor leaves after opening) still counts as empty.
        {
            let mut txn = doc.transact_mut();
            let frag = txn.get_or_insert_xml_fragment(box_field("b"));
            frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        }
        assert_eq!(
            delete_box(&doc, "a", false),
            Err(BoxError::NotEmpty("a".into()))
        );
        assert_eq!(Page::read(&doc).boxes.len(), 2);
        delete_box(&doc, "b", false).unwrap();
        let page = Page::read(&doc);
        assert_eq!(page.boxes.len(), 1);
        assert!(Page::fragment(&doc, "box:b").nodes.is_empty());
        assert_eq!(
            delete_box(&doc, "b", false),
            Err(BoxError::NoSuchBox("b".into()))
        );
        // `force` takes the content too.
        delete_box(&doc, "a", true).unwrap();
        assert!(Page::read(&doc).boxes.is_empty());
        assert!(Page::fragment(&doc, "box:a").nodes.is_empty());
    }

    #[test]
    fn each_call_is_one_update() {
        let doc = new_doc();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(0));
        let n = seen.clone();
        doc.observe_update_v1("count", move |_, _| *n.lock().unwrap() += 1)
            .unwrap();
        create_box(&doc, "a", 1.0, 2.0, 300.0, 1.0).unwrap();
        move_box(&doc, "a", 5.0, 6.0).unwrap();
        resize_box(&doc, "a", 200.0).unwrap();
        create_box(&doc, "b", 1.0, 2.0, 300.0, 1.0).unwrap();
        bring_to_front(&doc, "a").unwrap();
        delete_box(&doc, "b", false).unwrap();
        assert_eq!(*seen.lock().unwrap(), 6);
    }
}
