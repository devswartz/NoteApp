//! Tree management calls of the client against a scripted transport: what is sent (method, path,
//! body) and how the answers are read.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_api::{ApiError, Client, Request, Response, Transport, TrashKind};
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
    /// The last request as (method, path, body).
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
fn the_tree_reads_trashed_pages_and_older_servers_lack_them() {
    let s = Script::default();
    let c = signed_in(&s);
    s.reply(
        200,
        json!({ "notebooks": [], "sections": [], "pages": [],
                "trashedPages": [{ "id": "p9", "title": "Old plan" }] }),
    );
    let t = c.tree("w1").unwrap();
    assert_eq!(t.trashed_pages.len(), 1);
    assert_eq!(t.trashed_pages[0].id, "p9");
    assert_eq!(t.trashed_pages[0].title, "Old plan");
    s.reply(200, json!({ "notebooks": [], "sections": [], "pages": [] }));
    assert!(c.tree("w1").unwrap().trashed_pages.is_empty());
}

#[test]
fn notebooks_create_patch_move_and_delete() {
    let s = Script::default();
    let c = signed_in(&s);

    s.reply(200, json!({ "id": "n1", "sectionId": "s1" }));
    let nb = c
        .create_notebook("w 1", "Work", Some("#4f46e5"), Some("private"))
        .unwrap();
    assert_eq!((nb.id.as_str(), nb.section_id.as_str()), ("n1", "s1"));
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/workspaces/w%201/notebooks".into(),
            json!({ "name": "Work", "color": "#4f46e5", "visibility": "private" })
        )
    );
    // No colour or visibility: the server picks them, so they are not sent.
    s.reply(200, json!({ "id": "n2", "sectionId": "s2" }));
    c.create_notebook("w1", "Home", None, None).unwrap();
    assert_eq!(s.last().2, json!({ "name": "Home" }));

    s.reply(200, json!({ "ok": true, "removedPageShares": 2 }));
    assert_eq!(
        c.patch_notebook("n1", &json!({ "visibility": "private" }))
            .unwrap(),
        2
    );
    assert_eq!(
        s.last(),
        (
            "PATCH".into(),
            "/notebooks/n1".into(),
            json!({ "visibility": "private" })
        )
    );
    s.reply(200, json!({ "ok": true }));
    assert_eq!(c.patch_notebook("n1", &json!({ "name": "W" })).unwrap(), 0);

    s.reply(200, json!({ "ok": true, "position": 1.5 }));
    assert_eq!(c.move_notebook("n1", Some(1)).unwrap(), 1.5);
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/notebooks/n1/move".into(),
            json!({ "index": 1 })
        )
    );
    s.reply(200, json!({ "ok": true, "position": 9.0 }));
    c.move_notebook("n1", None).unwrap();
    assert_eq!(s.last().2, json!({}));

    s.reply(200, json!({ "ok": true, "trashId": "n1", "tasks": 3 }));
    let t = c.delete_notebook("n1").unwrap();
    assert_eq!((t.trash_id.as_str(), t.tasks), ("n1", 3));
    assert_eq!(s.last().0, "DELETE");
    assert_eq!(s.last().1, "/notebooks/n1");
}

#[test]
fn sections_create_patch_move_copy_and_delete() {
    let s = Script::default();
    let c = signed_in(&s);

    s.reply(200, json!({ "id": "s1" }));
    assert_eq!(c.create_section("n1", None, "Ideas", None).unwrap(), "s1");
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/notebooks/n1/sections".into(),
            json!({ "name": "Ideas" })
        )
    );
    s.reply(200, json!({ "id": "s2" }));
    c.create_section("n1", Some("s1"), "Sub", Some("#112233"))
        .unwrap();
    assert_eq!(
        s.last().2,
        json!({ "name": "Sub", "parentId": "s1", "color": "#112233" })
    );

    s.reply(200, json!({ "ok": true }));
    c.patch_section("s1", &json!({ "name": "Plans" })).unwrap();
    assert_eq!(
        s.last(),
        (
            "PATCH".into(),
            "/sections/s1".into(),
            json!({ "name": "Plans" })
        )
    );

    // A move always says where: a null parent puts the section at the top level.
    s.reply(
        200,
        json!({ "ok": true, "notebookId": "n2", "parentId": null, "position": 3.0 }),
    );
    let m = c.move_section("s1", "n2", None, Some(2)).unwrap();
    assert_eq!(m.notebook_id, "n2");
    assert_eq!(m.parent_id, None);
    assert_eq!(m.position, 3.0);
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/sections/s1/move".into(),
            json!({ "index": 2, "notebookId": "n2", "parentId": null })
        )
    );
    s.reply(
        200,
        json!({ "ok": true, "notebookId": "n1", "parentId": "s9", "position": 1.0 }),
    );
    let m = c.move_section("s1", "n1", Some("s9"), None).unwrap();
    assert_eq!(m.parent_id.as_deref(), Some("s9"));
    assert_eq!(s.last().2, json!({ "notebookId": "n1", "parentId": "s9" }));

    s.reply(200, json!({ "id": "s3" }));
    assert_eq!(c.copy_section("s1", None, None).unwrap(), "s3");
    assert_eq!(
        s.last(),
        ("POST".into(), "/sections/s1/copy".into(), json!({}))
    );
    s.reply(200, json!({ "id": "s4" }));
    c.copy_section("s1", Some("n2"), Some("Mine")).unwrap();
    assert_eq!(s.last().2, json!({ "notebookId": "n2", "name": "Mine" }));

    s.reply(200, json!({ "ok": true, "trashId": "s1", "tasks": 0 }));
    assert_eq!(c.delete_section("s1").unwrap().trash_id, "s1");
    assert_eq!(s.last().0, "DELETE");
    assert_eq!(s.last().1, "/sections/s1");
}

#[test]
fn pages_create_patch_move_copy_and_delete() {
    let s = Script::default();
    let c = signed_in(&s);

    s.reply(200, json!({ "id": "p1", "pendingTemplate": null }));
    assert_eq!(c.create_page("s1", "").unwrap(), "p1");
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/sections/s1/pages".into(),
            json!({ "title": "" })
        )
    );

    s.reply(200, json!({ "ok": true }));
    c.patch_page("p1", &json!({ "title": "Plan" })).unwrap();
    assert_eq!(
        s.last(),
        (
            "PATCH".into(),
            "/pages/p1".into(),
            json!({ "title": "Plan" })
        )
    );
    s.reply(200, json!({ "ok": true }));
    c.patch_page("p1", &json!({ "icon": null })).unwrap();
    assert_eq!(s.last().2, json!({ "icon": null }));

    s.reply(
        200,
        json!({ "ok": true, "sectionId": "s2", "position": 0.5 }),
    );
    let m = c.move_page("p1", Some("s2"), Some(0)).unwrap();
    assert_eq!((m.section_id.as_str(), m.position), ("s2", 0.5));
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/pages/p1/move".into(),
            json!({ "index": 0, "sectionId": "s2" })
        )
    );
    s.reply(
        200,
        json!({ "ok": true, "sectionId": "s1", "position": 4.0 }),
    );
    c.move_page("p1", None, None).unwrap();
    assert_eq!(s.last().2, json!({}));

    s.reply(200, json!({ "id": "p2" }));
    assert_eq!(c.copy_page("p1", None, None).unwrap(), "p2");
    assert_eq!(
        s.last(),
        ("POST".into(), "/pages/p1/copy".into(), json!({}))
    );
    s.reply(200, json!({ "id": "p3" }));
    c.copy_page("p1", Some("s2"), Some("Copy")).unwrap();
    assert_eq!(s.last().2, json!({ "sectionId": "s2", "title": "Copy" }));

    s.reply(200, json!({ "ok": true, "trashId": "p1", "tasks": 1 }));
    let t = c.delete_page("p1").unwrap();
    assert_eq!((t.trash_id.as_str(), t.tasks), ("p1", 1));
    assert_eq!(s.last().1, "/pages/p1");
}

#[test]
fn the_trash_lists_restores_deletes_and_empties() {
    let s = Script::default();
    let c = signed_in(&s);

    s.reply(
        200,
        json!([
            { "kind": "page", "id": "p1", "name": "Plan", "icon": "x", "deletedAt": "2026-11-20T10:00:00.000Z",
              "deletedBy": "u1", "deletedByName": "Ann", "expiresAt": "2027-01-19T10:00:00.000Z", "daysLeft": 58,
              "path": "Work > Ideas", "pages": 0, "sections": 0 },
            { "kind": "notebook", "id": "n1", "name": "Old", "icon": null, "deletedAt": "2026-11-19T10:00:00.000Z",
              "deletedBy": null, "deletedByName": null, "expiresAt": "2027-01-18T10:00:00.000Z", "daysLeft": 57,
              "path": "", "pages": 4, "sections": 2 }
        ]),
    );
    let items = c.trash("w1").unwrap();
    assert_eq!(s.last().1, "/workspaces/w1/trash");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].kind, TrashKind::Page);
    assert_eq!(items[0].icon.as_deref(), Some("x"));
    assert_eq!(items[0].deleted_by_name.as_deref(), Some("Ann"));
    assert_eq!(items[0].days_left, 58);
    assert_eq!(items[1].kind, TrashKind::Notebook);
    assert_eq!((items[1].pages, items[1].sections), (4, 2));
    assert_eq!(items[1].deleted_by, None);

    s.reply(200, json!({ "movedTo": "General" }));
    assert_eq!(
        c.restore_from_trash(TrashKind::Section, "s1")
            .unwrap()
            .moved_to,
        "General"
    );
    assert_eq!(
        s.last(),
        ("POST".into(), "/trash/section/s1/restore".into(), json!({}))
    );

    s.reply(200, json!({ "ok": true }));
    c.purge_from_trash(TrashKind::Page, "p1").unwrap();
    assert_eq!(s.last().0, "DELETE");
    assert_eq!(s.last().1, "/trash/page/p1");

    s.reply(200, json!({ "removed": 5 }));
    assert_eq!(c.empty_trash("w1").unwrap(), 5);
    assert_eq!(s.last().0, "DELETE");
    assert_eq!(s.last().1, "/workspaces/w1/trash");
}

#[test]
fn refusals_and_a_lost_connection_come_back_unchanged() {
    let s = Script::default();
    let c = signed_in(&s);
    s.reply(
        400,
        json!({ "error": "Cannot move between workspaces", "code": "x" }),
    );
    match c.move_page("p1", Some("other"), None) {
        Err(ApiError::Http {
            status, message, ..
        }) => {
            assert_eq!(status, 400);
            assert_eq!(message, "Cannot move between workspaces");
        }
        r => panic!("{r:?}"),
    }
    // A write is sent once: a lost connection is a Network error, never a second send.
    s.replies
        .lock()
        .unwrap()
        .push_back(Err("connection refused".into()));
    let before = s.seen.lock().unwrap().len();
    assert!(matches!(
        c.create_page("s1", "x"),
        Err(ApiError::Network(_))
    ));
    assert_eq!(s.seen.lock().unwrap().len(), before + 1);
}
