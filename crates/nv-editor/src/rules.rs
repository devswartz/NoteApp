//! Input rules (EDITOR.md 4): what typing a few characters at the start of a line, or around a
//! word, turns into. Today's rules come from TipTap's extensions and `src/editor/smartLists.ts`.

use crate::editor::Editor;
use crate::node::{u16_len, Mark, Node};
use crate::schema::Attrs;
use crate::selection::Selection;
use serde_json::json;

/// Runs after typed text lands (the caret is just after it).
pub fn after_text_input(ed: &mut Editor, typed: &str) {
    let Some(pos) = ed.sel.head() else { return };
    let r = ed.resolve(pos);
    let parent = r.parent(&ed.doc);
    if parent.is("codeBlock") || parent.is("detailsSummary") {
        return;
    }
    let before = text_before(ed, pos);
    // A rule's change is its own undo step, after the typing that triggered it (so undo gives
    // back the typed "- ", as today).
    let (doc, sel, marks) = (ed.doc.clone(), ed.sel.clone(), ed.stored_marks.clone());
    if block_rule(ed, &before) || mark_rule(ed, &before) {
        let (new_doc, new_sel, new_marks) = (
            std::mem::replace(&mut ed.doc, doc),
            std::mem::replace(&mut ed.sel, sel),
            std::mem::replace(&mut ed.stored_marks, marks),
        );
        ed.checkpoint();
        ed.doc = new_doc;
        ed.sel = new_sel;
        ed.stored_marks = new_marks;
        return;
    }
    if typed.chars().all(char::is_whitespace) {
        autolink(ed, &before);
    }
}

fn text_before(ed: &Editor, pos: usize) -> String {
    let r = ed.resolve(pos);
    let parent = r.parent(&ed.doc);
    let mut s = String::new();
    let mut p = 0;
    for c in &parent.content {
        if p >= r.parent_offset {
            break;
        }
        if c.is_text() {
            let take = (r.parent_offset - p).min(c.node_size());
            s.push_str(&c.text[..crate::node::byte_at(&c.text, take)]);
        } else {
            s.push('\u{fffc}');
        }
        p += c.node_size();
    }
    s
}

/// Rules matching the whole text before the caret, at the start of a text block.
fn block_rule(ed: &mut Editor, before: &str) -> bool {
    let start_list = |ed: &mut Editor, kind: &str, attrs: Attrs, join: bool| {
        clear_line_start(ed, before);
        wrap_in_list(ed, kind, attrs, join)
    };
    // Bullets: "- ", "* ", "+ " (leading spaces allowed).
    let t = before.trim_start();
    if matches!(t, "- " | "* " | "+ ") {
        return start_list(ed, "bulletList", Attrs::new(), true);
    }
    // "1. " (TipTap), "1) " (smart lists): numbered from that number.
    if let Some(num) = before.strip_suffix(". ").filter(|n| is_digits(n)) {
        let n: u64 = num.parse().unwrap_or(1);
        let mut a = Attrs::new();
        a.insert("start".into(), json!(n));
        return start_list(ed, "orderedList", a, true);
    }
    if let Some(num) = before.strip_suffix(") ").filter(|n| is_digits(n)) {
        let n: u64 = num.parse().unwrap_or(1);
        let mut a = Attrs::new();
        a.insert("start".into(), json!(n));
        a.insert("paren".into(), json!(true));
        return start_list(ed, "orderedList", a, false);
    }
    // "a. " "A) " "i. " "I) ": lettered and roman lists, never joined to a list above.
    let b: Vec<char> = before.chars().collect();
    if b.len() == 3
        && matches!(b[0], 'a' | 'A' | 'i' | 'I')
        && matches!(b[1], '.' | ')')
        && b[2].is_whitespace()
    {
        let mut a = Attrs::new();
        a.insert("type".into(), json!(b[0].to_string()));
        a.insert("start".into(), json!(1));
        a.insert("paren".into(), json!(b[1] == ')'));
        return start_list(ed, "orderedList", a, false);
    }
    // "> " quote.
    if t == "> " {
        clear_line_start(ed, before);
        let (from, to) = ed.range();
        return ed.wrap_range(from, to, "blockquote");
    }
    // "# " to "### " headings.
    let hashes = before.chars().take_while(|c| *c == '#').count();
    if (1..=3).contains(&hashes) && before.len() == hashes + 1 && before.ends_with(' ') {
        clear_line_start(ed, before);
        let mut a = Attrs::new();
        a.insert("level".into(), json!(hashes));
        return ed.set_block_type("heading", a);
    }
    // "``` " (or ```lang ) code block.
    if let Some(rest) = before
        .strip_prefix("```")
        .or_else(|| before.strip_prefix("~~~"))
    {
        if rest.ends_with(char::is_whitespace) {
            let lang = rest.trim_end();
            if lang.chars().all(|c| c.is_ascii_lowercase()) {
                clear_line_start(ed, before);
                let mut a = Attrs::new();
                if !lang.is_empty() {
                    a.insert("language".into(), json!(lang));
                }
                return ed.set_block_type("codeBlock", a);
            }
        }
    }
    // "---" (or "___ ", "*** ") horizontal rule, in place of the line's start.
    if matches!(before, "---" | "—-" | "___ " | "*** ") {
        clear_line_start(ed, before);
        return insert_rule(ed);
    }
    false
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// Delete the matched text at the start of the caret's text block.
fn clear_line_start(ed: &mut Editor, before: &str) {
    let pos = ed.sel.head().unwrap();
    let n = u16_len(before);
    ed.delete_range(pos - n, pos);
    ed.sel = Selection::caret(pos - n);
}

fn wrap_in_list(ed: &mut Editor, kind: &str, attrs: Attrs, join: bool) -> bool {
    let pos = ed.sel.head().unwrap();
    let r = ed.resolve(pos);
    let d = r.depth();
    let parent_path = r.path_to(d - 1);
    let idx = r.index_at(d - 1);
    let start = attrs.get("start").and_then(|v| v.as_u64()).unwrap_or(1);
    let block = ed.doc.at(&r.path).clone();
    let item = Node::el("listItem", vec![block]);
    let parent = ed.doc.at_mut(&parent_path);
    // Joins the list just above when it's the same kind (numbered: when the numbers carry on).
    if join && idx > 0 {
        let prev = &parent.content[idx - 1];
        let joins = prev.is(kind)
            && (kind != "orderedList"
                || prev.content.len() as u64 + prev.attr("start").as_u64().unwrap_or(1) == start);
        if joins {
            parent.content.remove(idx);
            let prev = &mut parent.content[idx - 1];
            prev.content.push(item);
            // Before: <prev>…</prev><p>|  → <prev>…<li><p>| </li></prev>: one token less before the caret.
            ed.sel = Selection::caret(pos + 1);
            return true;
        }
    }
    parent.content[idx] = Node::new(kind, attrs, vec![item]);
    ed.sel = Selection::caret(pos + 2);
    true
}

fn insert_rule(ed: &mut Editor) -> bool {
    let pos = ed.sel.head().unwrap();
    let r = ed.resolve(pos);
    let d = r.depth();
    let parent_path = r.path_to(d - 1);
    let idx = r.index_at(d - 1);
    // The rule goes before the line, which keeps what's left of it (nodeInputRule).
    ed.doc
        .at_mut(&parent_path)
        .content
        .insert(idx, Node::el("horizontalRule", vec![]));
    ed.sel = Selection::caret(pos + 1);
    true
}

/// `**b**`, `__b__`, `*i*`, `_i_`, `` `c` ``, `~~s~~`, `==h==` just before the caret (after a space or the line start).
fn mark_rule(ed: &mut Editor, before: &str) -> bool {
    for (delim, mark) in [
        ("**", "bold"),
        ("__", "bold"),
        ("~~", "strike"),
        ("==", "highlight"),
        ("`", "code"),
        ("*", "italic"),
        ("_", "italic"),
    ] {
        let Some(inner_end) = before.strip_suffix(delim) else {
            continue;
        };
        let Some(open) = inner_end.rfind(delim) else {
            continue;
        };
        let inner = &inner_end[open + delim.len()..];
        if inner.is_empty()
            || inner.contains(delim.chars().next().unwrap())
            || inner.starts_with(char::is_whitespace) && inner.trim().is_empty()
        {
            continue;
        }
        let lead = &inner_end[..open];
        if !(lead.is_empty() || lead.ends_with(char::is_whitespace)) {
            continue;
        }
        // Single-char delimiters must not be half of a double one ("**" handled first).
        if delim.len() == 1 && lead.ends_with(delim) {
            continue;
        }
        let pos = ed.sel.head().unwrap();
        let total = u16_len(delim) * 2 + u16_len(inner);
        let start = pos - total;
        let r = ed.resolve(pos);
        let marks = ed.marks_at(start + u16_len(delim));
        let path = r.path.clone();
        let off = r.parent_offset;
        let m = crate::node::add_mark(&marks, &Mark::simple(mark));
        replace_inline(ed, &path, off - total, off, vec![Node::text(inner, m)]);
        ed.sel = Selection::caret(start + u16_len(inner));
        // Typing on isn't marked.
        ed.stored_marks = Some(crate::node::remove_mark(&marks, mark));
        return true;
    }
    false
}

fn replace_inline(ed: &mut Editor, path: &[usize], from: usize, to: usize, insert: Vec<Node>) {
    let block = ed.doc.at_mut(path);
    let size = block.content_size();
    let mut content = block.inline_slice(0, from);
    content.extend(insert);
    content.extend(block.inline_slice(to, size));
    block.content = content;
    block.normalize();
}

/// A URL with a scheme, typed and followed by a space, becomes a link (TipTap's autolink;
/// bare domains stay text, as today).
fn autolink(ed: &mut Editor, before: &str) {
    let trimmed = before.trim_end();
    let word_start = trimmed.rfind(char::is_whitespace).map_or(0, |i| i + 1);
    let word = &trimmed[word_start..];
    let lower = word.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) || word.len() <= 8 {
        return;
    }
    let pos = ed.sel.head().unwrap();
    let ws = u16_len(&before[trimmed.len()..]);
    let to = pos - ws;
    let from = to - u16_len(word);
    let mut a = Attrs::new();
    a.insert("href".into(), json!(word));
    ed.add_mark_range(from, to, &Mark::new("link", a));
}
