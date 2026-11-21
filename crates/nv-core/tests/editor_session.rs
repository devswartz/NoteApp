//! Editor sessions through the Core API (src/editor_session.rs): typing writes into the page
//! doc, undo, IME composition, two sessions converging, and tasks through the app's callbacks.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use nv_core::*;

fn page(name: &str) -> Vec<u8> {
    fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/corpus/cases")
            .join(name)
            .join("page.bin"),
    )
    .unwrap()
}

#[derive(Default)]
struct FakeTasks {
    log: Mutex<Vec<String>>,
    titles: Mutex<Vec<(String, String)>>,
}

impl TaskCallbacks for FakeTasks {
    fn new_id(&self) -> String {
        let n = self.log.lock().unwrap().len();
        format!("task-{n}")
    }
    fn create(&self, id: String, title: String, done: bool) {
        self.log
            .lock()
            .unwrap()
            .push(format!("create {id} {title:?} {done}"));
        self.titles.lock().unwrap().push((id, title));
    }
    fn delete(&self, id: String) {
        self.log.lock().unwrap().push(format!("delete {id}"));
        self.titles.lock().unwrap().retain(|t| t.0 != id);
    }
    fn restore(&self, id: String) -> bool {
        self.log.lock().unwrap().push(format!("restore {id}"));
        true
    }
    fn title(&self, id: String) -> Option<String> {
        self.titles
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.0 == id)
            .map(|t| t.1.clone())
    }
    fn set_title(&self, id: String, title: String) {
        self.log
            .lock()
            .unwrap()
            .push(format!("title {id} {title:?}"));
    }
}

fn open(update: Vec<u8>, field: &str) -> (Arc<EditorSession>, Arc<FakeTasks>) {
    let tasks = Arc::new(FakeTasks::default());
    let s = EditorSession::open(update, field.into(), tasks.clone()).unwrap();
    (s, tasks)
}

/// The box's text as the page doc holds it (read back through `read_page`).
fn box_text(s: &EditorSession, id: &str) -> String {
    let info = read_page(s.encode_update_since(Vec::new()).unwrap()).unwrap();
    let c = info
        .content
        .iter()
        .find(|c| c.box_id.as_deref() == Some(id))
        .unwrap();
    fn text(n: &ContentNode, out: &mut String) {
        for r in &n.runs {
            out.push_str(&r.text);
        }
        for k in &n.children {
            text(k, out);
        }
    }
    let mut out = String::new();
    for n in &c.nodes {
        text(n, &mut out);
        out.push('\n');
    }
    out
}

#[test]
fn typing_changes_the_state_and_the_page() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    let before = box_text(&s, "a");
    let sv = s.state_vector();
    for c in "Hi ".chars() {
        s.insert_text(c.to_string());
    }
    let st = s.state();
    assert!(st.doc_json.contains("Hi "), "{}", st.doc_json);
    assert_eq!(st.selection, EditorSelection::Text { anchor: 4, head: 4 });
    let after = box_text(&s, "a");
    assert_eq!(after, format!("Hi {before}"));
    // The edit is there to send.
    assert!(s.encode_update_since(sv).unwrap().len() > 2);
    // Undo takes the typing away, in the state and in the page.
    assert!(s.undo());
    assert_eq!(box_text(&s, "a"), before);
    assert!(!s.state().doc_json.contains("Hi "));
    assert!(s.redo());
    assert_eq!(box_text(&s, "a"), after);
}

#[test]
fn keys_and_commands() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    s.insert_text("x".into());
    s.set_selection(1, 2);
    assert!(s
        .command("toggleMark".into(), r#"{"mark":"bold"}"#.into())
        .unwrap());
    assert!(s.state().doc_json.contains(r#""marks":[{"type":"bold"}]"#));
    // Undo (the typing and the bold were one step, within 500 ms).
    assert!(s.key("Mod+z".into()));
    assert!(!s.state().doc_json.contains("bold"));
    s.set_selection(1, 1);
    s.insert_text("x".into());
    assert_eq!(
        s.command("noSuchThing".into(), String::new()),
        Err(EditorError::UnknownCommand {
            name: "noSuchThing".into()
        })
    );
    assert!(matches!(
        s.command("toggleMark".into(), "[1]".into()),
        Err(EditorError::InvalidArgs { .. })
    ));
    let c = s.copy();
    assert_eq!(c.text, "");
    s.set_selection(1, 2);
    assert_eq!(s.copy().text, "x");
    assert!(s.paste(String::new(), "yz".into()));
    assert!(s.state().doc_json.contains("yz"));
}

#[test]
fn slash_menu_in_the_state() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    s.insert_text("/".into());
    s.insert_text("he".into());
    let sug = s.state().suggestion.unwrap();
    assert_eq!(sug.trigger, SuggestionTrigger::Slash);
    assert_eq!(sug.query, "he");
    assert_eq!(sug.slash_items[0], "Heading 1");
    assert!(s
        .command("pickSlash".into(), r#"{"title":"Heading 2"}"#.into())
        .unwrap());
    assert!(s.state().suggestion.is_none());
}

#[test]
fn unknown_boxes_and_bad_bytes() {
    let t: Arc<dyn TaskCallbacks> = Arc::new(FakeTasks::default());
    assert_eq!(
        EditorSession::open(page("canvas-boxes"), "box:nope".into(), t.clone()).err(),
        Some(EditorError::NoSuchBox {
            field: "box:nope".into()
        })
    );
    assert!(matches!(
        EditorSession::open(vec![1, 2, 3], "default".into(), t).err(),
        Some(EditorError::InvalidPage { .. })
    ));
}

#[test]
fn composition_is_one_change_on_commit() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    let before = box_text(&s, "a");
    let sv = s.state_vector();
    let nothing = s.encode_update_since(sv.clone()).unwrap();
    s.set_composition("k".into(), 1, 1);
    s.set_composition("か".into(), 0, 1);
    let st = s.state();
    assert_eq!(st.composing, Some(TextRange { from: 1, to: 2 }));
    assert_eq!(st.selection, EditorSelection::Text { anchor: 1, head: 2 });
    assert!(st.doc_json.contains("か"));
    // Nothing written while composing.
    assert_eq!(s.encode_update_since(sv.clone()).unwrap(), nothing);
    assert_eq!(box_text(&s, "a"), before);
    s.commit_composition("蚊".into());
    assert_eq!(s.state().composing, None);
    assert_eq!(box_text(&s, "a"), format!("蚊{before}"));
    // One change: one undo takes it away.
    assert!(s.undo());
    assert_eq!(box_text(&s, "a"), before);
    // Cancel leaves the page as it was.
    s.set_composition("x".into(), 1, 1);
    s.cancel_composition();
    assert_eq!(box_text(&s, "a"), before);
    assert!(!s.state().doc_json.contains("\"x"));
}

#[test]
fn replacement_and_the_views_text() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    let before = box_text(&s, "a");
    // The view's string starts with the box's first line, offsets matching positions - 1.
    let text = s.text_for_view();
    assert!(before.starts_with(text.lines().next().unwrap()));
    assert_eq!(s.view_offset_to_pos(0), 1);
    assert_eq!(s.pos_to_view_offset(1), 0);
    // Autocorrect: the first two characters replaced, the caret where it was (shifted).
    s.set_selection(3, 3);
    assert!(s.replace_range(1, 3, "XYZ".into()));
    assert_eq!(
        s.state().selection,
        EditorSelection::Text { anchor: 4, head: 4 }
    );
    let first: String = before.chars().skip(2).collect();
    assert_eq!(box_text(&s, "a"), format!("XYZ{first}"));
    assert!(s.undo());
    assert_eq!(box_text(&s, "a"), before);
    // finish_composition commits the marked text as it stands.
    s.set_composition("ab".into(), 2, 2);
    s.finish_composition();
    assert_eq!(s.state().composing, None);
    assert!(box_text(&s, "a").contains("ab"));
}

#[test]
fn two_sessions_converge() {
    let (a, _) = open(page("canvas-boxes"), "box:a");
    let (b, _) = open(page("canvas-boxes"), "box:a");
    // Bring b up to date with a's opening writes (the trailing paragraph), and back.
    b.apply_update(a.encode_update_since(b.state_vector()).unwrap())
        .unwrap();
    a.apply_update(b.encode_update_since(a.state_vector()).unwrap())
        .unwrap();
    // a's caret at the end of its first line; b types at the start of it.
    let end = {
        let st = a.state();
        let doc: serde_json::Value = serde_json::from_str(&st.doc_json).unwrap();
        let first = doc["content"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        1 + first.encode_utf16().count() as u32
    };
    a.set_selection(end, end);
    b.insert_text("B: ".into());
    a.insert_text("!".into());
    let ua = a.encode_update_since(b.state_vector()).unwrap();
    let ub = b.encode_update_since(a.state_vector()).unwrap();
    a.apply_update(ub).unwrap();
    b.apply_update(ua).unwrap();
    assert_eq!(a.state().doc_json, b.state().doc_json);
    let text = box_text(&a, "a");
    assert!(text.starts_with("B: "), "{text}");
    assert_eq!(box_text(&b, "a"), text);
    // a's caret stayed after its "!", moved right by b's typing.
    assert_eq!(
        a.state().selection,
        EditorSelection::Text {
            anchor: end + 4,
            head: end + 4
        }
    );
    // Remote cursors follow the same way.
    a.set_remote_cursors(vec![RemoteCursor {
        user_id: "b".into(),
        anchor: 1,
        head: 1,
    }]);
    b.set_selection(1, 1);
    b.insert_text("+".into());
    a.apply_update(b.encode_update_since(a.state_vector()).unwrap())
        .unwrap();
    assert_eq!(a.remote_cursors()[0].anchor, 2);
}

#[test]
fn tasks_go_through_the_callbacks() {
    let (s, tasks) = open(page("canvas-boxes"), "box:a");
    assert!(s
        .command("insertTask".into(), r#"{"title":"Buy milk"}"#.into())
        .unwrap());
    assert_eq!(
        tasks.log.lock().unwrap().clone(),
        ["create task-0 \"Buy milk\" false"]
    );
    assert!(s.state().doc_json.contains("task-0"));
    assert!(s.undo());
    assert!(!s.state().doc_json.contains("task-0"));
    assert_eq!(tasks.log.lock().unwrap().last().unwrap(), "delete task-0");
    assert!(s.redo());
    let log = tasks.log.lock().unwrap().clone();
    assert_eq!(
        log.last().unwrap(),
        "restore task-0",
        "{log:?} {}",
        s.state().doc_json
    );
}

/// Box a of canvas-boxes emptied, then: a heading, a bulleted list of two, a numbered item and
/// a rule (typed through the session, input rules included).
fn structured() -> Arc<EditorSession> {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    s.command("selectAll".into(), String::new()).unwrap();
    s.key("Backspace".into());
    s.insert_text("Title".into());
    s.command("setHeading".into(), r#"{"level":1}"#.into())
        .unwrap();
    s.key("Enter".into());
    for t in ["-", " ", "one"] {
        s.insert_text(t.into());
    }
    s.key("Enter".into());
    s.insert_text("two".into());
    s.key("Enter".into());
    s.key("Enter".into());
    for t in ["1", ".", " ", "first"] {
        s.insert_text(t.into());
    }
    s.key("Enter".into());
    s.key("Enter".into());
    s
}

#[test]
fn the_views_lines_and_selection_in_offsets() {
    let s = structured();
    let v = s.view_state();
    assert_eq!(v.text, "Title\none\ntwo\nfirst\n\n");
    assert_eq!(v.len, 21);
    let l = &v.lines;
    assert_eq!(
        (l[0].kind.as_str(), l[0].level, l[0].offset),
        ("heading", 1, 0)
    );
    assert_eq!(l[1].containers, ["bulletList", "listItem"]);
    assert_eq!(l[1].marker.as_deref(), Some("\u{2022}"));
    assert_eq!((l[2].offset, l[2].len), (10, 3));
    assert_eq!(l[3].containers, ["orderedList", "listItem"]);
    assert_eq!(l[3].marker.as_deref(), Some("1."));
    assert!(l[4].containers.is_empty() && l[4].marker.is_none());
    // A selection set in view offsets ("ne\ntw") reads back the same, and is the engine's
    // positions underneath.
    s.set_view_selection(7, 12);
    assert_eq!(
        s.view_selection(),
        ViewRange {
            anchor: 7,
            head: 12
        }
    );
    assert_eq!(
        s.state().selection,
        EditorSelection::Text {
            anchor: s.view_offset_to_pos(7),
            head: s.view_offset_to_pos(12)
        }
    );
    // Backwards selections keep their direction.
    s.set_view_selection(12, 7);
    assert_eq!(
        s.view_state().selection,
        ViewRange {
            anchor: 12,
            head: 7
        }
    );
    // All of the string is select-all.
    s.set_view_selection(0, 21);
    assert_eq!(s.state().selection, EditorSelection::All);
    assert_eq!(
        s.view_selection(),
        ViewRange {
            anchor: 0,
            head: 21
        }
    );
    // A rule is an object line: its U+FFFC alone selects the node.
    s.set_view_selection(20, 20);
    s.insert_text("/".into());
    s.insert_text("divider".into());
    assert!(s.key("Enter".into()));
    let v = s.view_state();
    let rule = v
        .lines
        .iter()
        .find(|l| l.kind == "horizontalRule")
        .unwrap()
        .clone();
    assert!(!rule.is_text);
    assert_eq!(
        v.text.encode_utf16().nth(rule.offset as usize),
        Some(0xfffc)
    );
    s.set_view_selection(rule.offset, rule.offset + 1);
    assert_eq!(s.state().selection, EditorSelection::Node { pos: rule.pos });
    assert_eq!(
        s.view_selection(),
        ViewRange {
            anchor: rule.offset,
            head: rule.offset + 1
        }
    );
    // A caret at the rule's line start goes back to the text before it.
    s.set_view_selection(rule.offset, rule.offset);
    let EditorSelection::Text { head, .. } = s.state().selection else {
        panic!("not a caret");
    };
    assert_eq!(s.pos_to_view_offset(head), rule.offset - 1);
    // Replacing in view offsets: "two" becomes "2".
    assert!(s.replace_view_range(10, 13, "2".into()));
    assert!(s.view_state().text.starts_with("Title\none\n2\nfirst"));
}

#[test]
fn marked_text_in_view_offsets() {
    let s = structured();
    // The caret after "two"; compose there.
    s.set_view_selection(13, 13);
    s.set_composition("k".into(), 1, 1);
    s.set_composition("かな".into(), 0, 2);
    let v = s.view_state();
    assert_eq!(
        v.marked,
        Some(ViewMarked {
            from: 13,
            to: 15,
            sel_from: 13,
            sel_to: 15
        })
    );
    assert_eq!(
        v.selection,
        ViewRange {
            anchor: 13,
            head: 15
        }
    );
    assert!(v.text.contains("twoかな\n"));
    // The positions agree with the view offsets.
    let c = s.state().composing.unwrap();
    assert_eq!(
        (s.pos_to_view_offset(c.from), s.pos_to_view_offset(c.to)),
        (13, 15)
    );
    // The caret inside the marked text.
    s.set_composition("かな".into(), 1, 1);
    let m = s.view_state().marked.unwrap();
    assert_eq!((m.sel_from, m.sel_to), (14, 14));
    s.commit_composition("仮名".into());
    let v = s.view_state();
    assert_eq!(v.marked, None);
    assert!(v.text.contains("two仮名\n"));
    assert_eq!(
        v.selection,
        ViewRange {
            anchor: 15,
            head: 15
        }
    );
    // A composition over a selection set in view offsets replaces it; cancel removes both.
    s.set_view_selection(6, 9);
    s.set_composition("x".into(), 1, 1);
    let m = s.view_state().marked.unwrap();
    assert_eq!((m.from, m.to), (6, 7));
    s.cancel_composition();
    assert_eq!(s.view_state().marked, None);
    assert!(s.view_state().text.starts_with("Title\n\ntwo"));
}

#[test]
fn slash_menu_rows_highlight_and_anchor() {
    let s = structured();
    s.set_view_selection(20, 20);
    s.insert_text("/".into());
    s.insert_text("h".into());
    let sug = s.state().suggestion.unwrap();
    assert_eq!(sug.trigger, SuggestionTrigger::Slash);
    assert_eq!((sug.view_from, sug.view_to), (20, 22));
    assert_eq!(s.view_offset_to_pos(sug.view_from), sug.from);
    assert_eq!(sug.items[0].id, "Heading 1");
    assert_eq!(sug.items[0].icon, "heading-1");
    assert_eq!(sug.items[0].description, "Large section heading");
    assert_eq!(sug.items.len(), sug.slash_items.len());
    assert_eq!(sug.highlighted, Some(0));
    // ArrowDown moves the highlight, ArrowUp wraps to the last row, Enter picks.
    assert!(s.key("ArrowDown".into()));
    assert_eq!(s.state().suggestion.unwrap().highlighted, Some(1));
    assert!(s.move_suggestion_highlight(-2));
    assert_eq!(
        s.state().suggestion.unwrap().highlighted,
        Some(sug.items.len() as u32 - 1)
    );
    assert!(s.move_suggestion_highlight(2));
    // Typing more resets the highlight to the first match.
    s.insert_text("e".into());
    assert_eq!(s.state().suggestion.unwrap().highlighted, Some(0));
    assert!(s.key("ArrowDown".into()));
    assert!(s.key("Enter".into()));
    assert!(s.state().suggestion.is_none());
    assert!(s
        .state()
        .doc_json
        .contains(r#"{"attrs":{"level":2},"type":"heading"}"#));
    // pick_suggestion runs the highlighted row; dismissing closes the menu for that trigger.
    s.insert_text("/".into());
    s.insert_text("quo".into());
    assert!(s.pick_suggestion());
    assert!(s.state().doc_json.contains("blockquote"));
    s.insert_text("/".into());
    assert!(s.dismiss_suggestion());
    assert!(s.state().suggestion.is_none());
    assert!(!s.pick_suggestion());
    // `[[` has the view's list: no rows, no highlight, but the anchor.
    s.insert_text(" [[pa".into());
    let sug = s.state().suggestion.unwrap();
    assert_eq!(sug.trigger, SuggestionTrigger::PageLink);
    assert_eq!(sug.query, "pa");
    assert!(sug.items.is_empty() && sug.highlighted.is_none());
    assert_eq!(sug.view_to - sug.view_from, 4);
    assert!(!s.move_suggestion_highlight(1));
}

#[test]
fn clipboard_through_view_selections() {
    let s = structured();
    // "one" and "two": the list items.
    s.set_view_selection(6, 13);
    let c = s.copy();
    assert!(c.text.contains("one") && c.text.contains("two"), "{c:?}");
    assert!(c.html.contains("<ul>") && c.html.contains("<li>"), "{c:?}");
    let cut = s.cut();
    assert_eq!(cut, c);
    assert!(!s.view_state().text.contains("one"));
    // Paste the HTML back at the empty line at the end: a list again.
    let end = s.view_state().len;
    s.set_view_selection(end, end);
    assert!(s.paste(cut.html.clone(), cut.text.clone()));
    let v = s.view_state();
    let one = v
        .lines
        .iter()
        .find(|l| {
            v.text
                .encode_utf16()
                .skip(l.offset as usize)
                .take(3)
                .eq("one".encode_utf16())
        })
        .unwrap();
    assert_eq!(one.marker.as_deref(), Some("\u{2022}"));
    // Plain text only: lines become paragraphs.
    let end = s.view_state().len;
    s.set_view_selection(end, end);
    assert!(s.paste(String::new(), "alpha\nbeta".into()));
    assert!(s.view_state().text.contains("alpha\nbeta"));
    // Copy of a node selection (a rule) is its HTML.
    s.set_view_selection(0, 0);
    s.insert_text("/".into());
    s.insert_text("divider".into());
    s.key("Enter".into());
    let rule = s
        .view_state()
        .lines
        .into_iter()
        .find(|l| l.kind == "horizontalRule")
        .unwrap();
    s.set_view_selection(rule.offset, rule.offset + 1);
    assert!(s.copy().html.contains("<hr>"));
}

#[test]
fn undo_groups_typing_in_500_ms_windows() {
    let tasks: Arc<dyn TaskCallbacks> = Arc::new(FakeTasks::default());
    let clock = nv_editor::bind::Clock::manual();
    let s =
        EditorSession::open_with_clock(page("canvas-boxes"), "box:a".into(), tasks, clock.clone())
            .unwrap();
    let before = box_text(&s, "a");
    // Opening isn't undoable.
    assert!(!s.can_undo() && !s.can_redo());
    s.insert_text("a".into());
    clock.advance(300);
    s.insert_text("b".into());
    // 600 ms after "a" but 300 ms after "b": the window runs from the last change.
    clock.advance(300);
    s.insert_text("c".into());
    clock.advance(501);
    s.insert_text("d".into());
    assert!(s.can_undo() && s.state().can_undo);
    assert_eq!(box_text(&s, "a"), format!("abcd{before}"));
    // "d" alone, then "abc" together.
    assert!(s.undo());
    assert_eq!(box_text(&s, "a"), format!("abc{before}"));
    assert!(s.can_redo() && s.state().can_redo);
    assert!(s.undo());
    assert_eq!(box_text(&s, "a"), before);
    assert!(!s.can_undo());
    assert!(s.redo());
    assert!(s.redo());
    assert!(!s.can_redo());
    assert_eq!(box_text(&s, "a"), format!("abcd{before}"));
    // An open composition counts as undoable (undo commits it first).
    clock.advance(501);
    s.set_composition("x".into(), 1, 1);
    assert!(s.can_undo() && !s.can_redo());
}

#[test]
fn undo_groups_on_the_real_clock() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    let before = box_text(&s, "a");
    s.insert_text("x".into());
    s.insert_text("y".into());
    std::thread::sleep(std::time::Duration::from_millis(650));
    s.insert_text("z".into());
    assert!(s.undo());
    assert_eq!(box_text(&s, "a"), format!("xy{before}"));
    assert!(s.undo());
    assert_eq!(box_text(&s, "a"), before);
    assert!(!s.can_undo());
}
