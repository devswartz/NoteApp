//! One text box's editing state and the commands that change it (EDITOR.md 4).
//!
//! Commands edit the tree directly and set the new selection themselves; the yrs binding
//! (EDITOR.md 3) diffs the tree against the box's fragment afterwards, so no step log is needed.

use crate::node::{add_mark, remove_mark, Mark, Node};
use crate::pos::{resolve, textblocks_between, ResolvedPos};
use crate::schema::{schema, Attrs};
use crate::selection::Selection;
use serde_json::{json, Value};

/// Where the keyboard is: in the box's text, or in a task line's title (EDITOR.md 5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Focus {
    Doc,
    TaskTitle(String),
}

pub struct Editor {
    pub doc: Node,
    pub sel: Selection,
    /// Marks the next typed text gets (Mod+B with an empty selection), when set.
    pub stored_marks: Option<Vec<Mark>>,
    pub focus: Focus,
    /// The suggestion menu closed with Escape (its trigger's position).
    pub dismissed: Option<usize>,
    /// The highlighted slash item: (the menu's trigger position, its query, the index). It
    /// goes back to the first item when the query changes.
    pub highlight: Option<(usize, String, usize)>,
    /// The task store behind the box's task lines.
    pub tasks: Box<dyn crate::tasks::TaskHost>,
    /// Task ids in the doc after the last change (to see which lines went or came back).
    pub known_tasks: Vec<String>,
    /// The box's fragment in the page doc, with its undo history (none for a detached editor).
    pub binding: Option<crate::bind::Binding>,
    /// IME composition in progress (provisional text, not written to yrs until commit).
    pub composition: Option<crate::compose::Composition>,
    /// Other people's carets in this box (kept across remote changes, `remote.rs`).
    pub remote_cursors: Vec<crate::remote::RemoteCursor>,
    /// The selection after the last change: what undo puts back.
    pub(crate) last_sel: Selection,
}

impl Editor {
    /// An editor on a box's content. Opening it adds the trailing paragraph when the content
    /// doesn't end with one, as today's editor does when the fragment loads.
    pub fn new(doc: Node, sel: Selection) -> Editor {
        let mut ed = Editor {
            doc,
            sel,
            stored_marks: None,
            focus: Focus::Doc,
            dismissed: None,
            highlight: None,
            tasks: Box::new(crate::tasks::NoTasks::default()),
            known_tasks: Vec::new(),
            binding: None,
            composition: None,
            remote_cursors: Vec::new(),
            last_sel: Selection::All,
        };
        ed.last_sel = ed.sel.clone();
        ed.known_tasks = crate::tasks::task_ids(&ed.doc);
        ed.finish();
        ed
    }

    // ───────────── Queries ─────────────

    pub fn resolve(&self, pos: usize) -> ResolvedPos {
        resolve(&self.doc, pos)
    }

    /// (from, to) of the selection.
    pub fn range(&self) -> (usize, usize) {
        let doc = &self.doc;
        self.sel.range(doc.content_size(), |p| {
            node_after(doc, p).map_or(0, Node::node_size)
        })
    }

    /// The marks text typed at `pos` gets (ProseMirror's `$pos.marks()`).
    pub fn marks_at(&self, pos: usize) -> Vec<Mark> {
        let r = self.resolve(pos);
        let parent = r.parent(&self.doc);
        if parent.content.is_empty() {
            return vec![];
        }
        // Inside a text node: its marks.
        let mut p = 0;
        for c in &parent.content {
            let size = c.node_size();
            if r.parent_offset > p && r.parent_offset < p + size {
                return c.marks.clone();
            }
            p += size;
        }
        let (before, after) = (
            if r.index > 0 {
                parent.content.get(r.index - 1)
            } else {
                None
            },
            parent.content.get(r.index),
        );
        let (main, other) = match before {
            Some(b) => (b, after),
            None => (after.unwrap(), None),
        };
        main.marks
            .iter()
            .filter(|m| {
                schema().mark(&m.kind).inclusive || other.is_some_and(|o| o.marks.contains(m))
            })
            .cloned()
            .collect()
    }

    // ───────────── Low-level edits ─────────────

    /// Replace `from..to` (offsets in the text block at `path`) with inline nodes.
    pub(crate) fn splice(&mut self, path: &[usize], from: usize, to: usize, insert: Vec<Node>) {
        let block = self.doc.at_mut(path);
        let size = block.content_size();
        let mut content = block.inline_slice(0, from);
        content.extend(insert);
        content.extend(block.inline_slice(to, size));
        block.content = content;
        block.normalize();
    }

    /// Delete `from..to` (any positions), joining the text blocks at the ends. Returns the caret position.
    pub fn delete_range(&mut self, from: usize, to: usize) -> usize {
        if from >= to {
            return from;
        }
        let rf = self.resolve(from);
        let rt = self.resolve(to);
        let f_tb = rf.parent(&self.doc).is_textblock();
        let t_tb = rt.parent(&self.doc).is_textblock();
        if f_tb && rf.path == rt.path {
            self.splice(&rf.path.clone(), rf.parent_offset, rt.parent_offset, vec![]);
            return from;
        }
        let tail = if t_tb {
            let tb = rt.parent(&self.doc);
            tb.inline_slice(rt.parent_offset, tb.content_size())
        } else {
            vec![]
        };
        let a = if f_tb {
            rf.after(&self.doc, rf.depth())
        } else {
            from
        };
        let b = if t_tb {
            rt.after(&self.doc, rt.depth())
        } else {
            to
        };
        remove_between(&mut self.doc, 0, a, b);
        if f_tb {
            let path = rf.path.clone();
            let size = self.doc.at(&path).content_size();
            self.splice(&path, rf.parent_offset, size, tail);
        }
        if self.doc.content.is_empty() {
            self.doc.content.push(Node::el("paragraph", vec![]));
            return 1;
        }
        from.min(self.doc.content_size())
    }

    /// Delete the selection, if any. Returns whether there was one.
    pub fn delete_selection(&mut self) -> bool {
        let (from, to) = self.range();
        if from == to {
            return false;
        }
        if self.sel == Selection::All {
            self.doc.content = vec![Node::el("paragraph", vec![])];
            self.sel = Selection::caret(1);
            return true;
        }
        let at = self.delete_range(from, to);
        self.sel = Selection::caret(near_text(&self.doc, at, -1));
        true
    }

    // ───────────── Typing ─────────────

    /// Typed text: replaces the selection, takes the stored or surrounding marks, runs input rules.
    pub fn insert_text(&mut self, text: &str) {
        if matches!(self.focus, Focus::TaskTitle(_)) {
            self.title_input(text);
            return;
        }
        let had_range = !self.sel.is_empty();
        self.delete_selection();
        let Some(pos) = self.sel.head() else { return };
        let r = self.resolve(pos);
        if !r.parent(&self.doc).is_textblock() {
            return;
        }
        let marks = if had_range {
            self.stored_marks
                .take()
                .unwrap_or_else(|| self.marks_at(pos))
        } else {
            self.stored_marks
                .clone()
                .unwrap_or_else(|| self.marks_at(pos))
        };
        let marks = if r.parent(&self.doc).is("codeBlock") {
            vec![]
        } else {
            marks
        };
        self.splice(
            &r.path,
            r.parent_offset,
            r.parent_offset,
            vec![Node::text(text, marks)],
        );
        self.sel = Selection::caret(pos + crate::node::u16_len(text));
        crate::rules::after_text_input(self, text);
    }

    pub fn insert_inline(&mut self, node: Node) {
        self.delete_selection();
        let Some(pos) = self.sel.head() else { return };
        let r = self.resolve(pos);
        if !r.parent(&self.doc).is_textblock() {
            return;
        }
        let mut node = node;
        node.marks = self.marks_at(pos);
        self.splice(&r.path, r.parent_offset, r.parent_offset, vec![node]);
        self.sel = Selection::caret(pos + 1);
    }

    pub fn hard_break(&mut self) -> bool {
        if let Some(pos) = self.sel.head() {
            if self.resolve(pos).parent(&self.doc).is("codeBlock") {
                return false;
            }
        }
        self.insert_inline(Node::el("hardBreak", vec![]));
        true
    }

    // ───────────── Enter ─────────────

    /// Split the text block at the caret. A heading split at its end continues as a paragraph.
    pub fn split_block(&mut self) -> bool {
        self.delete_selection();
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        let block = r.parent(&self.doc).clone();
        if !block.is_textblock() {
            return false;
        }
        let at_end = r.at_end(&self.doc);
        let size = block.content_size();
        let left = block.copy(block.inline_slice(0, r.parent_offset));
        let mut right = block.copy(block.inline_slice(r.parent_offset, size));
        if at_end && block.is("heading") {
            right = Node::el("paragraph", vec![]);
        }
        let (parent_path, index) = (r.path_to(r.depth() - 1), r.index_at(r.depth() - 1));
        let parent = self.doc.at_mut(&parent_path);
        parent.content[index] = left;
        let left_size = parent.content[index].node_size();
        parent.content.insert(index + 1, right);
        self.sel = Selection::caret(r.before(r.depth()) + left_size + 1);
        true
    }

    /// Split the list item at the caret (Enter in a list): the rest of the line and the item's
    /// other children go to a new item after it. A checklist item starts unchecked.
    pub fn split_list_item(&mut self) -> bool {
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        let d = r.depth();
        if d < 2 || !r.parent(&self.doc).is_textblock() {
            return false;
        }
        let item_d = d - 1;
        let item = r.node(&self.doc, item_d).clone();
        if !item.is_list_item() || r.index_at(item_d) != 0 {
            return false;
        }
        let block = r.parent(&self.doc).clone();
        let size = block.content_size();
        let left_block = block.copy(block.inline_slice(0, r.parent_offset));
        let right_block = Node::el("paragraph", block.inline_slice(r.parent_offset, size));
        let mut left = item.copy(vec![left_block]);
        left.content.extend(vec![]);
        let mut right_kids = vec![right_block];
        right_kids.extend(item.content[1..].iter().cloned());
        let mut right = item.copy(right_kids);
        if right.is("taskItem") {
            right = right.with_attr("checked", json!(false));
        }
        let list_path = r.path_to(item_d - 1);
        let idx = r.index_at(item_d - 1);
        let list = self.doc.at_mut(&list_path);
        list.content[idx] = left;
        let left_size = list.content[idx].node_size();
        list.content.insert(idx + 1, right);
        // Caret: start of the new item's paragraph.
        self.sel = Selection::caret(r.before(item_d) + left_size + 2);
        true
    }

    /// Enter on an empty line in a quote or callout: the line leaves the container
    /// (ProseMirror's liftEmptyBlock), after it when it's the last line, before it when the first.
    pub fn lift_empty_block(&mut self) -> bool {
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        let d = r.depth();
        if d < 2 || !r.parent(&self.doc).content.is_empty() || !r.parent(&self.doc).is_textblock() {
            return false;
        }
        let container = r.node(&self.doc, d - 1);
        if !matches!(
            container.kind.as_str(),
            "blockquote" | "callout" | "detailsContent"
        ) {
            return false;
        }
        let idx = r.index_at(d - 1);
        let n = container.content.len();
        if idx == n - 1 && n > 1 {
            return self.move_line_out(&r, true);
        }
        if idx == 0 && n > 1 {
            return self.move_line_out(&r, false);
        }
        false
    }

    /// Move the text block at `r` out of its container, to just after (or before) the container.
    fn move_line_out(&mut self, r: &ResolvedPos, after: bool) -> bool {
        let d = r.depth();
        let mut container_d = d - 1;
        // A toggle's content leaves its whole toggle.
        if r.node(&self.doc, container_d).is("detailsContent") {
            container_d -= 1;
        }
        let line_path = r.path.clone();
        let line = self.doc.at(&line_path).clone();
        let cpath = r.path_to(container_d);
        let outer_path = r.path_to(container_d - 1);
        let cidx = r.index_at(container_d - 1);
        let c_before = r.before(container_d);
        // Remove the line.
        let lp = &line_path[..line_path.len() - 1];
        self.doc
            .at_mut(lp)
            .content
            .remove(*line_path.last().unwrap());
        let csize = self.doc.at(&cpath).node_size();
        let outer = self.doc.at_mut(&outer_path);
        if after {
            outer.content.insert(cidx + 1, line);
            self.sel = Selection::caret(c_before + csize + 1);
        } else {
            outer.content.insert(cidx, line);
            self.sel = Selection::caret(c_before + 1);
        }
        true
    }

    /// Enter in a closed toggle's summary: a new line after the toggle.
    fn enter_in_summary(&mut self) -> bool {
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        if !r.parent(&self.doc).is("detailsSummary") {
            return false;
        }
        let d = r.depth() - 1;
        let after = r.after(&self.doc, d);
        let outer = r.path_to(d - 1);
        let idx = r.index_at(d - 1);
        self.doc
            .at_mut(&outer)
            .content
            .insert(idx + 1, Node::el("paragraph", vec![]));
        self.sel = Selection::caret(after + 1);
        true
    }

    pub fn enter(&mut self) -> bool {
        let Some(pos) = self.sel.head() else {
            return self.split_block();
        };
        let r = self.resolve(pos);
        if r.parent(&self.doc).is("codeBlock") {
            self.insert_text_raw("\n");
            return true;
        }
        if self.sel.is_empty() {
            if crate::tasks::exit_empty_last_child(self) {
                return true;
            }
            // Empty list item: one level out (smart lists), then out of the list.
            if r.parent(&self.doc).content.is_empty() && r.depth() >= 2 {
                let item = r.node(&self.doc, r.depth() - 1);
                if item.is_list_item() && item.content.len() == 1 {
                    return self.outdent();
                }
            }
            if self.enter_in_summary() {
                return true;
            }
            if self.lift_empty_block() {
                return true;
            }
        }
        if r.depth() >= 2 && r.node(&self.doc, r.depth() - 1).is_list_item() {
            self.delete_selection();
            return self.split_list_item();
        }
        self.split_block()
    }

    /// Insert text without input rules or marks (a line break in code).
    fn insert_text_raw(&mut self, text: &str) {
        self.delete_selection();
        let Some(pos) = self.sel.head() else { return };
        let r = self.resolve(pos);
        self.splice(
            &r.path,
            r.parent_offset,
            r.parent_offset,
            vec![Node::text(text, vec![])],
        );
        self.sel = Selection::caret(pos + crate::node::u16_len(text));
    }

    // ───────────── Backspace / Delete ─────────────

    pub fn backspace(&mut self) -> bool {
        if self.delete_selection() {
            return true;
        }
        if let Selection::Node { pos } = self.sel {
            let size = node_after(&self.doc, pos).map_or(0, Node::node_size);
            self.delete_range(pos, pos + size);
            self.sel = Selection::caret(near_text(&self.doc, pos, -1));
            return true;
        }
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        if !r.at_start() {
            // One character (or inline node) back; a surrogate pair counts as one.
            let back = char_before_len(&self.doc, &r);
            self.delete_range(pos - back, pos);
            self.sel = Selection::caret(pos - back);
            return true;
        }
        if crate::tasks::backspace_at_note_start(self) {
            return true;
        }
        let d = r.depth();
        // At the start of a list item's first line: lift the item.
        if d >= 2 && r.node(&self.doc, d - 1).is_list_item() && r.index_at(d - 1) == 0 {
            return self.outdent();
        }
        // An empty last line of a quote, callout or toggle moves out first (blockExit.ts).
        if d >= 2 && r.parent(&self.doc).content.is_empty() {
            let c = r.node(&self.doc, d - 1);
            if matches!(c.kind.as_str(), "blockquote" | "callout" | "detailsContent")
                && r.index_at(d - 1) == c.content.len() - 1
                && c.content.len() > 1
            {
                return self.move_line_out(&r, true);
            }
        }
        self.join_backward(&r)
    }

    fn join_backward(&mut self, r: &ResolvedPos) -> bool {
        let d = r.depth();
        // Find the nearest ancestor (or the block itself) with a sibling before it.
        let mut level = d;
        while level >= 1 && r.index_at(level - 1) == 0 {
            level -= 1;
        }
        if level == 0 {
            return false;
        }
        if level < d {
            // First line of a container (a quote, a callout): lift it out of it.
            let c = r.node(&self.doc, d - 1);
            if matches!(c.kind.as_str(), "blockquote" | "callout") {
                return self.move_line_out(r, false);
            }
            return false;
        }
        let parent_path = r.path_to(d - 1);
        let idx = r.index_at(d - 1);
        let prev = &self.doc.at(&parent_path).content[idx - 1];
        if prev.is(crate::tasks::TASK) && prev.content.is_empty()
            || prev.is_leaf() && !prev.is_inline()
        {
            // A leaf block (rule, image, task line) before: an empty line goes, else the leaf is selected.
            let prev_pos = r.before(d) - prev.node_size();
            if r.parent(&self.doc).content.is_empty() {
                self.doc.at_mut(&parent_path).content.remove(idx);
            }
            self.sel = Selection::Node { pos: prev_pos };
            return true;
        }
        // Join into the deepest last text block before.
        let Some((tb_path, tb_end)) = last_textblock(&self.doc, &parent_path, idx - 1, r.before(d))
        else {
            return false;
        };
        if self.doc.at(&tb_path).is(crate::tasks::TASK) {
            return false;
        }
        let content = r.parent(&self.doc).content.clone();
        self.doc.at_mut(&parent_path).content.remove(idx);
        let tb = self.doc.at_mut(&tb_path);
        tb.content.extend(content);
        tb.normalize();
        // Drop containers emptied on the way (none in practice: the block was a direct sibling).
        self.sel = Selection::caret(tb_end);
        true
    }

    pub fn delete_forward(&mut self) -> bool {
        if self.delete_selection() {
            return true;
        }
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        if !r.at_end(&self.doc) {
            let fwd = char_after_len(&self.doc, &r);
            self.delete_range(pos, pos + fwd);
            return true;
        }
        // Join the next text block into this one.
        let after = r.after(&self.doc, r.depth());
        if after >= self.doc.content_size() {
            return false;
        }
        let next = near_text(&self.doc, after, 1);
        let rn = self.resolve(next);
        if !rn.parent(&self.doc).is_textblock() || rn.parent_offset != 0 {
            return false;
        }
        let content = rn.parent(&self.doc).content.clone();
        let size = rn.parent(&self.doc).node_size();
        remove_between(
            &mut self.doc,
            0,
            rn.before(rn.depth()),
            rn.before(rn.depth()) + size,
        );
        let tb = self.doc.at_mut(&r.path);
        tb.content.extend(content);
        tb.normalize();
        self.sel = Selection::caret(pos);
        true
    }

    // ───────────── Marks ─────────────

    pub fn toggle_mark(&mut self, kind: &str) -> bool {
        let (from, to) = self.range();
        let mark = Mark::simple(kind);
        if from == to {
            let current = self
                .stored_marks
                .clone()
                .unwrap_or_else(|| self.marks_at(from));
            let next = if current.iter().any(|m| m.kind == kind) {
                remove_mark(&current, kind)
            } else {
                add_mark(&current, &mark)
            };
            self.stored_marks = Some(next);
            return true;
        }
        let all = self.range_has_mark(from, to, kind);
        if all {
            self.remove_mark_range(from, to, kind);
        } else {
            self.add_mark_range(from, to, &mark);
        }
        true
    }

    /// Whether every bit of text in `from..to` has a mark of `kind`.
    pub fn range_has_mark(&self, from: usize, to: usize, kind: &str) -> bool {
        let mut any = false;
        let mut all = true;
        for_inline_in(&self.doc, from, to, &mut |n| {
            if n.is_text() {
                any = true;
                if !n.marks.iter().any(|m| m.kind == kind) {
                    all = false;
                }
            }
        });
        any && all
    }

    pub fn add_mark_range(&mut self, from: usize, to: usize, mark: &Mark) {
        self.map_inline(from, to, &|n| {
            let mut n = n;
            if n.is_text() || n.is_inline() {
                n.marks = add_mark(&n.marks, mark);
            }
            n
        });
    }

    pub fn remove_mark_range(&mut self, from: usize, to: usize, kind: &str) {
        self.map_inline(from, to, &|n| {
            let mut n = n;
            n.marks = remove_mark(&n.marks, kind);
            n
        });
    }

    /// Apply `f` to the inline content in `from..to`, splitting text at the ends.
    fn map_inline(&mut self, from: usize, to: usize, f: &dyn Fn(Node) -> Node) {
        for (p, path) in textblocks_between(&self.doc, from, to) {
            let block = self.doc.at(&path);
            if block.is("codeBlock") {
                continue;
            }
            let size = block.content_size();
            let a = from.saturating_sub(p + 1).min(size);
            let b = to.saturating_sub(p + 1).min(size);
            if a >= b {
                continue;
            }
            let mid: Vec<Node> = block.inline_slice(a, b).into_iter().map(f).collect();
            self.splice(&path, a, b, mid);
        }
    }

    // ───────────── Block types ─────────────

    /// Set every text block in the selection to `kind` (paragraph, heading, codeBlock).
    pub fn set_block_type(&mut self, kind: &str, attrs: Attrs) -> bool {
        let (from, to) = self.range();
        let blocks = textblocks_between(&self.doc, from, to);
        if blocks.is_empty() {
            return false;
        }
        for (_, path) in blocks {
            let b = self.doc.at_mut(&path);
            let mut n = Node::new(kind, attrs.clone(), std::mem::take(&mut b.content));
            if kind == "codeBlock" {
                let text = n.text_content();
                n.content = if text.is_empty() {
                    vec![]
                } else {
                    vec![Node::text(&text, vec![])]
                };
            }
            *b = n;
        }
        true
    }

    pub fn toggle_heading(&mut self, level: u64) -> bool {
        let (from, _) = self.range();
        let r = self.resolve(from);
        let b = r.parent(&self.doc);
        if b.is("heading") && b.attr("level") == &json!(level) {
            self.set_block_type("paragraph", Attrs::new())
        } else {
            let mut a = Attrs::new();
            a.insert("level".into(), json!(level));
            self.set_block_type("heading", a)
        }
    }

    pub fn toggle_code_block(&mut self) -> bool {
        let (from, _) = self.range();
        if self.resolve(from).parent(&self.doc).is("codeBlock") {
            self.set_block_type("paragraph", Attrs::new())
        } else {
            self.set_block_type("codeBlock", Attrs::new())
        }
    }

    /// Wrap the blocks of the selection in a container (a quote, a callout), or unwrap them.
    pub fn toggle_wrap(&mut self, kind: &str) -> bool {
        let (from, to) = self.range();
        let r = self.resolve(from);
        if let Some(d) = r.find(&self.doc, |n| n.is(kind)) {
            // Unwrap: the container's children take its place.
            let path = r.path_to(d);
            let kids = self.doc.at(&path).content.clone();
            let parent = &path[..path.len() - 1];
            let i = path[path.len() - 1];
            self.doc.at_mut(parent).content.splice(i..=i, kids);
            self.sel = shift_sel(&self.sel, -1);
            return true;
        }
        self.wrap_range(from, to, kind)
    }

    /// The (parent path, first index, last index) of the sibling blocks covering `from..to`.
    pub fn block_range(&self, from: usize, to: usize) -> Option<(Vec<usize>, usize, usize)> {
        let rf = self.resolve(from);
        let rt = self.resolve(to);
        let mut d = rf.shared_depth(&self.doc, to);
        // The range's parent holds blocks: step out of text blocks.
        if rf.node(&self.doc, d).is_textblock() {
            d -= 1;
        }
        if d > rt.depth() || d >= rf.depth() {
            return None;
        }
        Some((rf.path_to(d), rf.index_at(d), rt.index_at(d)))
    }

    pub fn wrap_range(&mut self, from: usize, to: usize, kind: &str) -> bool {
        let Some((path, a, b)) = self.block_range(from, to) else {
            return false;
        };
        let parent = self.doc.at_mut(&path);
        let kids: Vec<Node> = parent.content.drain(a..=b).collect();
        parent.content.insert(a, Node::el(kind, kids));
        self.sel = shift_sel(&self.sel, 1);
        true
    }

    // ───────────── Lists ─────────────

    /// The innermost list item around the selection's start: (depth of the item).
    pub fn list_item_depth(&self) -> Option<usize> {
        let (from, _) = self.range();
        let r = self.resolve(from);
        for d in (1..=r.depth()).rev() {
            let n = r.node(&self.doc, d);
            if n.is_list_item() {
                return Some(d);
            }
            if matches!(
                n.kind.as_str(),
                "codeBlock" | "tableCell" | "tableHeader" | "taskRef"
            ) {
                return None;
            }
        }
        None
    }

    pub fn toggle_list(&mut self, list: &str) -> bool {
        let item = if list == "taskList" {
            "taskItem"
        } else {
            "listItem"
        };
        let (from, to) = self.range();
        let r = self.resolve(from);
        if let Some(d) = self.list_item_depth() {
            let list_d = d - 1;
            let current = r.node(&self.doc, list_d);
            if current.is(list) {
                // Same list: lift the items out of it.
                let mut guard = 0;
                while self.list_item_depth().is_some() && guard < 10 {
                    if !self.outdent() {
                        break;
                    }
                    guard += 1;
                }
                return true;
            }
            // Another kind of list: change its type (and its items' type).
            let path = r.path_to(list_d);
            let old = self.doc.at(&path).clone();
            let items = old
                .content
                .into_iter()
                .map(|it| {
                    let mut n = Node::new(item, Attrs::new(), it.content);
                    n.marks = vec![];
                    n
                })
                .collect();
            *self.doc.at_mut(&path) = Node::new(list, Attrs::new(), items);
            return true;
        }
        // Wrap each block of the selection in its own item.
        let Some((path, a, b)) = self.block_range(from, to) else {
            return false;
        };
        let parent = self.doc.at_mut(&path);
        let kids: Vec<Node> = parent.content.drain(a..=b).collect();
        let items = kids.into_iter().map(|k| Node::el(item, vec![k])).collect();
        parent.content.insert(a, Node::el(list, items));
        self.sel = shift_sel(&self.sel, 2);
        true
    }

    /// Tab in a list: nest the item under the one before it. Nothing before it: nothing happens.
    pub fn indent(&mut self) -> bool {
        let Some(d) = self.list_item_depth() else {
            return false;
        };
        let (from, _) = self.range();
        let r = self.resolve(from);
        let idx = r.index_at(d - 1);
        if idx == 0 {
            return false;
        }
        let list_path = r.path_to(d - 1);
        let list_kind = self.doc.at(&list_path).kind.clone();
        let list = self.doc.at_mut(&list_path);
        let item = list.content.remove(idx);
        let prev = &mut list.content[idx - 1];
        match prev.content.last_mut() {
            Some(last) if last.is(&list_kind) => last.content.push(item),
            _ => prev.content.push(Node::el(&list_kind, vec![item])),
        }
        // The item now ends a list inside the item before it. A new list (open token where the
        // item before used to close) keeps the item's position; joining an existing nested list
        // moves it back over that list's and the item's closing tokens.
        let joined = self.doc.at(&list_path).content[idx - 1]
            .content
            .last()
            .is_some_and(|l| l.content.len() > 1);
        let shift: isize = if joined { -2 } else { 0 };
        self.sel = shift_sel(&self.sel, shift);
        true
    }

    /// Shift+Tab in a list (and Enter on an empty item): the item goes one level out; at the top
    /// level it leaves the list. A top-level item lifted out of the middle of a numbered list
    /// splits it, and the part after is marked `continued` (smartLists.ts).
    pub fn outdent(&mut self) -> bool {
        let Some(d) = self.list_item_depth() else {
            return false;
        };
        let (from, _) = self.range();
        let r = self.resolve(from);
        let list_d = d - 1;
        let list_path = r.path_to(list_d);
        let idx = r.index_at(list_d);
        let list = self.doc.at(&list_path).clone();
        let item_start = r.before(d);
        let caret_offset = from - item_start; // within the item
        let nested = list_d >= 1 && r.node(&self.doc, list_d - 1).is_list_item();
        if nested {
            // Into the parent list, after the parent item; following siblings become the item's children.
            let pitem_path = r.path_to(list_d - 1);
            let plist_path = r.path_to(list_d - 2);
            let pidx = r.index_at(list_d - 2);
            let mut item = list.content[idx].clone();
            let following: Vec<Node> = list.content[idx + 1..].to_vec();
            if !following.is_empty() {
                match item.content.last_mut() {
                    Some(l) if l.is(&list.kind) => l.content.extend(following),
                    _ => item.content.push(list.copy(following)),
                }
            }
            let pitem = self.doc.at_mut(&pitem_path);
            let li = pitem.content.len() - 1;
            pitem.content[li].content.truncate(idx);
            if pitem.content[li].content.is_empty() {
                pitem.content.pop();
            }
            let pitem_size = pitem.node_size();
            let plist = self.doc.at_mut(&plist_path);
            plist.content.insert(pidx + 1, item);
            let pitem_before = r.before(list_d - 1);
            self.sel = Selection::caret(pitem_before + pitem_size + caret_offset);
            return true;
        }
        // Top level: the item's blocks replace it, splitting the list.
        let parent_path = r.path_to(list_d - 1);
        let lidx = r.index_at(list_d - 1);
        let before_items: Vec<Node> = list.content[..idx].to_vec();
        let after_items: Vec<Node> = list.content[idx + 1..].to_vec();
        let item = &list.content[idx];
        let mut replacement = Vec::new();
        if !before_items.is_empty() {
            replacement.push(list.copy(before_items.clone()));
        }
        let lead = if before_items.is_empty() {
            0
        } else {
            replacement[0].node_size()
        };
        replacement.extend(item.content.iter().cloned());
        if !after_items.is_empty() {
            let mut rest = list.copy(after_items);
            if list.is("orderedList") && !before_items.is_empty() {
                rest = rest
                    .with_attr("start", json!(1))
                    .with_attr("continued", json!(true));
            }
            replacement.push(rest);
        }
        let parent = self.doc.at_mut(&parent_path);
        parent.content.splice(lidx..=lidx, replacement);
        let list_before = r.before(list_d);
        // The item's first block now starts at list_before + lead.
        self.sel = Selection::caret(list_before + lead + caret_offset - 1);
        true
    }

    // ───────────── Moving blocks ─────────────

    /// Alt+Shift+↑/↓: swap the block at the caret (its top-level-most simple container) with its neighbour.
    pub fn move_block(&mut self, up: bool) -> bool {
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        // The block: the list item when in a list, else the top-level block.
        let d = (1..=r.depth())
            .find(|&d| r.node(&self.doc, d).is_list_item())
            .unwrap_or(1);
        let parent_path = r.path_to(d - 1);
        let idx = r.index_at(d - 1);
        let parent = self.doc.at_mut(&parent_path);
        let n = parent.content.len();
        let other = if up {
            if idx == 0 {
                return false;
            }
            idx - 1
        } else {
            if idx + 1 >= n {
                return false;
            }
            idx + 1
        };
        let other_size = parent.content[other].node_size() as isize;
        parent.content.swap(idx, other);
        self.sel = shift_sel(&self.sel, if up { -other_size } else { other_size });
        true
    }

    // ───────────── After every change ─────────────

    /// What runs after every input (TipTap's appendTransaction plugins): the trailing paragraph.
    pub fn finish(&mut self) {
        // Composition text is provisional: nothing is written (or task-synced) until commit.
        if self.composition.is_some() {
            return;
        }
        let last_is_para = self.doc.content.last().is_some_and(|n| n.is("paragraph"));
        if !last_is_para {
            self.doc.content.push(Node::el("paragraph", vec![]));
        }
        self.sync_tasks();
        if let Some(b) = &mut self.binding {
            b.write(&self.doc, &self.last_sel, &self.sel);
        }
        self.last_sel = self.sel.clone();
    }

    /// An editor on what `field` of `doc` holds now, bound to it, with the caret at the start
    /// of the first text block. Opening writes the trailing paragraph when it's missing.
    pub fn open(
        doc: nv_model::yrs::Doc,
        field: &str,
        tasks: Box<dyn crate::tasks::TaskHost>,
        clock: crate::bind::Clock,
    ) -> Editor {
        let mut tree = crate::bind::read_tree(&doc, field);
        if !tree.content.last().is_some_and(|n| n.is("paragraph")) {
            tree.content.push(Node::el("paragraph", vec![]));
        }
        let caret = Selection::caret(near_text(&tree, 0, 1));
        let mut ed = Editor::new(tree, caret);
        ed.tasks = tasks;
        ed.bind(doc, field, clock);
        ed
    }

    /// Bind the editor to `field` of a page doc: the tree is written there, and undo starts.
    pub fn bind(&mut self, doc: nv_model::yrs::Doc, field: &str, clock: crate::bind::Clock) {
        self.binding = Some(crate::bind::Binding::new(doc, field, &self.doc, clock));
    }

    /// Record the current state as its own undo step: what comes next starts a new one.
    pub fn checkpoint(&mut self) {
        if self.composition.is_some() {
            return;
        }
        if let Some(b) = &mut self.binding {
            b.write(&self.doc, &self.last_sel, &self.sel);
            b.stop_capturing();
        }
        self.last_sel = self.sel.clone();
    }

    /// Whether `undo` would change something (an open composition counts: undo commits it
    /// first, then undoes that).
    pub fn can_undo(&self) -> bool {
        self.composition.is_some() || self.binding.as_ref().is_some_and(|b| b.can_undo())
    }

    pub fn can_redo(&self) -> bool {
        self.composition.is_none() && self.binding.as_ref().is_some_and(|b| b.can_redo())
    }

    pub fn undo(&mut self) -> bool {
        self.end_composition();
        let Some(b) = &mut self.binding else {
            return false;
        };
        let Some((doc, sel)) = b.undo() else {
            return true;
        };
        let sel = collapse_into_restored(&self.doc, &doc, sel);
        self.apply_history(doc, sel);
        true
    }

    pub fn redo(&mut self) -> bool {
        self.end_composition();
        let Some(b) = &mut self.binding else {
            return false;
        };
        let Some((doc, sel)) = b.redo() else {
            return true;
        };
        self.apply_history(doc, sel);
        true
    }

    fn apply_history(&mut self, doc: Node, sel: Selection) {
        self.doc = doc;
        let size = self.doc.content_size();
        self.sel = match sel {
            Selection::Text { anchor, head } => Selection::Text {
                anchor: anchor.min(size),
                head: head.min(size),
            },
            other => other,
        };
        self.stored_marks = None;
        self.focus = Focus::Doc;
        self.sync_tasks();
        self.last_sel = self.sel.clone();
    }

    pub fn select_all(&mut self) -> bool {
        self.sel = Selection::All;
        true
    }
}

// ───────────── Helpers ─────────────

pub fn node_after(doc: &Node, pos: usize) -> Option<&Node> {
    let r = resolve(doc, pos);
    r.parent(doc).content.get(r.index).filter(|_| {
        // Only when pos is at the child's start.
        let mut p = 0;
        for c in &r.parent(doc).content[..r.index] {
            p += c.node_size();
        }
        p == r.parent_offset
    })
}

/// The nearest position in a text block from `pos`, searching in `dir` (-1 back, 1 forward) first.
pub fn near_text(doc: &Node, pos: usize, dir: i32) -> usize {
    let size = doc.content_size();
    let ok = |p: usize| resolve(doc, p).parent(doc).is_textblock();
    if ok(pos) {
        return pos;
    }
    let mut order: Vec<i32> = vec![dir, -dir];
    order.dedup();
    for d in order {
        let mut p = pos as i64;
        loop {
            p += d as i64;
            if p < 0 || p as usize > size {
                break;
            }
            if ok(p as usize) {
                return p as usize;
            }
        }
    }
    pos
}

fn char_before_len(doc: &Node, r: &ResolvedPos) -> usize {
    let parent = r.parent(doc);
    let mut p = 0;
    for c in &parent.content {
        let size = c.node_size();
        if r.parent_offset <= p + size && r.parent_offset > p {
            if c.is_text() {
                let off = r.parent_offset - p;
                let b = crate::node::byte_at(&c.text, off);
                return c.text[..b].chars().last().map_or(1, char::len_utf16);
            }
            return 1;
        }
        p += size;
    }
    1
}

fn char_after_len(doc: &Node, r: &ResolvedPos) -> usize {
    let parent = r.parent(doc);
    let mut p = 0;
    for c in &parent.content {
        let size = c.node_size();
        if r.parent_offset >= p && r.parent_offset < p + size {
            if c.is_text() {
                let b = crate::node::byte_at(&c.text, r.parent_offset - p);
                return c.text[b..].chars().next().map_or(1, char::len_utf16);
            }
            return 1;
        }
        p += size;
    }
    1
}

/// Remove every node lying wholly in `a..b` (positions), recursing into partly covered ones.
/// Containers left empty and invalid go too.
pub fn remove_between(node: &mut Node, start: usize, a: usize, b: usize) {
    let mut p = start;
    let mut i = 0;
    while i < node.content.len() {
        let size = node.content[i].node_size();
        let (s, e) = (p, p + size);
        if s >= a && e <= b {
            node.content.remove(i);
            p = e;
            continue;
        }
        if e > a && s < b && !node.content[i].is_leaf() && !node.content[i].is_textblock() {
            remove_between(&mut node.content[i], s + 1, a, b);
            let c = &node.content[i];
            let kinds: Vec<&str> = c.content.iter().map(|n| n.kind.as_str()).collect();
            if c.content.is_empty() && !schema().valid_content(&c.kind, &kinds) {
                node.content.remove(i);
                p = e;
                continue;
            }
        }
        p = e;
        i += 1;
    }
}

/// The deepest last text block inside `parent.content[idx]` (path, and the position at its content's end).
fn last_textblock(
    doc: &Node,
    parent: &[usize],
    idx: usize,
    end_of_node: usize,
) -> Option<(Vec<usize>, usize)> {
    let mut path = parent.to_vec();
    path.push(idx);
    let mut end = end_of_node; // position after the node
    loop {
        let n = doc.at(&path);
        if n.is_textblock() {
            return Some((path, end - 1));
        }
        if n.is_leaf() || n.content.is_empty() || n.is(crate::tasks::TASK) {
            return if n.is(crate::tasks::TASK) {
                Some((path, end))
            } else {
                None
            };
        }
        end -= 1;
        path.push(n.content.len() - 1);
    }
}

fn for_inline_in(doc: &Node, from: usize, to: usize, f: &mut dyn FnMut(&Node)) {
    doc.descendants(&mut |n, p| {
        if p + n.node_size() <= from || p >= to {
            return !n.is_inline() && p < to;
        }
        if n.is_inline() {
            f(n);
            return false;
        }
        true
    });
}

/// Shift a selection's positions (after wrapping or unwrapping around it).
pub fn shift_sel(sel: &Selection, by: isize) -> Selection {
    let m = |p: usize| (p as isize + by).max(0) as usize;
    match *sel {
        Selection::Text { anchor, head } => Selection::Text {
            anchor: m(anchor),
            head: m(head),
        },
        Selection::Node { pos } => Selection::Node { pos: m(pos) },
        Selection::All => Selection::All,
    }
}

pub fn attrs(v: Value) -> Attrs {
    v.as_object().cloned().unwrap_or_default()
}

/// The doc as a flat token list (one per position), to find what an undo re-inserted.
fn tokens(n: &Node, out: &mut Vec<String>) {
    for c in &n.content {
        if c.is_text() {
            for u in c.text.encode_utf16() {
                out.push(format!("{u}{:?}", c.marks));
            }
        } else if c.is_leaf() {
            out.push(format!("<{} {:?}/>", c.kind, c.attrs));
        } else {
            out.push(format!("<{} {:?}>", c.kind, c.attrs));
            tokens(c, out);
            out.push(format!("</{}>", c.kind));
        }
    }
}

/// A selection restored by undo whose ends fall in content the undo put back resolves to the
/// start of that content, as yrs relative positions on deleted items do in today's editor.
fn collapse_into_restored(before: &Node, after: &Node, sel: Selection) -> Selection {
    let (mut a, mut b) = (Vec::new(), Vec::new());
    tokens(before, &mut a);
    tokens(after, &mut b);
    if b.len() <= a.len() {
        return sel;
    }
    let mut pre = 0;
    while pre < a.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let end = b.len() - suf;
    let m = |p: usize| if p >= pre && p <= end { pre } else { p };
    match sel {
        Selection::Text { anchor, head } => Selection::Text {
            anchor: m(anchor),
            head: m(head),
        },
        other => other,
    }
}
