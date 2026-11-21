//! The box's fragment in the page's yrs doc (EDITOR.md 3), and undo through yrs (EDITOR.md 6).
//!
//! The tree is written to the fragment in y-prosemirror's mapping (an element per non-text node,
//! an `XmlText` per run of text with marks as formatting attributes) by diffing it against what
//! is there, and read back through `nv-model`. Undo is yrs's `UndoManager` on the fragment,
//! tracking this editor's own writes only and grouping changes within 500 ms.

use crate::node::{u16_len, Mark, Node};
use crate::schema::{schema, Attrs};
use crate::selection::Selection;
use nv_model::yrs::types::Attrs as YAttrs;
use nv_model::yrs::undo::Options;
use nv_model::yrs::{
    Any, Doc, Origin, Text, Transact, TransactionMut, UndoManager, Xml, XmlElementPrelim,
    XmlElementRef, XmlFragment, XmlFragmentRef, XmlOut, XmlTextPrelim, XmlTextRef,
};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Origin of this editor's writes (tracked by its undo manager).
const LOCAL: &str = "nv-editor";
/// Origin of the first write when a box is bound (not undoable).
const LOAD: &str = "nv-editor-load";

/// Milliseconds for undo grouping: the wall clock, or a manual one tests move with `advance`.
#[derive(Clone, Default)]
pub struct Clock {
    manual: Option<Arc<AtomicU64>>,
}

impl Clock {
    pub fn manual() -> Clock {
        Clock {
            manual: Some(Arc::new(AtomicU64::new(1_000_000))),
        }
    }
    pub fn now(&self) -> u64 {
        match &self.manual {
            Some(t) => t.load(Ordering::SeqCst),
            None => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64),
        }
    }
    pub fn advance(&self, ms: u64) {
        if let Some(t) = &self.manual {
            t.fetch_add(ms, Ordering::SeqCst);
        }
    }
}

pub struct Binding {
    pub doc: Doc,
    pub field: String,
    fragment: XmlFragmentRef,
    undo: UndoManager,
    pub clock: Clock,
    /// Selections (before, after) for each undo / redo stack item, kept beside yrs's stacks.
    undo_sel: Vec<(Selection, Selection)>,
    redo_sel: Vec<(Selection, Selection)>,
}

impl Binding {
    /// Bind to `field` of `doc`, writing `tree` there first (not undoable).
    pub fn new(doc: Doc, field: &str, tree: &Node, clock: Clock) -> Binding {
        let fragment = doc.get_or_insert_xml_fragment(field);
        let c = clock.clone();
        let mut tracked = HashSet::new();
        tracked.insert(Origin::from(LOCAL));
        let options = Options {
            capture_timeout_millis: 500,
            tracked_origins: tracked,
            capture_transaction: None,
            timestamp: Arc::new(move || c.now()),
            init_undo_stack: Vec::new(),
            init_redo_stack: Vec::new(),
        };
        let mut undo = UndoManager::with_options(options);
        undo.expand_scope(&doc, &fragment);
        let b = Binding {
            doc,
            field: field.to_string(),
            fragment,
            undo,
            clock,
            undo_sel: Vec::new(),
            redo_sel: Vec::new(),
        };
        let old = read_children(&b.doc, field);
        {
            let mut txn = b.doc.transact_mut_with(LOAD);
            write_children(&mut txn, &b.fragment, &old, &tree.content);
        }
        b
    }

    /// The fragment's content as a tree.
    pub fn read(&self) -> Node {
        let mut doc = Node::el("doc", read_children(&self.doc, &self.field));
        doc.normalize();
        doc
    }

    /// Write a new tree (after a local change), recording the selections around it for undo.
    pub fn write(&mut self, tree: &Node, before: &Selection, after: &Selection) {
        let old = read_children(&self.doc, &self.field);
        if old == tree.content {
            return;
        }
        let n = self.undo.undo_stack().len();
        {
            let mut txn = self.doc.transact_mut_with(LOCAL);
            write_children(&mut txn, &self.fragment, &old, &tree.content);
        }
        let m = self.undo.undo_stack().len();
        if m > n {
            self.undo_sel.push((before.clone(), after.clone()));
        } else if let Some(last) = self.undo_sel.last_mut() {
            last.1 = after.clone();
        }
        self.undo_sel.truncate(m);
        self.redo_sel.clear();
    }

    /// The next change starts a new undo step, however soon it comes.
    pub fn stop_capturing(&mut self) {
        self.undo.reset();
    }

    /// Undo the newest change; returns the tree and the selection to show.
    pub fn undo(&mut self) -> Option<(Node, Selection)> {
        if !self.undo.can_undo() {
            return None;
        }
        self.undo.undo_blocking();
        let sel = self.undo_sel.pop();
        if let Some(s) = &sel {
            self.redo_sel.push(s.clone());
        }
        Some((self.read(), sel.map_or(Selection::caret(1), |s| s.0)))
    }

    pub fn redo(&mut self) -> Option<(Node, Selection)> {
        if !self.undo.can_redo() {
            return None;
        }
        self.undo.redo_blocking();
        let sel = self.redo_sel.pop();
        if let Some(s) = &sel {
            self.undo_sel.push(s.clone());
        }
        Some((self.read(), sel.map_or(Selection::caret(1), |s| s.1)))
    }
}

// ───────────── Reading (through nv-model) ─────────────

fn read_children(doc: &Doc, field: &str) -> Vec<Node> {
    let page = nv_model::Page::read(doc);
    let nodes = page
        .fragments
        .iter()
        .find(|f| f.name == field)
        .map(|f| f.nodes.clone())
        .unwrap_or_default();
    let mut out = Vec::new();
    for n in &nodes {
        from_model(n, &mut out);
    }
    out
}

fn any_to_json(a: &Any) -> Value {
    serde_json::to_value(a).unwrap_or(Value::Null)
}

fn from_model(n: &nv_model::Node, out: &mut Vec<Node>) {
    match n {
        nv_model::Node::Element(e) => {
            if !schema().nodes.contains_key(&e.tag) {
                return;
            }
            let attrs: Attrs = e
                .attrs
                .iter()
                .map(|(k, v)| (k.clone(), any_to_json(v)))
                .collect();
            let mut kids = Vec::new();
            for c in &e.children {
                from_model(c, &mut kids);
            }
            let mut node = Node::new(&e.tag, attrs, kids);
            node.normalize();
            out.push(node);
        }
        nv_model::Node::Text(runs) => {
            for r in runs {
                if let nv_model::Insert::Text(s) = &r.insert {
                    let mut marks: Vec<Mark> = r
                        .attrs
                        .iter()
                        .filter_map(|(k, v)| {
                            let name = k.split("--").next().unwrap_or(k);
                            if !schema().is_mark(name) {
                                return None;
                            }
                            let a = match any_to_json(v) {
                                Value::Object(m) => m,
                                _ => Attrs::new(),
                            };
                            Some(Mark::new(name, a))
                        })
                        .collect();
                    marks.sort_by_key(Mark::rank);
                    out.push(Node::text(s, marks));
                }
            }
        }
        nv_model::Node::Other => {}
    }
}

// ───────────── Writing (by diff) ─────────────

/// Y children of a block: elements, and one text per run of text nodes.
#[derive(PartialEq)]
enum YChild<'a> {
    El(&'a Node),
    Text(Vec<&'a Node>),
}

fn y_children(nodes: &[Node]) -> Vec<YChild<'_>> {
    let mut out: Vec<YChild> = Vec::new();
    for n in nodes {
        if n.is_text() {
            if let Some(YChild::Text(v)) = out.last_mut() {
                v.push(n);
                continue;
            }
            out.push(YChild::Text(vec![n]));
        } else {
            out.push(YChild::El(n));
        }
    }
    out
}

fn json_to_any(v: &Value) -> Any {
    serde_json::from_value(v.clone()).unwrap_or(Any::Null)
}

fn mark_attrs(marks: &[Mark]) -> YAttrs {
    let mut a = YAttrs::new();
    for m in marks {
        let defaults = &schema().mark(&m.kind).attrs;
        let obj: serde_json::Map<String, Value> = m
            .attrs
            .iter()
            .filter(|(k, v)| !v.is_null() || defaults.get(*k).is_some_and(|d| !d.is_null()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        a.insert(m.kind.as_str().into(), json_to_any(&Value::Object(obj)));
    }
    a
}

/// Make the Y children of `parent` (currently `old`) match `new`.
fn write_children<P: XmlFragment>(
    txn: &mut TransactionMut,
    parent: &P,
    old: &[Node],
    new: &[Node],
) {
    let (ov, nv) = (y_children(old), y_children(new));
    let mut pre = 0;
    while pre < ov.len() && pre < nv.len() && ov[pre] == nv[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < ov.len() - pre
        && suf < nv.len() - pre
        && ov[ov.len() - 1 - suf] == nv[nv.len() - 1 - suf]
    {
        suf += 1;
    }
    let (om, nm) = (&ov[pre..ov.len() - suf], &nv[pre..nv.len() - suf]);
    // Same shape in the middle: update in place (keeps concurrent edits in other parts of a block).
    if om.len() == nm.len() {
        let mut ok = true;
        for (i, (o, n)) in om.iter().zip(nm).enumerate() {
            let idx = (pre + i) as u32;
            match (o, n, parent.get(txn, idx)) {
                (YChild::El(o), YChild::El(n), Some(XmlOut::Element(el))) if o.kind == n.kind => {
                    update_element(txn, &el, o, n);
                }
                (YChild::Text(o), YChild::Text(n), Some(XmlOut::Text(t))) => {
                    update_text(txn, &t, o, n)
                }
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            return;
        }
    }
    parent.remove_range(txn, pre as u32, om.len() as u32);
    for (i, c) in nm.iter().enumerate() {
        insert_child(txn, parent, (pre + i) as u32, c);
    }
}

fn insert_child<P: XmlFragment>(txn: &mut TransactionMut, parent: &P, idx: u32, c: &YChild) {
    match c {
        YChild::El(n) => {
            let el = parent.insert(txn, idx, XmlElementPrelim::empty(n.kind.as_str()));
            set_attrs(txn, &el, n);
            for (i, k) in y_children(&n.content).iter().enumerate() {
                insert_child(txn, &el, i as u32, k);
            }
        }
        YChild::Text(runs) => {
            let t = parent.insert(txn, idx, XmlTextPrelim::new(""));
            let mut at = 0;
            for r in runs {
                t.insert_with_attributes(txn, at, &r.text, mark_attrs(&r.marks));
                at += u16_len(&r.text) as u32;
            }
        }
    }
}

fn set_attrs(txn: &mut TransactionMut, el: &XmlElementRef, n: &Node) {
    for (k, v) in &n.attrs {
        if !v.is_null() {
            el.insert_attribute(txn, k.as_str(), json_to_any(v));
        }
    }
}

fn update_element(txn: &mut TransactionMut, el: &XmlElementRef, o: &Node, n: &Node) {
    for (k, v) in &n.attrs {
        if o.attrs.get(k) != Some(v) {
            if v.is_null() {
                el.remove_attribute(txn, &k.as_str());
            } else {
                el.insert_attribute(txn, k.as_str(), json_to_any(v));
            }
        }
    }
    write_children(txn, el, &o.content, &n.content);
}

/// Text runs as (UTF-16 unit, marks) cells, for a character diff.
fn cells<'a>(runs: &[&'a Node]) -> Vec<(u16, &'a [Mark])> {
    runs.iter()
        .flat_map(|r| r.text.encode_utf16().map(move |u| (u, r.marks.as_slice())))
        .collect()
}

fn update_text(txn: &mut TransactionMut, t: &XmlTextRef, o: &[&Node], n: &[&Node]) {
    let (oc, nc) = (cells(o), cells(n));
    let mut pre = 0;
    while pre < oc.len() && pre < nc.len() && oc[pre] == nc[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < oc.len() - pre
        && suf < nc.len() - pre
        && oc[oc.len() - 1 - suf] == nc[nc.len() - 1 - suf]
    {
        suf += 1;
    }
    let del = oc.len() - pre - suf;
    if del > 0 {
        t.remove_range(txn, pre as u32, del as u32);
    }
    // Insert the new middle, run by run.
    let mid = &nc[pre..nc.len() - suf];
    let mut at = pre as u32;
    let mut i = 0;
    while i < mid.len() {
        let marks = mid[i].1;
        let mut j = i;
        while j < mid.len() && mid[j].1 == marks {
            j += 1;
        }
        let units: Vec<u16> = mid[i..j].iter().map(|c| c.0).collect();
        let s = String::from_utf16_lossy(&units);
        t.insert_with_attributes(txn, at, &s, mark_attrs(marks));
        at += (j - i) as u32;
        i = j;
    }
}
