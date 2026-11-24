//! Copy, paste and duplicate whole boxes on a live page, and template content in and out of a
//! page, in the web's own formats (`src/editor/boxClipboard.ts`, `src/editor/canvasDoc.ts`).
//! Every call that changes the page is **one transaction** with the box-edit origin: one
//! update to send and one step of `LivePage::undo` (which takes the boxes and their content
//! back out). See docs/rewrite/status/core.md, "For apple: templates, push devices, box
//! clipboard".

use std::collections::HashMap;

use nv_editor::Node;
use nv_model::boxes as model;
use nv_model::page::{
    box_field, box_geoms, page_settings, PAGE_COLORS, PAGE_SETTINGS_KEY, RULE_LINES,
};
use nv_model::yrs::{Map, ReadTxn, Transact, WriteTxn};
use nv_model::BoxGeom;
use serde_json::{json, Value};

use crate::boxes::{geom_origin, new_box_id};
use crate::{BoxError, LivePage};

/// How far each further paste or duplicate of boxes is nudged down and right (the web's
/// `PASTE_STEP`).
const PASTE_STEP: f64 = 24.0;
/// The width of the one box a document template becomes (`READABLE_BOX_W`).
const READABLE_BOX_W: f64 = 686.0;

fn invalid(m: impl Into<String>) -> BoxError {
    BoxError::Invalid { message: m.into() }
}

/// Where pasted boxes go.
#[derive(Clone, Copy, PartialEq)]
enum Place {
    /// As copied.
    Exact,
    /// The group's top-left here.
    At(f64, f64),
    /// As copied, nudged off the boxes already there.
    Nudge,
}

/// A box to write: geometry (as copied) and its blocks as editor JSON.
struct NewBox {
    x: f64,
    y: f64,
    w: f64,
    /// Template boxes carry their own stacking; pasted ones are stacked in order on top.
    z: Option<f64>,
    wide: bool,
    content: Vec<Value>,
}

/// Replace `taskRef` ids by `map` (a copy of a box gets its own tasks).
fn map_tasks(v: &mut Value, map: &HashMap<String, String>) {
    if map.is_empty() {
        return;
    }
    if v.get("type").and_then(Value::as_str) == Some("taskRef") {
        if let Some(id) = v
            .pointer("/attrs/taskId")
            .and_then(Value::as_str)
            .and_then(|t| map.get(t))
        {
            v["attrs"]["taskId"] = Value::String(id.clone());
        }
    }
    if let Some(kids) = v.get_mut("content").and_then(Value::as_array_mut) {
        for k in kids {
            map_tasks(k, map);
        }
    }
}

/// `{date}` and `{time}` in every text node.
fn fill_text(v: &mut Value, date: &str, time: &str) {
    if let Some(t) = v.get("text").and_then(Value::as_str).map(String::from) {
        if t.contains('{') {
            let out = replace_ci(&replace_ci(&t, "{date}", date), "{time}", time);
            v["text"] = Value::String(out);
        }
    }
    if let Some(kids) = v.get_mut("content").and_then(Value::as_array_mut) {
        for k in kids {
            fill_text(k, date, time);
        }
    }
}

fn replace_ci(s: &str, pat: &str, with: &str) -> String {
    if with.is_empty() {
        return s.to_string();
    }
    let lower = s.to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(i) = lower[at..].find(pat) {
        out.push_str(&s[at..at + i]);
        out.push_str(with);
        at += i + pat.len();
    }
    out.push_str(&s[at..]);
    out
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

impl LivePage {
    /// The boxes as clip entries, in the order asked.
    fn clip_of(&self, ids: &[String]) -> Result<Vec<Value>, BoxError> {
        let geoms = {
            let txn = self.doc().transact();
            box_geoms(&txn)
        };
        ids.iter()
            .map(|id| {
                let g = geoms
                    .iter()
                    .find(|g| &g.id == id)
                    .ok_or_else(|| BoxError::NoSuchBox { id: id.clone() })?;
                let tree = nv_editor::bind::read_tree(self.doc(), &box_field(id));
                let mut o = json!({ "x": g.x, "y": g.y, "w": g.w });
                if g.wide {
                    o["wide"] = Value::Bool(true);
                }
                o["content"] = Value::Array(tree.content.iter().map(Node::to_json).collect());
                Ok(o)
            })
            .collect()
    }

    fn clip_boxes(clip: &[Value]) -> Result<Vec<NewBox>, BoxError> {
        clip.iter()
            .map(|b| {
                let content = b
                    .get("content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                Ok(NewBox {
                    x: num(b, "x").unwrap_or(0.0),
                    y: num(b, "y").unwrap_or(0.0),
                    w: num(b, "w").unwrap_or(360.0),
                    z: None,
                    wide: b.get("wide").and_then(Value::as_bool) == Some(true),
                    content,
                })
            })
            .collect()
    }

    /// Write boxes, and optionally the page settings, as one undoable edit. Returns the new ids.
    fn write_new_boxes(
        &self,
        boxes: Vec<NewBox>,
        at: Place,
        settings: Option<(String, String)>,
    ) -> Result<Vec<String>, BoxError> {
        if self.is_closed() {
            return Err(BoxError::Closed);
        }
        // Parse every box before touching the page: a bad one changes nothing.
        let mut trees = Vec::new();
        for b in &boxes {
            let mut blocks = b.content.clone();
            if blocks.is_empty() {
                blocks.push(json!({ "type": "paragraph" }));
            }
            let doc = json!({ "type": "doc", "content": blocks });
            trees.push(Node::from_json(&doc).map_err(invalid)?);
        }
        let mut guard = self.ink_undo.lock().unwrap();
        let mgr = guard.get_or_insert_with(|| {
            crate::ink::new_ink_undo(self.doc(), self.page_undo.seq.clone())
        });
        let ids: Vec<String> = boxes.iter().map(|_| new_box_id()).collect();
        for id in &ids {
            let frag = self.doc().get_or_insert_xml_fragment(box_field(id));
            mgr.expand_scope(self.doc(), &frag);
        }
        if settings.is_some() {
            mgr.expand_scope(self.doc(), &self.doc().get_or_insert_map(PAGE_SETTINGS_KEY));
        }
        let mut txn = self.doc().transact_mut_with(geom_origin());
        let existing = box_geoms(&txn);
        let top = existing.iter().fold(0.0_f64, |m, g| m.max(g.z));
        // Where the group goes: its top-left at `at`, or nudged off the boxes already there.
        let (min_x, min_y) = boxes
            .iter()
            .fold((f64::MAX, f64::MAX), |(a, b), n| (a.min(n.x), b.min(n.y)));
        let (mut dx, mut dy) = (0.0, 0.0);
        if let Place::At(ax, ay) = at {
            dx = ax - min_x;
            dy = ay - min_y;
        } else if at == Place::Nudge && !boxes.is_empty() {
            let taken = |ox: f64, oy: f64| {
                boxes.iter().any(|b| {
                    existing
                        .iter()
                        .any(|e| (e.x - (b.x + ox)).abs() < 1.0 && (e.y - (b.y + oy)).abs() < 1.0)
                })
            };
            for _ in 0..40 {
                if !taken(dx, dy) {
                    break;
                }
                dx += PASTE_STEP;
                dy += PASTE_STEP;
            }
        }
        for (i, ((b, id), tree)) in boxes.iter().zip(&ids).zip(&trees).enumerate() {
            let g = BoxGeom {
                id: id.clone(),
                x: (b.x + dx).max(0.0),
                y: (b.y + dy).max(0.0),
                w: b.w,
                z: top + 1.0 + b.z.unwrap_or(i as f64),
                wide: b.wide,
            };
            model::insert_box_in(&mut txn, &g)?;
            nv_editor::bind::write_fragment_in(&mut txn, &box_field(id), tree);
        }
        if let Some((color, rules)) = settings {
            let map = txn.get_or_insert_map(PAGE_SETTINGS_KEY);
            map.insert(&mut txn, "color", color.as_str());
            map.insert(&mut txn, "rules", rules.as_str());
        }
        Ok(ids)
    }
}

#[uniffi::export]
impl LivePage {
    /// The boxes as the web's box clipboard holds them, to keep in the app and paste later
    /// (`paste_boxes`), here or on another page: JSON
    /// `{"boxes":[{"x","y","w","wide"?,"content":[ProseMirror blocks]}],"text":"...","cut":false}`.
    /// Boxes come out in the order of `box_ids`. `text` is plain text for the system clipboard
    /// (one line per block, boxes separated by a blank line). `cut` is false: to cut, copy
    /// then `delete_box_with_content` the originals (a cut box's tasks stay the same tasks).
    /// `NoSuchBox` for an id the page doesn't have; nothing is changed.
    pub fn boxes_json(&self, box_ids: Vec<String>) -> Result<String, BoxError> {
        let boxes = self.clip_of(&box_ids)?;
        let text = boxes
            .iter()
            .map(|b| {
                b["content"]
                    .as_array()
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter_map(|n| Node::from_json(n).ok())
                            .map(|n| n.text_content())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default()
            })
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        Ok(json!({ "boxes": boxes, "text": text, "cut": false }).to_string())
    }

    /// Paste what `boxes_json` made (the object, or just its `boxes` array) as new boxes, in
    /// front of everything else, as one edit (`undo()` takes them all away). With `at_x` and
    /// `at_y` the group's top-left lands there (a right-click); without, it keeps its place
    /// nudged down and right by 24 px steps until it no longer sits exactly on a box that is
    /// already there. `task_map` replaces task ids in the content (old id to new id, from
    /// copying the tasks with `create_task`; empty keeps the same tasks, as a cut does).
    /// Returns the new box ids in clip order. `Invalid` for JSON that isn't a clip or holds
    /// content the editor doesn't know; nothing is changed then.
    pub fn paste_boxes(
        &self,
        json: String,
        at_x: Option<f64>,
        at_y: Option<f64>,
        task_map: HashMap<String, String>,
    ) -> Result<Vec<String>, BoxError> {
        let v: Value = serde_json::from_str(&json).map_err(|e| invalid(e.to_string()))?;
        let list = match &v {
            Value::Array(a) => a.clone(),
            o => o
                .get("boxes")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| invalid("not a box clip"))?,
        };
        let mut list = list;
        for b in &mut list {
            map_tasks(b, &task_map);
        }
        let at = match (at_x, at_y) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Place::At(x, y),
            _ => Place::Nudge,
        };
        self.write_new_boxes(Self::clip_boxes(&list)?, at, None)
    }

    /// Copy the boxes and paste them in place, nudged as `paste_boxes` does: the web's
    /// Duplicate. Returns the new ids in the order of `box_ids`. Their tasks are the same
    /// tasks (call `boxes_json`, make copies of the tasks and `paste_boxes` with a `task_map`
    /// to give the copies their own). One undo step.
    pub fn duplicate_boxes(&self, box_ids: Vec<String>) -> Result<Vec<String>, BoxError> {
        let clip = self.clip_of(&box_ids)?;
        self.write_new_boxes(Self::clip_boxes(&clip)?, Place::Nudge, None)
    }

    /// The page as template content for `Core::save_page_as_template` (kind "canvas"): a doc
    /// of `canvasBox` nodes (attrs x, y, w, z and wide, content = the box's blocks) for the
    /// non-empty boxes in reading order, and `attrs.pageSettings` ({color, rules}) when the
    /// page has settings.
    pub fn canvas_template_json(&self) -> String {
        let (order, settings) = {
            let txn = self.doc().transact();
            let set = txn
                .get_map(PAGE_SETTINGS_KEY)
                .is_some_and(|m| m.len(&txn) > 0)
                .then(|| page_settings(&txn));
            (nv_model::page::Page::read(self.doc()).reading_order(), set)
        };
        let mut boxes = Vec::new();
        for g in order {
            let tree = nv_editor::bind::read_tree(self.doc(), &box_field(&g.id));
            if tree
                .content
                .iter()
                .all(|n| n.kind == "paragraph" && n.content.is_empty())
            {
                continue;
            }
            let mut attrs = json!({ "x": g.x, "y": g.y, "w": g.w, "z": g.z });
            if g.wide {
                attrs["wide"] = Value::Bool(true);
            }
            boxes.push(json!({
                "type": "canvasBox",
                "attrs": attrs,
                "content": tree.content.iter().map(Node::to_json).collect::<Vec<_>>(),
            }));
        }
        let mut doc = json!({ "type": "doc", "content": boxes });
        if let Some(s) = settings {
            doc["attrs"] = json!({ "pageSettings": { "color": s.color, "rules": s.rules } });
        }
        doc.to_string()
    }

    /// Write what `Core::use_template` / `claim_pending_template` returned into this page, as
    /// the web does: `kind` "canvas" makes one box per `canvasBox` (geometry kept, stacked
    /// above what is there) and applies the page settings the template carries; any other kind
    /// (a document template) becomes one wide box at the top left. `{date}` and `{time}` in
    /// the text are replaced by `date` and `time` when those are not empty (pass the
    /// user's localized "Tuesday, November 24, 2026" and "3:45 PM"). One undo step. Returns the
    /// new box ids (empty for an empty template). Setting the page's title and icon from the
    /// template (only when the page has none) is `Core::rename_page` / `set_page_icon`.
    pub fn insert_template_content(
        &self,
        content_json: String,
        kind: String,
        date: String,
        time: String,
    ) -> Result<Vec<String>, BoxError> {
        let mut v: Value =
            serde_json::from_str(&content_json).map_err(|e| invalid(e.to_string()))?;
        fill_text(&mut v, &date, &time);
        let blocks = v
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let boxes: Vec<NewBox> = if kind == "canvas" {
            blocks
                .iter()
                .filter(|n| n.get("type").and_then(Value::as_str) == Some("canvasBox"))
                .map(|n| NewBox {
                    x: n.pointer("/attrs/x").and_then(Value::as_f64).unwrap_or(0.0),
                    y: n.pointer("/attrs/y").and_then(Value::as_f64).unwrap_or(0.0),
                    w: n.pointer("/attrs/w")
                        .and_then(Value::as_f64)
                        .filter(|w| *w != 0.0)
                        .unwrap_or(360.0),
                    z: Some(n.pointer("/attrs/z").and_then(Value::as_f64).unwrap_or(0.0)),
                    wide: n.pointer("/attrs/wide").and_then(Value::as_bool) == Some(true),
                    content: n
                        .get("content")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                })
                .collect()
        } else {
            vec![NewBox {
                x: 0.0,
                y: 0.0,
                w: READABLE_BOX_W,
                z: None,
                wide: true,
                content: blocks,
            }]
        };
        let settings = (kind == "canvas")
            .then(|| v.pointer("/attrs/pageSettings"))
            .flatten()
            .map(|s| {
                let pick = |k: &str, list: &[&str]| {
                    s.get(k)
                        .and_then(Value::as_str)
                        .filter(|x| list.contains(x))
                        .unwrap_or("none")
                        .to_string()
                };
                (pick("color", &PAGE_COLORS), pick("rules", &RULE_LINES))
            });
        // The settings are an attribute of the template's doc, not of a box: with no boxes
        // they are still applied.
        self.write_new_boxes(boxes, Place::Exact, settings)
    }
}
