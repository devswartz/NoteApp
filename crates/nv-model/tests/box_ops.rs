//! The box calls (`nv_model::boxes`) against what today's web code leaves behind
//! (tests/corpus/box-ops/, made by scripts/corpus/box-ops.ts): the same five edits to the
//! `canvas-boxes` corpus page must end with the same raw `boxes` map (nested maps, same fields
//! and values, no `wide` after a resize) and the same fragments.

use std::fs;
use std::path::{Path, PathBuf};

use nv_model::boxes::{bring_to_front, create_box, delete_box, move_box, resize_box};
use nv_model::yrs::types::ToJson;
use nv_model::yrs::{Any, Doc, ReadTxn, StateVector, Transact};
use nv_model::{doc_from_update, Page};
use serde_json::Value;

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus")
}

fn json(v: &Any) -> Value {
    match v {
        Any::Number(n) => {
            let f = nv_model::js::number(n);
            if f == f.trunc() {
                Value::from(f as i64)
            } else {
                Value::from(f)
            }
        }
        Any::Bool(b) => Value::from(*b),
        Any::String(s) => Value::from(&**s),
        Any::Map(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), json(v))).collect()),
        other => panic!("unexpected {other:?}"),
    }
}

/// The `boxes` map as plain JSON, after a round trip through update bytes (as it would reach the web).
fn boxes_json(doc: &Doc) -> Value {
    let bytes = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let doc = doc_from_update(&bytes).unwrap();
    let txn = doc.transact();
    json(&txn.get_map("boxes").unwrap().to_json(&txn))
}

#[test]
fn the_rust_calls_leave_what_the_web_code_leaves() {
    let start = fs::read(corpus().join("cases/canvas-boxes/page.bin")).unwrap();
    let doc = doc_from_update(&start).unwrap();

    // 1. A click at (300, 212): the web puts the box 12 above it, 360 wide, one above the top z.
    let top = Page::read(&doc)
        .boxes
        .iter()
        .fold(0.0_f64, |m, b| m.max(b.z));
    create_box(&doc, "new1", 300.0, 212.0 - 12.0, 360.0, top + 1.0).unwrap();
    // 2. Drag `a` to (111, 222.6).
    move_box(&doc, "a", 111.0, 222.6).unwrap();
    // 3. Drag the wide box's edge to 500.
    resize_box(&doc, "top", 500.0).unwrap();
    // 4. Bring `c` to front.
    bring_to_front(&doc, "c").unwrap();
    // 5. Remove the empty box.
    delete_box(&doc, "empty", false).unwrap();

    let expected: Value =
        serde_json::from_str(&fs::read_to_string(corpus().join("box-ops/expected.json")).unwrap())
            .unwrap();
    assert_eq!(boxes_json(&doc), expected["boxes"]);

    // And read through the page reader, the same page as the web's own result.
    let web = doc_from_update(&fs::read(corpus().join("box-ops/after.bin")).unwrap()).unwrap();
    let (rust, web) = (Page::read(&doc), Page::read(&web));
    let sorted = |p: &Page| {
        let mut b = p.boxes.clone();
        b.sort_by(|a, b| a.id.cmp(&b.id));
        b
    };
    assert_eq!(sorted(&rust), sorted(&web));
    assert_eq!(rust.fragments, web.fragments);
    assert_eq!(rust.kind(), web.kind());
}
