//! Version history through the Core: list, fetch a version's document, and restore into an open
//! live page, against the stand-in collab server with HTTP scripted. The restore is an ordinary
//! edit of the live document: it queues behind unsent edits, survives a dropped connection and a
//! restart, reaches the server, and nothing older comes back.

#![allow(clippy::type_complexity)]

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nv_api::{Request, Response, Transport};
use nv_core::*;
use nv_model::yrs::updates::decoder::Decode;
use nv_model::yrs::{ReadTxn, StateVector, Transact, Update, WriteTxn, XmlFragment, XmlTextPrelim};
use serde_json::{json, Value};
use support::{read_text, type_text, wait_for, TestServer};

#[derive(Clone, Default)]
struct Script {
    replies: Arc<Mutex<VecDeque<Result<(u16, Value), String>>>>,
    seen: Arc<Mutex<Vec<(String, String, Option<String>)>>>,
}
impl Script {
    fn reply(&self, status: u16, body: Value) -> &Self {
        self.replies.lock().unwrap().push_back(Ok((status, body)));
        self
    }
    fn fail(&self) -> &Self {
        self.replies
            .lock()
            .unwrap()
            .push_back(Err("connection refused".into()));
        self
    }
    fn take(&self) -> Vec<(String, Value)> {
        self.seen
            .lock()
            .unwrap()
            .drain(..)
            .map(|(m, u, b)| {
                (
                    format!("{m} {}", u.split("/api").nth(1).unwrap_or(&u)),
                    serde_json::from_str(&b.unwrap_or_else(|| "null".into())).unwrap(),
                )
            })
            .collect()
    }
}
impl Transport for Script {
    fn send(&self, req: &Request) -> Result<Response, String> {
        self.seen
            .lock()
            .unwrap()
            .push((req.method.into(), req.url.clone(), req.body.clone()));
        let (status, body) = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| format!("unscripted: {} {}", req.method, req.url))??;
        Ok(Response {
            status,
            body: body.to_string(),
            request_id: None,
        })
    }
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> TempDir {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        TempDir(std::env::temp_dir().join(format!("nv-ver-{}-{nanos}", std::process::id())))
    }
    fn db(&self) -> String {
        self.0.join("store.db").to_string_lossy().into_owned()
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Standard base64 (tests only; avoids a dependency).
fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn session() -> Value {
    json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref-acc",
            "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } })
}

fn tree() -> Value {
    json!({ "notebooks": [], "sections": [], "pages": [
        { "id": "page-1", "sectionId": "s1", "title": "Page", "icon": null, "kind": "canvas",
          "position": 1.0, "updatedAt": "2026-11-01", "updatedBy": null, "locked": false } ] })
}

#[derive(Default)]
struct Events(Mutex<Vec<LiveStatus>>);
impl LivePageListener for Events {
    fn on_status(&self, s: LiveStatus) {
        self.0.lock().unwrap().push(s);
    }
    fn on_change(&self, _: PageInfo) {}
}
impl Events {
    fn syncs(&self) -> usize {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|s| **s == LiveStatus::Synced)
            .count()
    }
    fn reconnecting(&self) -> bool {
        self.0
            .lock()
            .unwrap()
            .iter()
            .any(|s| matches!(s, LiveStatus::Reconnecting { .. }))
    }
}

fn start(server: &TestServer, dir: &TempDir, s: &Script, signed_in: bool) -> Arc<Core> {
    let core = Core::with_transport(&server.base, Box::new(s.clone()), Some(dir.db()));
    core.set_reconnect_delays(Duration::from_millis(20), Duration::from_millis(100));
    s.reply(200, session());
    if signed_in {
        core.restore_session("ref-acc".into()).unwrap();
    } else {
        core.sign_in("a@b.c".into(), "pw".into()).unwrap();
        s.reply(200, tree());
        core.tree("w1".into()).unwrap();
    }
    s.take();
    core
}

/// The version: one box `main` holding `text`.
fn version_doc(text: &str) -> Vec<u8> {
    let doc = nv_model::new_doc();
    nv_model::boxes::create_box(&doc, "main", 0.0, 0.0, 400.0, 1.0).unwrap();
    {
        let mut txn = doc.transact_mut();
        let f = txn.get_or_insert_xml_fragment("box:main");
        f.push_back(&mut txn, XmlTextPrelim::new(text));
    }
    let b = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    b
}

fn version_reply(id: &str, doc: &[u8]) -> Value {
    json!({ "id": id, "title": "Page", "authorId": "u1", "reason": "auto", "at": "2026-11-21T10:00:00.000Z",
            "createdAt": "2026-11-21T10:05:00.000Z", "ydoc": b64(doc) })
}

fn text_of(live: &LivePage) -> String {
    read_text(
        &nv_model::doc_from_update(&live.document()).unwrap(),
        "box:main",
    )
}

fn edit(live: &LivePage, text: &str) {
    let doc = nv_model::doc_from_update(&live.document()).unwrap();
    let before = doc.transact().state_vector();
    type_text(&doc, "box:main", text);
    live.apply_update(doc.transact().encode_state_as_update_v1(&before))
        .unwrap();
}

#[test]
fn listing_and_previewing_versions() {
    let server = TestServer::start(&["acc"]);
    let (s, dir) = (Script::default(), TempDir::new());
    let core = start(&server, &dir, &s, false);
    s.reply(
        200,
        json!([{ "id": "v2", "title": "T2", "authorId": "u1", "reason": "restore", "at": "a2", "createdAt": "c2" },
               { "id": "v1", "title": "T1", "authorId": null, "reason": "auto", "at": "a1", "createdAt": "c1" }]),
    );
    let list = core.page_versions("page-1".into()).unwrap();
    assert_eq!(s.take()[0].0, "GET /pages/page-1/versions");
    assert_eq!(
        (
            list.len(),
            list[0].reason.as_str(),
            list[1].author_id.clone()
        ),
        (2, "restore", None)
    );
    let doc = version_doc("Preview me");
    s.reply(200, version_reply("v1", &doc));
    let v = core.page_version("page-1".into(), "v1".into()).unwrap();
    assert_eq!(v.version.created_at, "2026-11-21T10:05:00.000Z");
    // The document reads with the usual page readers.
    let content = page_content(v.document.clone()).unwrap();
    assert!(format!("{content:?}").contains("Preview me"));
    assert_eq!(read_page(v.document).unwrap().boxes[0].id, "main");
    // A preview is not stored.
    assert_eq!(core.cached_page_document("page-1".into()), None);
}

#[test]
fn a_restore_with_an_unsent_edit_queued_reaches_the_server_and_nothing_older_comes_back() {
    let server = TestServer::start(&["acc"]);
    let (s, dir) = (Script::default(), TempDir::new());
    let core = start(&server, &dir, &s, false);
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("sync", || ev.syncs() == 1);
    // The page has a box (as every page has), holding what the server's copy has.
    live.create_box_with_id("main".into(), 0.0, 0.0, 400.0, 1.0)
        .unwrap();
    wait_for("the box on the server", || {
        server.text("box:main") == "Hello"
    });
    wait_for("receipt", || live.unsent_updates() == 0);

    // The connection drops; an edit is made offline and waits in the outbox.
    server.set_offline(true);
    server.kick(None);
    wait_for("offline", || ev.reconnecting());
    edit(&live, "QUEUED-OLD");
    wait_for("the edit to be kept", || {
        live.unsent_updates() == 1 && core.unsent_pages() == ["page-1"]
    });
    let stale = live.document(); // a copy of the page from before the restore
    assert!(text_of(&live).contains("QUEUED-OLD"));

    // Restore (the HTTP side works while the collab socket is down).
    s.reply(200, version_reply("v1", &version_doc("Version text")));
    s.reply(200, json!({ "id": "before-1" }));
    let before = core.restore_version(live.clone(), "v1".into()).unwrap();
    assert_eq!(before.as_deref(), Some("before-1"));
    let calls = s.take();
    assert_eq!(
        calls,
        [
            ("GET /pages/page-1/versions/v1".to_string(), Value::Null),
            (
                "POST /pages/page-1/versions".to_string(),
                json!({ "reason": "restore" })
            )
        ],
        "fetch the version, then the 'before restore' snapshot"
    );
    assert_eq!(
        text_of(&live),
        "Version text",
        "the open page shows it at once"
    );
    assert_eq!(
        live.unsent_updates(),
        2,
        "the queued edit, then the restore, in that order"
    );

    // Back online: both go out in order; the server ends with the restored content only.
    server.set_offline(false);
    wait_for("the server to have the restore", || {
        server.text("box:main") == "Version text"
    });
    wait_for("receipts", || {
        live.unsent_updates() == 0 && core.unsent_pages().is_empty()
    });
    let room = server.text("box:main");
    assert!(
        !room.contains("Hello") && !room.contains("QUEUED-OLD"),
        "{room}"
    );

    // An old copy of the page (the one taken before the restore) reaches the server later, as a
    // device that was offline all along would send it: nothing it holds comes back.
    server
        .room
        .doc()
        .transact_mut()
        .apply_update(Update::decode_v1(&stale).unwrap())
        .unwrap();
    assert_eq!(server.text("box:main"), "Version text");

    // The app restarts: the restored page opens as it is, with nothing left to send.
    live.close();
    let s2 = Script::default();
    let core2 = start(&server, &dir, &s2, true);
    assert!(core2.unsent_pages().is_empty());
    let ev2 = Arc::new(Events::default());
    let live2 = core2.open_live_page("page-1".into(), ev2.clone()).unwrap();
    wait_for("sync", || ev2.syncs() == 1);
    assert_eq!(text_of(&live2), "Version text");
    live2.close();
}

#[test]
fn two_open_copies_converge_on_a_restore() {
    let server = TestServer::start(&["acc"]);
    let (s, dir) = (Script::default(), TempDir::new());
    let core = start(&server, &dir, &s, false);
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("sync", || ev.syncs() == 1);
    live.create_box_with_id("main".into(), 0.0, 0.0, 400.0, 1.0)
        .unwrap();
    wait_for("box", || server.text("box:main") == "Hello");

    // A second device on the same page (another core, its own store).
    let (s2, dir2) = (Script::default(), TempDir::new());
    let other = start(&server, &dir2, &s2, false);
    let ev2 = Arc::new(Events::default());
    let live2 = other.open_live_page("page-1".into(), ev2.clone()).unwrap();
    wait_for("second sync", || ev2.syncs() == 1);
    wait_for("it has the page", || text_of(&live2) == "Hello");

    s.reply(200, version_reply("v1", &version_doc("Restored")));
    s.reply(200, json!({ "id": "b" }));
    core.restore_version(live.clone(), "v1".into()).unwrap();
    wait_for("the other copy to converge", || {
        text_of(&live2) == "Restored"
    });
    wait_for("the server", || server.text("box:main") == "Restored");
    // The other copy typing on afterwards edits the restored page, not the old one.
    edit(&live2, " + more");
    wait_for("the first copy", || text_of(&live) == "Restored + more");
    live.close();
    live2.close();
}

#[test]
fn a_refused_or_failed_restore_changes_nothing() {
    let server = TestServer::start(&["acc"]);
    let (s, dir) = (Script::default(), TempDir::new());
    let core = start(&server, &dir, &s, false);
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("sync", || ev.syncs() == 1);
    live.create_box_with_id("main".into(), 0.0, 0.0, 400.0, 1.0)
        .unwrap();
    wait_for("receipt", || live.unsent_updates() == 0);

    // A viewer: the version is readable, the snapshot is refused (403), the page is untouched.
    s.reply(200, version_reply("v1", &version_doc("Nope")));
    s.reply(
        403,
        json!({ "error": "You don't have edit access to this page" }),
    );
    match core.restore_version(live.clone(), "v1".into()) {
        Err(CoreError::Server { status: 403, .. }) => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(text_of(&live), "Hello");

    // No connection to the server: Network, and the page is untouched.
    s.fail();
    assert!(matches!(
        core.restore_version(live.clone(), "v1".into()),
        Err(CoreError::Network { .. })
    ));
    assert_eq!(text_of(&live), "Hello");

    // A closed page.
    live.close();
    assert!(matches!(
        core.restore_version(live.clone(), "v1".into()),
        Err(CoreError::Network { .. })
    ));
}
