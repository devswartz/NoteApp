//! The editor suite's document notation (tests/editor/README.md), the Rust twin of
//! `tests/editor/notation.ts`: `<paragraph>Hel|lo <bold>x</bold></paragraph>`.

use crate::node::{u16_len, Mark, Node};
use crate::schema::{schema, Attrs};
use crate::selection::Selection;
use serde_json::Value;

#[derive(Debug)]
enum Tok {
    Open(String, Attrs, bool),
    Close(String),
    Text(String),
    Marker(char),
}

fn tokenize(src: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut text = String::new();
    let flush = |text: &mut String, out: &mut Vec<Tok>| {
        if !text.is_empty() && !(text.trim().is_empty() && text.contains('\n')) {
            out.push(Tok::Text(std::mem::take(text)));
        }
        text.clear();
    };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                if let Some(n) = chars.get(i + 1) {
                    text.push(*n);
                }
                i += 2;
            }
            '|' | '[' | ']' | '^' => {
                flush(&mut text, &mut out);
                out.push(Tok::Marker(c));
                i += 1;
            }
            '<' => {
                flush(&mut text, &mut out);
                let mut j = i + 1;
                let mut quoted = false;
                while j < chars.len() {
                    let d = chars[j];
                    if quoted {
                        if d == '\\' {
                            j += 1;
                        } else if d == '"' {
                            quoted = false;
                        }
                    } else if d == '"' {
                        quoted = true;
                    } else if d == '>' {
                        break;
                    }
                    j += 1;
                }
                if j >= chars.len() {
                    return Err("unclosed tag".into());
                }
                let body: String = chars[i + 1..j].iter().collect();
                let body = body.trim();
                i = j + 1;
                if let Some(name) = body.strip_prefix('/') {
                    out.push(Tok::Close(name.trim().to_string()));
                    continue;
                }
                let self_close = body.ends_with('/');
                let inner = if self_close {
                    body[..body.len() - 1].trim()
                } else {
                    body
                };
                let name_end = inner
                    .find(|c: char| c.is_whitespace())
                    .unwrap_or(inner.len());
                let name = &inner[..name_end];
                out.push(Tok::Open(
                    name.to_string(),
                    parse_attrs(&inner[name_end..])?,
                    self_close,
                ));
            }
            _ => {
                text.push(c);
                i += 1;
            }
        }
    }
    flush(&mut text, &mut out);
    Ok(out)
}

fn parse_attrs(s: &str) -> Result<Attrs, String> {
    let mut attrs = Attrs::new();
    let b = s.as_bytes();
    let mut i = 0;
    loop {
        while i < b.len() && (b[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return Ok(attrs);
        }
        let k0 = i;
        while i < b.len() && b[i] != b'=' {
            i += 1;
        }
        let key = s[k0..i].trim().to_string();
        i += 1;
        let v0 = i;
        if i < b.len() && b[i] == b'"' {
            i += 1;
            while i < b.len() && b[i] != b'"' {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
        } else {
            while i < b.len() && !(b[i] as char).is_whitespace() {
                i += 1;
            }
        }
        let v: Value =
            serde_json::from_str(&s[v0..i]).map_err(|e| format!("bad attribute {key}: {e}"))?;
        attrs.insert(key, v);
    }
}

/// Parse notation into a doc and the selection it marks.
pub fn parse(src: &str) -> Result<(Node, Option<Selection>), String> {
    let toks = tokenize(src)?;
    let mut st = P {
        toks,
        i: 0,
        pos: 0,
        anchor: None,
        head: None,
        node: None,
    };
    let content = st.children(None, &[])?;
    let mut doc = Node::el("doc", content);
    doc.normalize();
    let sel = match (st.node, st.anchor, st.head) {
        (Some(p), _, _) => Some(Selection::Node { pos: p }),
        (None, Some(a), h) => {
            let h = h.unwrap_or(a);
            if a == 0 && h == doc.content_size() && a != h {
                Some(Selection::All)
            } else {
                Some(Selection::Text { anchor: a, head: h })
            }
        }
        (None, None, Some(h)) => Some(Selection::Text { anchor: h, head: h }),
        _ => None,
    };
    Ok((doc, sel))
}

struct P {
    toks: Vec<Tok>,
    i: usize,
    pos: usize,
    anchor: Option<usize>,
    head: Option<usize>,
    node: Option<usize>,
}

impl P {
    fn children(&mut self, until: Option<&str>, marks: &[Mark]) -> Result<Vec<Node>, String> {
        let mut out = Vec::new();
        while self.i < self.toks.len() {
            let i = self.i;
            self.i += 1;
            match &self.toks[i] {
                Tok::Close(n) => {
                    if Some(n.as_str()) != until {
                        return Err(format!("</{n}> closes <{until:?}>"));
                    }
                    return Ok(out);
                }
                Tok::Marker(m) => match m {
                    '|' => {
                        self.anchor = Some(self.pos);
                        self.head = Some(self.pos);
                    }
                    '[' => self.anchor = Some(self.pos),
                    '^' => self.node = Some(self.pos),
                    _ => self.head = Some(self.pos),
                },
                Tok::Text(t) => {
                    let t = t.clone();
                    self.pos += u16_len(&t);
                    out.push(Node::text(&t, marks.to_vec()));
                }
                Tok::Open(name, attrs, self_close) => {
                    let (name, attrs, self_close) = (name.clone(), attrs.clone(), *self_close);
                    if schema().is_mark(&name) {
                        if !self_close {
                            let mut ms = marks.to_vec();
                            ms.push(Mark::new(&name, attrs));
                            ms.sort_by_key(Mark::rank);
                            out.extend(self.children(Some(&name), &ms)?);
                        }
                        continue;
                    }
                    if !schema().nodes.contains_key(&name) {
                        return Err(format!("unknown node <{name}>"));
                    }
                    let mut node = Node::new(&name, attrs, Vec::new());
                    if node.is_leaf() {
                        self.pos += 1;
                        if !self_close {
                            self.children(Some(&name), marks)?;
                        }
                        node.marks = marks.to_vec();
                    } else {
                        self.pos += 1;
                        if !self_close {
                            let inherited: Vec<Mark> = if node.is_textblock() {
                                marks.to_vec()
                            } else {
                                Vec::new()
                            };
                            node.content = self.children(Some(&name), &inherited)?;
                        }
                        self.pos += 1;
                    }
                    out.push(node);
                }
            }
        }
        match until {
            Some(u) => Err(format!("<{u}> not closed")),
            None => Ok(out),
        }
    }
}

fn esc(c: char, out: &mut String) {
    if matches!(c, '<' | '>' | '|' | '[' | ']' | '^' | '\\') {
        out.push('\\');
    }
    out.push(c);
}

fn attr_text(attrs: &Attrs, defaults: &Attrs, rename: &dyn Fn(&str, &Value) -> Value) -> String {
    let mut keys: Vec<&String> = attrs.keys().collect();
    keys.sort();
    let mut s = String::new();
    for k in keys {
        let v = &attrs[k];
        if Some(v) == defaults.get(k) || (v.is_null() && !defaults.contains_key(k)) {
            continue;
        }
        s.push(' ');
        s.push_str(k);
        s.push('=');
        s.push_str(&serde_json::to_string(&rename(k, v)).unwrap());
    }
    s
}

/// Serialise a doc in the notation, one top-level block per line, marking `sel`.
/// `rename` rewrites attribute values (task ids to their suite names).
pub fn serialize(
    doc: &Node,
    sel: Option<&Selection>,
    rename: &dyn Fn(&str, &Value) -> Value,
) -> String {
    let size = doc.content_size();
    let marker = |p: usize| -> String {
        match sel {
            None => String::new(),
            Some(Selection::Node { pos }) => {
                if p == *pos {
                    "^".into()
                } else {
                    String::new()
                }
            }
            Some(Selection::All) => {
                if p == 0 && p == size {
                    "|".into()
                } else if p == 0 {
                    "[".into()
                } else if p == size {
                    "]".into()
                } else {
                    String::new()
                }
            }
            Some(Selection::Text { anchor, head }) => {
                if anchor == head {
                    if p == *anchor {
                        "|".into()
                    } else {
                        String::new()
                    }
                } else {
                    let mut s = String::new();
                    if p == *anchor {
                        s.push('[');
                    }
                    if p == *head {
                        s.push(']');
                    }
                    s
                }
            }
        }
    };
    fn node(
        n: &Node,
        pos: usize,
        m: &dyn Fn(usize) -> String,
        r: &dyn Fn(&str, &Value) -> Value,
    ) -> String {
        let a = attr_text(&n.attrs, &schema().node(&n.kind).attrs, r);
        if n.is_leaf() {
            return format!("<{}{}/>", n.kind, a);
        }
        if n.content.is_empty() {
            return format!("<{}{}>{}</{}>", n.kind, a, m(pos + 1), n.kind);
        }
        format!(
            "<{}{}>{}</{}>",
            n.kind,
            a,
            content(n, pos + 1, m, r),
            n.kind
        )
    }
    fn content(
        parent: &Node,
        start: usize,
        m: &dyn Fn(usize) -> String,
        r: &dyn Fn(&str, &Value) -> Value,
    ) -> String {
        let mut s = String::new();
        let mut open: Vec<Mark> = Vec::new();
        let mut p = start;
        for child in &parent.content {
            let marks: &[Mark] = if child.is_inline() { &child.marks } else { &[] };
            let mut keep = 0;
            while keep < open.len() && keep < marks.len() && open[keep] == marks[keep] {
                keep += 1;
            }
            for k in (keep..open.len()).rev() {
                s.push_str(&format!("</{}>", open[k].kind));
            }
            open.truncate(keep);
            for mk in &marks[keep..] {
                let a = attr_text(&mk.attrs, &schema().mark(&mk.kind).attrs, r);
                s.push_str(&format!("<{}{}>", mk.kind, a));
                open.push(mk.clone());
            }
            if child.is_text() {
                let mut q = p;
                for c in child.text.chars() {
                    s.push_str(&m(q));
                    esc(c, &mut s);
                    q += c.len_utf16();
                }
            } else {
                s.push_str(&m(p));
                s.push_str(&node(child, p, m, r));
            }
            p += child.node_size();
        }
        for k in (0..open.len()).rev() {
            s.push_str(&format!("</{}>", open[k].kind));
        }
        s.push_str(&m(p));
        s
    }
    let mut lines = Vec::new();
    let mut p = 0;
    for child in &doc.content {
        lines.push(format!("{}{}", marker(p), node(child, p, &marker, rename)));
        p += child.node_size();
    }
    if let Some(last) = lines.last_mut() {
        last.push_str(&marker(p));
    }
    lines.join("\n")
}

/// Canonical form of notation text (parse, then serialise), for comparing expectations.
pub fn canonical(src: &str, with_selection: bool) -> Result<String, String> {
    let (doc, sel) = parse(src)?;
    Ok(serialize(
        &doc,
        if with_selection { sel.as_ref() } else { None },
        &|_, v| v.clone(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        for src in [
            "<paragraph>Hel|lo <bold>wor<italic>ld</italic></bold></paragraph>",
            "<heading level=2>[a]</heading>\n<paragraph></paragraph>",
            "<bulletList><listItem><paragraph>a</paragraph></listItem></bulletList>",
            "^<taskRef taskId=\"t1\"></taskRef>",
            "<paragraph>a<hardBreak/>b \\[x\\]</paragraph>",
        ] {
            assert_eq!(canonical(src, true).unwrap(), src);
        }
    }

    #[test]
    fn positions() {
        let (doc, sel) = parse("<paragraph>ab</paragraph><paragraph>c|d</paragraph>").unwrap();
        assert_eq!(doc.content_size(), 8);
        assert_eq!(sel, Some(Selection::Text { anchor: 6, head: 6 }));
    }
}
