//! Locked pages through the Core: what an unlock does and, above all, what it never puts on the
//! disk. The marker texts below stand for a locked page's content; after every scenario the
//! SQLite file (and its write-ahead log) is searched for them byte by byte.
//!
//! HTTP is scripted; the live page scenarios use the stand-in collab server.

#![allow(clippy::type_complexity)]

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nv_api::{Request, Response, Transport};
use nv_core::*;
use nv_model::yrs::{ReadTxn, Transact, WriteTxn, XmlFragment, XmlTextPrelim};
use serde_json::{json, Value};
use support::{wait_for, TestServer};

const TITLE: &str = "SECRETTITLE-4f3a";
const DESC: &str = "SECRETDESC-9b21";
const BODY: &str = "SECRETBODY-77c0";
const TYPED: &str = "SECRETTYPED-d5e8";
const PLAIN: &str = "plain-task-title";

#[derive(Clone, Default)]
struct Script {
    replies: Arc<Mutex<VecDeque<(u16, Value)>>>,
    seen: Arc<Mutex<Vec<(String, String, Option<String>)>>>,
}
impl Script {
    fn reply(&self, status: u16, body: Value) -> &Self {
        self.replies.lock().unwrap().push_back((status, body));
        self
    }
    fn take(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .drain(..)
            .map(|(m, u, _)| format!("{m} {}", u.split("/api").nth(1).unwrap_or(&u)))
            .collect()
    }
    fn last_body(&self) -> Value {
        let b = self.seen.lock().unwrap().last().unwrap().2.clone();
        serde_json::from_str(&b.unwrap_or_else(|| "null".into())).unwrap()
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
            .ok_or_else(|| format!("unscripted: {} {}", req.method, req.url))?;
        Ok(Response {
            status,
            body: body.to_string(),
            request_id: None,
        })
    }
}

struct TempDir(PathBuf);
impl TempDir {
    fn new(name: &str) -> TempDir {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        TempDir(std::env::temp_dir().join(format!("nv-lock-{name}-{}-{nanos}", std::process::id())))
    }
    fn db(&self) -> String {
        self.0.join("store.db").to_string_lossy().into_owned()
    }
    /// Every byte the store has on disk: the database, its write-ahead log and shared memory.
    fn disk(&self) -> Vec<u8> {
        let mut all = Vec::new();
        for suffix in ["", "-wal", "-shm", "-journal"] {
            if let Ok(b) = std::fs::read(format!("{}{suffix}", self.db())) {
                all.extend(b);
            }
        }
        assert!(all.len() > 1000, "the store file was not found");
        all
    }
    fn has(&self, needle: &str) -> bool {
        let hay = self.disk();
        let n = needle.as_bytes();
        hay.windows(n.len()).any(|w| w == n)
    }
    /// The needle, also as UTF-16 (a string in a Yjs or JSON column would be UTF-8, but be sure).
    fn has_any_encoding(&self, needle: &str) -> bool {
        let hay = self.disk();
        let utf16: Vec<u8> = needle
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        self.has(needle) || hay.windows(utf16.len()).any(|w| w == utf16.as_slice())
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn session() -> Value {
    json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
            "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } })
}

fn page(id: &str, locked: bool) -> Value {
    json!({ "id": id, "sectionId": "s1", "title": format!("Title {id}"), "icon": null, "kind": "canvas",
            "position": 1.0, "updatedAt": "2026-11-01", "updatedBy": null, "locked": locked })
}

fn tree(pages: Vec<Value>) -> Value {
    json!({ "notebooks": [{ "id": "n1", "workspaceId": "w1", "name": "NB", "color": "#336699",
                            "visibility": "private", "createdBy": "u1", "position": 1.0 }],
            "sections": [{ "id": "s1", "notebookId": "n1", "parentId": null, "name": "S", "color": "#996633", "position": 1.0 }],
            "pages": pages, "trashedPages": [] })
}

fn task(id: &str, page: &str, title: &str, desc: &str) -> Value {
    json!({ "id": id, "workspaceId": "w1", "title": title, "description": desc, "status": "open", "priority": 2,
            "dueDate": "2026-12-01", "pageId": page, "tagIds": ["t1"], "createdBy": "u1",
            "createdAt": "2026-11-01", "updatedAt": "2026-11-01", "locked": false })
}

fn core(s: &Script, base: &str, dir: &TempDir) -> Arc<Core> {
    s.reply(200, session());
    let core = Core::with_transport(base, Box::new(s.clone()), Some(dir.db()));
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    core
}

const BASE: &str = "http://localhost:4417";

fn unlock(core: &Core, s: &Script) {
    s.reply(200, json!({ "expiresAt": "2026-11-22T10:05:00.000Z" }));
    assert_eq!(
        core.unlock_locked_notes("hunter2-pass".into()).unwrap(),
        "2026-11-22T10:05:00.000Z"
    );
    assert_eq!(s.last_body(), json!({ "password": "hunter2-pass" }));
    assert_eq!(s.take(), ["POST /locked-notes/unlock"]);
}

#[test]
fn task_titles_of_locked_pages_arrive_in_full_after_an_unlock_but_are_never_stored() {
    let (s, dir) = (Script::default(), TempDir::new("tasks"));
    let core = core(&s, BASE, &dir);
    // The stored tree is stale: it still shows p1 as an ordinary page (it was locked from
    // another device). Unlocked, the core fetches the tree again before storing tasks.
    s.reply(200, tree(vec![page("p1", false), page("p2", false)]));
    core.tree("w1".into()).unwrap();
    s.take();
    unlock(&core, &s);

    s.reply(200, tree(vec![page("p1", true), page("p2", false)])); // the refresh
    s.reply(
        200,
        json!([
            task("k1", "p1", TITLE, DESC),
            task("k2", "p2", PLAIN, "ordinary"),
            task("k3", "p1", &format!("{TITLE} again"), "")
        ]),
    );
    let tasks = core.tasks("w1".into()).unwrap();
    assert_eq!(
        s.take(),
        ["GET /workspaces/w1/tree", "GET /workspaces/w1/tasks"],
        "the tree is fetched again first while unlocked"
    );
    // The caller gets them in full (that is what unlocking is for)...
    let by = |id: &str| tasks.iter().find(|t| t.id == id).unwrap().clone();
    assert_eq!((by("k1").title.as_str(), by("k1").locked), (TITLE, false));
    assert_eq!(by("k1").description, DESC);
    assert_eq!(by("k2").title, PLAIN);
    // ...the stored copy has them withheld, as the server withholds them from a locked sign-in.
    let stored = core.cached_tasks("w1".into()).unwrap();
    let st = |id: &str| stored.iter().find(|t| t.id == id).unwrap().clone();
    assert_eq!(
        (
            st("k1").title.as_str(),
            st("k1").description.as_str(),
            st("k1").locked
        ),
        ("Locked task", "", true)
    );
    assert_eq!(st("k1").tag_ids, Vec::<String>::new());
    assert_eq!(
        st("k1").due_date.as_deref(),
        Some("2026-12-01"),
        "dates stay, as on the server"
    );
    assert_eq!(st("k3").title, "Locked task");
    assert_eq!((st("k2").title.as_str(), st("k2").locked), (PLAIN, false));

    // A task write on the locked page answers in full; what is stored is withheld again.
    let mut done = task("k1", "p1", TITLE, DESC);
    done["status"] = json!("done");
    s.reply(200, done);
    let t = core.set_task_done("k1".into(), true).unwrap();
    assert_eq!(t.title, TITLE);
    assert_eq!(
        core.cached_tasks("w1".into()).unwrap()[0].title,
        "Locked task"
    );
    s.take();

    // A new task on the locked page cannot be queued offline (its title would be stored).
    s.reply(500, json!({ "error": "down" }));
    let _ = core.create_task("w1".into(), "SECRETTITLE-new".into(), Some("p1".into()));

    assert!(!dir.has_any_encoding(TITLE), "task title on disk");
    assert!(!dir.has_any_encoding(DESC), "task description on disk");
    assert!(
        !dir.has_any_encoding("SECRETTITLE-new"),
        "queued task on disk"
    );
    assert!(
        dir.has(PLAIN),
        "the search itself works: an ordinary task is on disk"
    );
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

fn doc_with(text: &str) -> Vec<u8> {
    let doc = nv_model::new_doc();
    nv_model::boxes::create_box(&doc, "main", 0.0, 0.0, 400.0, 1.0).unwrap();
    {
        let mut txn = doc.transact_mut();
        let f = txn.get_or_insert_xml_fragment("box:main");
        f.push_back(&mut txn, XmlTextPrelim::new(text));
    }
    let b = doc
        .transact()
        .encode_state_as_update_v1(&nv_model::yrs::StateVector::default());
    b
}

#[test]
fn locking_a_page_takes_its_document_and_task_titles_off_the_device() {
    let (s, dir) = (Script::default(), TempDir::new("lock"));
    let core = core(&s, BASE, &dir);
    s.reply(200, tree(vec![page("p1", false)]));
    core.tree("w1".into()).unwrap();
    s.reply(200, json!([task("k1", "p1", TITLE, DESC)]));
    core.tasks("w1".into()).unwrap();
    s.reply(200, json!({ "ydoc": b64(&doc_with(BODY)) }));
    core.page_document("p1".into()).unwrap();
    s.take();
    assert!(core.cached_page_document("p1".into()).is_some());
    assert!(
        dir.has(BODY) && dir.has(TITLE),
        "stored while the page is ordinary"
    );

    // The server accepts the lock; the tree fetch right after fails (the connection drops).
    s.reply(200, json!({ "ok": true }));
    s.reply(500, json!({ "error": "down" }));
    core.lock_page("p1".into()).unwrap();
    assert_eq!(s.take(), ["POST /pages/p1/lock", "GET /workspaces/w1/tree"]);
    assert!(core.cached_page_document("p1".into()).is_none());
    assert!(
        core.cached_tree("w1".into()).unwrap().pages[0].locked,
        "marked at once"
    );
    let t = &core.cached_tasks("w1".into()).unwrap()[0];
    assert_eq!((t.title.as_str(), t.locked), ("Locked task", true));
    assert!(
        !dir.has_any_encoding(BODY),
        "page content on disk after locking"
    );
    assert!(
        !dir.has_any_encoding(TITLE),
        "task title on disk after locking"
    );
    assert!(!dir.has_any_encoding(DESC));
}

#[test]
fn live_editing_an_unlocked_locked_page_stays_in_memory() {
    let server = TestServer::start(&["acc"]);
    support::type_text(server.room.doc(), "box:main", BODY);
    let (s, dir) = (Script::default(), TempDir::new("live"));
    let core = core(&s, &server.base, &dir);
    core.set_reconnect_delays(Duration::from_millis(20), Duration::from_millis(100));
    s.reply(200, tree(vec![page("page-1", true)]));
    core.tree("w1".into()).unwrap();
    s.take();
    unlock(&core, &s);

    #[derive(Default)]
    struct Quiet(Mutex<Vec<LiveStatus>>);
    impl LivePageListener for Quiet {
        fn on_status(&self, st: LiveStatus) {
            self.0.lock().unwrap().push(st);
        }
        fn on_change(&self, _: PageInfo) {}
    }
    let ev = Arc::new(Quiet::default());
    s.reply(200, tree(vec![page("page-1", true)])); // refreshed before opening
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    assert_eq!(s.take(), ["GET /workspaces/w1/tree"]);
    wait_for("sync", || {
        ev.0.lock().unwrap().contains(&LiveStatus::Synced)
    });
    assert!(
        String::from_utf8_lossy(&live.document()).contains(BODY),
        "the unlocked page's content is readable live"
    );

    // Edit it: a new text in its box.
    let edit = |text: &str| {
        let doc = nv_model::doc_from_update(&live.document()).unwrap();
        let before = doc.transact().state_vector();
        support::type_text(&doc, "box:main", text);
        live.apply_update(doc.transact().encode_state_as_update_v1(&before))
            .unwrap();
    };
    edit(TYPED);
    wait_for("the server to get the edit", || {
        server.text("box:main").contains(TYPED)
    });
    wait_for("the receipt", || live.unsent_updates() == 0);

    // And an edit while the connection is down: kept in memory, not in the outbox.
    server.set_offline(true);
    server.kick(None);
    wait_for("reconnecting", || {
        ev.0.lock()
            .unwrap()
            .iter()
            .any(|s| matches!(s, LiveStatus::Reconnecting { .. }))
    });
    edit("SECRETOFFLINE-aa11");
    assert_eq!(live.unsent_updates(), 1, "held in memory");
    assert!(core.unsent_pages().is_empty(), "not in the store's outbox");
    live.close();

    assert!(core.cached_page_document("page-1".into()).is_none());
    for marker in [BODY, TYPED, "SECRETOFFLINE-aa11"] {
        assert!(!dir.has_any_encoding(marker), "{marker} reached the store");
    }
    assert_eq!(core.store_error(), None);
}

#[test]
fn unlock_calls_status_and_what_they_send() {
    let (s, dir) = (Script::default(), TempDir::new("calls"));
    let core = core(&s, BASE, &dir);

    s.reply(
        200,
        json!({ "hasPassword": true, "unlocked": false, "expiresAt": null, "idleMs": 300000, "lockedPages": 1,
                "failures": 2, "blockedUntil": null, "triesBeforeLockout": 3, "devices": [] }),
    );
    let st = core.locked_notes_status().unwrap();
    assert_eq!(
        (
            st.has_password,
            st.unlocked,
            st.idle_ms,
            st.tries_before_lockout
        ),
        (true, false, 300_000, 3)
    );

    // Wrong password: the server's message and code reach the caller; nothing is kept.
    s.reply(
        400,
        json!({ "error": "Incorrect password. 2 tries left before unlocking is paused for 15 minutes.", "code": "wrong_password" }),
    );
    match core.unlock_locked_notes("nope-nope".into()) {
        Err(CoreError::Server {
            status,
            code,
            message,
        }) => {
            assert_eq!((status, code.as_deref()), (400, Some("wrong_password")));
            assert!(!message.contains("nope-nope"));
        }
        other => panic!("{other:?}"),
    }
    s.take();

    s.reply(200, json!({ "ok": true, "expiresAt": "e1" }));
    assert_eq!(
        core.set_locked_notes_password("new-secret".into(), Some("old-secret".into()))
            .unwrap()
            .as_deref(),
        Some("e1")
    );
    assert_eq!(
        s.last_body(),
        json!({ "password": "new-secret", "currentPassword": "old-secret" })
    );
    s.take();

    s.reply(
        200,
        json!({ "id": "d1", "secret": "dev-secret-1", "expiresAt": "x" }),
    );
    let d = core
        .register_unlock_device("install-0123456789abcdef".into(), Some("iPhone".into()))
        .unwrap();
    assert_eq!(d.secret, "dev-secret-1");
    assert!(!format!("{d:?}").contains("dev-secret-1"));
    s.reply(200, json!({ "expiresAt": "e2" }));
    core.unlock_locked_notes_with_device(d.id, d.secret, "install-0123456789abcdef".into())
        .unwrap();
    assert_eq!(s.last_body()["deviceId"], "d1");
    s.reply(200, json!({ "unlocked": true, "expiresAt": "e3" }));
    assert_eq!(
        core.keep_locked_notes_unlocked().unwrap(),
        LockKeepalive {
            unlocked: true,
            expires_at: Some("e3".into())
        }
    );
    s.reply(200, json!({ "ok": true }));
    core.lock_locked_notes().unwrap();
    s.reply(200, json!({ "ok": true }));
    core.remove_unlock_device("d1".into()).unwrap();
    s.take();

    // Locked now: tasks() fetches no extra tree.
    s.reply(200, json!([]));
    core.tasks("w1".into()).unwrap();
    assert_eq!(s.take(), ["GET /workspaces/w1/tasks"]);

    // Remove a lock: the password goes in the body, the stored tree is fetched again.
    s.reply(200, tree(vec![page("p1", true)]));
    core.tree("w1".into()).unwrap();
    s.take();
    s.reply(200, json!({ "ok": true }));
    s.reply(200, tree(vec![page("p1", false)]));
    core.remove_page_lock("p1".into(), "new-secret".into())
        .unwrap();
    assert_eq!(
        s.take(),
        ["POST /pages/p1/lock/remove", "GET /workspaces/w1/tree"]
    );
    assert!(!core.cached_tree("w1".into()).unwrap().pages[0].locked);
    // The password was never written anywhere on the device.
    for pw in ["new-secret", "old-secret", "dev-secret-1", "hunter2-pass"] {
        assert!(!dir.has_any_encoding(pw), "{pw} on disk");
    }
}
