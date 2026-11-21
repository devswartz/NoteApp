//! Inserting and wrapping blocks: task lines, tables, rules, callouts, toggles.

use crate::editor::Editor;
use crate::node::Node;
use crate::selection::Selection;

impl Editor {
    /// Insert a block at the caret: in place of an empty line, else after the caret's line.
    /// Returns the position before the new block.
    pub fn insert_block_at_caret(&mut self, block: Node) -> Option<usize> {
        self.delete_selection();
        let pos = self.sel.head()?;
        let r = self.resolve(pos);
        let d = r.depth();
        if d == 0 || !r.parent(&self.doc).is_textblock() {
            return None;
        }
        let parent = r.path_to(d - 1);
        let i = r.index_at(d - 1);
        let before = r.before(d);
        let empty = r.parent(&self.doc).content.is_empty();
        let size = r.parent(&self.doc).node_size();
        let kids = &mut self.doc.at_mut(&parent).content;
        if empty {
            kids[i] = block;
            Some(before)
        } else {
            kids.insert(i + 1, block);
            Some(before + size)
        }
    }

    /// Insert a leaf block (a rule, a task line); the caret goes to the line after it.
    pub fn insert_block(&mut self, block: Node) -> bool {
        let leaf = block.is_leaf() || block.content.is_empty();
        let size = block.node_size();
        match self.insert_block_at_caret(block) {
            Some(p) => {
                let after = p + size;
                if leaf {
                    // A line after it to type on (the trailing paragraph when it's last).
                    self.finish();
                    self.sel = Selection::caret(crate::editor::near_text(&self.doc, after, 1));
                }
                true
            }
            None => false,
        }
    }

    /// Wrap the caret's line in a container (a callout), the caret staying in the line.
    pub fn wrap_block_in(&mut self, kind: &str) -> bool {
        let (from, to) = self.range();
        self.wrap_range(from, to, kind)
    }

    /// `/toggle`: the line becomes a toggle's summary, with an empty line of content under it.
    pub fn set_details(&mut self) -> bool {
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        let d = r.depth();
        if !r.parent(&self.doc).is_textblock() {
            return false;
        }
        let line = r.parent(&self.doc).clone();
        let summary = Node::el("detailsSummary", line.content);
        let details = Node::el(
            "details",
            vec![
                summary,
                Node::el("detailsContent", vec![Node::el("paragraph", vec![])]),
            ],
        );
        let parent = r.path_to(d - 1);
        let i = r.index_at(d - 1);
        self.doc.at_mut(&parent).content[i] = details;
        // details > summary: one more level than the line had.
        self.sel = Selection::caret(pos + 1);
        true
    }

    /// Insert text with the caret's marks but no input rules.
    pub fn insert_plain(&mut self, text: &str) {
        let Some(pos) = self.sel.head() else { return };
        let marks = self.marks_at(pos);
        let r = self.resolve(pos);
        if !r.parent(&self.doc).is_textblock() {
            return;
        }
        let block = self.doc.at_mut(&r.path);
        let size = block.content_size();
        let mut content = block.inline_slice(0, r.parent_offset);
        content.push(Node::text(text, marks));
        content.extend(block.inline_slice(r.parent_offset, size));
        block.content = content;
        block.normalize();
        self.sel = Selection::caret(pos + crate::node::u16_len(text));
    }
}
