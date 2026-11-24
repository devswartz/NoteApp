//! Templates, push devices and snooze against a scripted transport.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_api::{ApiError, Client, Request, Response, TemplateSection, Transport};
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

fn meta() -> Value {
    json!({ "id": "t1", "workspaceId": "w1", "name": "Weekly", "icon": "x", "visibility": "workspace",
            "kind": "canvas", "createdBy": "u1", "createdAt": "2026-11-24T10:00:00.000Z",
            "updatedAt": "2026-11-24T10:00:00.000Z", "taskCount": 2, "fileCount": 0,
            "canManage": true, "scoped": true,
            "sections": [{ "sectionId": "s1", "includeSubsections": false }] })
}

#[test]
fn template_calls() {
    let (c, s) = client();
    s.reply(200, json!([meta()]));
    let t = c.templates("w1").unwrap();
    assert_eq!(s.last().1, "/workspaces/w1/templates");
    assert_eq!(t[0].name, "Weekly");
    assert!(!t[0].sections[0].include_subsections);

    s.reply(200, meta());
    let secs = [TemplateSection {
        section_id: "s1".into(),
        include_subsections: true,
    }];
    c.save_page_as_template(
        "p1",
        "Weekly",
        Some("x"),
        &json!({"type":"doc"}),
        "canvas",
        Some(&secs),
    )
    .unwrap();
    let (m, p, b) = s.last();
    assert_eq!((m.as_str(), p.as_str()), ("POST", "/pages/p1/templates"));
    assert_eq!(b["name"], "Weekly");
    assert_eq!(b["kind"], "canvas");
    assert_eq!(b["sections"][0]["sectionId"], "s1");
    assert_eq!(b["content"]["type"], "doc");

    s.reply(200, meta());
    c.update_template("t1", Some("New"), None, None).unwrap();
    let (m, p, b) = s.last();
    assert_eq!((m.as_str(), p.as_str()), ("PATCH", "/templates/t1"));
    assert_eq!(b, json!({ "name": "New" }));

    s.reply(200, json!({ "ok": true }));
    c.delete_template("t1").unwrap();
    assert_eq!(s.last().0, "DELETE");

    s.reply(
        200,
        json!({ "title": "Weekly", "icon": null, "kind": "canvas",
                         "content": { "type": "doc", "content": [] }, "taskIds": ["a", "b"] }),
    );
    let u = c.use_template("t1", "p1").unwrap();
    assert_eq!(s.last().2, json!({ "pageId": "p1" }));
    assert_eq!(u.task_ids, ["a", "b"]);
    assert_eq!(u.template_id, None);

    for (arg, want) in [
        (None, Value::Null),
        (Some("none"), json!("none")),
        (Some("t1"), json!("t1")),
    ] {
        s.reply(200, json!({ "ok": true }));
        c.set_section_default_template("s1", arg).unwrap();
        let (m, p, b) = s.last();
        assert_eq!(
            (m.as_str(), p.as_str()),
            ("PUT", "/sections/s1/default-template")
        );
        assert_eq!(b["templateId"], want);
    }

    s.reply(
        200,
        json!({ "id": "p9", "pendingTemplate": { "id": "t1", "name": "Weekly" } }),
    );
    let r = c
        .create_page_from_template("s1", "", Some("default"))
        .unwrap();
    assert_eq!(s.last().2, json!({ "title": "", "template": "default" }));
    assert_eq!(r.pending_template.unwrap().name, "Weekly");

    s.reply(200, Value::Null);
    assert!(c.claim_pending_template("p9", false).unwrap().is_none());
    s.reply(
        200,
        json!({ "templateId": "t1", "name": "Weekly", "title": "Weekly", "icon": null,
                         "kind": "canvas", "content": { "type": "doc" }, "taskIds": [] }),
    );
    let u = c.claim_pending_template("p9", true).unwrap().unwrap();
    assert_eq!(s.last().2, json!({ "discard": true }));
    assert_eq!(u.template_id.as_deref(), Some("t1"));
}

#[test]
fn push_devices_and_snooze() {
    let (c, s) = client();
    s.reply(200, json!({ "ok": true }));
    c.register_device("ios", "abcdef0123456789abcdef").unwrap();
    let (m, p, b) = s.last();
    assert_eq!((m.as_str(), p.as_str()), ("POST", "/notifications/devices"));
    assert_eq!(
        b,
        json!({ "platform": "ios", "token": "abcdef0123456789abcdef" })
    );

    s.reply(200, json!({ "ok": true }));
    c.unregister_device("abcdef0123456789abcdef").unwrap();
    let (m, p, b) = s.last();
    assert_eq!(
        (m.as_str(), p.as_str()),
        ("DELETE", "/notifications/devices")
    );
    assert_eq!(b, json!({ "token": "abcdef0123456789abcdef" }));

    s.reply(
        200,
        json!({ "taskId": "k1", "until": "2026-11-24T12:00:00.000Z" }),
    );
    let r = c.snooze_reminder("tok", "1h").unwrap();
    let (m, p, b) = s.last();
    assert_eq!((m.as_str(), p.as_str()), ("POST", "/reminders/snooze"));
    assert_eq!(b, json!({ "token": "tok", "option": "1h" }));
    assert_eq!(r.task_id, "k1");
    assert!(s.seen.lock().unwrap().last().unwrap().bearer.is_none());

    s.reply(404, json!({ "error": "This notification has expired" }));
    assert!(matches!(
        c.snooze_reminder("old", "10m"),
        Err(ApiError::Http { status: 404, .. })
    ));
}
