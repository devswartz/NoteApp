//! The live doc as the editor session will use it (`LivePage::doc`, `add_remote_hook`), against
//! the stand-in collab server (crates/nv-sync/tests/support): an edit made on the doc itself
//! (with an origin of its own, as nv-editor writes) reaches the server and the outbox like
//! `apply_update`, and isn't reported back as a remote change; a remote update runs the hooks
//! around it; a hook holding its own lock while local edits take the same lock doesn't deadlock.
//! Unit tests because the accessors are crate-visible only.

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nv_api::{Request, Response, Transport};
use nv_model::yrs::{Transact, WriteTxn, XmlFragment, XmlTextPrelim};
use serde_json::{json, Value};
use support::{read_text, type_text, wait_for, TestServer};

use crate::{Core, LivePage, LivePageListener, LiveStatus, PageInfo};

#[derive(Clone, Default)]
struct Script(Arc<Mutex<VecDeque<Value>>>);
impl Transport for Script {
    fn send(&self, req: &Request) -> Result<Response, String> {
        let body = self
            .0
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| format!("unscripted: {} {}", req.method, req.url))?;
        Ok(Response {
            status: 200,
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
        TempDir(
            std::env::temp_dir().join(format!("nv-livedoc-{name}-{}-{nanos}", std::process::id())),
        )
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

#[derive(Default)]
struct Events {
    statuses: Mutex<Vec<LiveStatus>>,
    changes: AtomicU32,
}
impl LivePageListener for Events {
    fn on_status(&self, s: LiveStatus) {
        self.statuses.lock().unwrap().push(s);
    }
    fn on_change(&self, _: PageInfo) {
        self.changes.fetch_add(1, Ordering::SeqCst);
    }
}
impl Events {
    fn synced(&self) -> bool {
        self.statuses.lock().unwrap().contains(&LiveStatus::Synced)
    }
    fn reconnecting(&self) -> bool {
        self.statuses
            .lock()
            .unwrap()
            .iter()
            .any(|s| matches!(s, LiveStatus::Reconnecting { .. }))
    }
}

/// A signed-in core with a store that knows page-1 (unlocked), and the page open live.
fn open(server: &TestServer, dir: &TempDir) -> (Arc<Core>, Arc<LivePage>, Arc<Events>) {
    let s = Script::default();
    s.0.lock().unwrap().extend([
        json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
        json!({ "notebooks": [], "sections": [], "pages": [
            { "id": "page-1", "sectionId": "s1", "title": "Page", "icon": null, "kind": "canvas",
              "position": 1.0, "updatedAt": "2026-11-01", "updatedBy": null, "locked": false } ] }),
    ]);
    let core = Core::with_transport(&server.base, Box::new(s), Some(dir.db()));
    core.set_reconnect_delays(Duration::from_millis(20), Duration::from_millis(100));
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    core.tree("w1".into()).unwrap();
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    (core, live, ev)
}

/// An edit on the live doc itself, as nv-editor's binding writes (its own origin).
fn edit_in_place(live: &LivePage, field: &str, text: &str) {
    let mut txn = live.doc().transact_mut_with("nv-editor-local");
    let frag = txn.get_or_insert_xml_fragment(field);
    frag.push_back(&mut txn, XmlTextPrelim::new(text));
}

/// Records each remote update it runs around: (text of `box:main` before, changed, after).
struct Seen {
    page: Arc<LivePage>,
    log: Mutex<Vec<(String, bool, String)>>,
}
impl nv_sync::RemoteHook for Seen {
    fn around_remote(&self, apply: &mut dyn FnMut() -> bool) {
        let before = read_text(self.page.doc(), "box:main");
        let changed = apply();
        let after = read_text(self.page.doc(), "box:main");
        self.log.lock().unwrap().push((before, changed, after));
    }
}

#[test]
fn edits_on_the_live_doc_are_sent_and_kept_like_apply_update() {
    let server = TestServer::start(&["acc"]);
    let dir = TempDir::new("local");
    let (core, live, ev) = open(&server, &dir);
    wait_for("sync", || ev.synced());
    let seen = Arc::new(Seen {
        page: live.clone(),
        log: Mutex::default(),
    });
    live.add_remote_hook(seen.clone());
    let changes = ev.changes.load(Ordering::SeqCst);

    // Online: straight to the server.
    edit_in_place(&live, "box:main", " there");
    wait_for("the server to get it", || {
        server.text("box:main") == "Hello there"
    });
    wait_for("the receipt", || live.unsent_updates() == 0);
    assert_eq!(ev.changes.load(Ordering::SeqCst), changes, "no on_change");

    // Offline: kept in the store's outbox, then sent after reconnecting.
    server.set_offline(true);
    server.kick(None);
    wait_for("offline", || ev.reconnecting());
    edit_in_place(&live, "box:new", "typed offline");
    wait_for("the edit to be kept", || {
        core.unsent_pages() == ["page-1"] && live.unsent_updates() == 1
    });
    server.set_offline(false);
    wait_for("the server to get the offline edit", || {
        server.text("box:new") == "typed offline"
    });
    wait_for("the queue to empty", || {
        live.unsent_updates() == 0 && core.unsent_pages().is_empty()
    });

    // Never reported back as someone else's change: on_change only for the resync (every sync
    // reports one), and the hooks only ran around echoes and the resync, which changed nothing.
    assert_eq!(ev.changes.load(Ordering::SeqCst), changes + 1);
    assert!(
        seen.log
            .lock()
            .unwrap()
            .iter()
            .all(|(_, changed, _)| !changed),
        "{:?}",
        seen.log.lock().unwrap()
    );
    assert!(!live.is_closed());
    live.close();
    assert!(live.is_closed());
}

#[test]
fn a_remote_update_runs_the_hooks_around_it() {
    let server = TestServer::start(&["acc"]);
    let dir = TempDir::new("remote");
    let (_core, live, ev) = open(&server, &dir);
    wait_for("sync", || ev.synced());
    let seen = Arc::new(Seen {
        page: live.clone(),
        log: Mutex::default(),
    });
    let id = live.add_remote_hook(seen.clone());

    type_text(server.room.doc(), "box:main", ", world");
    wait_for("the hook", || {
        seen.log
            .lock()
            .unwrap()
            .iter()
            .any(|(_, changed, _)| *changed)
    });
    let log = seen.log.lock().unwrap().clone();
    let (before, _, after) = log.iter().find(|(_, c, _)| *c).unwrap();
    assert_eq!(
        (before.as_str(), after.as_str()),
        ("Hello", "Hello, world"),
        "the hook saw the doc before and after"
    );
    wait_for("on_change too", || ev.changes.load(Ordering::SeqCst) >= 2);

    // Removed: not called again.
    live.remove_remote_hook(id);
    let n = seen.log.lock().unwrap().len();
    type_text(server.room.doc(), "box:main", "!");
    wait_for("the change", || {
        read_text(live.doc(), "box:main") == "Hello, world!"
    });
    assert_eq!(seen.log.lock().unwrap().len(), n);
    live.close();
}

/// A session-like hook: its own mutex around stick, apply, re-read.
struct Locked {
    page: Arc<LivePage>,
    state: Mutex<String>,
}
impl nv_sync::RemoteHook for Locked {
    fn around_remote(&self, apply: &mut dyn FnMut() -> bool) {
        let mut state = self.state.lock().unwrap();
        apply();
        *state = read_text(self.page.doc(), "box:main");
    }
}

#[test]
fn a_hook_holding_its_lock_and_local_edits_under_the_same_lock_do_not_deadlock() {
    let server = TestServer::start(&["acc"]);
    let dir = TempDir::new("locks");
    let (_core, live, ev) = open(&server, &dir);
    wait_for("sync", || ev.synced());
    let hook = Arc::new(Locked {
        page: live.clone(),
        state: Mutex::new(String::new()),
    });
    live.add_remote_hook(hook.clone());

    // Local edits under the hook's lock (as a session's edit holds its mutex), while the
    // server sends remote ones that the hook wraps.
    let local = {
        let (live, hook) = (live.clone(), hook.clone());
        std::thread::spawn(move || {
            for i in 0..40 {
                let mut state = hook.state.lock().unwrap();
                edit_in_place(&live, "box:mine", &i.to_string());
                *state = read_text(live.doc(), "box:main");
                drop(state);
                std::thread::sleep(Duration::from_millis(2));
            }
        })
    };
    for _ in 0..40 {
        type_text(server.room.doc(), "box:main", "r");
        std::thread::sleep(Duration::from_millis(2));
    }
    local.join().unwrap();
    let want = format!("Hello{}", "r".repeat(40));
    wait_for("every remote edit", || *hook.state.lock().unwrap() == want);
    let mine: String = (0..40).map(|i| i.to_string()).collect();
    wait_for("every local edit on the server", || {
        server.text("box:mine") == mine
    });
    live.close();
}
