//! A page fragment as an owned tree: what the readers (text, Markdown, headings) walk.
//! The shape is y-prosemirror's: elements are blocks and inline atoms, text is an `XmlText`
//! whose formatting attributes are the marks.

use yrs::types::text::YChange;
use yrs::types::ToJson;
use yrs::{Any, Out, ReadTxn, Text, Xml, XmlFragment, XmlOut};

/// One node of a fragment.
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Element(Element),
    Text(Vec<Run>),
    /// Anything else a hand-built update put in a fragment; readers skip it.
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Element {
    pub tag: String,
    /// Every attribute, sorted by name.
    pub attrs: Vec<(String, Any)>,
    pub children: Vec<Node>,
}

/// One delta op of a text node: a stretch of text (or an embed) with the same marks.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub insert: Insert,
    /// Formatting attributes, sorted by name (y-prosemirror: mark name, or `name--<hash>` for marks that may overlap).
    pub attrs: Vec<(String, Any)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Insert {
    Text(String),
    Embed(Any),
}

impl Element {
    pub fn attr(&self, k: &str) -> Option<&Any> {
        self.attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }
    /// A string attribute (`typeof v === 'string'`).
    pub fn str_attr(&self, k: &str) -> Option<&str> {
        match self.attr(k) {
            Some(Any::String(s)) => Some(s),
            _ => None,
        }
    }
}

impl Run {
    pub fn attr(&self, k: &str) -> Option<&Any> {
        self.attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }
}

impl Node {
    pub fn element(&self) -> Option<&Element> {
        match self {
            Node::Element(e) => Some(e),
            _ => None,
        }
    }
    pub fn is(&self, tag: &str) -> bool {
        self.element().is_some_and(|e| e.tag == tag)
    }
    pub fn children(&self) -> &[Node] {
        match self {
            Node::Element(e) => &e.children,
            _ => &[],
        }
    }
}

/// The plain text of a text node's string inserts.
pub fn runs_text(runs: &[Run]) -> String {
    runs.iter()
        .filter_map(|r| match &r.insert {
            Insert::Text(s) => Some(s.as_str()),
            Insert::Embed(_) => None,
        })
        .collect()
}

fn out_json<T: ReadTxn>(txn: &T, v: &Out) -> Any {
    match v {
        Out::Any(a) => a.clone(),
        other => other.to_json(txn),
    }
}

fn sorted(mut v: Vec<(String, Any)>) -> Vec<(String, Any)> {
    v.sort_by(|a, b| crate::js::cmp_str(&a.0, &b.0));
    v
}

pub(crate) fn read_node<T: ReadTxn>(txn: &T, n: &XmlOut) -> Node {
    match n {
        XmlOut::Element(el) => Node::Element(Element {
            tag: el.tag().to_string(),
            attrs: sorted(
                el.attributes(txn)
                    .map(|(k, v)| (k.to_string(), out_json(txn, &v)))
                    .collect(),
            ),
            children: el.children(txn).map(|c| read_node(txn, &c)).collect(),
        }),
        XmlOut::Text(t) => Node::Text(
            t.diff(txn, YChange::identity)
                .into_iter()
                .map(|d| Run {
                    insert: match &d.insert {
                        Out::Any(Any::String(s)) => Insert::Text(s.to_string()),
                        other => Insert::Embed(out_json(txn, other)),
                    },
                    attrs: sorted(
                        d.attributes
                            .map(|a| a.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
                            .unwrap_or_default(),
                    ),
                })
                .collect(),
        ),
        XmlOut::Fragment(_) => Node::Other,
    }
}

/// A root fragment's nodes (none when the root doesn't exist).
pub(crate) fn read_fragment<T: ReadTxn>(txn: &T, name: &str) -> Vec<Node> {
    match txn.get_xml_fragment(name) {
        Some(f) => f.children(txn).map(|c| read_node(txn, &c)).collect(),
        None => Vec::new(),
    }
}
