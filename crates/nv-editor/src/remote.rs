//! Other people's changes (EDITOR.md 3, "Remote changes"): apply their yrs update to the box's
//! doc, re-read the tree, and carry the selection (and the remote cursors shown in the box)
//! across through yrs sticky indexes taken before the change. Positions that can't be tied to
//! the fragment are clamped to the new tree instead.

use crate::editor::{near_text, node_after, Editor, Focus};
use crate::selection::Selection;

/// Someone else's caret or selection in this box, as positions in the tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCursor {
    pub user_id: String,
    pub anchor: usize,
    pub head: usize,
}

impl Editor {
    /// Apply someone else's change (a Yjs update for the page doc). The tree is read again, the
    /// selection and remote cursors follow the text they were in, and an open composition is
    /// kept on top. Task lines that came or went with the change don't touch the task store
    /// (the other person's app did that).
    pub fn apply_update(&mut self, update: &[u8]) -> Result<(), String> {
        let composing = self.suspend_composition();
        let result = self.apply_remote_inner(update);
        self.resume_composition(composing);
        result
    }

    fn apply_remote_inner(&mut self, update: &[u8]) -> Result<(), String> {
        let Some(b) = &self.binding else {
            return Err("the editor isn't bound to a doc".into());
        };
        let mut positions = match self.sel {
            Selection::Text { anchor, head } => vec![anchor, head],
            Selection::Node { pos } => vec![pos],
            Selection::All => vec![],
        };
        let mine = positions.len();
        for c in &self.remote_cursors {
            positions.push(c.anchor);
            positions.push(c.head);
        }
        let sticks = b.stick(&self.doc, &positions);
        b.apply_remote(update)?;
        let doc = b.read();
        let mapped = b.unstick(&doc, &sticks);
        let size = doc.content_size();
        let at = |i: usize| -> usize {
            let p = mapped[i].unwrap_or(positions[i]).min(size);
            near_text(&doc, p, -1)
        };
        let sel = match self.sel {
            Selection::Text { .. } => Selection::text(at(0), at(1)),
            Selection::Node { .. } => {
                let p = mapped[0].unwrap_or(positions[0]).min(size);
                if node_after(&doc, p).is_some() {
                    Selection::Node { pos: p }
                } else {
                    Selection::caret(near_text(&doc, p, -1))
                }
            }
            Selection::All => Selection::All,
        };
        for (k, c) in self.remote_cursors.iter_mut().enumerate() {
            let i = mine + 2 * k;
            c.anchor = mapped[i].unwrap_or(c.anchor).min(size);
            c.head = mapped[i + 1].unwrap_or(c.head).min(size);
        }
        self.doc = doc;
        self.sel = sel.clone();
        self.last_sel = sel;
        self.known_tasks = crate::tasks::task_ids(&self.doc);
        if let Focus::TaskTitle(id) = &self.focus {
            if !self.known_tasks.contains(id) {
                self.focus = Focus::Doc;
            }
        }
        self.dismissed = None;
        Ok(())
    }

    /// Set the remote cursors shown in this box (positions clamped to the tree).
    pub fn set_remote_cursors(&mut self, cursors: Vec<RemoteCursor>) {
        let size = self.doc.content_size();
        self.remote_cursors = cursors
            .into_iter()
            .map(|mut c| {
                c.anchor = c.anchor.min(size);
                c.head = c.head.min(size);
                c
            })
            .collect();
    }
}

#[cfg(test)]
mod tests {
    use crate::bind::Clock;
    use crate::notation::{parse, serialize};
    use crate::remote::RemoteCursor;
    use crate::Editor;
    use nv_model::yrs::updates::decoder::Decode;
    use nv_model::yrs::{Doc, ReadTxn, StateVector, Transact, Update};

    fn editor(src: &str) -> Editor {
        let (doc, sel) = parse(src).unwrap();
        let mut ed = Editor::new(doc, sel.unwrap());
        ed.bind(nv_model::new_doc(), "default", Clock::manual());
        ed
    }

    fn show(ed: &Editor) -> String {
        serialize(&ed.doc, Some(&ed.sel), &|_, v| v.clone())
    }

    fn full(doc: &Doc) -> Vec<u8> {
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// A second editor on a copy of `ed`'s doc.
    fn other(ed: &Editor) -> Editor {
        let doc = nv_model::new_doc();
        doc.transact_mut()
            .apply_update(Update::decode_v1(&full(&ed.binding.as_ref().unwrap().doc)).unwrap())
            .unwrap();
        let tree = crate::bind::read_tree(&doc, "default");
        let mut e = Editor::new(tree, crate::Selection::caret(1));
        e.bind(doc, "default", Clock::manual());
        e
    }

    #[test]
    fn caret_follows_its_text() {
        let mut a = editor("<paragraph>hello wor|ld</paragraph>");
        let mut b = other(&a);
        // B types at the start of the line: A's caret moves right with its text.
        b.insert_text("+");
        b.finish();
        a.apply_update(&full(&b.binding.as_ref().unwrap().doc))
            .unwrap();
        assert_eq!(show(&a), "<paragraph>+hello wor|ld</paragraph>");
        // A types: B sees it, and both trees match.
        a.insert_text("X");
        a.finish();
        b.apply_update(&full(&a.binding.as_ref().unwrap().doc))
            .unwrap();
        assert_eq!(a.doc, b.doc);
    }

    #[test]
    fn caret_in_a_removed_line_is_clamped() {
        let mut a = editor("<paragraph>one</paragraph><paragraph>tw|o</paragraph>");
        let mut b = other(&a);
        b.sel = crate::Selection::All;
        b.insert_text("z");
        b.finish();
        a.apply_update(&full(&b.binding.as_ref().unwrap().doc))
            .unwrap();
        assert_eq!(a.doc, b.doc);
        assert!(a.sel.head().unwrap() <= a.doc.content_size());
    }

    #[test]
    fn remote_cursors_follow_too() {
        let mut a = editor("<paragraph>abc|</paragraph>");
        a.set_remote_cursors(vec![RemoteCursor {
            user_id: "u2".into(),
            anchor: 2,
            head: 3,
        }]);
        let mut b = other(&a);
        b.sel = crate::Selection::caret(1);
        b.insert_text("__");
        b.finish();
        a.apply_update(&full(&b.binding.as_ref().unwrap().doc))
            .unwrap();
        assert_eq!(
            (a.remote_cursors[0].anchor, a.remote_cursors[0].head),
            (4, 5)
        );
    }

    #[test]
    fn composition_survives_a_remote_change() {
        let mut a = editor("<paragraph>ab|</paragraph>");
        let before = full(&a.binding.as_ref().unwrap().doc);
        let mut b = other(&a);
        b.sel = crate::Selection::caret(1);
        b.insert_text("Z");
        b.finish();
        a.set_composition("か", None);
        a.apply_update(&full(&b.binding.as_ref().unwrap().doc))
            .unwrap();
        assert_eq!(show(&a), "<paragraph>Zabか|</paragraph>");
        a.commit_composition("蚊");
        a.finish();
        assert_eq!(show(&a), "<paragraph>Zab蚊|</paragraph>");
        assert_ne!(full(&a.binding.as_ref().unwrap().doc), before);
        b.apply_update(&full(&a.binding.as_ref().unwrap().doc))
            .unwrap();
        assert_eq!(a.doc, b.doc);
    }
}
