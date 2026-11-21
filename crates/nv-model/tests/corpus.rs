//! The page-format corpus (tests/corpus/README.md): nv-model must say exactly what today's TS
//! code says about every committed page.

use std::fs;
use std::path::{Path, PathBuf};

use nv_model::lists::{list_marker, list_suffix, xml_list_start};
use nv_model::page::DEFAULT_FIELD;
use nv_model::yrs::{Any, Map, ReadTxn, Transact};
use nv_model::{
    doc_from_update, extract_page, page_headings, sanitize_doc, to_markdown, DocKind, Fragment,
    Insert, Node, Page, TaskLine,
};
use serde_json::{json, Map as JMap, Value};

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus")
}

fn num(f: f64) -> Value {
    if f.is_finite() && f == f.trunc() && f.abs() < 9e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

/// A value as `JSON.stringify` writes it.
fn any(v: &Any) -> Value {
    match v {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => json!(b),
        Any::Number(n) => num(nv_model::js::number(n)),
        Any::String(s) => json!(&**s),
        Any::Array(a) => Value::Array(a.iter().map(any).collect()),
        Any::Map(m) => Value::Object(
            m.iter()
                .filter(|(_, v)| !matches!(v, Any::Undefined))
                .map(|(k, v)| (k.clone(), any(v)))
                .collect(),
        ),
        Any::Buffer(b) => Value::Object(
            b.iter()
                .enumerate()
                .map(|(i, x)| (i.to_string(), json!(x)))
                .collect(),
        ),
    }
}

fn attrs(a: &[(String, Any)]) -> Value {
    Value::Object(
        a.iter()
            .filter(|(_, v)| !matches!(v, Any::Undefined))
            .map(|(k, v)| (k.clone(), any(v)))
            .collect::<JMap<_, _>>(),
    )
}

fn node(n: &Node) -> Value {
    match n {
        Node::Element(e) => {
            json!({ "type": e.tag, "attrs": attrs(&e.attrs), "content": e.children.iter().map(node).collect::<Vec<_>>() })
        }
        Node::Text(runs) => json!({ "text": runs.iter().map(|r| {
            let mut o = JMap::new();
            match &r.insert {
                Insert::Text(s) => o.insert("insert".into(), json!(s)),
                Insert::Embed(v) => o.insert("embed".into(), any(v)),
            };
            if !r.attrs.is_empty() { o.insert("attributes".into(), attrs(&r.attrs)); }
            Value::Object(o)
        }).collect::<Vec<_>>() }),
        Node::Other => json!({ "other": true }),
    }
}

fn fragments(f: &[Fragment]) -> Value {
    Value::Array(f.iter().map(|f| json!({ "name": f.name, "content": f.nodes.iter().map(node).collect::<Vec<_>>() })).collect())
}

fn base64(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            s.push(if i <= c.len() {
                A[(n >> (18 - 6 * i)) as usize & 63] as char
            } else {
                '='
            });
        }
    }
    s
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort_by(|a, b| nv_model::js::cmp_str(a, b));
    v
}

fn ordered_lists(page: &Page) -> Value {
    fn walk(sibs: &[Node], fragment: &str, path: &mut Vec<usize>, out: &mut Vec<Value>) {
        for (i, n) in sibs.iter().enumerate() {
            path.push(i);
            if let Some(el) = n.element() {
                if el.tag == "orderedList" {
                    let start = xml_list_start(sibs, i);
                    let markers: Vec<String> = (0..el.children.len())
                        .map(|k| {
                            format!(
                                "{}{}",
                                list_marker(el.attr("type"), start + k as f64),
                                list_suffix(el.attr("paren"))
                            )
                        })
                        .collect();
                    out.push(json!({ "fragment": fragment, "path": path, "start": num(start), "markers": markers }));
                }
                walk(&el.children, fragment, path, out);
            }
            path.pop();
        }
    }
    let mut out = Vec::new();
    for f in &page.fragments {
        walk(&f.nodes, &f.name, &mut Vec::new(), &mut out);
    }
    Value::Array(out)
}

fn expected_json(update: &[u8]) -> Value {
    let page = Page::from_update(update).expect("page.bin decodes");
    let ex = extract_page(&page);
    let mut boxes = page.boxes.clone();
    boxes.sort_by(|a, b| nv_model::js::cmp_str(&a.id, &b.id));
    let doc = doc_from_update(update).unwrap();
    let removed = sanitize_doc(&doc);
    let clean = Page::read(&doc);
    let ink_keys = {
        let txn = doc.transact();
        sorted(
            txn.get_map("ink")
                .map(|m| m.keys(&txn).map(String::from).collect())
                .unwrap_or_default(),
        )
    };
    json!({
        "kind": if page.kind() == DocKind::Canvas { "canvas" } else { "document" },
        "formatVersion": num(page.format_version),
        "newerFormat": page.is_newer_format(),
        "pageSettings": { "color": page.settings.color, "rules": page.settings.rules },
        "boxes": boxes.iter().map(|b| {
            let mut o = json!({ "id": b.id, "x": num(b.x), "y": num(b.y), "w": num(b.w), "z": num(b.z) });
            if b.wide { o["wide"] = json!(true); }
            o
        }).collect::<Vec<_>>(),
        "readingOrder": page.reading_order().iter().map(|b| b.id.clone()).collect::<Vec<_>>(),
        "mainFragment": page.main_fragment().name,
        "fragments": fragments(&page.fragments),
        "headings": page_headings(&page).iter().map(|h| json!({ "boxId": h.box_id, "index": h.index, "level": num(h.level), "text": h.text })).collect::<Vec<_>>(),
        "ink": page.ink.iter().map(|s| json!({ "id": s.id, "bytes": base64(&s.data) })).collect::<Vec<_>>(),
        "taskIds": sorted(ex.task_ids.into_iter().collect()),
        "mentionIds": sorted(ex.mention_ids.into_iter().collect()),
        "orderedLists": ordered_lists(&page),
        "sanitized": {
            "removed": removed,
            "fragments": fragments(&clean.fragments),
            "ink": clean.ink.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            "inkKeys": ink_keys,
        },
    })
}

fn lookup(tasks: &Value) -> impl Fn(&str) -> TaskLine + '_ {
    move |id| match tasks.get(id) {
        None => TaskLine::Unknown,
        Some(Value::Null) => TaskLine::Hidden,
        Some(t) => TaskLine::Shown {
            title: t["title"].as_str().unwrap_or_default().into(),
            done: t["done"].as_bool().unwrap_or(false),
            due: t.get("due").and_then(|d| d.as_str()).map(String::from),
        },
    }
}

/// The first difference between two JSON values, as a path.
fn diff(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                if let Some(d) = diff(
                    x.get(k).unwrap_or(&Value::Null),
                    y.get(k).unwrap_or(&Value::Null),
                    &format!("{path}.{k}"),
                ) {
                    return Some(d);
                }
                if x.contains_key(k) != y.contains_key(k) {
                    return Some(format!("{path}.{k}: present in only one"));
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (p, q))| diff(p, q, &format!("{path}[{i}]"))),
        _ if a == b => None,
        _ => Some(format!("{path}: rust {a} vs ts {b}")),
    }
}

#[test]
fn corpus_cases() {
    let mut failures = Vec::new();
    let mut count = 0;
    for entry in fs::read_dir(corpus().join("cases")).unwrap() {
        let dir = entry.unwrap().path();
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let update = fs::read(dir.join("page.bin")).unwrap();
        let input: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("input.json")).unwrap()).unwrap();
        let want: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("expected.json")).unwrap()).unwrap();
        count += 1;

        let got = expected_json(&update);
        if let Some(d) = diff(&got, &want, "") {
            failures.push(format!("{name}: expected.json differs at {d}"));
        }
        let page = Page::from_update(&update).unwrap();
        let md = to_markdown(
            input["title"].as_str().unwrap_or_default(),
            &page.fragments,
            &lookup(&input["tasks"]),
        );
        if md != fs::read_to_string(dir.join("page.md")).unwrap() {
            failures.push(format!("{name}: page.md differs:\n{md}"));
        }
        let text = extract_page(&page).text;
        if text != fs::read_to_string(dir.join("page.txt")).unwrap() {
            failures.push(format!("{name}: page.txt differs:\n{text}"));
        }
        assert_eq!(page.fragments[0].name, DEFAULT_FIELD);
    }
    assert!(count >= 12, "the corpus has {count} cases");
    assert!(
        failures.is_empty(),
        "{} corpus failures:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[test]
fn list_marker_table() {
    let want: Value =
        serde_json::from_str(&fs::read_to_string(corpus().join("list-markers.json")).unwrap())
            .unwrap();
    for t in want["markers"].as_array().unwrap() {
        let kind = t["type"].as_str().map(|s| Any::String(s.into()));
        for pair in t["values"].as_array().unwrap() {
            let n = pair[0].as_f64().unwrap();
            assert_eq!(
                list_marker(kind.as_ref(), n),
                pair[1].as_str().unwrap(),
                "listMarker({kind:?}, {n})"
            );
        }
    }
    for pair in want["suffix"].as_array().unwrap() {
        let paren = match &pair[0] {
            Value::Bool(b) => Some(Any::Bool(*b)),
            Value::String(s) => Some(Any::String(s.as_str().into())),
            _ => Some(Any::Null),
        };
        assert_eq!(list_suffix(paren.as_ref()), pair[1].as_str().unwrap());
    }
}

/// Pages arrive from the network: a truncated or corrupted update must be an error, never a panic.
#[test]
fn broken_updates_do_not_panic() {
    for entry in fs::read_dir(corpus().join("cases")).unwrap() {
        let update = fs::read(entry.unwrap().path().join("page.bin")).unwrap();
        for cut in 0..update.len() {
            let _ = Page::from_update(&update[..cut]);
        }
        for i in 0..update.len() {
            let mut bad = update.clone();
            bad[i] ^= 0x5a;
            let _ = Page::from_update(&bad);
        }
    }
}
