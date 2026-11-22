//! Search and comment calls of the client against a scripted transport.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_api::{ApiError, Client, Request, Response, Transport};
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
            .unwrap_or_else(|| panic!("an unscripted request: {} {}", req.method, req.url))
    }
}

fn signed_in(s: &Script) -> Client {
    s.reply(
        200,
        json!({ "accessToken": "acc1", "expiresIn": 900, "refreshToken": "ref1",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
    );
    let c = Client::with_transport("http://localhost:4417/", Box::new(s.clone()));
    c.login("a@b.c", "pw").unwrap();
    c
}

#[test]
fn search_sends_the_query_and_reads_pages_and_tasks() {
    let s = Script::default();
    let c = signed_in(&s);
    s.reply(
        200,
        json!({
            "pages": [{ "id": "p1", "title": "Q4 plan", "icon": null, "snippet": "the \u{ab}plan\u{bb} for Q4",
                        "notebookName": "Work", "sectionName": "Roadmap", "path": "Work \u{203a} Roadmap" }],
            "tasks": [{ "id": "t1", "workspaceId": "w1", "title": "Plan it", "status": "open", "priority": 4,
                        "createdBy": "u1", "createdAt": "2026-11-01", "updatedAt": "2026-11-02",
                        "snippet": "write the \u{ab}plan\u{bb}" },
                      { "id": "t2", "workspaceId": "w1", "title": "Plans", "status": "done", "priority": 4,
                        "createdBy": "u1", "createdAt": "2026-11-01", "updatedAt": "2026-11-02" }]
        }),
    );
    let r = c.search("w 1", "plan b&c", Some(5)).unwrap();
    assert_eq!(r.pages[0].snippet, "the \u{ab}plan\u{bb} for Q4");
    assert_eq!(r.pages[0].path, "Work \u{203a} Roadmap");
    assert_eq!(r.tasks[0].task.title, "Plan it");
    assert_eq!(
        r.tasks[0].snippet.as_deref(),
        Some("write the \u{ab}plan\u{bb}")
    );
    assert_eq!(r.tasks[1].snippet, None);
    assert_eq!(
        s.seen()[1].url,
        "http://localhost:4417/api/workspaces/w%201/search?q=plan%20b%26c&limit=5"
    );
}

#[test]
fn search_without_a_limit_and_with_a_network_error() {
    let s = Script::default();
    let c = signed_in(&s);
    s.reply(200, json!({ "pages": [], "tasks": [] }));
    assert!(c.search("w1", "x", None).unwrap().pages.is_empty());
    assert_eq!(
        s.seen()[1].url,
        "http://localhost:4417/api/workspaces/w1/search?q=x"
    );
    s.fail().fail().fail();
    assert!(matches!(
        c.search("w1", "x", None),
        Err(ApiError::Network(_))
    ));
}

fn thread(resolved: bool) -> Value {
    json!({ "id": "th1", "pageId": "p1", "workspaceId": "w1", "quote": "hello", "createdBy": "u1",
            "createdAt": "2026-11-01T10:00:00.000Z",
            "resolvedAt": if resolved { json!("2026-11-02T10:00:00.000Z") } else { json!(null) },
            "resolvedBy": if resolved { json!("u2") } else { json!(null) },
            "comments": [{ "id": "c1", "threadId": "th1", "authorId": "u1", "body": "First",
                           "createdAt": "2026-11-01T10:00:00.000Z", "editedAt": null }] })
}

#[test]
fn comment_calls_use_the_servers_routes_and_bodies() {
    let s = Script::default();
    let c = signed_in(&s);
    s.reply(200, json!([thread(false)]))
        .reply(200, thread(false))
        .reply(200, thread(false))
        .reply(200, thread(true))
        .reply(200, thread(false))
        .reply(200, thread(false))
        .reply(200, json!({ "ok": true, "threadDeleted": true }))
        .reply(200, json!({ "ok": true }));
    let list = c.page_comments("p1").unwrap();
    assert_eq!(list[0].comments[0].body, "First");
    assert_eq!(list[0].resolved_at, None);
    c.add_comment_thread("p1", "th1", "hello", "First").unwrap();
    c.reply_to_thread("th1", "Yes").unwrap();
    assert_eq!(
        c.set_thread_resolved("th1", true)
            .unwrap()
            .resolved_by
            .as_deref(),
        Some("u2")
    );
    c.set_thread_resolved("th1", false).unwrap();
    c.edit_comment("c1", "Edited").unwrap();
    assert!(c.delete_comment("c1").unwrap());
    c.delete_comment_thread("th1").unwrap();
    let seen: Vec<(&str, String, Option<Value>)> = s
        .seen()
        .iter()
        .skip(1)
        .map(|r| {
            (
                r.method,
                r.url.replace("http://localhost:4417/api", ""),
                r.body.as_deref().map(|b| serde_json::from_str(b).unwrap()),
            )
        })
        .collect();
    let expect: Vec<(&str, &str, Option<Value>)> = vec![
        ("GET", "/pages/p1/comments", None),
        (
            "POST",
            "/pages/p1/comments",
            Some(json!({ "threadId": "th1", "quote": "hello", "body": "First" })),
        ),
        (
            "POST",
            "/comment-threads/th1/replies",
            Some(json!({ "body": "Yes" })),
        ),
        (
            "PATCH",
            "/comment-threads/th1",
            Some(json!({ "resolved": true })),
        ),
        (
            "PATCH",
            "/comment-threads/th1",
            Some(json!({ "resolved": false })),
        ),
        ("PATCH", "/comments/c1", Some(json!({ "body": "Edited" }))),
        ("DELETE", "/comments/c1", None),
        ("DELETE", "/comment-threads/th1", None),
    ];
    assert_eq!(seen.len(), expect.len());
    for (got, want) in seen.iter().zip(&expect) {
        assert_eq!((got.0, got.1.as_str(), &got.2), (want.0, want.1, &want.2));
    }
}

#[test]
fn a_viewer_cannot_comment() {
    let s = Script::default();
    let c = signed_in(&s);
    s.reply(403, json!({ "error": "You have view-only access" }));
    match c.add_comment_thread("p1", "th1", "", "Hi") {
        Err(ApiError::Http {
            status, message, ..
        }) => {
            assert_eq!(
                (status, message.as_str()),
                (403, "You have view-only access")
            );
        }
        other => panic!("{other:?}"),
    }
}
