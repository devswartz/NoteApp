//! Runs the editor suite (`tests/editor/scenarios/*.json`, README there) against the engine.
//!
//! The engine doesn't pass every scenario yet, so this is a ratchet: every scenario named in
//! `tests/passing.txt` must pass, and the test prints the others. After making more pass, run
//! `NV_EDITOR_UPDATE=1 cargo test -p nv-editor --test suite` to rewrite the list.

use nv_editor::notation::{canonical, parse, serialize};
use nv_editor::{Editor, Focus, Selection, TaskHost};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
    let store = FakeTasks::default();
    if let Some(given) = s.get("tasks").and_then(Value::as_object) {
        let mut t = store.0.lock().unwrap();
        for (id, v) in given {
            t.given.push(id.clone());
            let status = v["status"].as_str().unwrap_or("open").to_string();
            t.live.push((
                id.clone(),
                v["title"].as_str().unwrap_or("").to_string(),
                status,
            ));
        }
    }
    let mut ed = Editor::new(doc, sel.unwrap_or(Selection::caret(1)));
    ed.tasks = Box::new(store.clone());
    let clock = nv_editor::bind::Clock::manual();
    ed.bind(nv_model::new_doc(), "default", clock.clone());
    let mut n = 0;
    let mut menu: MenuHighlight = None;
    for step in s["steps"].as_array().unwrap() {
        n += 1;
        if let Some(t) = step.get("type").and_then(Value::as_str) {
            for c in t.chars() {
                ed.insert_text(&c.to_string());
                ed.finish();
            }
        } else if let Some(k) = step.get("key").and_then(Value::as_str) {
            for _ in 0..step.get("times").and_then(Value::as_u64).unwrap_or(1) {
                if !view_menu_key(&mut ed, k, &mut menu) {
                    ed.key(k);
                }
            }
        } else if let Some(c) = step.get("command").and_then(Value::as_str) {
            command(&mut ed, c, step.get("args").unwrap_or(&json!({})))?;
            ed.finish();
        } else if let Some(p) = step.get("paste") {
            let c = nv_editor::clipboard::Clipboard {
                html: p["text/html"].as_str().unwrap_or("").into(),
                text: p["text/plain"].as_str().unwrap_or("").into(),
            };
            ed.paste(&c);
            ed.finish();
        } else if let Some(want) = step.get("copy") {
            let cut = step.get("cut").and_then(Value::as_bool).unwrap_or(false);
            let got = if cut { ed.cut() } else { ed.copy() };
            ed.finish();
            if let Some(t) = want.get("text").and_then(Value::as_str) {
                if got.text != t {
                    return Err(format!(
                        "step {n}: copied text\n    want: {t:?}\n    got:  {:?}",
                        got.text
                    ));
                }
            }
        } else if let Some(id) = step.get("focusTitle").and_then(Value::as_str) {
            ed.focus_title(id);
        } else if let Some(t) = step.get("compose").and_then(Value::as_str) {
            let sel = step.get("selection").and_then(Value::as_array).map(|a| {
                let at = |i: usize| a.get(i).and_then(Value::as_u64).unwrap_or(0) as usize;
                (at(0), at(1))
            });
            ed.set_composition(t, sel);
            ed.finish();
        } else if let Some(t) = step.get("commitComposition").and_then(Value::as_str) {
            ed.commit_composition(t);
            ed.finish();
        } else if step.get("cancelComposition").is_some() {
            ed.cancel_composition();
            ed.finish();
        } else if let Some(r) = step.get("replace") {
            let at = |k: &str| r[k].as_u64().unwrap_or(0) as usize;
            ed.replace_range(at("from"), at("to"), r["text"].as_str().unwrap_or(""));
            ed.finish();
        } else if let Some(ms) = step.get("wait").and_then(Value::as_u64) {
            clock.advance(ms);
        } else if let Some(e) = step.get("expect") {
            check(&ed, &store, e).map_err(|m| format!("step {n}: {m}"))?;
        } else {
            return Err(format!("step {n}: not supported yet: {step}"));
        }
    }
    check(&ed, &store, &s["expect"])
}

/// Fixtures (tests/editor/README.md): the pages and people the menus offer.
const PAGES: &[(&str, &str)] = &[("p2", "Project plan"), ("p3", "Project notes")];
const PEOPLE: &[(&str, &str, &str)] = &[
    ("u1", "Tess Tester", "t@example.test"),
    ("u2", "Sam Lee", "sam@example.test"),
];

/// The `[[` menu's rows (today's `pageItems.ts`): matching pages, best first, then "Create"
/// (None) when the query names no page exactly.
fn page_rows(q: &str) -> Vec<Option<&'static str>> {
    let q = q.trim().to_lowercase();
    let mut scored: Vec<(usize, &str)> = PAGES
        .iter()
        .filter_map(|(id, title)| {
            let t = title.to_lowercase();
            let s = if q.is_empty() || t.starts_with(&q) {
                0
            } else if t.split_whitespace().any(|w| w.starts_with(&q)) {
                1
            } else if t.contains(&q) {
                2
            } else {
                return None;
            };
            Some((s, *id))
        })
        .collect();
    scored.sort_by_key(|x| x.0);
    let mut rows: Vec<Option<&str>> = scored.into_iter().map(|x| Some(x.1)).collect();
    if !q.is_empty() && !PAGES.iter().any(|(_, t)| t.to_lowercase() == q) {
        rows.push(None);
    }
    rows
}

/// The `@` menu's rows (today's `matchMembers`): (id, name), best first.
fn people_rows(q: &str) -> Vec<(&'static str, &'static str)> {
    let q = q.trim().to_lowercase();
    if q.is_empty() {
        return PEOPLE.iter().map(|p| (p.0, p.1)).collect();
    }
    let mut scored: Vec<(usize, &str, &str)> = PEOPLE
        .iter()
        .filter_map(|(id, name, email)| {
            let n = name.to_lowercase();
            let s = if n.starts_with(&q) {
                0
            } else if n.split_whitespace().any(|w| w.starts_with(&q)) {
                1
            } else if n.contains(&q) || email.starts_with(&q) {
                2
            } else {
                return None;
            };
            Some((s, *id, *name))
        })
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.2.cmp(b.2)));
    scored.into_iter().map(|x| (x.1, x.2)).collect()
}

/// The view's `[[` / `@` menu highlight: (the menu's trigger position, its query, the index);
/// it goes back to the top when the query changes, as in today's menus.
type MenuHighlight = Option<(usize, String, usize)>;

/// What the view does for the `[[` and `@` menus (they list pages and people, which the core
/// has, so the highlight is the view's): ArrowUp / ArrowDown move the highlight, wrapping, and
/// Enter or Tab picks the highlighted row. Escape goes to the engine (`dismiss_suggestion`).
fn view_menu_key(ed: &mut Editor, key: &str, menu: &mut MenuHighlight) -> bool {
    use nv_editor::suggest::Trigger;
    let Some(s) = ed.suggestion().filter(|s| s.trigger != Trigger::Slash) else {
        return false;
    };
    let n = match s.trigger {
        Trigger::PageLink => page_rows(&s.query).len(),
        _ => people_rows(&s.query).len(),
    };
    let index = match menu {
        Some((from, q, i)) if *from == s.from && *q == s.query => *i,
        _ => 0,
    };
    let done = match key {
        "ArrowDown" | "ArrowUp" => {
            if n == 0 {
                return false;
            }
            let delta = if key == "ArrowDown" { 1 } else { n - 1 };
            *menu = Some((s.from, s.query.clone(), (index + delta) % n));
            return true;
        }
        "Enter" | "Tab" => match s.trigger {
            Trigger::PageLink => match page_rows(&s.query).get(index) {
                Some(Some(id)) => ed.pick_page(id),
                // "Create" makes a page on the server first: not something one box can do.
                Some(None) => true,
                None => false,
            },
            _ => match people_rows(&s.query).get(index) {
                Some((id, name)) => ed.pick_mention(id, name),
                None => false,
            },
        },
        _ => return false,
    };
    if done {
        *menu = None;
        ed.finish();
    }
    done
}

fn command(ed: &mut Editor, name: &str, a: &Value) -> Result<(), String> {
    ed.command(name, a).map(|_| ())
}

/// The suite's task store: titles and status by id, in creation order, with deleted tasks kept
/// so undo can restore them (as today's tab keeps them, undoTasks.ts).
#[derive(Default)]
struct Tasks {
    live: Vec<(String, String, String)>,
    deleted: Vec<(String, String, String)>,
    given: Vec<String>,
    n: usize,
}

#[derive(Clone, Default)]
struct FakeTasks(Arc<Mutex<Tasks>>);

impl TaskHost for FakeTasks {
    fn new_id(&mut self) -> String {
        let mut t = self.0.lock().unwrap();
        t.n += 1;
        format!("new-{}", t.n)
    }
    fn create(&mut self, id: &str, title: &str, done: bool) {
        let status = if done { "done" } else { "open" };
        self.0
            .lock()
            .unwrap()
            .live
            .push((id.into(), title.into(), status.into()));
    }
    fn delete(&mut self, id: &str) {
        let mut t = self.0.lock().unwrap();
        if let Some(i) = t.live.iter().position(|x| x.0 == id) {
            let x = t.live.remove(i);
            t.deleted.push(x);
        }
    }
    fn restore(&mut self, id: &str) -> bool {
        let mut t = self.0.lock().unwrap();
        match t.deleted.iter().position(|x| x.0 == id) {
            Some(i) => {
                let x = t.deleted.remove(i);
                t.live.push(x);
                true
            }
            None => false,
        }
    }
    fn title(&self, id: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .live
            .iter()
            .find(|x| x.0 == id)
            .map(|x| x.1.clone())
    }
    fn set_title(&mut self, id: &str, title: &str) {
        if let Some(x) = self.0.lock().unwrap().live.iter_mut().find(|x| x.0 == id) {
            x.1 = title.into();
        }
    }
}

/// Suite names for task ids: given ones keep theirs; new ones get the next free `t<n>` in order
/// of appearance, the doc first, then the task list (as the TipTap harness does).
fn task_names(ed: &Editor, store: &FakeTasks) -> BTreeMap<String, String> {
    let t = store.0.lock().unwrap();
    let mut names: BTreeMap<String, String> =
        t.given.iter().map(|g| (g.clone(), g.clone())).collect();
    let mut n = 0;
    let mut order = nv_editor::tasks::task_ids(&ed.doc);
    order.extend(t.live.iter().map(|x| x.0.clone()));
    for id in order {
        if names.contains_key(&id) {
            continue;
        }
        let name = loop {
            n += 1;
            let c = format!("t{n}");
            if !names.values().any(|v| *v == c) {
                break c;
            }
        };
        names.insert(id, name);
    }
    names
}

fn check(ed: &Editor, store: &FakeTasks, e: &Value) -> Result<(), String> {
    let names = task_names(ed, store);
    let rename = |k: &str, v: &Value| match (k, v.as_str()) {
        ("taskId", Some(id)) => json!(names.get(id).cloned().unwrap_or(id.to_string())),
        _ => v.clone(),
    };
    if let Some(want) = e.get("doc").and_then(Value::as_str) {
        let ignore = e
            .get("ignoreSelection")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let in_doc = ed.focus == Focus::Doc && !ignore;
        let want = canonical(want, !ignore)?;
        let got = serialize(&ed.doc, if in_doc { Some(&ed.sel) } else { None }, &rename);
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
            Focus::TaskTitle(id) => {
                format!("title:{}", names.get(id).cloned().unwrap_or(id.clone()))
            }
        };
        if got != f {
            return Err(format!("focus: want {f}, got {got}"));
        }
    }
    if let Some(want) = e.get("tasks").and_then(Value::as_object) {
        let want: BTreeMap<String, (String, String)> = want
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    (
                        v["title"].as_str().unwrap_or("").to_string(),
                        v["status"].as_str().unwrap_or("open").to_string(),
                    ),
                )
            })
            .collect();
        let got: BTreeMap<String, (String, String)> = store
            .0
            .lock()
            .unwrap()
            .live
            .iter()
            .map(|(id, title, status)| {
                (
                    names.get(id).cloned().unwrap_or(id.clone()),
                    (title.clone(), status.clone()),
                )
            })
            .collect();
        if want != got {
            return Err(format!("tasks\n    want: {want:?}\n    got:  {got:?}"));
        }
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
