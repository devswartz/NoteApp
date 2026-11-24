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

/// Where a Yjs relative position (a collaborator's cursor, as awareness carries it) is in the
/// box `field` of `doc`, as an offset in the box's `text_for_view()` (UTF-16 units). None when
/// it isn't inside that box.
pub fn relative_to_view_offset(
    doc: &nv_model::yrs::Doc,
    field: &str,
    st: &nv_model::yrs::StickyIndex,
) -> Option<usize> {
    let pos = crate::bind::locate_relative(doc, field, st)?;
    let mut tree = crate::bind::read_tree(doc, field);
    crate::editor::normalize_loaded(&mut tree);
    Some(crate::input::ViewText::of(&tree).to_offset(pos))
}

/// A Yjs relative position for an offset in the box's `text_for_view()`: what to put in
/// awareness so the web and other apps draw this caret. None where it can't be tied to the box.
pub fn view_offset_to_relative(
    doc: &nv_model::yrs::Doc,
    field: &str,
    offset: usize,
) -> Option<nv_model::yrs::StickyIndex> {
    let mut tree = crate::bind::read_tree(doc, field);
    crate::editor::normalize_loaded(&mut tree);
    let pos = crate::input::ViewText::of(&tree).to_pos(offset);
    crate::bind::relative_position(doc, field, pos)
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
        let mut doc = b.read();
        if b.is_lazy() {
            crate::editor::normalize_loaded(&mut doc);
        }
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

    #[test]
    fn a_caret_crosses_the_wire_as_a_yjs_relative_position() {
        use crate::remote::{relative_to_view_offset, view_offset_to_relative};
        let mut a = editor("<paragraph>one</paragraph><paragraph>two th|ree</paragraph>");
        a.finish();
        let doc_a = a.binding.as_ref().unwrap().doc.clone();
        // The view text is one line per block: offset 4 + 7 = 11 is after "two thr".
        let rel = view_offset_to_relative(&doc_a, "default", 11).unwrap();
        // The awareness JSON is what y-prosemirror reads: an item id and an assoc.
        let json = serde_json::to_value(&rel).unwrap();
        assert!(json.get("item").is_some() || json.get("type").is_some());
        assert_eq!(json["assoc"], 0);
        // Another client (the web, or another app) resolves it on its own copy of the doc, even
        // after text was typed before it.
        let mut b = other(&a);
        b.sel = crate::Selection::caret(1);
        b.insert_text("++");
        b.finish();
        let doc_b = b.binding.as_ref().unwrap().doc.clone();
        let back: nv_model::yrs::StickyIndex = serde_json::from_value(json).unwrap();
        assert_eq!(relative_to_view_offset(&doc_b, "default", &back), Some(13));
        // The end of a line and the very start resolve too.
        let end = view_offset_to_relative(&doc_b, "default", 15).unwrap();
        assert_eq!(relative_to_view_offset(&doc_b, "default", &end), Some(15));
        let start = view_offset_to_relative(&doc_b, "default", 0).unwrap();
        assert_eq!(relative_to_view_offset(&doc_b, "default", &start), Some(0));
    }

    #[test]
    fn a_web_cursor_is_read() {
        use crate::remote::relative_to_view_offset;
        let a = editor("<paragraph>hello|</paragraph>");
        let doc = a.binding.as_ref().unwrap().doc.clone();
        // The item of the first character of the text, as y-prosemirror sends it.
        let rel = crate::bind::relative_position(&doc, "default", 3).unwrap();
        let id = serde_json::to_value(&rel).unwrap()["item"].clone();
        let web = serde_json::json!({ "type": null, "tname": null, "item": id, "assoc": 0 });
        let st: nv_model::yrs::StickyIndex = serde_json::from_value(web).unwrap();
        assert_eq!(relative_to_view_offset(&doc, "default", &st), Some(2));
        // Not in this fragment: none.
        assert_eq!(relative_to_view_offset(&doc, "box:zzz", &st), None);
    }
}
