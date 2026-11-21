//! The client's session rules against a scripted transport (no server needed).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_api::{ApiError, Client, Request, Response, Transport};
use serde_json::json;

#[derive(Clone, Default)]
struct Script {
    replies: Arc<Mutex<VecDeque<Result<Response, String>>>>,
    seen: Arc<Mutex<Vec<Request>>>,
}

impl Script {
    fn reply(&self, status: u16, body: serde_json::Value) -> &Self {
        self.replies.lock().unwrap().push_back(Ok(Response {
            status,
            body: body.to_string(),
            request_id: Some("rid-1".into()),
        }));
        self
    }
    fn fail(&self) -> &Self {
        self.replies
            .lock()
            .unwrap()
            .push_back(Err("connection refused".into()));
        self
    }
    fn seen(&self) -> Vec<Request> {
        self.seen.lock().unwrap().clone()
    }
}

impl Transport for Script {
    fn send(&self, req: &Request) -> Result<Response, String> {
        self.seen.lock().unwrap().push(req.clone());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("an unscripted request")
    }
}

fn session(access: &str, refresh: &str, expires_in: u64) -> serde_json::Value {
    json!({ "accessToken": access, "expiresIn": expires_in, "refreshToken": refresh,
            "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } })
}

fn client(s: &Script) -> Client {
    Client::with_transport("http://localhost:4417/", Box::new(s.clone()))
}

#[test]
fn login_then_authenticated_calls() {
    let s = Script::default();
    s.reply(200, session("acc1", "ref1", 900)).reply(
        200,
        json!([{ "id": "w1", "name": "Ann's Space", "role": "owner", "createdAt": "2026-01-01" }]),
    );
    let c = client(&s);
    let auth = c.login("a@b.c", "pw").unwrap();
    assert_eq!(auth.user.name, "Ann");
    assert_eq!(c.session_refresh_token().as_deref(), Some("ref1"));
    let ws = c.workspaces().unwrap();
    assert_eq!(ws[0].id, "w1");
    let seen = s.seen();
    assert_eq!(seen[0].url, "http://localhost:4417/api/auth/login");
    assert_eq!(seen[0].bearer, None);
    assert_eq!(seen[1].url, "http://localhost:4417/api/workspaces");
    assert_eq!(seen[1].bearer.as_deref(), Some("acc1"));
}

#[test]
fn a_401_refreshes_once_and_retries() {
    let s = Script::default();
    s.reply(200, session("old", "ref1", 900))
        .reply(401, json!({ "error": "Token expired" }))
        .reply(200, session("new", "ref2", 900))
        .reply(200, json!({ "notebooks": [], "sections": [], "pages": [] }));
    let c = client(&s);
    c.login("a@b.c", "pw").unwrap();
    let tree = c.tree("w 1").unwrap();
    assert!(tree.pages.is_empty());
    let seen = s.seen();
    assert_eq!(
        seen[1].url,
        "http://localhost:4417/api/workspaces/w%201/tree"
    );
    assert_eq!(seen[2].body.as_deref(), Some(r#"{"refreshToken":"ref1"}"#));
    assert_eq!(seen[3].bearer.as_deref(), Some("new"));
    assert_eq!(c.session_refresh_token().as_deref(), Some("ref2"));
}

#[test]
fn an_expiring_token_is_refreshed_first() {
    let s = Script::default();
    s.reply(200, session("short", "ref1", 10))
        .reply(200, session("fresh", "ref2", 900))
        .reply(200, json!([]));
    let c = client(&s);
    c.login("a@b.c", "pw").unwrap();
    c.tasks("w1").unwrap();
    assert_eq!(s.seen()[2].bearer.as_deref(), Some("fresh"));
}

#[test]
fn a_rejected_refresh_signs_out() {
    let s = Script::default();
    s.reply(
        401,
        json!({ "error": "Session expired, please sign in again" }),
    );
    let c = client(&s);
    assert_eq!(c.restore("stale").unwrap_err(), ApiError::SignedOut);
    assert_eq!(c.session_refresh_token(), None);
    assert_eq!(c.me().unwrap_err(), ApiError::SignedOut);
}

#[test]
fn errors_carry_status_code_and_request_id() {
    let s = Script::default();
    s.reply(401, json!({ "error": "Incorrect email or password" }));
    let c = client(&s);
    match c.login("a@b.c", "bad").unwrap_err() {
        ApiError::Http {
            status,
            message,
            request_id,
            ..
        } => {
            assert_eq!(
                (status, message.as_str(), request_id.as_deref()),
                (401, "Incorrect email or password", Some("rid-1"))
            );
        }
        e => panic!("{e:?}"),
    }
}

#[test]
fn gets_retry_network_errors_and_writes_do_not() {
    let s = Script::default();
    s.reply(200, session("acc", "ref", 900))
        .fail()
        .reply(503, json!({}))
        .reply(200, json!({ "ydoc": "AAA=" }));
    let c = client(&s);
    c.login("a@b.c", "pw").unwrap();
    assert_eq!(c.page_doc("p1").unwrap(), vec![0, 0]);
    assert_eq!(s.seen().len(), 4);

    s.fail();
    assert!(matches!(
        c.update_task("t1", &json!({ "status": "done" })),
        Err(ApiError::Network(_))
    ));
    assert_eq!(s.seen().len(), 5);
}

#[test]
fn parses_a_task_from_the_server() {
    let s = Script::default();
    s.reply(200, session("acc", "ref", 900)).reply(
        200,
        json!([{ "id": "t1", "workspaceId": "w1", "title": "Ship", "description": "", "status": "open", "priority": 4,
                 "dueDate": "2026-12-01", "dueTime": null, "recurrence": null, "reminderAt": null, "assigneeId": null,
                 "createdBy": "u1", "pageId": "p1", "parentId": null, "teamId": null, "tagIds": ["g1"], "assignedBy": null,
                 "checklist": { "done": 1, "total": 2 }, "completedAt": null, "completedBy": null,
                 "createdAt": "2026-11-01T00:00:00Z", "updatedAt": "2026-11-01T00:00:00Z", "somethingNew": 1 }]),
    );
    let c = client(&s);
    c.login("a@b.c", "pw").unwrap();
    let t = &c.tasks("w1").unwrap()[0];
    assert_eq!(
        (
            t.title.as_str(),
            t.due_date.as_deref(),
            t.checklist.as_ref().map(|c| c.total)
        ),
        ("Ship", Some("2026-12-01"), Some(2))
    );
    assert_eq!(c.collab_url("p 1"), "ws://localhost:4417/collab/p%201");
}

fn task_json(id: &str, title: &str) -> serde_json::Value {
    json!({ "id": id, "workspaceId": "w1", "title": title, "status": "open", "priority": 4,
            "dueDate": null, "dueTime": null, "reminderAt": null, "assigneeId": null, "createdBy": "u1",
            "pageId": "p1", "parentId": null, "completedAt": null,
            "createdAt": "2026-11-01", "updatedAt": "2026-11-01" })
}

#[test]
fn task_writes_create_with_a_client_id_rename_and_delete() {
    let id = "0d9a1c7e-5b1f-4a53-9d0e-2f6a8b7c1e44";
    let s = Script::default();
    s.reply(200, session("acc", "ref", 900))
        .reply(200, task_json(id, ""))
        .reply(200, task_json(id, "Call Bo"))
        .reply(200, json!({ "ok": true }))
        .reply(404, json!({ "error": "Task not found" }));
    let c = client(&s);
    c.login("a@b.c", "pw").unwrap();
    let new = nv_api::NewTask {
        id: Some(id.into()),
        page_id: Some("p1".into()),
        ..Default::default()
    };
    assert_eq!(c.create_task("w1", &new).unwrap().id, id);
    assert_eq!(c.set_task_title(id, "Call Bo").unwrap().title, "Call Bo");
    c.delete_task(id).unwrap();
    // Gone already: the server's 404 comes back as is (the core treats it as done).
    assert!(matches!(
        c.delete_task(id),
        Err(ApiError::Http { status: 404, .. })
    ));

    let seen = s.seen();
    let calls: Vec<_> = seen.iter().map(|r| (r.method, r.url.as_str())).collect();
    assert_eq!(
        calls[1..],
        [
            ("POST", "http://localhost:4417/api/workspaces/w1/tasks"),
            ("PATCH", &*format!("http://localhost:4417/api/tasks/{id}")),
            ("DELETE", &*format!("http://localhost:4417/api/tasks/{id}")),
            ("DELETE", &*format!("http://localhost:4417/api/tasks/{id}")),
        ]
    );
    // Only the fields that are set, under the server's names (an empty title is allowed).
    let body: serde_json::Value = serde_json::from_str(seen[1].body.as_deref().unwrap()).unwrap();
    assert_eq!(body, json!({ "id": id, "title": "", "pageId": "p1" }));
    assert_eq!(seen[2].body.as_deref(), Some(r#"{"title":"Call Bo"}"#));
    assert_eq!(seen[3].body, None);
    assert_eq!(seen[3].bearer.as_deref(), Some("acc"));
    // A NewTask reads back from its JSON (the core keeps queued creates that way).
    let back: nv_api::NewTask = serde_json::from_value(body).unwrap();
    assert_eq!(back, new);
}
