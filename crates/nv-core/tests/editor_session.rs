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
