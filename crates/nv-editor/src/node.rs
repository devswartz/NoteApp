//! The document tree (EDITOR.md 2): ProseMirror's shape, with positions counted the same way.

use crate::schema::{schema, Attrs};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Mark {
    pub kind: String,
    /// Every attribute, defaults filled in.
    pub attrs: Attrs,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub kind: String,
    /// Every attribute, defaults filled in.
    pub attrs: Attrs,
    pub content: Vec<Node>,
    /// Text nodes only.
    pub text: String,
    /// Inline nodes only, in schema order.
    pub marks: Vec<Mark>,
}

/// Length in UTF-16 code units: positions count text the way JavaScript (and yrs, set to UTF-16) does.
pub fn u16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The byte index of UTF-16 offset `n` in `s` (clamped to the end).
pub fn byte_at(s: &str, n: usize) -> usize {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units >= n {
            return i;
        }
        units += c.len_utf16();
    }
    s.len()
}

fn with_defaults(defaults: &Attrs, given: Attrs) -> Attrs {
    let mut out = defaults.clone();
    for (k, v) in given {
        out.insert(k, v);
    }
    out
}

impl Mark {
    pub fn new(kind: &str, attrs: Attrs) -> Mark {
        Mark {
            kind: kind.to_string(),
            attrs: with_defaults(&schema().mark(kind).attrs, attrs),
        }
    }
    pub fn simple(kind: &str) -> Mark {
        Mark::new(kind, Attrs::new())
    }
    pub fn rank(&self) -> usize {
        schema().mark(&self.kind).rank
    }
}

/// Add a mark to a set (replacing one of the same type, dropping marks it excludes), keeping schema order.
pub fn add_mark(marks: &[Mark], m: &Mark) -> Vec<Mark> {
    let ex = schema().mark(&m.kind).excludes.clone();
    // `excludes: ""` (the comment anchor): marks of the same kind with other attributes stay beside it.
    let coexists = matches!(&ex, Some(e) if e.is_empty());
    if coexists && marks.contains(m) {
        return marks.to_vec();
    }
    let mut out: Vec<Mark> = marks
        .iter()
        .filter(|x| {
            (coexists || x.kind != m.kind)
                && !matches!(&ex, Some(e) if e == "_" || e.split_whitespace().any(|n| n == x.kind))
        })
        .cloned()
        .collect();
    if out.iter().any(
        |x| matches!(&schema().mark(&x.kind).excludes, Some(e) if e == "_" && x.kind != m.kind),
    ) {
        return out; // e.g. code excludes everything else
    }
    out.push(m.clone());
    out.sort_by_key(Mark::rank);
    out
}

pub fn remove_mark(marks: &[Mark], kind: &str) -> Vec<Mark> {
    marks.iter().filter(|m| m.kind != kind).cloned().collect()
}

impl Node {
    pub fn new(kind: &str, attrs: Attrs, content: Vec<Node>) -> Node {
        Node {
            kind: kind.to_string(),
            attrs: with_defaults(&schema().node(kind).attrs, attrs),
            content,
            text: String::new(),
            marks: Vec::new(),
        }
    }

    pub fn el(kind: &str, content: Vec<Node>) -> Node {
        Node::new(kind, Attrs::new(), content)
    }

    pub fn text(s: &str, marks: Vec<Mark>) -> Node {
        Node {
            kind: "text".into(),
            attrs: Attrs::new(),
            content: Vec::new(),
            text: s.to_string(),
            marks,
        }
    }

    /// A node of `kind` with the least content that is valid (an empty list item gets its paragraph).
    pub fn filled(kind: &str, attrs: Attrs) -> Node {
        let kids = schema()
            .required_children(kind)
            .into_iter()
            .map(|k| Node::filled(k, Attrs::new()))
            .collect();
        Node::new(kind, attrs, kids)
    }

    pub fn attr(&self, k: &str) -> &Value {
        self.attrs.get(k).unwrap_or(&Value::Null)
    }

    pub fn with_attr(mut self, k: &str, v: Value) -> Node {
        self.attrs.insert(k.to_string(), v);
        self
    }

    pub fn is_text(&self) -> bool {
        self.kind == "text"
    }
    pub fn is_leaf(&self) -> bool {
        self.is_text() || schema().node(&self.kind).leaf
    }
    pub fn is_inline(&self) -> bool {
        self.is_text() || schema().node(&self.kind).inline
    }
    pub fn is_block(&self) -> bool {
        !self.is_inline()
    }
    pub fn is_textblock(&self) -> bool {
        !self.is_text() && schema().node(&self.kind).textblock
    }
    pub fn is_atom(&self) -> bool {
        !self.is_text() && schema().node(&self.kind).atom
    }
    pub fn is(&self, kind: &str) -> bool {
        self.kind == kind
    }
    pub fn is_list(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "bulletList" | "orderedList" | "taskList"
        )
    }
    pub fn is_list_item(&self) -> bool {
        matches!(self.kind.as_str(), "listItem" | "taskItem")
    }

    pub fn content_size(&self) -> usize {
        self.content.iter().map(Node::node_size).sum()
    }

    pub fn node_size(&self) -> usize {
        if self.is_text() {
            u16_len(&self.text)
        } else if self.is_leaf() {
            1
        } else {
            self.content_size() + 2
        }
    }

    /// The text of the node's content (leaf inline nodes count as nothing, hard breaks as nothing).
    pub fn text_content(&self) -> String {
        if self.is_text() {
            return self.text.clone();
        }
        self.content.iter().map(Node::text_content).collect()
    }

    pub fn same_markup(&self, other: &Node) -> bool {
        self.kind == other.kind && self.attrs == other.attrs && self.marks == other.marks
    }

    /// A copy with other content.
    pub fn copy(&self, content: Vec<Node>) -> Node {
        Node {
            kind: self.kind.clone(),
            attrs: self.attrs.clone(),
            content,
            text: String::new(),
            marks: self.marks.clone(),
        }
    }

    /// Merges adjacent text with the same marks and drops empty text, through the whole subtree.
    pub fn normalize(&mut self) {
        for c in &mut self.content {
            c.normalize();
        }
        let mut out: Vec<Node> = Vec::with_capacity(self.content.len());
        for c in self.content.drain(..) {
            if c.is_text() && c.text.is_empty() {
                continue;
            }
            if let Some(last) = out.last_mut() {
                if last.is_text() && c.is_text() && last.marks == c.marks {
                    last.text.push_str(&c.text);
                    continue;
                }
            }
            out.push(c);
        }
        self.content = out;
    }

    /// The node as ProseMirror's JSON (`Node.toJSON()`): `type`, then `attrs` (all of them,
    /// defaults included) when the node has any, `content` when it has children, and for text
    /// `text` and `marks` (when it has any).
    pub fn to_json(&self) -> Value {
        let mut o = serde_json::Map::new();
        o.insert("type".into(), Value::String(self.kind.clone()));
        if self.is_text() {
            o.insert("text".into(), Value::String(self.text.clone()));
        } else {
            if !self.attrs.is_empty() {
                o.insert("attrs".into(), Value::Object(self.attrs.clone()));
            }
            if !self.content.is_empty() {
                let kids = self.content.iter().map(Node::to_json).collect();
                o.insert("content".into(), Value::Array(kids));
            }
        }
        if !self.marks.is_empty() {
            let marks = self
                .marks
                .iter()
                .map(|m| {
                    let mut mo = serde_json::Map::new();
                    mo.insert("type".into(), Value::String(m.kind.clone()));
                    if !m.attrs.is_empty() {
                        mo.insert("attrs".into(), Value::Object(m.attrs.clone()));
                    }
                    Value::Object(mo)
                })
                .collect();
            o.insert("marks".into(), Value::Array(marks));
        }
        Value::Object(o)
    }

    /// The node at a child path.
    pub fn at(&self, path: &[usize]) -> &Node {
        path.iter().fold(self, |n, &i| &n.content[i])
    }

    pub fn at_mut(&mut self, path: &[usize]) -> &mut Node {
        path.iter().fold(self, |n, &i| &mut n.content[i])
    }

    /// Calls `f(node, pos)` for every descendant, `pos` being the position before it.
    pub fn descendants(&self, f: &mut dyn FnMut(&Node, usize) -> bool) {
        fn walk(n: &Node, start: usize, f: &mut dyn FnMut(&Node, usize) -> bool) {
            let mut p = start;
            for c in &n.content {
                if f(c, p) && !c.is_leaf() {
                    walk(c, p + 1, f);
                }
                p += c.node_size();
            }
        }
        walk(self, 0, f)
    }

    /// The inline content between two offsets of a text block's content, split at the ends.
    pub fn inline_slice(&self, from: usize, to: usize) -> Vec<Node> {
        let mut out = Vec::new();
        let mut p = 0;
        for c in &self.content {
            let size = c.node_size();
            let (s, e) = (p, p + size);
            p = e;
            if c.is_text() {
                let a = from.max(s) - s;
                let b = to.min(e).saturating_sub(s);
                if b > a {
                    let t = &c.text[byte_at(&c.text, a)..byte_at(&c.text, b)];
                    out.push(Node::text(t, c.marks.clone()));
                }
            } else if s >= from && e <= to {
                out.push(c.clone());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use crate::notation::parse;
    use serde_json::json;

    #[test]
    fn to_json_is_prosemirror_shaped() {
        let (doc, _) = parse("<heading level=2>a<bold>b</bold></heading>").unwrap();
        assert_eq!(
            doc.to_json(),
            json!({"type": "doc", "content": [{
                "type": "heading",
                "attrs": doc.content[0].attrs,
                "content": [
                    {"type": "text", "text": "a"},
                    {"type": "text", "text": "b", "marks": [{"type": "bold"}]}
                ]
            }]})
        );
        assert_eq!(doc.content[0].attrs["level"], json!(2));
    }
}
