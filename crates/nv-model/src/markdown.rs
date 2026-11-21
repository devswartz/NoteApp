//! Page content → Markdown, for exports and the AI connector (server/markdown.ts). Covers the
//! editor's node types; unknown nodes fall back to their children.

use crate::js;
use crate::lists::{list_marker, list_suffix, xml_list_start};
use crate::page::Fragment;
use crate::tree::{Insert, Node, Run};

/// What the task lookup knows about a task id.
#[derive(Debug, Clone, PartialEq)]
pub enum TaskLine {
    /// Shown as a checklist line, its notes indented under it.
    Shown {
        title: String,
        done: bool,
        due: Option<String>,
    },
    /// Can't be shown: its notes still are, unindented.
    Unknown,
    /// Left out on purpose, with its notes.
    Hidden,
}

fn inline(runs: &[Run]) -> String {
    runs.iter()
        .map(|r| {
            let Insert::Text(text) = &r.insert else {
                return String::new();
            };
            let mut s = text.clone();
            if js::truthy(r.attr("code")) {
                return format!("`{s}`");
            }
            if js::truthy(r.attr("bold")) {
                s = format!("**{s}**");
            }
            if js::truthy(r.attr("italic")) {
                s = format!("*{s}*");
            }
            if js::truthy(r.attr("strike")) {
                s = format!("~~{s}~~");
            }
            let href = js::field(r.attr("link"), "href");
            if js::truthy(href) {
                s = format!("[{s}]({})", js::to_string(href));
            }
            s
        })
        .collect()
}

fn text_of(n: &Node) -> String {
    n.children()
        .iter()
        .map(|c| match c {
            Node::Text(runs) => inline(runs),
            _ => text_of(c),
        })
        .collect()
}

fn blocks_of(nodes: &[Node], tasks: &dyn Fn(&str) -> TaskLine, indent: &str) -> Vec<String> {
    (0..nodes.len())
        .flat_map(|i| block(nodes, i, tasks, indent))
        .collect()
}

/// The Markdown lines of `siblings[index]` (the siblings number ordered lists).
pub fn block(
    siblings: &[Node],
    index: usize,
    tasks: &dyn Fn(&str) -> TaskLine,
    indent: &str,
) -> Vec<String> {
    let n = &siblings[index];
    let el = match n {
        Node::Text(runs) => return vec![format!("{indent}{}", inline(runs))],
        Node::Other => return Vec::new(),
        Node::Element(el) => el,
    };
    let kids = &el.children;
    match el.tag.as_str() {
        "paragraph" => vec![format!("{indent}{}", text_of(n))],
        "heading" => {
            let level = js::number_or_one(el.attr("level")).max(0.0).floor() as usize;
            vec![format!("{} {}", "#".repeat(level), text_of(n))]
        }
        "blockquote" => blocks_of(kids, tasks, "")
            .into_iter()
            .map(|l| format!("> {l}"))
            .collect(),
        "codeBlock" => vec![
            format!("```{}", js::string_or_empty(el.attr("language"))),
            text_of(n),
            "```".into(),
        ],
        "horizontalRule" => vec!["---".into()],
        "image" => vec![format!(
            "![{}]({})",
            js::string_or_empty(el.attr("alt")),
            js::to_string(el.attr("src"))
        )],
        "bulletList" | "orderedList" | "taskList" => {
            let start = if el.tag == "orderedList" {
                xml_list_start(siblings, index)
            } else {
                0.0
            };
            let child_indent = format!("{indent}  ");
            kids.iter()
                .enumerate()
                .flat_map(|(i, item)| {
                    let marker = match el.tag.as_str() {
                        "orderedList" => format!(
                            "{}{}",
                            list_marker(el.attr("type"), start + i as f64),
                            list_suffix(el.attr("paren"))
                        ),
                        "taskList" => {
                            let checked = item.element().and_then(|e| e.attr("checked"));
                            format!("- [{}]", if js::truthy(checked) { 'x' } else { ' ' })
                        }
                        _ => "-".into(),
                    };
                    let lines = blocks_of(item.children(), tasks, &child_indent);
                    let mut lines = lines.into_iter();
                    let first = lines.next().unwrap_or_default();
                    let mut out = vec![format!("{indent}{marker} {}", js::trim_start(&first))];
                    out.extend(lines);
                    out
                })
                .collect()
        }
        "taskRef" => {
            // The task's line, then the notes under it indented one level (kept even when the task can't be shown).
            let id = js::string_or_empty(el.attr("taskId"));
            match tasks(&id) {
                TaskLine::Hidden => Vec::new(),
                TaskLine::Unknown => blocks_of(kids, tasks, indent),
                TaskLine::Shown { title, done, due } => {
                    let due = due
                        .filter(|d| !d.is_empty())
                        .map(|d| format!(" (due {d})"))
                        .unwrap_or_default();
                    let mut out = vec![format!(
                        "{indent}- [{}] {title}{due}",
                        if done { 'x' } else { ' ' }
                    )];
                    out.extend(blocks_of(kids, tasks, &format!("{indent}  ")));
                    out
                }
            }
        }
        "table" => {
            let rows: Vec<Vec<String>> = kids
                .iter()
                .map(|r| {
                    r.children()
                        .iter()
                        .map(|c| text_of(c).replace('|', "\\|"))
                        .collect()
                })
                .collect();
            let Some(head) = rows.first() else {
                return Vec::new();
            };
            let mut out = vec![
                format!("| {} |", head.join(" | ")),
                format!(
                    "| {} |",
                    head.iter().map(|_| "---").collect::<Vec<_>>().join(" | ")
                ),
            ];
            out.extend(rows[1..].iter().map(|r| format!("| {} |", r.join(" | "))));
            out
        }
        _ => blocks_of(kids, tasks, indent),
    }
}

/// The Markdown of some content without the title heading; fragments run on in order.
pub fn markdown_body(fragments: &[Fragment], tasks: &dyn Fn(&str) -> TaskLine) -> String {
    let mut out = String::new();
    // Every fragment's nodes as one run (a task line can be tight with one at the end of the box before).
    let all: Vec<(&[Node], usize)> = fragments
        .iter()
        .flat_map(|f| (0..f.nodes.len()).map(move |i| (f.nodes.as_slice(), i)))
        .collect();
    for (k, &(sibs, i)) in all.iter().enumerate() {
        let text = block(sibs, i, tasks, "").join("\n");
        if text.is_empty() {
            continue;
        }
        // Consecutive embedded tasks form one tight checklist.
        let tight = k > 0 && sibs[i].is("taskRef") && {
            let (ps, pi) = all[k - 1];
            ps[pi].is("taskRef")
        };
        if !out.is_empty() {
            out.push_str(if tight { "\n" } else { "\n\n" });
        }
        out.push_str(&text);
    }
    js::trim(&js::collapse_newlines(&out)).to_string()
}

/// A page as Markdown: `# title` then the body.
pub fn to_markdown(
    title: &str,
    fragments: &[Fragment],
    tasks: &dyn Fn(&str) -> TaskLine,
) -> String {
    let title = if title.is_empty() { "Untitled" } else { title };
    format!("# {title}\n\n{}\n", markdown_body(fragments, tasks))
}
