//! Page-level undo (`LivePage::undo` ...): one undo across box geometry, ink and the text of any
//! box, by recency. Stand-in collab server as in tests/ink_undo.rs.

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_core::*;
use nv_editor::bind::Clock;
use support::{read_text, wait_for, TestServer};

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
}
impl LivePageListener for Events {
    fn on_status(&self, s: LiveStatus) {
        if s == LiveStatus::Synced {
            *self.synced.lock().unwrap() += 1;
        }
    }
    fn on_change(&self, _: PageInfo) {}
}

struct NoTasks;
impl TaskCallbacks for NoTasks {
    fn new_id(&self) -> String {
        "t".into()
    }
    fn create(&self, _: String, _: String, _: bool) {}
    fn delete(&self, _: String) {}
    fn restore(&self, _: String) -> bool {
        false
    }
    fn title(&self, _: String) -> Option<String> {
        None
    }
    fn set_title(&self, _: String, _: String) {}
}

fn open_page(server: &TestServer) -> (Arc<Core>, Arc<LivePage>) {
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
    (core, live)
}

fn text(live: &LivePage, id: &str) -> String {
    let doc = nv_model::doc_from_update(&live.document()).unwrap();
    read_text(&doc, &format!("box:{id}"))
}

fn geom(live: &LivePage, id: &str) -> (f64, f64, f64, f64) {
    let b = live.info().boxes.into_iter().find(|b| b.id == id).unwrap();
    (b.x, b.y, b.w, b.z)
}

fn has_box(live: &LivePage, id: &str) -> bool {
    live.info().boxes.iter().any(|b| b.id == id)
}

fn draw(live: &LivePage, y: f64) {
    let samples: Vec<f64> = (0..=40)
        .flat_map(|i| {
            [
                10.0 + 100.0 * i as f64 / 40.0,
                y,
                0.5,
                std::f64::consts::FRAC_PI_2,
                0.0,
                5000.0 + i as f64 * 4.0,
            ]
        })
        .collect();
    live.add_ink_stroke_from_samples(0, 0x1f2328ff, 2.5, false, false, samples)
        .unwrap()
        .unwrap();
}

/// A page with boxes a, b and c, and sessions on a and c.
struct Fixture {
    _server: TestServer,
    _core: Arc<Core>,
    live: Arc<LivePage>,
    clock: Clock,
    sa: Arc<EditorSession>,
    sc: Arc<EditorSession>,
}

fn fixture() -> Fixture {
    let server = TestServer::start(&["acc"]);
    let (core, live) = open_page(&server);
    for (id, x) in [("a", 0.0), ("b", 300.0), ("c", 600.0)] {
        live.create_box_with_id(id.into(), x, 0.0, 200.0, 1.0)
            .unwrap();
    }
    let clock = Clock::manual();
    let open = |id: &str| {
        EditorSession::open_live_with_clock(
            &live,
            format!("box:{id}"),
            Arc::new(NoTasks),
            clock.clone(),
        )
        .unwrap()
    };
    let (sa, sc) = (open("a"), open("c"));
    Fixture {
        _server: server,
        _core: core,
        live,
        clock,
        sa,
        sc,
    }
}

#[test]
fn interleaved_changes_undo_by_recency_across_kinds_and_redo_forward() {
    let f = fixture();
    let live = &f.live;
    f.sa.insert_text("alpha".into());
    f.clock.advance(1000);
    draw(live, 50.0);
    live.move_box("b".into(), 350.0, 40.0).unwrap();
    f.sc.insert_text("gamma".into());
    assert!(text(live, "a").contains("alpha") && text(live, "c").contains("gamma"));
    assert!(live.can_undo() && !live.can_redo());

    // Newest first: the text of c, the move of b, the stroke, the text of a.
    assert!(live.undo().unwrap());
    assert!(!text(live, "c").contains("gamma"));
    assert_eq!(geom(live, "b").0, 350.0);
    assert!(live.undo().unwrap());
    assert_eq!(geom(live, "b").0, 300.0);
    assert_eq!(live.ink_strokes().len(), 1);
    assert!(live.undo().unwrap());
    assert!(live.ink_strokes().is_empty());
    assert!(text(live, "a").contains("alpha"));
    assert!(live.undo().unwrap());
    assert!(!text(live, "a").contains("alpha"));
    assert!(live.can_redo());

    // Redo comes forward in the same order.
    assert!(live.redo().unwrap());
    assert!(text(live, "a").contains("alpha"));
    assert!(live.ink_strokes().is_empty());
    assert!(live.redo().unwrap());
    assert_eq!(live.ink_strokes().len(), 1);
    assert!(live.redo().unwrap());
    assert_eq!(geom(live, "b").0, 350.0);
    assert!(live.redo().unwrap());
    assert!(text(live, "c").contains("gamma"));
    assert!(!live.redo().unwrap() && !live.can_redo());

    // The creations of the boxes are steps too, below all of it.
    for _ in 0..4 {
        assert!(live.undo().unwrap());
    }
    for _ in 0..3 {
        assert!(live.undo().unwrap());
    }
    assert!(live.info().boxes.is_empty());
    assert!(!live.undo().unwrap() && !live.can_undo());
}

#[test]
fn a_new_change_anywhere_clears_every_redo() {
    let f = fixture();
    let live = &f.live;
    f.sa.insert_text("alpha".into());
    f.clock.advance(1000);
    live.move_box("b".into(), 350.0, 40.0).unwrap();
    draw(live, 50.0);
    for _ in 0..3 {
        assert!(live.undo().unwrap());
    }
    assert!(live.can_redo());
    // A text change drops the redo of the text, the move and the stroke.
    f.sc.insert_text("gamma".into());
    assert!(!live.can_redo());
    assert!(!live.redo().unwrap());
    assert!(live.undo().unwrap());
    assert!(live.can_redo());
    // A box change drops it too.
    live.move_box("a".into(), 5.0, 5.0).unwrap();
    assert!(!live.can_redo());
    assert!(live.undo().unwrap());
    assert!(live.can_redo());
    // And so does ink.
    draw(live, 90.0);
    assert!(!live.can_redo());
}

#[test]
fn create_box_undo_removes_it() {
    let f = fixture();
    let live = &f.live;
    let id = live.create_box(10.0, 10.0, 200.0, 2.0).unwrap();
    assert!(has_box(live, &id));
    assert!(live.undo().unwrap());
    assert!(!has_box(live, &id));
    assert!(live.redo().unwrap());
    assert!(has_box(live, &id));
}

#[test]
fn resize_and_bring_to_front_undo() {
    let f = fixture();
    let live = &f.live;
    live.resize_box("a".into(), 400.0).unwrap();
    live.bring_to_front("a".into()).unwrap();
    let (_, _, w, z) = geom(live, "a");
    assert_eq!((w, z), (400.0, 2.0));
    live.undo().unwrap();
    assert_eq!(geom(live, "a").3, 1.0);
    live.undo().unwrap();
    assert_eq!(geom(live, "a").2, 200.0);
}

#[test]
fn delete_box_with_text_undo_brings_box_and_text_back() {
    let f = fixture();
    let live = &f.live;
    f.sa.insert_text("keep me".into());
    f.clock.advance(1000);
    live.delete_box_with_content("a".into()).unwrap();
    assert!(!has_box(live, "a"));
    assert!(!text(live, "a").contains("keep me"));
    assert!(live.undo().unwrap());
    assert!(has_box(live, "a"));
    assert!(text(live, "a").contains("keep me"), "{}", text(live, "a"));
    assert!(live.redo().unwrap());
    assert!(!has_box(live, "a"));
}

#[test]
fn remote_changes_are_never_undone() {
    let server = TestServer::start(&["acc", "acc"]);
    let (_c1, a) = open_page(&server);
    let (_c2, b) = open_page(&server);
    b.create_box_with_id("theirs".into(), 0.0, 0.0, 200.0, 1.0)
        .unwrap();
    draw(&b, 50.0);
    wait_for("a to see them", || {
        has_box(&a, "theirs") && a.ink_strokes().len() == 1
    });
    assert!(!a.can_undo());
    assert!(!a.undo().unwrap());
    a.create_box_with_id("mine".into(), 0.0, 0.0, 200.0, 1.0)
        .unwrap();
    assert!(a.undo().unwrap());
    assert!(!a.undo().unwrap());
    assert!(has_box(&a, "theirs") && !has_box(&a, "mine"));
    assert_eq!(a.ink_strokes().len(), 1);
}

#[test]
fn ink_undo_still_works_and_a_closed_session_leaves_the_page_stack() {
    let f = fixture();
    let live = &f.live;
    draw(live, 50.0);
    assert!(live.ink_can_undo());
    assert!(live.ink_undo().unwrap());
    assert!(live.ink_strokes().is_empty());
    assert!(live.ink_redo().unwrap());
    assert_eq!(live.ink_strokes().len(), 1);

    // Text steps go with their session; the geometry and ink steps stay.
    f.sa.insert_text("alpha".into());
    f.clock.advance(1000);
    draw(live, 90.0);
    drop(f.sa);
    assert!(live.undo().unwrap());
    assert_eq!(live.ink_strokes().len(), 1);
    assert!(live.undo().unwrap());
    assert!(live.ink_strokes().is_empty());
    assert!(
        text(live, "a").contains("alpha"),
        "text step left the stack"
    );
}
