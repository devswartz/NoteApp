//! Editor sessions through the Core API (src/editor_session.rs): typing writes into the page
//! doc, undo, IME composition, two sessions converging, tasks through the app's callbacks, the
//! one-call view frame, and sessions on a live page (against the stand-in collab server,
//! crates/nv-sync/tests/support).

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nv_core::*;
use nv_model::yrs::updates::decoder::Decode;
use nv_model::yrs::{ReadTxn, StateVector, Transact, Update};
use support::{wait_for, TestServer};

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
    text_in(s.encode_update_since(Vec::new()).unwrap(), id)
}

/// The text of box `id` in a page document, a line per block.
fn text_in(update: Vec<u8>, id: &str) -> String {
    let info = read_page(update).unwrap();
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
fn add_checklist_is_offered_next_to_a_task() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    s.key("Mod+a".into());
    s.insert_text("/add".into());
    let rows = |s: &EditorSession| {
        s.state()
            .suggestion
            .map(|g| g.slash_items)
            .unwrap_or_default()
    };
    assert!(!rows(&s).contains(&"Add checklist".to_string()));
    s.key("Mod+a".into());
    s.insert_text("Pack".into());
    assert!(s.key("Mod+Enter".into()));
    // The task line (an empty one is two positions), then the line below it.
    s.set_selection(3, 3);
    s.insert_text("/add".into());
    let sug = s.state().suggestion.unwrap();
    assert_eq!(sug.slash_items, vec!["Add checklist".to_string()]);
    assert_eq!(sug.items[0].icon, "list-plus");
    assert!(s.key("Enter".into()));
    let doc = s.state().doc_json;
    assert!(doc.contains("taskList"), "{doc}");
    assert!(!doc.contains("/add"), "{doc}");
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

#[test]
fn one_call_per_frame_and_revisions() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    let first = s.view_render();
    assert_eq!(first.view, s.view_state());
    assert_eq!(first.revision, s.revision());
    // Reading doesn't move anything.
    let again = s.view_render();
    assert_eq!(again, first);
    // A selection move: a new revision, the same text.
    s.set_view_selection(1, 1);
    s.set_view_selection(0, 0);
    let moved = s.view_render();
    assert!(moved.revision > first.revision);
    assert_eq!(moved.text_revision, first.text_revision);
    assert_eq!(moved.view.selection, ViewRange { anchor: 0, head: 0 });
    // Typing: new text.
    s.insert_text("/".into());
    let typed = s.view_render();
    assert!(typed.revision > moved.revision);
    assert!(typed.text_revision > moved.text_revision);
    assert_eq!(typed.view.text, s.text_for_view());
    assert!(typed.can_undo && !typed.can_redo);
    let sug = typed.suggestion.unwrap();
    assert_eq!(sug.trigger, SuggestionTrigger::Slash);
    assert_eq!((sug.view_from, sug.view_to), (0, 1));
    // Composing shows the marked text in the frame.
    s.dismiss_suggestion();
    s.set_composition("k".into(), 1, 1);
    let marked = s.view_render().view.marked.unwrap();
    assert_eq!((marked.from, marked.to), (1, 2));
    s.cancel_composition();
    // Remote carets in view offsets.
    s.set_remote_cursors(vec![RemoteCursor {
        user_id: "u2".into(),
        anchor: 1,
        head: 1,
    }]);
    let r = s.view_render();
    assert_eq!(
        r.remote_cursors,
        [ViewCursor {
            user_id: "u2".into(),
            anchor: 0,
            head: 0
        }]
    );
    assert_eq!(r.focus_task_id, None);
}

#[derive(Clone, Default)]
struct Script(Arc<Mutex<VecDeque<serde_json::Value>>>);
impl nv_api::Transport for Script {
    fn send(&self, req: &nv_api::Request) -> Result<nv_api::Response, String> {
        let body = self
            .0
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| format!("unscripted: {} {}", req.method, req.url))?;
        Ok(nv_api::Response {
            status: 200,
            body: body.to_string(),
            request_id: None,
        })
    }
}

#[derive(Default)]
struct Events {
    synced: Mutex<u32>,
    changes: Mutex<u32>,
}
impl LivePageListener for Events {
    fn on_status(&self, s: LiveStatus) {
        if s == LiveStatus::Synced {
            *self.synced.lock().unwrap() += 1;
        }
    }
    fn on_change(&self, _: PageInfo) {
        *self.changes.lock().unwrap() += 1;
    }
}

/// Apply a full page document (or an update) to a doc.
fn apply(doc: &nv_model::yrs::Doc, update: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

fn full(doc: &nv_model::yrs::Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

#[test]
fn a_live_session_edits_the_live_page_and_sees_others_changes() {
    let server = TestServer::start(&["acc"]);
    apply(server.room.doc(), &page("canvas-boxes"));
    let script = Script::default();
    script.0.lock().unwrap().push_back(serde_json::json!({
        "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
        "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true }
    }));
    let core = Core::with_transport(&server.base, Box::new(script), None);
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("sync", || *ev.synced.lock().unwrap() == 1);
    let before = text_in(live.document(), "a");

    let tasks = Arc::new(FakeTasks::default());
    let s = EditorSession::open_live(live.clone(), "box:a".into(), tasks.clone()).unwrap();
    for c in "Hi ".chars() {
        s.insert_text(c.to_string());
    }
    // In the live page at once, and on the server soon after: no bytes through the app.
    assert_eq!(text_in(live.document(), "a"), format!("Hi {before}"));
    wait_for("the server to get the typing", || {
        text_in(full(server.room.doc()), "a") == format!("Hi {before}")
    });
    wait_for("the receipt", || live.unsent_updates() == 0);
    // The server's echo of our own edit isn't taken as someone else's change.
    std::thread::sleep(Duration::from_millis(100));
    let rev = s.revision();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(s.revision(), rev);

    // Someone else types at the start of the box, on the server.
    let (other, _) = open(full(server.room.doc()), "box:a");
    let sv = other.state_vector();
    other.insert_text("Yo ".into());
    apply(server.room.doc(), &other.encode_update_since(sv).unwrap());
    wait_for("the change to reach the session", || {
        s.view_render().view.text.starts_with("Yo Hi ")
    });
    assert!(s.revision() > rev);
    assert!(*ev.changes.lock().unwrap() > 0, "the app hears it too");
    // The caret stayed after our "Hi ".
    assert_eq!(
        s.state().selection,
        EditorSelection::Text { anchor: 7, head: 7 }
    );

    // Undo takes back only this session's typing; the other person's stays.
    assert!(s.undo());
    assert_eq!(text_in(live.document(), "a"), format!("Yo {before}"));
    wait_for("the server to get the undo", || {
        text_in(full(server.room.doc()), "a") == format!("Yo {before}")
    });
    assert!(!s.can_undo());

    // Tasks still go through the app's callbacks.
    assert!(s
        .command("insertTask".into(), r#"{"title":"Buy milk"}"#.into())
        .unwrap());
    assert_eq!(
        tasks.log.lock().unwrap().clone(),
        ["create task-0 \"Buy milk\" false"]
    );
    wait_for("the task line on the server", || {
        read_page(full(server.room.doc()))
            .unwrap()
            .task_ids
            .contains(&"task-0".to_string())
    });

    // A second session on the page: each takes the other's edits as others' changes.
    let s2 = EditorSession::open_live(live.clone(), "box:a".into(), Arc::new(FakeTasks::default()))
        .unwrap();
    s2.insert_text("Q".into());
    assert!(s.text_for_view().starts_with("Q"), "{}", s.text_for_view());
    drop(s2);

    // Closing the page leaves the session usable (its edits just aren't sent).
    live.close();
    s.insert_text("z".into());
    drop(s);
}

#[test]
fn opening_a_session_sends_no_update() {
    let server = TestServer::start(&["acc"]);
    apply(server.room.doc(), &page("canvas-boxes"));
    let script = Script::default();
    script.0.lock().unwrap().push_back(serde_json::json!({
        "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
        "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true }
    }));
    let core = Core::with_transport(&server.base, Box::new(script), None);
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("sync", || *ev.synced.lock().unwrap() == 1);
    wait_for("the receipt", || live.unsent_updates() == 0);
    let sv = |u: Vec<u8>| {
        nv_model::doc_from_update(&u)
            .unwrap()
            .transact()
            .state_vector()
    };
    let before = sv(live.document());

    // Every box, opened and drawn: nothing is written, whether or not it ends in a paragraph.
    for b in nv_model::Page::read(&nv_model::doc_from_update(&live.document()).unwrap()).boxes {
        let s = EditorSession::open_live(
            live.clone(),
            format!("box:{}", b.id),
            Arc::new(FakeTasks::default()),
        )
        .unwrap();
        let v = s.view_render();
        assert!(
            v.view.lines.last().is_some_and(|l| l.kind == "paragraph"),
            "the view always ends in a paragraph: {:?}",
            v.view.lines.last().map(|l| l.kind.clone())
        );
        s.set_view_selection(0, 0);
    }
    assert_eq!(live.unsent_updates(), 0);
    assert_eq!(
        sv(live.document()),
        before,
        "opening wrote to the live page"
    );
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        sv(full(server.room.doc())),
        before,
        "opening sent an update"
    );

    // The first real edit writes the trailing paragraph with it.
    let s = EditorSession::open_live(live.clone(), "box:a".into(), Arc::new(FakeTasks::default()))
        .unwrap();
    s.insert_text("x".into());
    assert_ne!(sv(live.document()), before);
}

#[test]
fn a_live_session_needs_the_box() {
    let server = TestServer::start(&["acc"]);
    let script = Script::default();
    script.0.lock().unwrap().push_back(serde_json::json!({
        "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
        "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true }
    }));
    let core = Core::with_transport(&server.base, Box::new(script), None);
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("sync", || *ev.synced.lock().unwrap() == 1);
    let t: Arc<dyn TaskCallbacks> = Arc::new(FakeTasks::default());
    assert_eq!(
        EditorSession::open_live(live.clone(), "box:a".into(), t).err(),
        Some(EditorError::NoSuchBox {
            field: "box:a".into()
        })
    );
    live.close();
}

fn mark(kind: ViewMarkKind, value: Option<&str>) -> ViewMark {
    ViewMark {
        kind,
        value: value.map(String::from),
    }
}

#[test]
fn view_runs_active_marks_and_atoms() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    s.set_view_selection(0, s.view_state().len);
    // "😀 word" with the emoji before the bold word, then a mention and a page link.
    s.insert_text("\u{1f600} word ".into());
    let r = s.view_render();
    let end = r.view.len;
    s.set_view_selection(3, 7);
    s.command("toggleMark".into(), r#"{"mark":"bold"}"#.into())
        .unwrap();
    s.command("setColor".into(), r#"{"color":"red"}"#.into())
        .unwrap();
    s.command("setHighlight".into(), r#"{"color":"yellow"}"#.into())
        .unwrap();
    s.command("setLink".into(), r#"{"href":"https://a.b"}"#.into())
        .unwrap();
    s.command("setComment".into(), r#"{"threadId":"t1"}"#.into())
        .unwrap();
    let marked = s.view_render();
    assert!(marked.text_revision > r.text_revision);
    assert_eq!(marked.view.text, r.view.text);
    let line = &marked.view.lines[0];
    assert_eq!(line.runs.len(), 3);
    assert_eq!(line.runs[0].len, 3);
    assert!(line.runs[0].marks.is_empty());
    assert_eq!((line.runs[1].from, line.runs[1].len), (3, 4));
    let kinds: Vec<ViewMarkKind> = line.runs[1].marks.iter().map(|m| m.kind).collect();
    for k in [
        ViewMarkKind::Bold,
        ViewMarkKind::Link,
        ViewMarkKind::TextColor,
        ViewMarkKind::Highlight,
        ViewMarkKind::Comment,
    ] {
        assert!(kinds.contains(&k), "{k:?}");
    }
    assert!(line.runs[1]
        .marks
        .contains(&mark(ViewMarkKind::Link, Some("https://a.b"))));
    assert!(line.runs[1]
        .marks
        .contains(&mark(ViewMarkKind::TextColor, Some("red"))));
    assert!(line.runs[1]
        .marks
        .contains(&mark(ViewMarkKind::Highlight, Some("yellow"))));
    assert!(line.runs[1]
        .marks
        .contains(&mark(ViewMarkKind::Comment, Some("t1"))));
    assert_eq!((line.runs[2].from, line.runs[2].len), (7, end - 7));
    // Active marks: over the range, and at a caret inside the word.
    assert!(marked
        .active
        .marks
        .contains(&mark(ViewMarkKind::Bold, None)));
    s.set_view_selection(5, 5);
    assert!(s
        .view_render()
        .active
        .marks
        .contains(&mark(ViewMarkKind::Bold, None)));
    s.set_view_selection(1, 1);
    assert!(s.view_render().active.marks.is_empty());
    // A mark toggle with no text change moves text_revision; a caret move doesn't.
    let before = s.view_render();
    s.set_view_selection(0, 2);
    assert_eq!(s.view_render().text_revision, before.text_revision);
    s.command("toggleMark".into(), r#"{"mark":"italic"}"#.into())
        .unwrap();
    let after = s.view_render();
    assert_eq!(after.view.text, before.view.text);
    assert!(after.text_revision > before.text_revision);
    // A stored mark at a caret shows in `active` only.
    s.set_view_selection(1, 1);
    let rev = s.view_render().text_revision;
    s.command("toggleMark".into(), r#"{"mark":"underline"}"#.into())
        .unwrap();
    let stored = s.view_render();
    assert_eq!(stored.text_revision, rev);
    assert!(stored
        .active
        .marks
        .contains(&mark(ViewMarkKind::Underline, None)));
    // Atoms.
    let at = s.view_render().view.len;
    s.set_view_selection(at, at);
    s.command(
        "insertMention".into(),
        r#"{"id":"u2","label":"Sam"}"#.into(),
    )
    .unwrap();
    s.command("insertPageLink".into(), r#"{"pageId":"p9"}"#.into())
        .unwrap();
    let v = s.view_render().view;
    let line = &v.lines[0];
    assert_eq!(line.atoms.len(), 2);
    assert_eq!(line.atoms[0].kind, "mention");
    assert_eq!(line.atoms[0].label, "Sam");
    assert_eq!(line.atoms[0].offset + 1, line.atoms[1].offset);
    assert!(line.atoms[0].attrs_json.contains("\"u2\""));
    assert_eq!(line.atoms[1].kind, "pageLink");
    assert_eq!(line.atoms[1].label, "p9");
    assert!(line.atoms[1].attrs_json.contains("\"p9\""));
    assert_eq!(line.attrs_json, None);
    assert_eq!(line.runs.iter().map(|r| r.len).sum::<u32>(), line.len);
}

#[test]
fn view_active_blocks() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    s.command("setHeading".into(), r#"{"level":2}"#.into())
        .unwrap();
    let a = s.view_render().active;
    assert_eq!((a.block.as_str(), a.heading_level), ("heading", 2));
    s.command("setParagraph".into(), "{}".into()).unwrap();
    s.command("toggleBulletList".into(), "{}".into()).unwrap();
    let a = s.view_render().active;
    assert_eq!(a.block, "paragraph");
    assert_eq!(a.list.as_deref(), Some("bulletList"));
    assert!(!a.in_quote && !a.in_code);
}

/// Cursors on the wire (awareness `cursor`: Yjs relative positions, as y-prosemirror sends
/// them): other clients' carets come out per box in view offsets, and ours goes out in the
/// same form.
#[test]
fn cursors_cross_the_wire_in_awareness() {
    use nv_editor::remote::{relative_to_view_offset, view_offset_to_relative};
    let server = TestServer::start(&["acc"]);
    apply(server.room.doc(), &page("canvas-boxes"));
    // Someone else (the web, say) has a selection in box a: the server holds their state.
    let rel = |o: usize| view_offset_to_relative(server.room.doc(), "box:a", o).unwrap();
    let state = serde_json::json!({
        "user": { "id": "u2", "name": "Bo", "color": "#ff0000", "canEdit": true },
        "cursor": { "anchor": rel(1), "head": rel(3) }
    });
    server.room.set_presence(&state.to_string());
    let script = Script::default();
    script.0.lock().unwrap().push_back(serde_json::json!({
        "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
        "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true }
    }));
    let core = Core::with_transport(&server.base, Box::new(script), None);
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("sync", || *ev.synced.lock().unwrap() == 1);
    live.announce_presence(true);
    wait_for("their caret", || !live.remote_cursors().is_empty());
    let c = live.remote_cursors().remove(0);
    assert_eq!(
        (
            c.user_id.as_str(),
            c.name.as_str(),
            c.color.as_str(),
            c.box_id.as_str()
        ),
        ("u2", "Bo", "#ff0000", "a")
    );
    assert_eq!((c.anchor, c.head), (1, 3));
    // Our own caret isn't in the list; the others see ours.
    live.set_local_cursor("a".into(), 2, 4);
    wait_for("our caret on the server", || {
        server
            .room
            .presence()
            .iter()
            .any(|(_, s)| s.contains("Ann") && s.contains("\"cursor\":{"))
    });
    let (_, mine) = server
        .room
        .presence()
        .into_iter()
        .find(|(_, s)| s.contains("Ann"))
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&mine).unwrap();
    assert_eq!(v["user"]["name"], "Ann");
    assert_eq!(v["user"]["canEdit"], true);
    let at = |k: &str| {
        let st: nv_model::yrs::StickyIndex =
            serde_json::from_value(v["cursor"][k].clone()).unwrap();
        relative_to_view_offset(server.room.doc(), "box:a", &st)
    };
    assert_eq!((at("anchor"), at("head")), (Some(2), Some(4)));
    // Text typed before their caret on the server moves it.
    let (other, _) = open(full(server.room.doc()), "box:a");
    let sv = other.state_vector();
    other.set_selection(1, 1);
    other.insert_text("+++".into());
    apply(server.room.doc(), &other.encode_update_since(sv).unwrap());
    wait_for("the caret to follow the text", || {
        live.remote_cursors().first().is_some_and(|c| c.anchor == 4)
    });
    assert_eq!(live.remote_cursors()[0].head, 6);
    // Taking ours back.
    live.clear_local_cursor();
    wait_for("our caret taken back", || {
        server
            .room
            .presence()
            .iter()
            .any(|(_, s)| s.contains("Ann") && s.contains("\"cursor\":null"))
    });
    live.close();
}

#[test]
fn table_commands_through_the_session() {
    let (s, _) = open(page("canvas-boxes"), "box:a");
    assert_eq!(s.table_state(), None);
    assert!(s
        .command(
            "insertTable".into(),
            r#"{"rows":2,"cols":2,"header":true}"#.into()
        )
        .unwrap());
    let t = s.table_state().unwrap();
    assert_eq!(
        t,
        TableState {
            header_row: true,
            can_merge: false,
            can_split: false
        }
    );
    assert!(s.command("addColumnAfter".into(), "".into()).unwrap());
    assert!(s.command("addRowBefore".into(), "".into()).unwrap());
    assert!(s
        .command(
            "mergeCells".into(),
            r#"{"top":0,"left":0,"bottom":1,"right":1}"#.into()
        )
        .unwrap());
    assert!(
        s.state().doc_json.contains("\"colspan\":2"),
        "{}",
        s.state().doc_json
    );
    assert!(s.table_state().unwrap().can_split);
    assert!(s.command("splitCell".into(), "".into()).unwrap());
    assert!(!s.table_state().unwrap().can_split);
    assert!(!s.command("splitCell".into(), "".into()).unwrap());
    assert!(s.command("toggleHeaderRow".into(), "".into()).unwrap());
    assert!(s.command("deleteTable".into(), "".into()).unwrap());
    assert_eq!(s.table_state(), None);
}
