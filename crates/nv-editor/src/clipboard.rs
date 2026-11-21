//! The clipboard (EDITOR.md 7): copy as plain text and HTML; paste plain text (with today's inline
//! Markdown paste rules), HTML (today's parse rules, unsafe links dropped) and URLs over a selection.

use crate::editor::{near_text, Editor};
use crate::node::{add_mark, Mark, Node};
use crate::schema::Attrs;
use crate::selection::Selection;
use crate::tasks::TASK;
use serde_json::json;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Clipboard {
    pub html: String,
    pub text: String,
}

impl Editor {
    pub fn copy(&self) -> Clipboard {
        let (from, to) = self.range();
        Clipboard {
            text: self.text_between(from, to),
            html: html_of(&self.slice_blocks(from, to)),
        }
    }

    /// Copy, then delete the selection. Task lines cut away keep their tasks (they're on their way to be pasted).
    pub fn cut(&mut self) -> Clipboard {
        let c = self.copy();
        let keep = self.known_tasks.clone();
        self.delete_selection();
        // Forget the cut lines without deleting their tasks.
        let now = crate::tasks::task_ids(&self.doc);
        self.known_tasks = keep.into_iter().filter(|id| now.contains(id)).collect();
        c
    }

    pub fn paste(&mut self, c: &Clipboard) -> bool {
        if !c.html.is_empty() {
            let blocks = parse_html(&c.html);
            if !blocks.is_empty() {
                return self.paste_blocks(blocks);
            }
        }
        self.paste_text(&c.text)
    }

    pub fn paste_text(&mut self, text: &str) -> bool {
        let t = text.trim();
        let is_url = (t.starts_with("https://") || t.starts_with("http://"))
            && !t.contains(char::is_whitespace);
        if is_url && !self.sel.is_empty() {
            let (from, to) = self.range();
            let mut a = Attrs::new();
            a.insert("href".into(), json!(t));
            self.add_mark_range(from, to, &Mark::new("link", a));
            return true;
        }
        let text = text.replace("\r\n", "\n");
        // In a code block, text goes in as it is, line breaks and all.
        if let Some(pos) = self.sel.head() {
            if self.resolve(pos).parent(&self.doc).is("codeBlock") {
                self.insert_text_raw(&text);
                return true;
            }
        }
        let blocks: Vec<Node> = text
            .split('\n')
            .map(|line| Node::el("paragraph", inline_markdown(line)))
            .collect();
        self.paste_blocks(blocks)
    }

    /// Put pasted blocks at the caret, ProseMirror style: a single line goes inline; otherwise the
    /// first block's text joins the line before the caret and the last block's the rest of it.
    pub fn paste_blocks(&mut self, mut blocks: Vec<Node>) -> bool {
        self.delete_selection();
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        if !r.parent(&self.doc).is_textblock() || blocks.is_empty() {
            return false;
        }
        for b in &mut blocks {
            b.normalize();
        }
        let path = r.path.clone();
        let block = r.parent(&self.doc).clone();
        let size = block.content_size();
        let head = block.inline_slice(0, r.parent_offset);
        let tail = block.inline_slice(r.parent_offset, size);
        if blocks.len() == 1 && blocks[0].is_textblock() {
            let ins = blocks.remove(0).content;
            let n: usize = ins.iter().map(Node::node_size).sum();
            let b = self.doc.at_mut(&path);
            b.content = [head, ins, tail].concat();
            b.normalize();
            self.sel = Selection::caret(pos + n);
            return true;
        }
        let parent = path[..path.len() - 1].to_vec();
        let i = path[path.len() - 1];
        let before = r.before(r.depth());
        let mut out: Vec<Node> = Vec::new();
        if block.content.is_empty() {
            out = blocks;
        } else {
            let mut it = blocks.into_iter();
            let first = it.next().unwrap();
            if first.is_textblock() {
                let mut b = block.copy([head, first.content].concat());
                b.normalize();
                out.push(b);
            } else {
                out.push(block.copy(head));
                out.push(first);
            }
            out.extend(it);
        }
        // Where the caret goes: the end of the last pasted text block.
        let caret_end = {
            let total: usize = out.iter().map(Node::node_size).sum();
            before + total
        };
        let last_is_tb = out.last().is_some_and(Node::is_textblock);
        if !tail.is_empty() {
            if last_is_tb {
                let l = out.last_mut().unwrap();
                l.content.extend(tail.clone());
                l.normalize();
            } else {
                out.push(Node::el("paragraph", tail.clone()));
            }
        }
        self.doc.at_mut(&parent).content.splice(i..=i, out);
        let tail_len: usize = if last_is_tb {
            tail.iter().map(Node::node_size).sum()
        } else {
            0
        };
        let end = if last_is_tb { caret_end - 1 } else { caret_end };
        self.sel = Selection::caret(near_text(&self.doc, end.min(self.doc.content_size()), -1));
        let _ = tail_len;
        true
    }

    /// Plain text of a range: text blocks separated by a blank line; a task as `[ ] title` with its
    /// notes indented two spaces (TaskRef's renderText).
    pub fn text_between(&self, from: usize, to: usize) -> String {
        let mut parts: Vec<String> = Vec::new();
        let tasks = &self.tasks;
        fn walk(
            n: &Node,
            start: usize,
            from: usize,
            to: usize,
            parts: &mut Vec<String>,
            title: &dyn Fn(&str) -> String,
        ) {
            let mut p = start;
            for c in &n.content {
                let end = p + c.node_size();
                if end > from && p < to {
                    if c.is(TASK) {
                        let mut lines = Vec::new();
                        task_text(c, p, from, to, 0, &mut lines, title);
                        parts.push(lines.join("\n"));
                    } else if c.is_textblock() {
                        let a = from.max(p + 1) - (p + 1);
                        let b = to.min(end - 1).saturating_sub(p + 1);
                        parts.push(inline_text(&c.inline_slice(a, b.max(a))));
                    } else if !c.is_leaf() {
                        walk(c, p + 1, from, to, parts, title);
                    }
                }
                p = end;
            }
        }
        let title = |id: &str| {
            let t = tasks.title(id).unwrap_or_default();
            format!("[ ] {t}")
        };
        walk(&self.doc, 0, from, to, &mut parts, &title);
        parts.join("\n\n")
    }

    /// The blocks a range covers (whole blocks; for the HTML copy).
    fn slice_blocks(&self, from: usize, to: usize) -> Vec<Node> {
        let mut out = Vec::new();
        let mut p = 0;
        for c in &self.doc.content {
            let end = p + c.node_size();
            if end > from && p < to {
                out.push(c.clone());
            }
            p = end;
        }
        out
    }
}

fn task_text(
    n: &Node,
    pos: usize,
    from: usize,
    to: usize,
    depth: usize,
    lines: &mut Vec<String>,
    title: &dyn Fn(&str) -> String,
) {
    let ind = "  ".repeat(depth);
    if from <= pos {
        lines.push(format!(
            "{ind}{}",
            title(n.attr("taskId").as_str().unwrap_or(""))
        ));
    }
    let mut p = pos + 1;
    for c in &n.content {
        let end = p + c.node_size();
        if end > from && p < to {
            if c.is(TASK) {
                task_text(c, p, from, to, depth + 1, lines, title);
            } else if c.is_textblock() {
                lines.push(format!("  {ind}{}", inline_text(&c.content)));
            } else {
                let mut sub = Vec::new();
                c.descendants(&mut |d, _| {
                    if d.is_textblock() {
                        sub.push(format!("  {ind}{}", inline_text(&d.content)));
                        return false;
                    }
                    true
                });
                lines.extend(sub);
            }
        }
        p = end;
    }
}

fn inline_text(nodes: &[Node]) -> String {
    nodes
        .iter()
        .map(|n| match n.kind.as_str() {
            "text" => n.text.clone(),
            "hardBreak" => "\n".into(),
            "mention" => format!("@{}", n.attr("label").as_str().unwrap_or("")),
            _ => String::new(),
        })
        .collect()
}

/// Today's mark paste rules on a line of plain text: `**b**`, `__b__`, `*i*`, `_i_`, `` `c` ``, `~~s~~`.
pub fn inline_markdown(line: &str) -> Vec<Node> {
    let mut out: Vec<Node> = Vec::new();
    let mut plain = String::new();
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    'outer: while i < chars.len() {
        let at_word_start = i == 0 || chars[i - 1].is_whitespace();
        if at_word_start {
            for (delim, mark) in [
                ("**", "bold"),
                ("__", "bold"),
                ("~~", "strike"),
                ("`", "code"),
                ("*", "italic"),
                ("_", "italic"),
            ] {
                let d: Vec<char> = delim.chars().collect();
                if chars[i..].starts_with(&d) {
                    let start = i + d.len();
                    let mut j = start;
                    while j + d.len() <= chars.len() {
                        if chars[j..].starts_with(&d)
                            && j > start
                            && !chars[start..j].contains(&d[0])
                        {
                            if !plain.is_empty() {
                                out.push(Node::text(&std::mem::take(&mut plain), vec![]));
                            }
                            let inner: String = chars[start..j].iter().collect();
                            out.push(Node::text(&inner, add_mark(&[], &Mark::simple(mark))));
                            i = j + d.len();
                            continue 'outer;
                        }
                        j += 1;
                    }
                }
            }
        }
        plain.push(chars[i]);
        i += 1;
    }
    if !plain.is_empty() {
        out.push(Node::text(&plain, vec![]));
    }
    out
}

// ───────────── HTML ─────────────

fn decode(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn esc_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Pasted HTML to blocks, by today's parse rules (the common tags), links kept only when safe.
pub fn parse_html(html: &str) -> Vec<Node> {
    struct B {
        blocks: Vec<Node>,
        inline: Vec<Node>,
        marks: Vec<Mark>,
        block_kind: Option<(String, Attrs)>,
        lists: Vec<(String, Vec<Node>)>,
        /// The open `<li>`'s attributes (a checklist item's `checked`).
        item: Attrs,
        /// Per open `<span>`: whether it opened a colour (`textStyle`) mark.
        spans: Vec<bool>,
    }
    let mut b = B {
        blocks: Vec::new(),
        inline: Vec::new(),
        marks: Vec::new(),
        block_kind: None,
        lists: Vec::new(),
        item: Attrs::new(),
        spans: Vec::new(),
    };
    fn flush(b: &mut B) {
        let has = b
            .inline
            .iter()
            .any(|n| !n.is_text() || !n.text.trim().is_empty());
        let (kind, attrs) = b
            .block_kind
            .take()
            .unwrap_or(("paragraph".into(), Attrs::new()));
        let mut content = std::mem::take(&mut b.inline);
        // Trim the block's edges.
        if let Some(f) = content.first_mut().filter(|n| n.is_text()) {
            f.text = f.text.trim_start().to_string();
        }
        if let Some(l) = content.last_mut().filter(|n| n.is_text()) {
            l.text = l.text.trim_end().to_string();
        }
        if !has {
            return;
        }
        let mut node = Node::new(&kind, attrs, content);
        node.normalize();
        match b.lists.last_mut() {
            Some((kind, items)) if kind == "taskList" => {
                items.push(Node::new("taskItem", b.item.clone(), vec![node]))
            }
            Some((_, items)) => items.push(Node::el("listItem", vec![node])),
            None => b.blocks.push(node),
        }
    }
    let mut rest = html;
    while !rest.is_empty() {
        if let Some(stripped) = rest.strip_prefix('<') {
            let end = stripped.find('>').unwrap_or(stripped.len());
            let tag = &stripped[..end];
            rest = &stripped[(end + 1).min(stripped.len())..];
            let closing = tag.starts_with('/');
            let body = tag.trim_start_matches('/').trim_end_matches('/');
            let name = body
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            let attr = |k: &str| -> Option<String> {
                let pat = format!("{k}=\"");
                let i = body.find(&pat)? + pat.len();
                let j = body[i..].find('"')? + i;
                Some(decode(&body[i..j]))
            };
            let mark = match name.as_str() {
                "strong" | "b" => Some("bold"),
                "em" | "i" => Some("italic"),
                "u" => Some("underline"),
                "s" | "strike" | "del" => Some("strike"),
                "code" => Some("code"),
                "a" => Some("link"),
                "mark" => Some("highlight"),
                _ => None,
            };
            // Colours are palette names only (src/editor/colors.ts): `<span data-color>` is a
            // text colour, `<mark data-color>` a highlight; anything else stays plain text.
            let color = attr("data-color").filter(|c| nv_model::urls::is_color_name(Some(c)));
            if name == "span" {
                if closing {
                    if b.spans.pop() == Some(true) {
                        if let Some(i) = b.marks.iter().rposition(|x| x.kind == "textStyle") {
                            b.marks.remove(i);
                        }
                    }
                } else if !body.ends_with('/') {
                    b.spans.push(color.is_some());
                    if let Some(c) = &color {
                        let mut a = Attrs::new();
                        a.insert("color".into(), json!(c));
                        b.marks.push(Mark::new("textStyle", a));
                    }
                }
                continue;
            }
            if let Some(m) = mark {
                if closing {
                    if let Some(i) = b.marks.iter().rposition(|x| x.kind == m) {
                        b.marks.remove(i);
                    }
                } else if m == "highlight" {
                    let mut a = Attrs::new();
                    if let Some(c) = &color {
                        a.insert("color".into(), json!(c));
                    }
                    b.marks.push(Mark::new("highlight", a));
                } else if m == "link" {
                    let href = nv_model::urls::safe_link_url(attr("href").as_deref());
                    if !href.is_empty() {
                        let mut a = Attrs::new();
                        a.insert("href".into(), json!(href));
                        b.marks.push(Mark::new("link", a));
                    }
                    // An unsafe link keeps its text, unlinked (its </a> finds no link to close).
                } else {
                    b.marks.push(Mark::simple(m));
                }
                continue;
            }
            match (name.as_str(), closing) {
                ("p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "pre", false) => {
                    flush(&mut b);
                    if name == "li" {
                        b.item = Attrs::new();
                        if attr("data-checked").as_deref() == Some("true") {
                            b.item.insert("checked".into(), json!(true));
                        }
                    }
                    if let Some(level) = name.strip_prefix('h').and_then(|l| l.parse::<u64>().ok())
                    {
                        let mut a = Attrs::new();
                        a.insert("level".into(), json!(level.min(3)));
                        b.block_kind = Some(("heading".into(), a));
                    } else if name == "pre" {
                        b.block_kind = Some(("codeBlock".into(), Attrs::new()));
                    }
                }
                ("p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "pre", true) => {
                    flush(&mut b)
                }
                ("ul" | "ol", false) => {
                    flush(&mut b);
                    b.lists.push((
                        if attr("data-type").as_deref() == Some("taskList") {
                            "taskList".into()
                        } else if name == "ul" {
                            "bulletList".into()
                        } else {
                            "orderedList".into()
                        },
                        Vec::new(),
                    ));
                }
                ("ul" | "ol", true) => {
                    flush(&mut b);
                    if let Some((kind, items)) = b.lists.pop() {
                        if !items.is_empty() {
                            let list = Node::el(&kind, items);
                            match b.lists.last_mut().and_then(|(_, it)| it.last_mut()) {
                                Some(item) => item.content.push(list),
                                None => b.blocks.push(list),
                            }
                        }
                    }
                }
                ("br", _) => {
                    let mut n = Node::el("hardBreak", vec![]);
                    n.marks = b.marks.clone();
                    b.inline.push(n);
                }
                _ => {}
            }
        } else {
            let end = rest.find('<').unwrap_or(rest.len());
            let raw = &rest[..end];
            rest = &rest[end..];
            let mut t = String::new();
            let mut last_space = false;
            for c in decode(raw).chars() {
                if c.is_whitespace() {
                    if !last_space {
                        t.push(' ');
                    }
                    last_space = true;
                } else {
                    t.push(c);
                    last_space = false;
                }
            }
            if !t.is_empty() {
                let mut marks: Vec<Mark> = Vec::new();
                for m in &b.marks {
                    marks = add_mark(&marks, m);
                }
                b.inline.push(Node::text(&t, marks));
            }
        }
    }
    flush(&mut b);
    while let Some((kind, items)) = b.lists.pop() {
        if !items.is_empty() {
            b.blocks.push(Node::el(&kind, items));
        }
    }
    b.blocks
}

/// Blocks as HTML, in today's renderHTML shapes for the common nodes.
pub fn html_of(blocks: &[Node]) -> String {
    fn inline(n: &Node) -> String {
        match n.kind.as_str() {
            "text" => {
                let mut s = esc_html(&n.text);
                for m in n.marks.iter().rev() {
                    s = match m.kind.as_str() {
                        "bold" => format!("<strong>{s}</strong>"),
                        "italic" => format!("<em>{s}</em>"),
                        "underline" => format!("<u>{s}</u>"),
                        "strike" => format!("<s>{s}</s>"),
                        "code" => format!("<code>{s}</code>"),
                        "link" => format!(
                            "<a href=\"{}\">{s}</a>",
                            esc_html(m.attrs.get("href").and_then(|v| v.as_str()).unwrap_or(""))
                        ),
                        _ => s,
                    };
                }
                s
            }
            "hardBreak" => "<br>".into(),
            "mention" => format!(
                "<span data-mention data-id=\"{}\">@{}</span>",
                n.attr("id").as_str().unwrap_or(""),
                esc_html(n.attr("label").as_str().unwrap_or(""))
            ),
            "pageLink" => format!(
                "<a data-type=\"page-link\" data-page-id=\"{}\"></a>",
                n.attr("pageId").as_str().unwrap_or("")
            ),
            _ => String::new(),
        }
    }
    fn block(n: &Node) -> String {
        let kids = || n.content.iter().map(block).collect::<String>();
        let text = || n.content.iter().map(inline).collect::<String>();
        match n.kind.as_str() {
            "paragraph" => format!("<p>{}</p>", text()),
            "heading" => {
                let l = n.attr("level").as_u64().unwrap_or(1);
                format!("<h{l}>{}</h{l}>", text())
            }
            "codeBlock" => format!("<pre><code>{}</code></pre>", text()),
            "bulletList" => format!("<ul>{}</ul>", kids()),
            "orderedList" => format!("<ol>{}</ol>", kids()),
            "taskList" => format!("<ul data-type=\"taskList\">{}</ul>", kids()),
            "listItem" | "taskItem" => format!("<li>{}</li>", kids()),
            "blockquote" => format!("<blockquote>{}</blockquote>", kids()),
            "horizontalRule" => "<hr>".into(),
            TASK => format!(
                "<div data-type=\"task-ref\" data-task-id=\"{}\"><div data-task-children>{}</div></div>",
                n.attr("taskId").as_str().unwrap_or(""),
                kids()
            ),
            _ => kids(),
        }
    }
    blocks.iter().map(block).collect()
}
