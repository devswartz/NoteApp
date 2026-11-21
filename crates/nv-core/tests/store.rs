//! The Core with an on-device store, against a scripted transport (no server needed): reads
//! are stored, the cached reads return them, offline calls fall back to them, locked pages are
//! never stored, and sign-out clears everything.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use nv_api::{Request, Response, Transport};
use nv_core::*;
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct Script {
    replies: Arc<Mutex<VecDeque<Result<Response, String>>>>,
    seen: Arc<Mutex<Vec<Request>>>,
}

impl Script {
    fn reply(&self, status: u16, body: Value) -> &Self {
        self.replies.lock().unwrap().push_back(Ok(Response {
            status,
            body: body.to_string(),
            request_id: None,
        }));
        self
    }
    /// No answer `n` times (a GET is tried three times before it gives up).
    fn fail(&self, n: usize) -> &Self {
        for _ in 0..n {
            self.replies
                .lock()
                .unwrap()
                .push_back(Err("connection refused".into()));
        }
        self
    }
    fn urls(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|r| format!("{} {}", r.method, r.url))
            .collect()
    }
    fn done(&self) -> bool {
        self.replies.lock().unwrap().is_empty()
    }
}

impl Transport for Script {
    fn send(&self, req: &Request) -> Result<Response, String> {
        self.seen.lock().unwrap().push(req.clone());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("an unscripted request: {} {}", req.method, req.url))
    }
}

/// A fresh database path in a fresh folder, removed when dropped.
struct TempDir(PathBuf);
impl TempDir {
    fn new(name: &str) -> TempDir {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        TempDir(std::env::temp_dir().join(format!("nv-core-{name}-{}-{nanos}", std::process::id())))
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

const SERVER: &str = "http://localhost:4417";

fn session(user_id: &str) -> Value {
    json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
            "user": { "id": user_id, "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } })
}

fn workspaces() -> Value {
    json!([{ "id": "w1", "name": "Ann's Space", "role": "owner", "createdAt": "2026-01-01" }])
}

fn page(id: &str, locked: bool) -> Value {
    json!({ "id": id, "sectionId": "s1", "title": format!("Page {id}"), "icon": null, "kind": "canvas",
            "position": 1.0, "updatedAt": "2026-11-01", "updatedBy": null, "locked": locked })
}

fn tree(pages: Vec<Value>) -> Value {
    json!({
        "notebooks": [{ "id": "n1", "workspaceId": "w1", "name": "Notes", "color": "#336699",
                        "visibility": "shared", "createdBy": "u1", "position": 1.0 }],
        "sections": [{ "id": "s1", "notebookId": "n1", "parentId": null, "name": "General",
                       "color": "#996633", "position": 1.0 }],
        "pages": pages,
    })
}

fn task(id: &str, status: &str) -> Value {
    json!({ "id": id, "workspaceId": "w1", "title": format!("Task {id}"), "status": status, "priority": 4,
            "dueDate": null, "dueTime": null, "reminderAt": null, "assigneeId": null, "createdBy": "u1",
            "pageId": null, "parentId": null, "completedAt": null,
            "createdAt": "2026-11-01", "updatedAt": "2026-11-02" })
}

fn signed_in(s: &Script, dir: &TempDir) -> Arc<Core> {
    s.reply(200, session("u1"));
    let core = Core::with_transport(SERVER, Box::new(s.clone()), Some(dir.db()));
    assert!(core.has_store());
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    core
}

#[test]
fn a_core_without_a_store_caches_nothing() {
    let s = Script::default();
    s.reply(200, session("u1")).reply(200, workspaces());
    let core = Core::with_transport(SERVER, Box::new(s.clone()), None);
    assert!(!core.has_store());
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    assert_eq!(core.workspaces().unwrap().len(), 1);
    assert_eq!(core.cached_workspaces(), None);
    assert_eq!(core.cached_tree("w1".into()), None);
    assert_eq!(core.cached_page_document("p1".into()), None);
}

#[test]
fn reads_are_stored_and_offline_falls_back_to_them() {
    let dir = TempDir::new("offline");
    let s = Script::default();
    let core = signed_in(&s, &dir);
    assert_eq!(core.cached_workspaces(), None);

    s.reply(200, workspaces())
        .reply(200, tree(vec![page("p1", false)]))
        .reply(200, json!([task("t1", "open")]))
        .reply(200, json!({ "ydoc": "AQID" }));
    let ws = core.workspaces().unwrap();
    let t = core.tree("w1".into()).unwrap();
    let tasks = core.tasks("w1".into()).unwrap();
    assert_eq!(core.page_document("p1".into()).unwrap(), [1, 2, 3]);
    assert_eq!(core.cached_workspaces(), Some(ws.clone()));
    assert_eq!(core.cached_tree("w1".into()), Some(t.clone()));
    assert_eq!(core.cached_tasks("w1".into()), Some(tasks.clone()));
    assert_eq!(core.cached_page_document("p1".into()), Some(vec![1, 2, 3]));

    // The server can't be reached: the stored copies.
    s.fail(3 * 4);
    assert_eq!(core.workspaces().unwrap(), ws);
    assert_eq!(core.tree("w1".into()).unwrap(), t);
    assert_eq!(core.tasks("w1".into()).unwrap(), tasks);
    assert_eq!(core.page_document("p1".into()).unwrap(), [1, 2, 3]);

    // Offline with nothing stored: the network error.
    s.fail(3);
    assert!(matches!(
        core.tree("w2".into()),
        Err(CoreError::Network { .. })
    ));
    // A server error is an answer, not offline: no fallback.
    s.reply(500, json!({ "error": "boom" }));
    assert!(matches!(
        core.workspaces(),
        Err(CoreError::Server { status: 500, .. })
    ));
    assert!(s.done());
}

#[test]
fn locked_pages_are_never_stored() {
    let dir = TempDir::new("locked");
    let s = Script::default();
    let core = signed_in(&s, &dir);
    s.reply(200, json!({ "ydoc": "CQk=" })) // p2, before any tree showed it
        .reply(200, tree(vec![page("p1", false), page("p2", false)]))
        .reply(200, json!({ "ydoc": "CQk=" })) // p2, known unlocked
        .reply(200, tree(vec![page("p1", false), page("p2", true)]))
        .reply(200, json!({ "ydoc": "CQk=" })); // p2 again, now known to be locked
    assert_eq!(core.page_document("p2".into()).unwrap(), [9, 9]);
    assert_eq!(
        core.cached_page_document("p2".into()),
        None,
        "not stored before a tree shows it unlocked"
    );
    core.tree("w1".into()).unwrap();
    assert_eq!(core.page_document("p2".into()).unwrap(), [9, 9]);
    assert!(core.cached_page_document("p2".into()).is_some());
    let t = core.tree("w1".into()).unwrap();
    assert!(t.pages.iter().any(|p| p.id == "p2" && p.locked));
    assert_eq!(
        core.cached_page_document("p2".into()),
        None,
        "dropped when the tree showed it locked"
    );
    assert_eq!(core.page_document("p2".into()).unwrap(), [9, 9]);
    assert_eq!(core.cached_page_document("p2".into()), None, "not stored");
    // Offline: no copy to fall back to.
    s.fail(3);
    assert!(matches!(
        core.page_document("p2".into()),
        Err(CoreError::Network { .. })
    ));
}

#[test]
fn task_writes_update_the_stored_tasks() {
    let dir = TempDir::new("tasks");
    let s = Script::default();
    let core = signed_in(&s, &dir);
    s.reply(200, json!([task("t1", "open")]))
        .reply(200, task("t1", "done"))
        .reply(201, task("t2", "open"));
    core.tasks("w1".into()).unwrap();
    core.set_task_done("t1".into(), true).unwrap();
    core.create_task("w1".into(), "Task t2".into(), None)
        .unwrap();
    let cached = core.cached_tasks("w1".into()).unwrap();
    assert_eq!(
        cached
            .iter()
            .map(|t| (t.id.as_str(), t.done))
            .collect::<Vec<_>>(),
        [("t1", true), ("t2", false)]
    );
}

#[test]
fn sign_out_clears_the_store_and_another_user_starts_empty() {
    let dir = TempDir::new("signout");
    let s = Script::default();
    let core = signed_in(&s, &dir);
    s.reply(200, workspaces())
        .reply(200, tree(vec![page("p1", false)]))
        .reply(200, json!({ "ydoc": "AQID" }));
    core.workspaces().unwrap();
    core.tree("w1".into()).unwrap();
    core.page_document("p1".into()).unwrap();

    // Another user signs in on this device: the first one's copy goes.
    s.reply(200, session("u2"));
    core.sign_in("b@b.c".into(), "pw".into()).unwrap();
    assert_eq!(core.cached_workspaces(), None);
    assert_eq!(core.cached_page_document("p1".into()), None);

    s.reply(200, workspaces()).reply(200, json!({ "ok": true }));
    core.workspaces().unwrap();
    assert!(core.cached_workspaces().is_some());
    core.sign_out();
    assert_eq!(core.cached_workspaces(), None);
    assert!(s.urls().last().unwrap().ends_with("/api/auth/logout"));
    assert!(matches!(core.workspaces(), Err(CoreError::SignedOut)));
}

#[test]
fn an_offline_launch_reads_the_stored_copy() {
    let dir = TempDir::new("launch");
    {
        let s = Script::default();
        let core = signed_in(&s, &dir);
        s.reply(200, workspaces())
            .reply(200, tree(vec![page("p1", false)]));
        core.workspaces().unwrap();
        core.tree("w1".into()).unwrap();
    }
    // The app starts again, offline, with the refresh token from the keychain.
    let s = Script::default();
    let core = Core::with_transport(SERVER, Box::new(s.clone()), Some(dir.db()));
    assert_eq!(core.cached_workspaces().unwrap()[0].id, "w1");
    assert_eq!(core.cached_tree("w1".into()).unwrap().pages[0].id, "p1");
    s.fail(1);
    assert!(matches!(
        core.restore_session("ref".into()),
        Err(CoreError::Network { .. })
    ));
    s.fail(1);
    assert_eq!(core.workspaces().unwrap()[0].id, "w1");
    assert!(s.done());
}

#[test]
fn a_database_that_cannot_be_read_is_replaced() {
    let dir = TempDir::new("damaged");
    std::fs::create_dir_all(&dir.0).unwrap();
    std::fs::write(dir.db(), [0xAB; 4096]).unwrap();
    let s = Script::default();
    let core = signed_in(&s, &dir);
    s.reply(200, workspaces());
    core.workspaces().unwrap();
    assert!(core.cached_workspaces().is_some());
}
