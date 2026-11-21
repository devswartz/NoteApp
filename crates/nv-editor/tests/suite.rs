//! Runs the editor suite (`tests/editor/scenarios/*.json`, README there) against the engine.
//!
//! The engine doesn't pass every scenario yet, so this is a ratchet: every scenario named in
//! `tests/passing.txt` must pass, and the test prints the others. After making more pass, run
//! `NV_EDITOR_UPDATE=1 cargo test -p nv-editor --test suite` to rewrite the list.

use nv_editor::notation::{canonical, parse, serialize};
use nv_editor::{Editor, Focus, Selection};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn suite_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/editor/scenarios")
}

fn passing_file() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/passing.txt")
}

struct Outcome {
    id: String,
    result: Result<(), String>,
    skipped: Option<String>,
}

/// One scenario: Ok, or why not.
fn run(s: &Value) -> Result<(), String> {
    let (doc, sel) = parse(s["doc"].as_str().unwrap())?;
    let mut ed = Editor::new(doc, sel.unwrap_or(Selection::caret(1)));
    let mut n = 0;
    for step in s["steps"].as_array().unwrap() {
        n += 1;
        if let Some(t) = step.get("type").and_then(Value::as_str) {
            for c in t.chars() {
                ed.insert_text(&c.to_string());
                ed.finish();
            }
        } else if let Some(k) = step.get("key").and_then(Value::as_str) {
            for _ in 0..step.get("times").and_then(Value::as_u64).unwrap_or(1) {
                ed.key(k);
            }
        } else if let Some(c) = step.get("command").and_then(Value::as_str) {
            command(&mut ed, c, step.get("args").unwrap_or(&json!({})))?;
            ed.finish();
        } else if step.get("wait").is_some() {
            // No clock-driven behaviour yet (undo grouping comes with the yrs binding).
        } else if let Some(e) = step.get("expect") {
            check(&ed, e).map_err(|m| format!("step {n}: {m}"))?;
        } else {
            return Err(format!("step {n}: not supported yet: {step}"));
        }
    }
    check(&ed, &s["expect"])
}

fn command(ed: &mut Editor, name: &str, a: &Value) -> Result<(), String> {
    let attrs = |k: &str, v: &Value| {
        let mut m = serde_json::Map::new();
        m.insert(k.to_string(), v.clone());
        m
    };
    match name {
        "toggleMark" => ed.toggle_mark(a["mark"].as_str().unwrap_or("")),
        "toggleBulletList" => ed.toggle_list("bulletList"),
        "toggleOrderedList" => ed.toggle_list("orderedList"),
        "toggleChecklist" => ed.toggle_list("taskList"),
        "toggleQuote" => ed.toggle_wrap("blockquote"),
        "toggleCodeBlock" => ed.toggle_code_block(),
        "setParagraph" => ed.set_block_type("paragraph", Default::default()),
        "setHeading" => ed.set_block_type("heading", attrs("level", &a["level"])),
        "toggleHeading" => ed.toggle_heading(a["level"].as_u64().unwrap_or(1)),
        "setColor" => {
            let (f, t) = ed.range();
            ed.add_mark_range(
                f,
                t,
                &nv_editor::Mark::new("textStyle", attrs("color", &a["color"])),
            );
            true
        }
        "setHighlight" => {
            let (f, t) = ed.range();
            ed.add_mark_range(
                f,
                t,
                &nv_editor::Mark::new("highlight", attrs("color", &a["color"])),
            );
            true
        }
        "setLink" => {
            let (f, t) = ed.range();
            ed.add_mark_range(
                f,
                t,
                &nv_editor::Mark::new("link", attrs("href", &a["href"])),
            );
            true
        }
        "unsetLink" => {
            let (f, t) = ed.range();
            ed.remove_mark_range(f, t, "link");
            true
        }
        "selectAll" => ed.select_all(),
        other => return Err(format!("command {other} not supported yet")),
    };
    Ok(())
}

fn check(ed: &Editor, e: &Value) -> Result<(), String> {
    if let Some(want) = e.get("doc").and_then(Value::as_str) {
        let ignore = e
            .get("ignoreSelection")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let in_doc = ed.focus == Focus::Doc && !ignore;
        let want = canonical(want, !ignore)?;
        let got = serialize(
            &ed.doc,
            if in_doc { Some(&ed.sel) } else { None },
            &|_, v| v.clone(),
        );
        if want != got {
            return Err(format!(
                "doc\n    want: {}\n    got:  {}",
                want.replace('\n', "\n          "),
                got.replace('\n', "\n          ")
            ));
        }
    }
    if let Some(f) = e.get("focus").and_then(Value::as_str) {
        let got = match &ed.focus {
            Focus::Doc => "editor".to_string(),
            Focus::TaskTitle(id) => format!("title:{id}"),
        };
        if got != f {
            return Err(format!("focus: want {f}, got {got}"));
        }
    }
    if e.get("tasks").is_some() {
        return Err("tasks not supported yet".into());
    }
    Ok(())
}

#[test]
fn editor_suite() {
    let mut outcomes = Vec::new();
    let mut files: Vec<PathBuf> = std::fs::read_dir(suite_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    for f in files {
        let stem = f.file_stem().unwrap().to_string_lossy().to_string();
        let data: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        for s in data["scenarios"].as_array().unwrap() {
            let id = format!("{stem}/{}", s["name"].as_str().unwrap());
            let skipped = s
                .pointer("/skip/rust")
                .and_then(Value::as_str)
                .map(String::from);
            let result = if skipped.is_some() {
                Ok(())
            } else {
                std::panic::catch_unwind(|| run(s)).unwrap_or_else(|p| {
                    Err(format!(
                        "panicked: {}",
                        p.downcast_ref::<String>()
                            .cloned()
                            .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                            .unwrap_or_default()
                    ))
                })
            };
            outcomes.push(Outcome {
                id,
                result,
                skipped,
            });
        }
    }
    let passing: BTreeSet<String> = outcomes
        .iter()
        .filter(|o| o.skipped.is_none() && o.result.is_ok())
        .map(|o| o.id.clone())
        .collect();
    let required: BTreeSet<String> = std::fs::read_to_string(passing_file())
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect();
    let mut per_file: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for o in &outcomes {
        let f = o.id.split('/').next().unwrap().to_string();
        let e = per_file.entry(f).or_default();
        e.1 += 1;
        if passing.contains(&o.id) {
            e.0 += 1;
        }
    }
    let verbose = std::env::var("NV_EDITOR_VERBOSE").is_ok();
    for o in &outcomes {
        match (&o.skipped, &o.result) {
            (Some(why), _) => println!("skip  {}  ({why})", o.id),
            (None, Ok(())) => {}
            (None, Err(e)) => {
                if verbose || required.contains(&o.id) {
                    println!("FAIL  {}\n  {e}", o.id)
                } else {
                    println!("todo  {}  ({})", o.id, e.lines().next().unwrap_or(""))
                }
            }
        }
    }
    for (f, (p, t)) in &per_file {
        println!("{f}: {p}/{t}");
    }
    println!("total: {}/{}", passing.len(), outcomes.len());
    if std::env::var("NV_EDITOR_UPDATE").is_ok() {
        let body: String = passing.iter().map(|s| format!("{s}\n")).collect();
        std::fs::write(passing_file(), format!("# Editor suite scenarios the engine passes (tests/suite.rs). Regenerate with NV_EDITOR_UPDATE=1.\n{body}")).unwrap();
        return;
    }
    let regressed: Vec<&String> = required.difference(&passing).collect();
    assert!(
        regressed.is_empty(),
        "scenarios that used to pass now fail: {regressed:?}"
    );
    let new: Vec<&String> = passing.difference(&required).collect();
    if !new.is_empty() {
        println!("newly passing (add with NV_EDITOR_UPDATE=1): {new:?}");
    }
}
