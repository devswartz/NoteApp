//! Ordered-list numbering (shared/listMarker.ts): markers for plain-text exports, and list starts
//! following `continued` lists on from the one before.

use yrs::Any;

use crate::js;
use crate::tree::Node;

/// An ordered list's marker: numbers, or the letters / roman numerals of a list typed as "a. " or "i. ".
pub fn list_marker(kind: Option<&Any>, n: f64) -> String {
    let kind = match kind {
        Some(Any::String(s)) => &**s,
        _ => "",
    };
    match kind {
        "a" | "A" => {
            let mut s = String::new();
            let mut k = n;
            while k > 0.0 {
                let code = (97.0 + (k - 1.0) % 26.0).trunc() as u32;
                s.insert(0, char::from_u32(code).unwrap_or('\u{FFFD}'));
                k = ((k - 1.0) / 26.0).floor();
            }
            if kind == "A" {
                s.to_uppercase()
            } else {
                s
            }
        }
        "i" | "I" => {
            const ROMAN: [(f64, &str); 13] = [
                (1000.0, "m"),
                (900.0, "cm"),
                (500.0, "d"),
                (400.0, "cd"),
                (100.0, "c"),
                (90.0, "xc"),
                (50.0, "l"),
                (40.0, "xl"),
                (10.0, "x"),
                (9.0, "ix"),
                (5.0, "v"),
                (4.0, "iv"),
                (1.0, "i"),
            ];
            let mut s = String::new();
            let mut k = n;
            for (v, r) in ROMAN {
                while k >= v {
                    s.push_str(r);
                    k -= v;
                }
            }
            if kind == "I" {
                s.to_uppercase()
            } else {
                s
            }
        }
        _ => js::number_string(n),
    }
}

/// "." or, for a list typed as "1) ", ")".
pub fn list_suffix(paren: Option<&Any>) -> &'static str {
    if js::truthy(paren) {
        ")"
    } else {
        "."
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ListInfo {
    pub ordered: bool,
    pub start: f64,
    /// Carries on from the numbered list before it (split by Enter in the editor).
    pub continued: bool,
    pub items: usize,
}

/// The first number of each ordered list among sibling blocks, following `continued` lists on.
pub fn list_starts(siblings: &[ListInfo]) -> Vec<Option<f64>> {
    let mut next = 1.0;
    siblings
        .iter()
        .map(|b| {
            if !b.ordered {
                return None;
            }
            let start = if b.continued {
                next
            } else if b.start == 0.0 || b.start.is_nan() {
                1.0
            } else {
                b.start
            };
            next = start + b.items as f64;
            Some(start)
        })
        .collect()
}

fn info(n: &Node) -> ListInfo {
    match n {
        Node::Element(el) => ListInfo {
            ordered: el.tag == "orderedList",
            start: js::number_or_one(el.attr("start")),
            continued: js::truthy(el.attr("continued")),
            items: el.children.len(),
        },
        Node::Text(_) | Node::Other => ListInfo {
            ordered: false,
            start: 1.0,
            continued: false,
            items: 0,
        },
    }
}

/// The first number of the ordered list at `siblings[index]` (`xmlListStart`).
pub fn xml_list_start(siblings: &[Node], index: usize) -> f64 {
    let infos: Vec<ListInfo> = siblings[..=index].iter().map(info).collect();
    list_starts(&infos).last().copied().flatten().unwrap_or(1.0)
}
