//! Inbox, share link and account deletion against a scripted transport.

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

#[test]
fn inbox_list_paging_and_read() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "unread": 2, "items": [
            { "id": "n1", "kind": "mention", "workspaceId": "w1", "actorId": "u2", "title": "Sam mentioned you",
              "body": "hi", "link": "/w/w1/p/p1", "data": { "pageId": "p1" },
              "createdAt": "2026-11-24T10:00:00.000Z", "readAt": null } ] }),
    );
    let l = c
        .notifications(Some(10), Some("2026-11-25T00:00:00.000Z"))
        .unwrap();
    assert_eq!(
        s.last().1,
        "/notifications?limit=10&before=2026-11-25T00%3A00%3A00.000Z"
    );
    assert_eq!(l.unread, 2);
    assert_eq!(l.items[0].kind, "mention");
    assert_eq!(l.items[0].data.as_ref().unwrap()["pageId"], "p1");

    s.reply(200, json!({ "items": [], "unread": 0 }));
    c.notifications(None, None).unwrap();
    assert_eq!(s.last().1, "/notifications");

    s.reply(200, json!({ "ok": true }));
    c.mark_notification_read("n 1").unwrap();
    assert_eq!(s.last().0, "POST");
    assert_eq!(s.last().1, "/notifications/n%201/read");
    s.reply(200, json!({ "ok": true }));
    c.mark_all_notifications_read().unwrap();
    assert_eq!(s.last().1, "/notifications/read-all");
}

#[test]
fn share_link_get_create_delete() {
    let (c, s) = client();
    s.reply(200, json!({ "url": null }));
    assert_eq!(c.page_link("p1").unwrap(), None);
    assert_eq!(
        (s.last().0.as_str(), s.last().1.as_str()),
        ("GET", "/pages/p1/link")
    );
    s.reply(200, json!({ "url": "https://x.test/s/tok" }));
    assert_eq!(c.create_page_link("p1").unwrap(), "https://x.test/s/tok");
    assert_eq!(s.last().0, "PUT");
    s.reply(200, json!({ "url": null }));
    c.delete_page_link("p1").unwrap();
    assert_eq!(s.last().0, "DELETE");
    s.reply(
        409,
        json!({ "error": "Locked pages can’t be shared by link" }),
    );
    match c.create_page_link("p1") {
        Err(ApiError::Http { status: 409, .. }) => {}
        e => panic!("{e:?}"),
    }
}

#[test]
fn account_deletion_preview_and_delete() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "deletedWorkspaces": [{ "id": "w1", "name": "Mine" }],
                "transferredWorkspaces": [{ "id": "w2", "name": "Team", "newOwnerName": "Sam" }],
                "sharedOwnership": [], "leftWorkspaces": [{ "id": "w3", "name": "Other" }],
                "privateNotebooks": 3 }),
    );
    let p = c.account_deletion_preview().unwrap();
    assert_eq!(s.last().1, "/auth/account/deletion-preview");
    assert_eq!(p.transferred_workspaces[0].new_owner_name, "Sam");
    assert_eq!(p.private_notebooks, 3);

    // A wrong password: 401 gets one refresh and a retry, then the coded refusal.
    s.reply(401, json!({ "error": "Incorrect password" }));
    s.reply(
        200,
        json!({ "accessToken": "acc2", "expiresIn": 900, "refreshToken": "ref2",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
    );
    s.reply(401, json!({ "error": "Incorrect password" }));
    match c.delete_account("nope") {
        Err(ApiError::Http {
            status: 401, code, ..
        }) => {
            assert_eq!(code.as_deref(), Some("wrong_password"))
        }
        e => panic!("{e:?}"),
    }
    assert_eq!(
        s.last(),
        (
            "DELETE".into(),
            "/auth/account".into(),
            json!({ "password": "nope" })
        )
    );

    s.reply(200, json!({ "ok": true }));
    c.delete_account("pw").unwrap();
    assert_eq!(s.last().2, json!({ "password": "pw" }));
}
