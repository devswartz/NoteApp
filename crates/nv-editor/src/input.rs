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
    /// The line's node type: a text block's (`paragraph`, `heading`, `codeBlock`), a leaf's
    /// (`horizontalRule`, `image`, ...), or `taskRef` for a task's title line.
    pub kind: String,
    /// A heading's level (0 for other lines).
    pub level: u8,
    /// The nodes the line sits in, from the box down (`bulletList`, `listItem`, `blockquote`,
    /// `taskRef` for a task's notes, ...): the view's indentation and quote bars.
    pub containers: Vec<String>,
    /// On the first line of a list item: its marker, `•` for bullets or the number as exports
    /// write it (`1.`, `b)`, `iv.`) for numbered lists. None on checklist items (see `checked`).
    pub marker: Option<String>,
    /// On the first line of a checklist item: whether it is ticked.
    pub checked: Option<bool>,
    /// On a task's title line: the task's id.
    pub task_id: Option<String>,
}

/// The box's text as the view's input protocol sees it, with the map back to positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewText {
    pub text: String,
    pub lines: Vec<ViewLine>,
}

/// Building a `ViewText`: the containers on the way down, and the list marker waiting for the
/// first line of the item being entered.
struct Build {
    v: ViewText,
    path: Vec<String>,
    pending: Option<(Option<String>, Option<bool>)>,
}

fn any_of(v: &serde_json::Value) -> Option<nv_model::yrs::Any> {
    use nv_model::yrs::Any;
    match v {
        serde_json::Value::String(s) => Some(Any::String(s.as_str().into())),
        serde_json::Value::Bool(b) => Some(Any::Bool(*b)),
        _ => None,
    }
}

/// The first number of each ordered list among `blocks` (following `continued` lists on).
fn list_starts(blocks: &[Node]) -> Vec<Option<f64>> {
    let infos: Vec<nv_model::lists::ListInfo> = blocks
        .iter()
        .map(|b| nv_model::lists::ListInfo {
            ordered: b.is("orderedList"),
            start: b.attr("start").as_f64().unwrap_or(1.0),
            continued: b.attr("continued").as_bool().unwrap_or(false),
            items: b.content.len(),
        })
        .collect();
    nv_model::lists::list_starts(&infos)
}

impl Build {
    fn line(&mut self, pos: usize, text: bool, size: usize, s: &str, node: &Node) {
        let v = &mut self.v;
        let mut offset = 0;
        if !v.lines.is_empty() {
            v.text.push('\n');
        }
        if let Some(l) = v.lines.last() {
            offset = l.offset + l.len + 1;
        }
        v.text.push_str(s);
        let (marker, checked) = self.pending.take().unwrap_or((None, None));
        v.lines.push(ViewLine {
            offset,
            len: u16_len(s),
            pos,
            text,
            size,
            kind: node.kind.clone(),
            level: if node.is("heading") {
                node.attr("level").as_u64().unwrap_or(1).min(6) as u8
            } else {
                0
            },
            containers: self.path.clone(),
            marker,
            checked,
            task_id: node
                .is(crate::tasks::TASK)
                .then(|| node.attr("taskId").as_str().unwrap_or("").to_string()),
        });
    }

    /// The children of `node`, whose content starts at `start`; `first` is the number of its
    /// first item when it is a numbered list.
    fn blocks(&mut self, node: &Node, start: usize, first: Option<f64>) {
        let mut pos = start;
        let starts = list_starts(&node.content);
        for (i, c) in node.content.iter().enumerate() {
            if node.is("bulletList") {
                self.pending = Some((Some("\u{2022}".into()), None));
            } else if node.is("orderedList") {
                let n = first.unwrap_or(1.0) + i as f64;
                let m = format!(
                    "{}{}",
                    nv_model::lists::list_marker(any_of(node.attr("type")).as_ref(), n),
                    nv_model::lists::list_suffix(any_of(node.attr("paren")).as_ref())
                );
                self.pending = Some((Some(m), None));
            } else if node.is("taskList") {
                self.pending = Some((None, Some(c.attr("checked") == &serde_json::json!(true))));
            }
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
                self.line(pos + 1, true, 0, &s, c);
            } else if c.is_leaf() {
                self.line(pos, false, c.node_size(), &OBJECT.to_string(), c);
            } else {
                if c.is(crate::tasks::TASK) {
                    // The task's title line; its notes follow as lines of their own.
                    self.line(pos, false, 1, &OBJECT.to_string(), c);
                }
                self.path.push(c.kind.clone());
                self.blocks(c, pos + 1, starts[i]);
                self.path.pop();
            }
            self.pending = None;
            pos += c.node_size();
        }
    }
}

impl ViewText {
    pub fn of(doc: &Node) -> ViewText {
        let mut b = Build {
            v: ViewText {
                text: String::new(),
                lines: Vec::new(),
            },
            path: Vec::new(),
            pending: None,
        };
        b.blocks(doc, 0, None);
        b.v
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

    /// The selection as (anchor, head) offsets in `text_for_view()`: a text selection maps its
    /// ends, a node selection is its U+FFFC (`offset..offset + 1`), select-all is `0..len`.
    pub fn view_selection(&self) -> (usize, usize) {
        self.view_selection_in(&self.text_for_view())
    }

    /// `view_selection` over a `ViewText` the caller already has (it must be this tree's).
    pub fn view_selection_in(&self, v: &ViewText) -> (usize, usize) {
        match self.sel {
            Selection::Text { anchor, head } => (v.to_offset(anchor), v.to_offset(head)),
            Selection::Node { pos } => {
                let o = v.to_offset(pos);
                (o, (o + 1).min(v.len()))
            }
            Selection::All => (0, v.len()),
        }
    }

    /// Set the selection from offsets in `text_for_view()` (the platform's `selectedTextRange`).
    /// A range covering exactly one object line's U+FFFC selects that node; a caret on an object
    /// line goes to the nearest text (back from its start, forward from its end); all of the
    /// string is select-all. Ends a composition.
    pub fn set_view_selection(&mut self, anchor: usize, head: usize) {
        self.end_composition();
        let v = self.text_for_view();
        let (a, h) = (anchor.min(v.len()), head.min(v.len()));
        let (from, to) = (a.min(h), a.max(h));
        let object = v
            .lines
            .iter()
            .find(|l| !l.text && l.offset == from)
            .filter(|_| to == from + 1);
        self.sel = if let Some(l) = object {
            Selection::Node { pos: l.pos }
        } else if from == 0 && to == v.len() && to > 0 && v.lines.len() > 1 {
            Selection::All
        } else {
            let end = |o: usize| {
                let p = v.to_pos(o);
                let on_object = v
                    .lines
                    .iter()
                    .any(|l| !l.text && o >= l.offset && o <= l.offset + l.len);
                if on_object {
                    let dir = if v.lines.iter().any(|l| !l.text && l.offset == o) {
                        -1
                    } else {
                        1
                    };
                    crate::editor::near_text(&self.doc, p, dir)
                } else {
                    p
                }
            };
            Selection::text(end(a), end(h))
        };
        self.stored_marks = None;
        self.focus = Focus::Doc;
    }

    /// While composing: the marked text's range and the selection inside it, as offsets in
    /// `text_for_view()` ((from, to), (sel_from, sel_to)), for `markedTextRange` and the like.
    pub fn view_composition(&self) -> Option<((usize, usize), (usize, usize))> {
        self.composition.as_ref()?;
        self.view_composition_in(&self.text_for_view())
    }

    /// `view_composition` over a `ViewText` the caller already has (it must be this tree's).
    pub fn view_composition_in(&self, v: &ViewText) -> Option<((usize, usize), (usize, usize))> {
        let c = self.composition.as_ref()?;
        let from = v.to_offset(c.from);
        let to = v.to_offset(c.to);
        let (s, e) = c.sel_in_text;
        Some(((from, to), ((from + s).min(to), (from + e).min(to))))
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
    fn the_line_table() {
        let ed = editor(
            "<orderedList start=3 type=\"a\"><listItem><paragraph>x</paragraph></listItem><listItem><paragraph>y</paragraph><bulletList><listItem><paragraph>z</paragraph></listItem></bulletList></listItem></orderedList><taskList><taskItem checked=true><paragraph>done</paragraph></taskItem></taskList><taskRef taskId=\"t1\"><paragraph>note</paragraph></taskRef><blockquote><heading level=2>h</heading></blockquote><paragraph>|</paragraph>",
        );
        let v = ed.text_for_view();
        let l = &v.lines;
        assert_eq!(l[0].marker.as_deref(), Some("c."));
        assert_eq!(l[1].marker.as_deref(), Some("d."));
        assert_eq!(l[2].marker.as_deref(), Some("\u{2022}"));
        assert_eq!(
            l[2].containers,
            ["orderedList", "listItem", "bulletList", "listItem"]
        );
        assert_eq!((l[3].marker.as_ref(), l[3].checked), (None, Some(true)));
        assert_eq!(
            (l[4].kind.as_str(), l[4].task_id.as_deref()),
            ("taskRef", Some("t1"))
        );
        assert_eq!(l[5].containers, ["taskRef"]);
        assert_eq!(l[5].marker, None);
        assert_eq!((l[6].kind.as_str(), l[6].level), ("heading", 2));
        assert_eq!(l[6].containers, ["blockquote"]);
    }

    #[test]
    fn selection_in_view_offsets() {
        let mut ed = editor("<paragraph>ab</paragraph><horizontalRule/><paragraph>|cd</paragraph>");
        assert_eq!(ed.view_selection(), (5, 5));
        ed.set_view_selection(3, 4);
        assert_eq!(ed.sel, Selection::Node { pos: 4 });
        assert_eq!(ed.view_selection(), (3, 4));
        ed.set_view_selection(4, 4);
        assert_eq!(ed.sel, Selection::caret(6));
        ed.set_view_selection(0, 7);
        assert_eq!(ed.sel, Selection::All);
        ed.set_view_selection(1, 6);
        assert_eq!(ed.sel, Selection::text(2, 7));
        ed.set_view_selection(6, 6);
        ed.set_composition("xy", Some((1, 1)));
        assert_eq!(ed.view_composition(), Some(((6, 8), (7, 7))));
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
