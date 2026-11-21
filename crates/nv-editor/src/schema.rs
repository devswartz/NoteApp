//! Today's document schema: node and mark names, content rules, attributes and their defaults.
//! Read from `tests/editor/schema.json`, which is exported from the live TipTap schema
//! (`node --import tsx tests/editor/run-tiptap.ts --schema`), so the two can't drift.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::LazyLock;

pub type Attrs = Map<String, Value>;

const SCHEMA_JSON: &str = include_str!("../../../tests/editor/schema.json");

/// The schema, loaded once.
pub static SCHEMA: LazyLock<Schema> = LazyLock::new(|| Schema::from_json(SCHEMA_JSON));

pub fn schema() -> &'static Schema {
    &SCHEMA
}

#[derive(Debug, Clone)]
pub struct NodeType {
    pub name: String,
    pub groups: Vec<String>,
    pub content: Option<Expr>,
    /// Marks allowed inside (`None`: all; `Some("")`: none).
    pub marks: Option<String>,
    pub inline: bool,
    pub atom: bool,
    pub leaf: bool,
    pub textblock: bool,
    pub code: bool,
    pub isolating: bool,
    pub defining: bool,
    pub attrs: Attrs,
    pub rank: usize,
}

#[derive(Debug, Clone)]
pub struct MarkType {
    pub name: String,
    pub inclusive: bool,
    /// Mark names this one excludes (besides itself); `_` is every mark.
    pub excludes: Option<String>,
    pub attrs: Attrs,
    pub rank: usize,
}

#[derive(Debug)]
pub struct Schema {
    pub nodes: HashMap<String, NodeType>,
    pub marks: HashMap<String, MarkType>,
    pub node_order: Vec<String>,
    pub mark_order: Vec<String>,
}

/// A content expression (`paragraph block*`, `(tableCell | tableHeader)*`).
#[derive(Debug, Clone)]
pub enum Expr {
    Name(String),
    Seq(Vec<Expr>),
    Choice(Vec<Expr>),
    Repeat(Box<Expr>, usize, bool), // min, unbounded
}

impl Schema {
    fn from_json(src: &str) -> Schema {
        let v: Value = serde_json::from_str(src).expect("tests/editor/schema.json");
        let strs = |k: &str| -> Vec<String> {
            v[k].as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_string())
                .collect()
        };
        let node_order = strs("nodeOrder");
        let mark_order = strs("markOrder");
        let mut nodes = HashMap::new();
        for (rank, name) in node_order.iter().enumerate() {
            let n = &v["nodes"][name];
            let content = n["content"].as_str().unwrap_or("");
            nodes.insert(
                name.clone(),
                NodeType {
                    name: name.clone(),
                    groups: n["group"]
                        .as_str()
                        .unwrap_or("")
                        .split_whitespace()
                        .map(String::from)
                        .collect(),
                    content: if content.is_empty() {
                        None
                    } else {
                        Some(parse_expr(content))
                    },
                    marks: n["marks"].as_str().map(String::from),
                    inline: n["inline"].as_bool().unwrap_or(false),
                    atom: n["atom"].as_bool().unwrap_or(false),
                    leaf: n["leaf"].as_bool().unwrap_or(false),
                    textblock: n["textblock"].as_bool().unwrap_or(false),
                    code: n["code"].as_bool().unwrap_or(false),
                    isolating: n["isolating"].as_bool().unwrap_or(false),
                    defining: n["defining"].as_bool().unwrap_or(false),
                    attrs: n["attrs"].as_object().cloned().unwrap_or_default(),
                    rank,
                },
            );
        }
        let mut marks = HashMap::new();
        for (rank, name) in mark_order.iter().enumerate() {
            let m = &v["marks"][name];
            marks.insert(
                name.clone(),
                MarkType {
                    name: name.clone(),
                    inclusive: m["inclusive"].as_bool().unwrap_or(true),
                    excludes: m["excludes"].as_str().map(String::from),
                    attrs: m["attrs"].as_object().cloned().unwrap_or_default(),
                    rank,
                },
            );
        }
        Schema {
            nodes,
            marks,
            node_order,
            mark_order,
        }
    }

    pub fn node(&self, name: &str) -> &NodeType {
        self.nodes
            .get(name)
            .unwrap_or_else(|| panic!("unknown node type {name}"))
    }

    pub fn mark(&self, name: &str) -> &MarkType {
        self.marks
            .get(name)
            .unwrap_or_else(|| panic!("unknown mark type {name}"))
    }

    pub fn is_mark(&self, name: &str) -> bool {
        self.marks.contains_key(name)
    }

    /// Does a node of type `kind` fit where the expression names `name` (a type or a group)?
    pub fn fits(&self, name: &str, kind: &str) -> bool {
        name == kind || self.node(kind).groups.iter().any(|g| g == name)
    }

    /// Whether `children` (node type names) is valid content for `parent`.
    pub fn valid_content(&self, parent: &str, children: &[&str]) -> bool {
        match &self.node(parent).content {
            None => children.is_empty(),
            Some(e) => self.ends(e, children, 0).contains(&children.len()),
        }
    }

    /// Every index the expression can stop at, matching `kinds` from `start`.
    fn ends(&self, e: &Expr, kinds: &[&str], start: usize) -> Vec<usize> {
        match e {
            Expr::Name(n) => {
                if start < kinds.len() && self.fits(n, kinds[start]) {
                    vec![start + 1]
                } else {
                    vec![]
                }
            }
            Expr::Seq(items) => {
                let mut at = vec![start];
                for it in items {
                    let mut next: Vec<usize> =
                        at.iter().flat_map(|&s| self.ends(it, kinds, s)).collect();
                    next.sort_unstable();
                    next.dedup();
                    at = next;
                }
                at
            }
            Expr::Choice(alts) => {
                let mut out: Vec<usize> = alts
                    .iter()
                    .flat_map(|a| self.ends(a, kinds, start))
                    .collect();
                out.sort_unstable();
                out.dedup();
                out
            }
            Expr::Repeat(inner, min, unbounded) => {
                let mut out = Vec::new();
                if *min == 0 {
                    out.push(start);
                }
                let mut frontier = vec![start];
                let max = if *unbounded {
                    kinds.len() - start.min(kinds.len()) + 1
                } else {
                    1
                };
                for count in 1..=max.max(*min) {
                    let mut next: Vec<usize> = frontier
                        .iter()
                        .flat_map(|&s| {
                            self.ends(inner, kinds, s)
                                .into_iter()
                                .filter(move |&e| e > s)
                        })
                        .collect();
                    next.sort_unstable();
                    next.dedup();
                    if next.is_empty() {
                        break;
                    }
                    if count >= *min {
                        out.extend(next.iter().copied());
                    }
                    frontier = next;
                }
                out.sort_unstable();
                out.dedup();
                out
            }
        }
    }

    /// The first node type (in schema order) that fits `name` and isn't text: what fills required content.
    pub fn default_type(&self, name: &str) -> Option<&str> {
        self.node_order
            .iter()
            .map(String::as_str)
            .find(|k| *k != "text" && self.fits(name, k))
    }

    /// The node types required to make `parent`'s content valid when empty, in order.
    pub fn required_children(&self, parent: &str) -> Vec<&str> {
        fn req<'a>(s: &'a Schema, e: &'a Expr, out: &mut Vec<&'a str>) {
            match e {
                Expr::Name(n) => {
                    if let Some(t) = s.default_type(n) {
                        out.push(t)
                    }
                }
                Expr::Seq(items) => items.iter().for_each(|i| req(s, i, out)),
                Expr::Choice(alts) => {
                    if let Some(a) = alts.first() {
                        req(s, a, out)
                    }
                }
                Expr::Repeat(inner, min, _) => {
                    for _ in 0..*min {
                        req(s, inner, out)
                    }
                }
            }
        }
        let mut out = Vec::new();
        if let Some(e) = &self.node(parent).content {
            req(self, e, &mut out);
        }
        out
    }

    /// Does `parent`'s content allow text / inline nodes?
    pub fn allows_mark(&self, parent: &str, mark: &str) -> bool {
        match &self.node(parent).marks {
            None => true,
            Some(m) => m == "_" || m.split_whitespace().any(|x| x == mark),
        }
    }
}

fn parse_expr(src: &str) -> Expr {
    let toks: Vec<String> = src
        .replace('(', " ( ")
        .replace(')', " ) ")
        .replace('|', " | ")
        .split_whitespace()
        .map(String::from)
        .collect();
    let mut i = 0;
    let e = parse_choice(&toks, &mut i);
    assert!(i == toks.len(), "bad content expression {src}");
    e
}

fn parse_choice(t: &[String], i: &mut usize) -> Expr {
    let mut alts = vec![parse_seq(t, i)];
    while *i < t.len() && t[*i] == "|" {
        *i += 1;
        alts.push(parse_seq(t, i));
    }
    if alts.len() == 1 {
        alts.pop().unwrap()
    } else {
        Expr::Choice(alts)
    }
}

fn parse_seq(t: &[String], i: &mut usize) -> Expr {
    let mut items = Vec::new();
    while *i < t.len() && t[*i] != "|" && t[*i] != ")" {
        let atom = if t[*i] == "(" {
            *i += 1;
            let e = parse_choice(t, i);
            assert_eq!(t[*i], ")");
            *i += 1;
            e
        } else {
            let tok = &t[*i];
            *i += 1;
            let (name, suffix) = match tok.chars().last() {
                Some(c @ ('*' | '+' | '?')) => (&tok[..tok.len() - 1], Some(c)),
                _ => (tok.as_str(), None),
            };
            let e = Expr::Name(name.to_string());
            match suffix {
                Some(c) => repeat(e, c),
                None => e,
            }
        };
        // A suffix after a group: `(a | b)*` tokenises as `)` then `*`.
        let atom = if *i < t.len() && matches!(t[*i].as_str(), "*" | "+" | "?") {
            let c = t[*i].chars().next().unwrap();
            *i += 1;
            repeat(atom, c)
        } else {
            atom
        };
        items.push(atom);
    }
    if items.len() == 1 {
        items.pop().unwrap()
    } else {
        Expr::Seq(items)
    }
}

fn repeat(e: Expr, c: char) -> Expr {
    match c {
        '*' => Expr::Repeat(Box::new(e), 0, true),
        '+' => Expr::Repeat(Box::new(e), 1, true),
        _ => Expr::Repeat(Box::new(e), 0, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_rules() {
        let s = schema();
        assert!(s.valid_content("listItem", &["paragraph", "bulletList"]));
        assert!(!s.valid_content("listItem", &["bulletList"]));
        assert!(s.valid_content("tableRow", &["tableCell", "tableHeader"]));
        assert!(s.valid_content("details", &["detailsSummary", "detailsContent"]));
        assert!(!s.valid_content("doc", &[]));
        assert!(s.valid_content("taskRef", &[]));
        assert_eq!(s.required_children("listItem"), vec!["paragraph"]);
        assert_eq!(s.required_children("doc"), vec!["paragraph"]);
        assert_eq!(
            s.required_children("details"),
            vec!["detailsSummary", "detailsContent"]
        );
    }
}
