//! IME composition (marked text): what an input method shows while the user is still choosing
//! (Japanese kana before conversion, dead keys, dictation's draft).
//!
//! The marked text is provisional. `set_composition` shows it in the tree, in place of the
//! selection, but `finish()` writes nothing to yrs and runs no task bookkeeping while it is
//! there, and no input rules run on it. Every update starts again from the state before the
//! composition began, so the tree never holds two drafts. `commit_composition` goes back to that
//! state and types the final text once with `insert_text` (input rules included), so the page
//! sees one change; `cancel_composition` goes back without typing.

use crate::editor::{Editor, Focus};
use crate::node::{u16_len, Mark, Node};
use crate::selection::Selection;

#[derive(Debug, Clone, PartialEq)]
pub struct Composition {
    /// The marked text as it is now.
    pub text: String,
    /// Its range in the tree.
    pub from: usize,
    pub to: usize,
    /// The selection inside the marked text (UTF-16 offsets from its start).
    pub sel_in_text: (usize, usize),
    base_doc: Node,
    base_sel: Selection,
    base_marks: Option<Vec<Mark>>,
}

impl Editor {
    pub fn is_composing(&self) -> bool {
        self.composition.is_some()
    }

    /// Show `text` as the marked text, replacing the selection the composition started on.
    /// `sel` is the selection inside it (UTF-16 offsets; none puts the caret at its end).
    /// In a task title the text is only shown by the view; the title changes on commit.
    pub fn set_composition(&mut self, text: &str, sel: Option<(usize, usize)>) {
        if matches!(self.focus, Focus::TaskTitle(_)) {
            return;
        }
        let (base_doc, base_sel, base_marks) = match self.composition.take() {
            Some(c) => (c.base_doc, c.base_sel, c.base_marks),
            None => (
                self.doc.clone(),
                self.sel.clone(),
                self.stored_marks.clone(),
            ),
        };
        self.doc = base_doc.clone();
        self.sel = base_sel.clone();
        self.stored_marks = base_marks.clone();
        self.delete_selection();
        let Some(pos) = self.sel.head() else {
            self.restore(base_doc, base_sel, base_marks);
            return;
        };
        let r = self.resolve(pos);
        if !r.parent(&self.doc).is_textblock() {
            self.restore(base_doc, base_sel, base_marks);
            return;
        }
        if !text.is_empty() {
            let marks = if r.parent(&self.doc).is("codeBlock") {
                vec![]
            } else {
                self.stored_marks
                    .clone()
                    .unwrap_or_else(|| self.marks_at(pos))
            };
            self.splice(
                &r.path,
                r.parent_offset,
                r.parent_offset,
                vec![Node::text(text, marks)],
            );
        }
        let len = u16_len(text);
        let (a, h) = sel.unwrap_or((len, len));
        let (a, h) = (a.min(len), h.min(len));
        self.sel = Selection::text(pos + a, pos + h);
        self.composition = Some(Composition {
            text: text.to_string(),
            from: pos,
            to: pos + len,
            sel_in_text: (a, h),
            base_doc,
            base_sel,
            base_marks,
        });
    }

    /// End the composition with its final text: typed once, input rules and all. The caller
    /// runs `finish()` (one yrs change).
    pub fn commit_composition(&mut self, text: &str) {
        if let Some(c) = self.composition.take() {
            self.restore(c.base_doc, c.base_sel, c.base_marks);
        }
        if !text.is_empty() {
            self.insert_text(text);
        }
    }

    /// End the composition without typing anything: back to the state before it.
    pub fn cancel_composition(&mut self) {
        if let Some(c) = self.composition.take() {
            self.restore(c.base_doc, c.base_sel, c.base_marks);
        }
    }

    /// Commit a composition still open (with its current text) before another kind of edit.
    pub fn end_composition(&mut self) {
        if let Some(text) = self.composition.as_ref().map(|c| c.text.clone()) {
            self.commit_composition(&text);
            self.finish();
        }
    }

    /// Take the composition off the tree for a moment (a remote change is applied to the state
    /// before it); `resume_composition` puts it back.
    pub(crate) fn suspend_composition(&mut self) -> Option<(String, (usize, usize))> {
        let c = self.composition.take()?;
        let resume = (c.text.clone(), c.sel_in_text);
        self.restore(c.base_doc, c.base_sel, c.base_marks);
        Some(resume)
    }

    pub(crate) fn resume_composition(&mut self, c: Option<(String, (usize, usize))>) {
        if let Some((text, sel)) = c {
            self.set_composition(&text, Some(sel));
        }
    }

    fn restore(&mut self, doc: Node, sel: Selection, marks: Option<Vec<Mark>>) {
        self.doc = doc;
        self.sel = sel;
        self.stored_marks = marks;
    }
}

#[cfg(test)]
mod tests {
    use crate::bind::Clock;
    use crate::notation::{parse, serialize};
    use crate::Editor;
    use nv_model::yrs::{ReadTxn, StateVector, Transact};

    fn editor(src: &str) -> Editor {
        let (doc, sel) = parse(src).unwrap();
        let mut ed = Editor::new(doc, sel.unwrap());
        ed.bind(nv_model::new_doc(), "default", Clock::manual());
        ed
    }

    fn show(ed: &Editor) -> String {
        serialize(&ed.doc, Some(&ed.sel), &|_, v| v.clone())
    }

    fn state(ed: &Editor) -> Vec<u8> {
        let b = ed.binding.as_ref().unwrap();
        b.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    #[test]
    fn marked_text_is_shown_but_not_written() {
        let mut ed = editor("<paragraph>ab|</paragraph>");
        let before = state(&ed);
        ed.set_composition("k", None);
        ed.finish();
        ed.set_composition("ka", None);
        ed.finish();
        assert_eq!(show(&ed), "<paragraph>abka|</paragraph>");
        let c = ed.composition.as_ref().unwrap();
        assert_eq!((c.from, c.to), (3, 5));
        assert_eq!(state(&ed), before, "nothing written while composing");
    }

    #[test]
    fn commit_types_once() {
        let mut ed = editor("<paragraph>ab|</paragraph>");
        ed.set_composition("k", None);
        ed.set_composition("か", Some((0, 1)));
        assert_eq!(show(&ed), "<paragraph>ab[か]</paragraph>");
        ed.commit_composition("蚊");
        ed.finish();
        assert_eq!(show(&ed), "<paragraph>ab蚊|</paragraph>");
        assert!(ed.composition.is_none());
        assert_eq!(ed.binding.as_ref().unwrap().read(), ed.doc);
        // One undo step takes it all away.
        ed.undo();
        assert_eq!(show(&ed), "<paragraph>ab|</paragraph>");
    }

    #[test]
    fn cancel_goes_back() {
        let mut ed = editor("<paragraph>a[b]c</paragraph>");
        ed.set_composition("x", None);
        assert_eq!(show(&ed), "<paragraph>ax|c</paragraph>");
        ed.cancel_composition();
        assert_eq!(show(&ed), "<paragraph>a[b]c</paragraph>");
    }

    #[test]
    fn commit_runs_input_rules() {
        let mut ed = editor("<paragraph>|</paragraph>");
        ed.set_composition("#", None);
        ed.commit_composition("#");
        ed.finish();
        ed.set_composition(" ", None);
        ed.commit_composition(" ");
        ed.finish();
        assert!(
            show(&ed).starts_with("<heading>|</heading>"),
            "{}",
            show(&ed)
        );
    }
}
