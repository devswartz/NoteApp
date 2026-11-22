//! Box calls on a live page (src/boxes.rs), against the stand-in collab server
//! (crates/nv-sync/tests/support): create, open the new box in an editor session and type,
//! move, resize, bring to front and delete, each reaching the server; and the page read back
//! through `nv_model::Page::read` as a web box would be.

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_core::*;
use nv_model::yrs::{ReadTxn, StateVector, Transact};
use support::{wait_for, TestServer};

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
        true
    }
    fn title(&self, _: String) -> Option<String> {
        None
    }
    fn set_title(&self, _: String, _: String) {}
}

fn full(doc: &nv_model::yrs::Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
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

fn geometry(update: Vec<u8>, id: &str) -> Option<nv_model::BoxGeom> {
    nv_model::Page::from_update(&update)
        .unwrap()
        .boxes
        .into_iter()
        .find(|b| b.id == id)
}

#[test]
fn a_created_box_opens_for_typing_and_everything_reaches_the_server() {
    let server = TestServer::start(&["acc"]);
    let (_core, live) = open_page(&server);

    let id = live.create_box(40.0, 60.0, 360.0, 1.0).unwrap();
    assert_eq!(id.len(), 16);
    assert!(id
        .chars()
        .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()));
    // In the live page at once, with the geometry given, and an empty fragment.
    let g = geometry(live.document(), &id).unwrap();
    assert_eq!(
        (g.x, g.y, g.w, g.z, g.wide),
        (40.0, 60.0, 360.0, 1.0, false)
    );
    assert_eq!(live.info().boxes.len(), 1);
    // It reaches the server (one update: the entry and the fragment).
    wait_for("the box on the server", || {
        geometry(full(server.room.doc()), &id).is_some()
    });

    // The editor opens it at once and typing in it goes out.
    let field = format!("box:{id}");
    let s = EditorSession::open_live(live.clone(), field.clone(), Arc::new(NoTasks)).unwrap();
    for c in "Hello".chars() {
        s.insert_text(c.to_string());
    }
    assert_eq!(s.text_for_view(), "Hello");
    wait_for("the typing on the server", || {
        server.text(&field).contains("Hello")
    });
    wait_for("the receipt", || live.unsent_updates() == 0);

    // The other calls, each seen on the server.
    live.move_box(id.clone(), 100.4, 250.0).unwrap();
    live.resize_box(id.clone(), 500.0).unwrap();
    let id2 = live.create_box(0.0, 0.0, 300.0, 2.0).unwrap();
    assert_eq!(live.bring_to_front(id.clone()).unwrap(), 3.0);
    wait_for("the edits on the server", || {
        let g = geometry(full(server.room.doc()), &id);
        g.is_some_and(|g| (g.x, g.y, g.w, g.z) == (100.0, 250.0, 500.0, 3.0))
    });
    assert_eq!(live.bring_to_front(id.clone()).unwrap(), 3.0);

    // A box with text isn't deleted by `delete_box`; an empty one is.
    assert_eq!(
        live.delete_box(id.clone()),
        Err(BoxError::NotEmpty { id: id.clone() })
    );
    live.delete_box(id2.clone()).unwrap();
    wait_for("the delete on the server", || {
        geometry(full(server.room.doc()), &id2).is_none()
            && geometry(full(server.room.doc()), &id).is_some()
    });
    live.delete_box_with_content(id.clone()).unwrap();
    wait_for("the second delete on the server", || {
        nv_model::Page::from_update(&full(server.room.doc()))
            .unwrap()
            .boxes
            .is_empty()
    });
    wait_for("the receipt", || live.unsent_updates() == 0);

    // Unknown ids, bad numbers and a closed page.
    let nope = "nope".to_string();
    assert_eq!(
        live.move_box(nope.clone(), 1.0, 1.0),
        Err(BoxError::NoSuchBox { id: nope.clone() })
    );
    assert_eq!(
        live.resize_box(nope.clone(), 200.0),
        Err(BoxError::NoSuchBox { id: nope.clone() })
    );
    assert_eq!(
        live.bring_to_front(nope.clone()),
        Err(BoxError::NoSuchBox { id: nope.clone() })
    );
    assert_eq!(
        live.delete_box(nope.clone()),
        Err(BoxError::NoSuchBox { id: nope })
    );
    assert!(matches!(
        live.create_box(f64::NAN, 0.0, 300.0, 1.0),
        Err(BoxError::Invalid { .. })
    ));
    live.close();
    assert_eq!(live.create_box(0.0, 0.0, 300.0, 1.0), Err(BoxError::Closed));
}

#[test]
fn another_page_reader_sees_a_created_box_like_the_webs() {
    // What `Page::read` gives for a box made here: canvas layout, the box in reading order,
    // an empty fragment, no `wide`.
    let server = TestServer::start(&["acc"]);
    let (_core, live) = open_page(&server);
    let a = live.create_box(0.0, 100.0, 360.0, 1.0).unwrap();
    let b = live.create_box(0.0, 20.0, 360.0, 2.0).unwrap();
    let page = nv_model::Page::from_update(&live.document()).unwrap();
    assert_eq!(page.kind(), nv_model::DocKind::Canvas);
    let order: Vec<_> = page.reading_order().into_iter().map(|g| g.id).collect();
    assert_eq!(order, [b.clone(), a.clone()]);
    assert!(page.fragments.iter().all(|f| f.nodes.is_empty()));
    // The bytes route works too: `open` on the document adds the trailing paragraph.
    let s = EditorSession::open(live.document(), format!("box:{a}"), Arc::new(NoTasks)).unwrap();
    s.insert_text("x".into());
    assert_eq!(s.text_for_view(), "x");
    live.close();
}
