//! Native text input (EDITOR.md 10): the text a platform's input protocol sees, offsets in it
//! mapped to engine positions, and replacements (autocorrect, spell-check, dictation results).
//!
//! **The view's text** is one string for the whole box: every text block is a line, lines are
//! joined by `\n`, a hard break is `\n` too, other inline atoms (mentions, page links, images)
//! are U+FFFC, and a block with no text of its own (a rule, an image, a task line, whose title
//! has its own field) is a line holding one U+FFFC. Offsets are UTF-16 code units, the unit of
//! `NSString`, Java strings, WinRT `HSTRING` and engine positions, so inside a line an offset
//! moves exactly as a position does.

use crate::editor::{Editor, Focus};
use crate::node::{byte_at, u16_len, Node};
use crate::selection::Selection;

/// The object replacement character: one unit standing for a node that has no text.
pub const OBJECT: char = '\u{fffc}';

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewLine {
    /// Where the line starts in the view's string (UTF-16 units).
    pub offset: usize,
    /// Its length in UTF-16 units (no separator).
    pub len: usize,
    /// For a text block, the position where its content starts; for an object line, the
    /// position before the node.
    pub pos: usize,
    /// False for a line standing for a node without text (one U+FFFC).
    pub text: bool,
    /// For an object line, the positions its U+FFFC covers (`pos..pos + size`).
    pub size: usize,
}

/// The box's text as the view's input protocol sees it, with the map back to positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewText {
    pub text: String,
    pub lines: Vec<ViewLine>,
}

impl ViewText {
    pub fn of(doc: &Node) -> ViewText {
        let mut v = ViewText {
            text: String::new(),
            lines: Vec::new(),
        };
        v.blocks(doc, 0);
        v
    }

    fn line(&mut self, pos: usize, text: bool, size: usize, s: &str) {
        let mut offset = 0;
        if !self.lines.is_empty() {
            self.text.push('\n');
        }
        if let Some(l) = self.lines.last() {
            offset = l.offset + l.len + 1;
        }
        self.text.push_str(s);
        self.lines.push(ViewLine {
            offset,
            len: u16_len(s),
            pos,
            text,
            size,
        });
    }

    /// The children of `node`, whose content starts at `start`.
    fn blocks(&mut self, node: &Node, start: usize) {
        let mut pos = start;
        for c in &node.content {
            if c.is_textblock() {
                let mut s = String::new();
                for i in &c.content {
                    if i.is_text() {
                        s.push_str(&i.text);
                    } else if i.is("hardBreak") {
                        s.push('\n');
                    } else {
                        s.push(OBJECT);
                    }
                }
                self.line(pos + 1, true, 0, &s);
            } else if c.is_leaf() {
                self.line(pos, false, c.node_size(), &OBJECT.to_string());
            } else {
                if c.is(crate::tasks::TASK) {
                    // The task's title line; its notes follow as lines of their own.
                    self.line(pos, false, 1, &OBJECT.to_string());
                }
                self.blocks(c, pos + 1);
            }
            pos += c.node_size();
        }
    }

    /// Length of the string in UTF-16 units.
    pub fn len(&self) -> usize {
        self.lines.last().map_or(0, |l| l.offset + l.len)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The engine position for a UTF-16 offset in the string (clamped to its end). The end of a
    /// line maps to the end of its block, the start of the next line to the start of the next.
    pub fn to_pos(&self, offset: usize) -> usize {
        let Some(l) = self
            .lines
            .iter()
            .find(|l| offset <= l.offset + l.len)
            .or(self.lines.last())
        else {
            return 0;
        };
        let into = offset.saturating_sub(l.offset).min(l.len);
        if l.text {
            l.pos + into
        } else if into == 0 {
            l.pos
        } else {
            l.pos + l.size
        }
    }

    /// The UTF-16 offset for an engine position. A position between blocks goes to the start
    /// of the next line (or the end of the string).
    pub fn to_offset(&self, pos: usize) -> usize {
        for l in &self.lines {
            if l.text {
                if pos < l.pos {
                    return l.offset;
                }
                if pos <= l.pos + l.len {
                    return l.offset + (pos - l.pos);
                }
            } else {
                if pos <= l.pos {
                    return l.offset;
                }
                if pos < l.pos + l.size.max(1) || (pos == l.pos + l.size && l.size > 0) {
                    return l.offset + l.len;
                }
            }
        }
        self.len()
    }

    /// The text between two offsets (`textInRange`, `getTextBeforeCursor`, ...).
    pub fn slice(&self, from: usize, to: usize) -> String {
        let (a, b) = (
            byte_at(&self.text, from.min(to)),
            byte_at(&self.text, to.max(from)),
        );
        self.text[a..b].to_string()
    }
}

impl Editor {
    /// The box's text for the view's input protocol (UITextInput, NSTextInputClient,
    /// InputConnection, CoreTextEditContext): see `ViewText`.
    pub fn text_for_view(&self) -> ViewText {
        ViewText::of(&self.doc)
    }

    /// An offset in `text_for_view()` as an engine position.
    pub fn view_offset_to_pos(&self, offset: usize) -> usize {
        self.text_for_view().to_pos(offset)
    }

    /// An engine position as an offset in `text_for_view()`.
    pub fn pos_to_view_offset(&self, pos: usize) -> usize {
        self.text_for_view().to_offset(pos)
    }

    /// Replace `from..to` with `text` where the platform says (autocorrect, spell-check,
    /// dictation results; `replaceRange:withText:`, `insertText:replacementRange:`,
    /// `commitText` over a composing region, `TextUpdating` with a range away from the caret),
    /// without moving the selection there first. The new text takes the marks of the first
    /// character it replaces (the caret's marks at `from` for an empty range); no input rules run
    /// (autocorrect shouldn't make `- ` a list); it's one undo step of its own. The selection is
    /// mapped: before the range it stays, after it it shifts, inside it it goes after the new
    /// text. In a task title, `from..to` are offsets in the title. The caller runs `finish()`.
    pub fn replace_range(&mut self, from: usize, to: usize, text: &str) -> bool {
        self.end_composition();
        if let Focus::TaskTitle(id) = self.focus.clone() {
            let t = self.tasks.title(&id).unwrap_or_default();
            let n = u16_len(&t);
            let (a, b) = (from.min(to).min(n), to.max(from).min(n));
            let new = format!("{}{text}{}", &t[..byte_at(&t, a)], &t[byte_at(&t, b)..]);
            self.tasks.set_title(&id, &new);
            return true;
        }
        let size = self.doc.content_size();
        let (from, to) = (from.min(to).min(size), to.max(from).min(size));
        let rf = self.resolve(from);
        if !rf.parent(&self.doc).is_textblock()
            || !self.resolve(to).parent(&self.doc).is_textblock()
        {
            return false;
        }
        let marks = if rf.parent(&self.doc).is("codeBlock") {
            vec![]
        } else if from == to {
            self.marks_at(from)
        } else {
            first_marks(rf.parent(&self.doc), rf.parent_offset)
                .unwrap_or_else(|| self.marks_at(from))
        };
        // Its own undo step: what was typed before isn't undone with it.
        self.checkpoint();
        let old = self.sel.clone();
        let at = self.delete_range(from, to);
        let r = self.resolve(at);
        if !text.is_empty() {
            self.splice(
                &r.path,
                r.parent_offset,
                r.parent_offset,
                vec![Node::text(text, marks)],
            );
        }
        let len = u16_len(text);
        let delta = self.doc.content_size() as isize - size as isize;
        let map = |p: usize| {
            if p <= from {
                p
            } else if p >= to {
                (p as isize + delta).max(0) as usize
            } else {
                at + len
            }
        };
        self.sel = match old {
            Selection::Text { anchor, head } => Selection::text(map(anchor), map(head)),
            Selection::Node { pos } if pos < from || pos >= to => Selection::Node { pos: map(pos) },
            Selection::Node { .. } => Selection::caret(at + len),
            Selection::All => Selection::All,
        };
        self.stored_marks = None;
        self.finish();
        if let Some(b) = &mut self.binding {
            b.stop_capturing();
        }
        true
    }
}

/// The marks of the inline node right after `offset` in a text block.
fn first_marks(block: &Node, offset: usize) -> Option<Vec<crate::node::Mark>> {
    let mut p = 0;
    for c in &block.content {
        let size = c.node_size();
        if offset < p + size {
            return Some(c.marks.clone());
        }
        p += size;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bind::Clock;
    use crate::notation::{parse, serialize};

    fn editor(src: &str) -> Editor {
        let (doc, sel) = parse(src).unwrap();
        let mut ed = Editor::new(doc, sel.unwrap_or(Selection::caret(1)));
        ed.bind(nv_model::new_doc(), "default", Clock::manual());
        ed
    }

    fn show(ed: &Editor) -> String {
        serialize(&ed.doc, Some(&ed.sel), &|_, v| v.clone())
    }

    #[test]
    fn one_string_for_the_box() {
        let ed = editor(
            "<paragraph>ab<hardBreak/>c</paragraph><bulletList><listItem><paragraph>d<mention id=\"u2\" label=\"Sam\"/></paragraph></listItem></bulletList><horizontalRule/><paragraph>é😀</paragraph>",
        );
        let v = ed.text_for_view();
        assert_eq!(v.text, "ab\nc\nd\u{fffc}\n\u{fffc}\né😀");
        assert_eq!(v.len(), 13);
        // Inside a line, offsets move as positions do: "c" is at offset 3 and position 4.
        assert_eq!(v.to_pos(3), 4);
        assert_eq!(v.to_offset(4), 3);
        // Line ends and starts: the paragraph ends at 5; the list's paragraph starts at 9.
        assert_eq!(v.to_pos(4), 5);
        assert_eq!(v.to_pos(5), 9);
        assert_eq!(v.to_offset(9), 5);
        // Between blocks (6, 7, 8: entering the list, the item, the paragraph) goes to the next line.
        assert_eq!(v.to_offset(6), 5);
        assert_eq!(v.to_offset(8), 5);
        // The rule: before it is its line's start, after it its line's end.
        let rule = v.lines[2].clone();
        assert!(!rule.text);
        assert_eq!(v.to_pos(rule.offset), rule.pos);
        assert_eq!(v.to_pos(rule.offset + 1), rule.pos + 1);
        // A surrogate pair is two units, as in NSString and Java.
        assert_eq!(v.to_pos(13), ed.doc.content_size() - 1);
        assert_eq!(v.slice(10, 13), "é😀");
        // Every text position round-trips.
        for l in v.lines.iter().filter(|l| l.text) {
            for i in 0..=l.len {
                assert_eq!(v.to_offset(v.to_pos(l.offset + i)), l.offset + i);
            }
        }
    }

    #[test]
    fn task_lines_are_objects() {
        let ed = editor(
            "<taskRef taskId=\"t1\"><paragraph>note</paragraph></taskRef><paragraph>|</paragraph>",
        );
        let v = ed.text_for_view();
        assert_eq!(v.text, "\u{fffc}\nnote\n");
        assert_eq!(v.to_pos(2), 2);
        assert_eq!(v.to_pos(v.len()), ed.doc.content_size() - 1);
    }

    #[test]
    fn replace_keeps_marks_and_maps_the_caret() {
        let mut ed = editor("<paragraph>I saw <italic>teh</italic> |</paragraph>");
        assert!(ed.replace_range(7, 10, "the"));
        assert_eq!(
            show(&ed),
            "<paragraph>I saw <italic>the</italic> |</paragraph>"
        );
        let mut ed = editor("<paragraph>a <bold>wrd</bold> b|</paragraph>");
        ed.replace_range(3, 6, "word");
        assert_eq!(show(&ed), "<paragraph>a <bold>word</bold> b|</paragraph>");
    }

    #[test]
    fn replace_runs_no_rules_and_is_one_step() {
        let mut ed = editor("<paragraph>-x|</paragraph>");
        ed.replace_range(2, 3, " ");
        assert_eq!(show(&ed), "<paragraph>- |</paragraph>");
        ed.undo();
        assert_eq!(
            serialize(&ed.doc, None, &|_, v| v.clone()),
            "<paragraph>-x</paragraph>"
        );
    }

    #[test]
    fn replace_in_a_task_title() {
        let mut ed = editor("<taskRef taskId=\"t1\"/><paragraph/>");
        struct T(String);
        impl crate::TaskHost for T {
            fn new_id(&mut self) -> String {
                "x".into()
            }
            fn create(&mut self, _: &str, _: &str, _: bool) {}
            fn delete(&mut self, _: &str) {}
            fn restore(&mut self, _: &str) -> bool {
                false
            }
            fn title(&self, _: &str) -> Option<String> {
                Some(self.0.clone())
            }
            fn set_title(&mut self, _: &str, t: &str) {
                self.0 = t.into();
            }
        }
        ed.tasks = Box::new(T("Call Sma".into()));
        ed.focus = Focus::TaskTitle("t1".into());
        ed.replace_range(5, 8, "Sam");
        assert_eq!(ed.tasks.title("t1").as_deref(), Some("Call Sam"));
    }
}
