//! Saved task views and backlinks against a scripted transport.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_api::{Client, Request, Response, Transport};
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
    fn last(&self) -> (String, String, Value) {
        let r = self.seen.lock().unwrap().last().unwrap().clone();
        (
            r.method.to_string(),
            r.url.trim_start_matches("http://localhost:4417/api").into(),
            r.body
                .map(|b| serde_json::from_str(&b).unwrap())
                .unwrap_or(Value::Null),
        )
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

fn client() -> (Client, Script) {
    let s = Script::default();
    s.reply(
        200,
        json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
    );
    let c = Client::with_transport("http://localhost:4417", Box::new(s.clone()));
    c.login("a@b.c", "pw").unwrap();
    (c, s)
}

fn view() -> Value {
    json!({ "id": "v1", "workspaceId": "w1", "ownerId": "u1", "shared": false, "name": "Due soon",
            "query": { "filters": { "due": "week" }, "sort": "due", "group": "none" },
            "position": 1, "createdAt": "2026-11-25T00:00:00Z" })
}

#[test]
fn saved_views_round_trip() {
    let (c, s) = client();
    s.reply(200, json!([view()]));
    let v = c.task_views("w 1").unwrap();
    assert_eq!(v[0].name, "Due soon");
    assert_eq!(v[0].query["filters"]["due"], "week");
    assert_eq!(s.last().0, "GET");
    assert_eq!(s.last().1, "/workspaces/w%201/task-views");

    s.reply(200, view());
    let q = json!({ "filters": {}, "sort": "due", "group": "none" });
    c.create_task_view("w1", "Due soon", &q, true).unwrap();
    let (m, p, b) = s.last();
    assert_eq!(
        (m.as_str(), p.as_str()),
        ("POST", "/workspaces/w1/task-views")
    );
    assert_eq!(b, json!({ "name": "Due soon", "query": q, "shared": true }));

    s.reply(200, view());
    c.update_task_view("v1", Some("New"), None, Some(false), Some(2.0))
        .unwrap();
    let (m, p, b) = s.last();
    assert_eq!((m.as_str(), p.as_str()), ("PATCH", "/task-views/v1"));
    assert_eq!(
        b,
        json!({ "name": "New", "shared": false, "position": 2.0 })
    );

    s.reply(200, json!({ "ok": true }));
    c.delete_task_view("v1").unwrap();
    assert_eq!(s.last().0, "DELETE");
}

#[test]
fn backlinks_are_read() {
    let (c, s) = client();
    s.reply(
        200,
        json!([{ "id": "p2", "title": "Other", "icon": null, "sectionName": "Notes",
                 "notebookName": "Work", "updatedAt": "2026-11-25T00:00:00Z" }]),
    );
    let b = c.backlinks("p1").unwrap();
    assert_eq!(
        (b[0].id.as_str(), b[0].section_name.as_str()),
        ("p2", "Notes")
    );
    assert_eq!(s.last().1, "/pages/p1/backlinks");
}
