//! Task writes through the Core against a scripted transport: create with the client's id,
//! rename, delete (with subtasks) and restore, as the web app does; offline writes queued in the
//! store and sent in order; refusals dropped; the locked-page rule; and `page_tasks`, the
//! editor's `TaskCallbacks` over the Core.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    /// No answer `n` times (a write is tried once; a GET three times).
    fn fail(&self, n: usize) -> &Self {
        for _ in 0..n {
            self.replies
                .lock()
                .unwrap()
                .push_back(Err("connection refused".into()));
        }
        self
    }
    /// The requests since the last call: "METHOD /path".
    fn take(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .drain(..)
            .map(|r| format!("{} {}", r.method, r.url.trim_start_matches(SERVER)))
            .collect()
    }
    fn bodies(&self) -> Vec<Option<Value>> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.body.as_deref().map(|b| serde_json::from_str(b).unwrap()))
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

struct TempDir(PathBuf);
impl TempDir {
    fn new(name: &str) -> TempDir {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        TempDir(
            std::env::temp_dir().join(format!("nv-tasks-{name}-{}-{nanos}", std::process::id())),
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

const SERVER: &str = "http://localhost:4417";
const A: &str = "0d9a1c7e-5b1f-4a53-9d0e-2f6a8b7c1e44";
const B: &str = "7f3b2a10-9c4d-4e8f-a1b2-c3d4e5f60718";

fn session() -> Value {
    json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
            "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } })
}

fn page(id: &str, locked: bool) -> Value {
    json!({ "id": id, "sectionId": "s1", "title": "Page", "icon": null, "kind": "canvas",
            "position": 1.0, "updatedAt": "2026-11-01", "updatedBy": null, "locked": locked })
}

fn task(id: &str, title: &str, status: &str, parent: Option<&str>) -> Value {
    json!({ "id": id, "workspaceId": "w1", "title": title, "status": status, "priority": 4,
            "dueDate": null, "dueTime": null, "reminderAt": null, "assigneeId": null, "createdBy": "u1",
            "pageId": "p1", "parentId": parent, "completedAt": null, "tagIds": ["g1"],
            "createdAt": "2026-11-01", "updatedAt": "2026-11-02" })
}

/// Signed in, with a store that has the workspace's tree (p1 unlocked, p2 locked) and tasks.
fn core(s: &Script, dir: &TempDir, tasks: Value) -> Arc<Core> {
    s.reply(200, session())
        .reply(200, json!({ "notebooks": [], "sections": [], "pages": [page("p1", false), page("p2", true)] }))
        .reply(200, tasks);
    let core = Core::with_transport(SERVER, Box::new(s.clone()), Some(dir.db()));
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    core.tree("w1".into()).unwrap();
    core.tasks("w1".into()).unwrap();
    s.take();
    core
}

fn input(id: &str, title: &str, page: &str) -> NewTaskInput {
    NewTaskInput {
        id: Some(id.into()),
        title: title.into(),
        page_id: Some(page.into()),
        parent_id: None,
        done: false,
    }
}

fn titles(core: &Core) -> Vec<(String, String)> {
    core.cached_tasks("w1".into())
        .unwrap()
        .into_iter()
        .map(|t| (t.id, t.title))
        .collect()
}

#[test]
fn new_task_ids_are_v4_uuids() {
    let a = new_task_id();
    assert_eq!(a.len(), 36);
    assert_eq!(&a[14..15], "4");
    assert!("89ab".contains(&a[19..20]));
    assert!(a
        .chars()
        .all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert_ne!(a, new_task_id());
}

#[test]
fn create_with_the_clients_id_rename_delete_and_restore() {
    let dir = TempDir::new("online");
    let s = Script::default();
    let core = core(&s, &dir, json!([]));

    s.reply(200, task(A, "", "open", None));
    let t = core
        .create_task_with("w1".into(), input(A, "", "p1"))
        .unwrap();
    assert_eq!((t.id.as_str(), t.page_id.as_deref()), (A, Some("p1")));
    s.reply(200, task(A, "Call Bo", "open", None));
    assert_eq!(
        core.set_task_title(A.into(), "Call Bo".into())
            .unwrap()
            .title,
        "Call Bo"
    );
    assert_eq!(core.cached_task(A.into()).unwrap().title, "Call Bo");
    // A subtask, created ticked: a create, then a PATCH.
    s.reply(200, task(B, "Sub", "open", Some(A)))
        .reply(200, task(B, "Sub", "done", Some(A)));
    let sub = NewTaskInput {
        parent_id: Some(A.into()),
        page_id: None,
        done: true,
        ..input(B, "Sub", "")
    };
    assert!(core.create_task_with("w1".into(), sub).unwrap().done);
    assert_eq!(
        s.take(),
        [
            "POST /api/workspaces/w1/tasks".into(),
            format!("PATCH /api/tasks/{A}"),
            "POST /api/workspaces/w1/tasks".into(),
            format!("PATCH /api/tasks/{B}"),
        ]
    );

    // Delete: the subtask goes too, and both can come back with the same ids.
    s.reply(200, json!({ "ok": true }));
    core.delete_task(A.into()).unwrap();
    assert!(titles(&core).is_empty());
    assert!(core.can_restore_task(A.into()));
    s.reply(200, task(A, "Call Bo", "open", None))
        .reply(200, task(B, "Sub", "open", Some(A)))
        .reply(200, task(B, "Sub", "done", Some(A)));
    s.seen.lock().unwrap().clear();
    assert!(core.restore_task(A.into()).unwrap());
    let bodies = s.bodies();
    assert_eq!(bodies[0].as_ref().unwrap()["id"], A);
    assert_eq!(bodies[0].as_ref().unwrap()["title"], "Call Bo");
    assert_eq!(bodies[0].as_ref().unwrap()["tagIds"], json!(["g1"]));
    assert_eq!(bodies[1].as_ref().unwrap()["parentId"], A);
    assert_eq!(bodies[2], Some(json!({ "status": "done" })));
    assert_eq!(
        s.take(),
        [
            "POST /api/workspaces/w1/tasks".into(),
            "POST /api/workspaces/w1/tasks".into(),
            format!("PATCH /api/tasks/{B}"),
        ]
    );
    assert_eq!(titles(&core).len(), 2);
    assert!(!core.restore_task(A.into()).unwrap(), "only once");

    // Deleting a task that is already gone counts as deleted.
    s.reply(404, json!({ "error": "Task not found" }));
    core.delete_task(A.into()).unwrap();
    // A refusal puts the stored task back.
    s.reply(200, task(A, "Call Bo", "open", None))
        .reply(200, task(B, "Sub", "open", Some(A)))
        .reply(200, task(B, "Sub", "done", Some(A)));
    assert!(core.restore_task(A.into()).unwrap());
    s.reply(
        403,
        json!({ "error": "You have view-only access to the note this task is in" }),
    );
    assert!(matches!(
        core.delete_task(A.into()),
        Err(CoreError::Server { status: 403, .. })
    ));
    assert_eq!(core.cached_task(A.into()).unwrap().title, "Call Bo");
    assert!(s.done());
}

#[test]
fn offline_writes_are_queued_and_sent_in_order() {
    let dir = TempDir::new("offline");
    let s = Script::default();
    let core = core(&s, &dir, json!([task(B, "Old", "open", None)]));

    // Offline: each write is tried once, kept, and applied to the stored tasks.
    s.fail(1);
    let t = core
        .create_task_with("w1".into(), input(A, "Draft", "p1"))
        .unwrap();
    assert_eq!((t.title.as_str(), t.done), ("Draft", false));
    // Earlier writes still wait: the next ones queue behind them (one try to send the queue).
    s.fail(1);
    assert_eq!(
        core.set_task_title(A.into(), "Call Bo".into())
            .unwrap()
            .title,
        "Call Bo"
    );
    s.fail(1);
    assert!(core.set_task_done(B.into(), true).unwrap().done);
    s.fail(1);
    core.delete_task(B.into()).unwrap();
    assert_eq!(core.unsent_task_changes(), 4);
    assert_eq!(titles(&core), [(A.to_string(), "Call Bo".to_string())]);
    assert_eq!(s.take().len(), 4);

    // A new Core on the same store (an app restart) still has them; `tasks()` sends them in
    // order, then reads the list.
    drop(core);
    s.reply(200, session());
    let core = Core::with_transport(SERVER, Box::new(s.clone()), Some(dir.db()));
    core.restore_session("ref".into()).unwrap();
    assert_eq!(core.unsent_task_changes(), 4);
    s.reply(200, task(A, "Draft", "open", None))
        .reply(200, task(A, "Call Bo", "open", None))
        .reply(200, task(B, "Old", "done", None))
        .reply(404, json!({ "error": "Task not found" }))
        .reply(200, json!([task(A, "Call Bo", "open", None)]));
    s.take();
    let list = core.tasks("w1".into()).unwrap();
    assert_eq!(
        s.take(),
        [
            "POST /api/workspaces/w1/tasks".into(),
            format!("PATCH /api/tasks/{A}"),
            format!("PATCH /api/tasks/{B}"),
            format!("DELETE /api/tasks/{B}"),
            "GET /api/workspaces/w1/tasks".into(),
        ]
    );
    assert_eq!(list.len(), 1);
    assert_eq!(core.unsent_task_changes(), 0);
    assert_eq!(core.task_error(), None);
    assert!(s.done());
}

#[test]
fn a_refused_queued_write_is_dropped_and_waiting_ones_overlay_the_list() {
    let dir = TempDir::new("refused");
    let s = Script::default();
    let core = core(&s, &dir, json!([]));
    s.fail(1);
    core.create_task_with("w1".into(), input(A, "One", "p1"))
        .unwrap();
    s.fail(1);
    core.create_task_with("w1".into(), input(B, "Two", "p1"))
        .unwrap();

    // Still offline when the list is read: the stored list (with both) comes back.
    s.fail(1).fail(3);
    assert_eq!(core.tasks("w1".into()).unwrap().len(), 2);

    // The server is back but refuses the first: dropped, noted, removed from the store. The
    // second is sent; the list the server sends is laid over with nothing left waiting.
    s.reply(400, json!({ "error": "Invalid page" }))
        .reply(200, task(B, "Two", "open", None))
        .reply(200, json!([task(B, "Two", "open", None)]));
    let list = core.tasks("w1".into()).unwrap();
    assert_eq!(list.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), [B]);
    assert!(core.task_error().unwrap().contains("Invalid page"));
    assert_eq!(core.unsent_task_changes(), 0);

    // Waiting writes are laid over a list read while they still can't be sent (a 5xx keeps
    // them): the server's list lacks the new task, the stored one has it.
    s.fail(1);
    core.create_task_with("w1".into(), input(A, "Again", "p1"))
        .unwrap();
    s.reply(503, json!({ "error": "busy" }))
        .reply(200, json!([task(B, "Two", "open", None)]));
    let ids: Vec<String> = core
        .tasks("w1".into())
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(ids, [B, A]);
    assert_eq!(core.unsent_task_changes(), 1);
}

#[test]
fn writes_for_a_locked_page_or_an_unknown_task_are_not_queued() {
    let dir = TempDir::new("locked");
    let s = Script::default();
    let core = core(&s, &dir, json!([]));
    s.fail(1);
    assert!(matches!(
        core.create_task_with("w1".into(), input(A, "Secret", "p2")),
        Err(CoreError::Network { .. })
    ));
    s.fail(1);
    assert!(matches!(
        core.set_task_title(B.into(), "Unknown".into()),
        Err(CoreError::Network { .. })
    ));
    assert_eq!(core.unsent_task_changes(), 0);
    assert!(titles(&core).is_empty());

    // Without a store nothing is queued: the error comes back as before.
    let s = Script::default();
    s.reply(200, session()).fail(1);
    let bare = Core::with_transport(SERVER, Box::new(s.clone()), None);
    bare.sign_in("a@b.c".into(), "pw".into()).unwrap();
    assert!(matches!(
        bare.create_task("w1".into(), "x".into(), None),
        Err(CoreError::Network { .. })
    ));
    let body = s.bodies().pop().flatten().unwrap();
    assert_eq!(
        body["id"].as_str().unwrap().len(),
        36,
        "create_task sends an id now"
    );
}

fn wait_for(what: &str, f: impl Fn() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn page_tasks_answers_at_once_and_writes_in_order_behind() {
    let dir = TempDir::new("callbacks");
    let s = Script::default();
    let core = core(&s, &dir, json!([task(B, "Existing", "open", None)]));
    let cb = core.clone().page_tasks("w1".into(), Some("p1".into()));

    assert_eq!(
        cb.title(B.into()).as_deref(),
        Some("Existing"),
        "from the store"
    );
    let id = cb.new_id();
    assert_eq!(id.len(), 36);
    s.reply(200, task(&id, "", "open", None))
        .reply(200, task(&id, "Plan", "open", None));
    cb.create(id.clone(), String::new(), false);
    cb.set_title(id.clone(), "Plan".into());
    assert_eq!(cb.title(id.clone()).as_deref(), Some("Plan"), "at once");
    wait_for("both writes", || {
        s.done()
            && core
                .cached_task(id.clone())
                .is_some_and(|t| t.title == "Plan")
    });
    let body = s.bodies()[0].clone().unwrap();
    assert_eq!(
        (body["id"].as_str(), body["pageId"].as_str()),
        (Some(id.as_str()), Some("p1"))
    );

    // Deleted, then brought back by undo: same id, same title.
    s.reply(200, json!({ "ok": true }))
        .reply(200, task(&id, "Plan", "open", None));
    cb.delete(id.clone());
    assert_eq!(cb.title(id.clone()), None);
    assert!(cb.restore(id.clone()));
    assert!(!cb.restore(id.clone()), "once");
    assert!(!cb.restore(B.into()), "not deleted here");
    assert_eq!(cb.title(id.clone()).as_deref(), Some("Plan"));
    wait_for("delete and restore", || {
        s.done() && core.cached_task(id.clone()).is_some()
    });
    let calls = s.take();
    assert_eq!(calls[calls.len() - 2], format!("DELETE /api/tasks/{id}"));
    assert_eq!(calls[calls.len() - 1], "POST /api/workspaces/w1/tasks");
    assert_eq!(core.task_error(), None);

    // A refused write is noted on the Core.
    s.reply(
        403,
        json!({ "error": "You have view-only access to the note this task is in" }),
    );
    cb.set_title(B.into(), "Nope".into());
    wait_for("the refusal", || core.task_error().is_some());
    wait_for("the title to come from the store again", || {
        cb.title(B.into()).as_deref() == Some("Existing")
    });
}
