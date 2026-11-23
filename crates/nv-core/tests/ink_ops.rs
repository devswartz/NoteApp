//! The ink calls (`nv_core::ink`, over `nv_model::ink` and `nv-ink`) against what today's web code
//! leaves behind (tests/corpus/ink-ops/, made by scripts/corpus/ink-ops.ts): the same edits to the
//! `settings-and-ink` corpus page must end, after every step, with the same blobs in the `ink`
//! map, byte for byte (ids are random, so a state is compared as a sorted list of blobs).
//! Also: the page reads back through nv-ink's decoder, unreadable strokes survive every edit.

use std::fs;
use std::path::{Path, PathBuf};

use nv_core::ink::*;
use nv_model::ink as model;
use nv_model::yrs::Doc;
use nv_model::{doc_from_update, Page};
use serde_json::Value;

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus")
}

fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn state(doc: &Doc) -> Vec<String> {
    // The opaque, undecodable ones in the corpus page are blobs too; the web's state() lists every Uint8Array,
    // including the empty one, which `ink_blobs` (like pageInk) leaves out: add the empty one to compare.
    let mut v: Vec<String> = model::ink_blobs(doc).iter().map(|(_, b)| b64(b)).collect();
    v.push(String::new());
    v.sort();
    v
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

fn floats(v: &Value) -> Vec<f32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_f64().unwrap() as f32)
        .collect()
}

fn ids_of(doc: &Doc, blobs: &[String]) -> Vec<String> {
    model::ink_blobs(doc)
        .into_iter()
        .filter(|(_, b)| blobs.contains(&b64(b)))
        .map(|(id, _)| id)
        .collect()
}

fn blobs_of(doc: &Doc, ids: &[String]) -> Vec<String> {
    let mut v: Vec<String> = ids
        .iter()
        .map(|id| b64(&model::ink_blob(doc, id).unwrap()))
        .collect();
    v.sort();
    v
}

#[test]
fn the_rust_calls_leave_what_the_web_code_leaves() {
    let start = fs::read(corpus().join("cases/settings-and-ink/page.bin")).unwrap();
    let doc = doc_from_update(&start).unwrap();
    let expected: Value =
        serde_json::from_str(&fs::read_to_string(corpus().join("ink-ops/expected.json")).unwrap())
            .unwrap();
    let created = expected["created"].as_u64().unwrap();
    assert_eq!(state(&doc), strings(&expected["before"]));

    let mut next = 0;
    let mut new_id = || {
        next += 1;
        format!("rust{next:08}")
    };

    for step in expected["steps"].as_array().unwrap() {
        let op = step["op"].as_str().unwrap();
        match op {
            "add" => {
                let i = &step["input"];
                let samples: Vec<f64> = i["samples"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|s| s.as_array().unwrap().iter().map(|n| n.as_f64().unwrap()))
                    .collect();
                let flags = i["flags"].as_u64().unwrap();
                let style = StrokeStyle {
                    tool: i["tool"].as_u64().unwrap() as u8,
                    color: i["color"].as_u64().unwrap() as u32,
                    width: i["width"].as_f64().unwrap() as f32,
                    pressure: flags & 2 != 0,
                    tilt: flags & 1 != 0,
                };
                let stroke = smooth_samples(&style, &samples).unwrap().unwrap();
                let blob = add_stroke(&doc, stroke, &new_id(), created);
                assert_eq!(b64(&blob), step["blob"].as_str().unwrap(), "the added blob");
            }
            "erase" => {
                let r = erase(
                    &doc,
                    &floats(&step["track"])
                        .chunks(2)
                        .map(|c| [c[0], c[1]])
                        .collect::<Vec<_>>(),
                    step["radius"].as_f64().unwrap() as f32,
                    step["partial"].as_bool().unwrap(),
                    &mut new_id,
                );
                assert!(!r.removed.is_empty());
            }
            "move" => {
                let ids = ids_of(&doc, &strings(&step["of"]));
                assert_eq!(ids.len(), strings(&step["of"]).len());
                let moved = translate(
                    &doc,
                    &ids,
                    step["dx"].as_f64().unwrap() as f32,
                    step["dy"].as_f64().unwrap() as f32,
                    &mut new_id,
                );
                assert_eq!(moved.len(), ids.len());
            }
            "lasso" => {
                let poly: Vec<[f32; 2]> = floats(&step["polygon"])
                    .chunks(2)
                    .map(|c| [c[0], c[1]])
                    .collect();
                let ids = hit_lasso_ids(&doc, &poly, step["minFraction"].as_f64().unwrap() as f32);
                assert_eq!(
                    blobs_of(&doc, &ids),
                    strings(&step["selected"]),
                    "lasso {:?}",
                    step["polygon"]
                );
                continue;
            }
            other => panic!("unknown step {other}"),
        }
        assert_eq!(state(&doc), strings(&step["after"]), "state after {op}");
    }
}

#[test]
fn the_web_final_page_reads_through_the_core_and_the_page_reader() {
    // The final page the web code left, read by both readers.
    let web = doc_from_update(&fs::read(corpus().join("ink-ops/after.bin")).unwrap()).unwrap();
    let strokes = read_strokes(&web);
    // s1, s2 (opaque corpus bytes) are listed, unreadable, with their bytes; the rest read.
    let unreadable: Vec<&str> = strokes
        .iter()
        .filter(|s| !s.readable)
        .map(|s| s.id.as_str())
        .collect();
    assert!(unreadable.contains(&"s1") && unreadable.contains(&"s2"));
    assert!(strokes.iter().filter(|s| s.readable).count() >= 4);
    let page = Page::read(&web);
    assert_eq!(page.ink.len(), strokes.len());
    for s in strokes.iter().filter(|s| s.readable) {
        assert_eq!(s.points.len(), s.point_count as usize * 6);
        let b = s.bounds.unwrap();
        // Every point lies inside the ink's bounds.
        for p in s.points.chunks(6) {
            assert!(p[0] >= b.min_x && p[0] <= b.max_x && p[1] >= b.min_y && p[1] <= b.max_y);
        }
        assert!(!ink_outline_ops(s.data.clone()).is_empty());
    }
}
