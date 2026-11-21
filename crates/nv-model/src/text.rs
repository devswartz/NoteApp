//! Plain text, task and mention references (server/collab.ts extractPage / extractDoc, what search
//! indexes) and the outline's headings (shared/pageDoc.ts pageHeadings).

use std::collections::BTreeSet;

use crate::js;
use crate::page::Page;
use crate::tree::{runs_text, Node};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Extracted {
    pub text: String,
    pub task_ids: BTreeSet<String>,
    pub mention_ids: BTreeSet<String>,
}

fn walk(n: &Node, out: &mut Extracted, parts: &mut String) {
    match n {
        Node::Text(runs) => parts.push_str(&runs_text(runs)),
        Node::Element(el) => {
            if el.tag == "taskRef" {
                if let Some(id) = el.str_attr("taskId").filter(|s| !s.is_empty()) {
                    out.task_ids.insert(id.to_string());
                }
            } else if el.tag == "mention" {
                if let Some(id) = el.str_attr("id").filter(|s| !s.is_empty()) {
                    out.mention_ids.insert(id.to_string());
                }
                if let Some(label) = el.str_attr("label").filter(|s| !s.is_empty()) {
                    parts.push('@');
                    parts.push_str(label);
                }
            }
            for c in &el.children {
                walk(c, out, parts);
            }
            parts.push('\n');
        }
        Node::Other => {}
    }
}

/// One fragment's text and references (`extractDoc`).
pub fn extract_nodes(nodes: &[Node]) -> Extracted {
    let mut out = Extracted::default();
    let mut parts = String::new();
    for n in nodes {
        walk(n, &mut out, &mut parts);
    }
    out.text = js::trim(&js::collapse_newlines(&parts)).to_string();
    out
}

/// A whole page's text and references: every fragment in reading order (`extractPage`).
pub fn extract_page(page: &Page) -> Extracted {
    let mut out = Extracted::default();
    let mut texts = Vec::new();
    for f in &page.fragments {
        let r = extract_nodes(&f.nodes);
        out.task_ids.extend(r.task_ids);
        out.mention_ids.extend(r.mention_ids);
        if !r.text.is_empty() {
            texts.push(r.text);
        }
    }
    // Recognised handwriting goes here once PLAN_INK phase I7 stores it (`inkSearchText`, empty for now).
    out.text = texts.join("\n\n");
    out
}

/// A heading of a page, for the outline.
#[derive(Debug, Clone, PartialEq)]
pub struct PageHeading {
    pub box_id: String,
    /// Index among the box's non-empty headings, in document order.
    pub index: usize,
    pub level: f64,
    pub text: String,
}

/// The text of an element as the editor shows it (marks dropped).
pub fn element_text(n: &Node) -> String {
    n.children()
        .iter()
        .map(|c| match c {
            Node::Text(runs) => runs_text(runs),
            Node::Element(_) => element_text(c),
            Node::Other => String::new(),
        })
        .collect()
}

/// Every non-empty heading of a canvas, box by box in reading order (inside containers too).
pub fn page_headings(page: &Page) -> Vec<PageHeading> {
    fn walk(nodes: &[Node], box_id: &str, index: &mut usize, out: &mut Vec<PageHeading>) {
        for c in nodes {
            let Some(el) = c.element() else { continue };
            if el.tag == "heading" {
                let text = js::trim(&element_text(c)).to_string();
                if !text.is_empty() {
                    out.push(PageHeading {
                        box_id: box_id.into(),
                        index: *index,
                        level: js::number_or_one(el.attr("level")),
                        text,
                    });
                    *index += 1;
                }
            } else {
                walk(&el.children, box_id, index, out);
            }
        }
    }
    let mut out = Vec::new();
    for f in &page.fragments {
        if let Some(id) = &f.box_id {
            walk(&f.nodes, id, &mut 0, &mut out);
        }
    }
    out
}
