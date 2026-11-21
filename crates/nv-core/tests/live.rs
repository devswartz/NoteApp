//! Live pages through the Core, against the stand-in collab server (crates/nv-sync/tests/support)
//! with HTTP scripted: `open_live_page` returns at once and reconnects; edits made offline are
//! kept in the store and sent by a new Core (an app restart); 4401 refreshes the session through
//! the Core, a rejected refresh ends with `SignedOut`, 4403 with `NoAccess` (and forgets the
//! queued edits); `open_page` reports drops the old way.

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nv_api::{Request, Response, Transport};
use nv_core::*;
use nv_model::yrs::{ReadTxn, Transact};
use serde_json::{json, Value};
use support::{read_text, type_text, wait_for, TestServer};

#[derive(Clone, Default)]
struct Script {
    replies: Arc<Mutex<VecDeque<(u16, Value)>>>,
    seen: Arc<Mutex<Vec<String>>>,
}
impl Script {
    fn reply(&self, status: u16, body: Value) -> &Self {
        self.replies.lock().unwrap().push_back((status, body));
        self
    }
    fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}
impl Transport for Script {
    fn send(&self, req: &Request) -> Result<Response, String> {
        self.seen
            .lock()
            .unwrap()
            .push(format!("{} {}", req.method, req.url));
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
        TempDir(std::env::temp_dir().join(format!("nv-live-{name}-{}-{nanos}", std::process::id())))
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

fn session(access: &str) -> Value {
    json!({ "accessToken": access, "expiresIn": 900, "refreshToken": format!("ref-{access}"),
            "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } })
}

fn tree(locked: bool) -> Value {
    json!({ "notebooks": [], "sections": [], "pages": [
        { "id": "page-1", "sectionId": "s1", "title": "Page", "icon": null, "kind": "canvas",
          "position": 1.0, "updatedAt": "2026-11-01", "updatedBy": null, "locked": locked } ] })
}

#[derive(Default)]
struct Events {
    statuses: Mutex<Vec<LiveStatus>>,
    changes: Mutex<u32>,
}
impl LivePageListener for Events {
    fn on_status(&self, s: LiveStatus) {
        self.statuses.lock().unwrap().push(s);
    }
    fn on_change(&self, _: PageInfo) {
        *self.changes.lock().unwrap() += 1;
    }
}
impl Events {
    fn all(&self) -> Vec<LiveStatus> {
        self.statuses.lock().unwrap().clone()
    }
    fn syncs(&self) -> usize {
        self.all()
            .iter()
            .filter(|s| **s == LiveStatus::Synced)
            .count()
    }
    fn reconnecting(&self) -> bool {
        self.all()
            .iter()
            .any(|s| matches!(s, LiveStatus::Reconnecting { .. }))
    }
    fn last(&self) -> Option<LiveStatus> {
        self.all().last().cloned()
    }
}

/// A core signed in (token `acc`) that knows page-1 (unlocked), with short reconnect delays.
fn core(server: &TestServer, dir: &TempDir, s: &Script, restore: bool) -> Arc<Core> {
    let core = Core::with_transport(&server.base, Box::new(s.clone()), Some(dir.db()));
    core.set_reconnect_delays(Duration::from_millis(20), Duration::from_millis(100));
    s.reply(200, session("acc"));
    if restore {
        core.restore_session("ref-acc".into()).unwrap();
    } else {
        core.sign_in("a@b.c".into(), "pw".into()).unwrap();
        s.reply(200, tree(false));
        core.tree("w1".into()).unwrap();
    }
    core
}

/// An edit: a new field with `text` in it, made on a copy of the page.
fn edit(live: &LivePage, field: &str, text: &str) {
    let doc = nv_model::doc_from_update(&live.document()).unwrap();
    let before = doc.transact().state_vector();
    type_text(&doc, field, text);
    live.apply_update(doc.transact().encode_state_as_update_v1(&before))
        .unwrap();
}

fn text_of(live: &LivePage, field: &str) -> String {
    read_text(&nv_model::doc_from_update(&live.document()).unwrap(), field)
}

#[test]
fn offline_edits_are_kept_across_a_restart_and_4401_refreshes_through_the_core() {
    let server = TestServer::start(&["acc"]);
    server.set_offline(true);
    let dir = TempDir::new("restart");
    {
        let s = Script::default();
        let core = core(&server, &dir, &s, false);
        let ev = Arc::new(Events::default());
        let t = Instant::now();
        let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
        assert!(t.elapsed() < Duration::from_millis(200), "returns at once");
        wait_for("offline", || ev.reconnecting());
        edit(&live, "box:new", "typed offline");
        wait_for("the edit to be kept", || {
            core.unsent_pages() == ["page-1"] && live.unsent_updates() == 1
        });
        live.close();
        assert_eq!(
            ev.last(),
            Some(LiveStatus::Ended {
                reason: LiveEnd::Closed,
                message: "closed".into()
            })
        );
        assert_eq!(core.store_error(), None);
    }

    // The app starts again (a new Core on the same store), now online.
    server.set_offline(false);
    let s = Script::default();
    let core = core(&server, &dir, &s, true);
    assert_eq!(core.unsent_pages(), ["page-1"]);
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    assert_eq!(
        text_of(&live, "box:new"),
        "typed offline",
        "applied at open"
    );
    wait_for("sync", || ev.syncs() == 1);
    wait_for("the server to get the edit", || {
        server.text("box:new") == "typed offline"
    });
    wait_for("the receipt", || {
        core.unsent_pages().is_empty() && live.unsent_updates() == 0
    });
    assert_eq!(text_of(&live, "box:main"), "Hello");

    // The token lapses: the server closes with 4401, the core refreshes, and it's back at once.
    server.set_tokens(&["acc2"]);
    s.reply(200, session("acc2"));
    server.kick(Some(4401));
    wait_for("a second sync", || ev.syncs() == 2);
    assert!(s.seen().last().unwrap().ends_with("/api/auth/refresh"));
    assert_eq!(core.refresh_token().as_deref(), Some("ref-acc2"), "rotated");
    assert!(ev.all().iter().any(|st| matches!(
        st,
        LiveStatus::Reconnecting {
            in_ms: 0,
            code: Some(4401),
            ..
        }
    )));

    // Next time the refresh is rejected: signed out, and it stops.
    server.set_tokens(&[]);
    s.reply(401, json!({ "error": "Session expired" }));
    server.kick(Some(4401));
    wait_for("the end", || {
        matches!(ev.last(), Some(LiveStatus::Ended { .. }))
    });
    assert!(matches!(
        ev.last(),
        Some(LiveStatus::Ended {
            reason: LiveEnd::SignedOut,
            ..
        })
    ));
    assert_eq!(core.user(), None);
    live.close();
}

#[test]
fn no_access_ends_the_page_and_forgets_its_queued_edits() {
    let server = TestServer::start(&["acc"]);
    server.set_offline(true);
    let dir = TempDir::new("forbidden");
    let s = Script::default();
    let core = core(&server, &dir, &s, false);
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("offline", || ev.reconnecting());
    edit(&live, "box:new", "typed offline");
    wait_for("the edit to be kept", || !core.unsent_pages().is_empty());

    server.set_forbidden(true);
    server.set_offline(false);
    wait_for("the end", || {
        matches!(ev.last(), Some(LiveStatus::Ended { .. }))
    });
    assert!(matches!(
        ev.last(),
        Some(LiveStatus::Ended {
            reason: LiveEnd::NoAccess,
            ..
        })
    ));
    assert!(core.unsent_pages().is_empty());
    live.close();
    assert_eq!(core.cached_page_document("page-1".into()), None);
}

#[test]
fn a_locked_page_keeps_its_edits_in_memory_only() {
    let server = TestServer::start(&["acc"]);
    server.set_offline(true);
    let dir = TempDir::new("locked");
    let s = Script::default();
    let core = core(&server, &dir, &s, false);
    s.reply(200, tree(true));
    core.tree("w1".into()).unwrap();
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("offline", || ev.reconnecting());
    edit(&live, "box:new", "secret");
    wait_for("the edit to be queued", || live.unsent_updates() == 1);
    assert!(core.unsent_pages().is_empty(), "not on disk");
    server.set_offline(false);
    wait_for("the server to get it", || {
        server.text("box:new") == "secret"
    });
    wait_for("the receipt", || live.unsent_updates() == 0);
    live.close();
    assert_eq!(core.cached_page_document("page-1".into()), None);
}

#[derive(Default)]
struct OldEvents(Mutex<Vec<SyncStatus>>);
impl PageListener for OldEvents {
    fn on_status(&self, s: SyncStatus) {
        self.0.lock().unwrap().push(s);
    }
    fn on_change(&self, _: PageInfo) {}
}

#[test]
fn open_page_reports_drops_the_old_way_and_reconnects() {
    let server = TestServer::start(&["acc"]);
    let dir = TempDir::new("old");
    let s = Script::default();
    let core = core(&server, &dir, &s, false);
    let ev = Arc::new(OldEvents::default());
    let live = core.open_page("page-1".into(), ev.clone()).unwrap();
    let syncs = || {
        ev.0.lock()
            .unwrap()
            .iter()
            .filter(|s| **s == SyncStatus::Synced)
            .count()
    };
    wait_for("sync", || syncs() == 1);
    server.kick(None);
    wait_for("a second sync", || syncs() == 2);
    server.kick(Some(1012));
    wait_for("a third sync", || syncs() == 3);
    let all = ev.0.lock().unwrap().clone();
    assert!(
        all.iter().any(|s| matches!(s, SyncStatus::Failed { .. })),
        "{all:?}"
    );
    assert!(all
        .iter()
        .any(|s| matches!(s, SyncStatus::Closed { code: 1012, .. })));
    live.close();
    assert_eq!(
        ev.0.lock().unwrap().last(),
        Some(&SyncStatus::Closed {
            code: 1000,
            reason: "closed".into()
        })
    );
    // A closed page refuses edits.
    assert!(live.apply_update(vec![0, 0]).is_err());
}
