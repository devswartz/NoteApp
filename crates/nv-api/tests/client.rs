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

#[test]
fn reads_every_task_field_and_tolerates_missing_and_unknown_ones() {
    let full = json!({
        "id": "t1", "workspaceId": "w1", "title": "Ship", "description": "Notes", "status": "done", "priority": 2,
        "dueDate": "2026-12-01", "dueTime": "09:30",
        "recurrence": { "freq": "week", "interval": 2, "byWeekday": [1, 4], "until": "2027-01-01", "basis": "completion" },
        "reminderAt": "2026-12-01T08:00:00.000Z", "assigneeId": "u2", "assignedBy": "u1", "createdBy": "u1",
        "pageId": "p1", "parentId": "t0", "teamId": "tm1", "tagIds": ["g1", "g2"],
        "checklist": { "done": 1, "total": 3 }, "completedAt": "2026-11-30T10:00:00.000Z", "completedBy": "u2",
        "createdAt": "2026-11-01T00:00:00Z", "updatedAt": "2026-11-02T00:00:00Z", "locked": true, "newerField": [1],
    });
    let t: nv_api::Task = serde_json::from_value(full).unwrap();
    assert_eq!(
        (
            t.assigned_by.as_deref(),
            t.completed_by.as_deref(),
            t.team_id.as_deref()
        ),
        (Some("u1"), Some("u2"), Some("tm1"))
    );
    let r = t.recurrence.clone().unwrap();
    assert_eq!(
        (
            r.freq.as_str(),
            r.interval,
            r.by_weekday.clone(),
            r.basis.as_deref()
        ),
        ("week", Some(2), Some(vec![1, 4]), Some("completion"))
    );
    // It goes out the way it came (the store keeps tasks as JSON).
    let back: nv_api::Task = serde_json::from_value(serde_json::to_value(&t).unwrap()).unwrap();
    assert_eq!(back, t);

    // An older server: only the ids and the title. A rule this core can't read is none.
    let bare: nv_api::Task =
        serde_json::from_value(json!({ "id": "t2", "title": "x", "recurrence": { "freq": 7 } }))
            .unwrap();
    assert_eq!(
        (bare.status.as_str(), bare.priority, bare.recurrence),
        ("open", 4, None)
    );
    assert!(bare.tag_ids.is_empty() && bare.description.is_empty() && !bare.locked);
}

#[test]
fn a_task_patch_sends_set_fields_and_null_for_cleared_ones() {
    let rule = nv_api::Recurrence {
        freq: "month".into(),
        interval: Some(1),
        by_month_day: Some(-1),
        ..Default::default()
    };
    let patch = nv_api::TaskPatch {
        title: Some("T".into()),
        description: Some(String::new()),
        status: Some("done".into()),
        priority: Some(1),
        due_date: Some(None),
        due_time: Some(Some("08:05".into())),
        recurrence: Some(Some(rule)),
        reminder_at: Some(None),
        assignee_id: Some(Some("u2".into())),
        page_id: Some(None),
        parent_id: Some(Some("t0".into())),
        team_id: Some(None),
        tag_ids: Some(vec![]),
    };
    assert_eq!(
        patch.to_value(),
        json!({
            "title": "T", "description": "", "status": "done", "priority": 1, "dueDate": null, "dueTime": "08:05",
            "recurrence": { "freq": "month", "interval": 1, "byMonthDay": -1 }, "reminderAt": null,
            "assigneeId": "u2", "pageId": null, "parentId": "t0", "teamId": null, "tagIds": []
        })
    );
    assert_eq!(nv_api::TaskPatch::default().to_value(), json!({}));
    assert!(nv_api::TaskPatch::default().is_empty() && !patch.is_empty());
    // Only what is set.
    let only = nv_api::TaskPatch {
        recurrence: Some(None),
        ..Default::default()
    };
    assert_eq!(only.to_value(), json!({ "recurrence": null }));
}

#[test]
fn task_detail_endpoints_tags_teams_members_reminders_notes() {
    let s = Script::default();
    s.reply(200, session("acc", "ref", 900))
        .reply(200, task_json("t1", "A"))
        .reply(200, json!([{ "id": "g1", "workspaceId": "w1", "name": "waiting", "color": "#10b981", "createdBy": "u1", "createdAt": "x" }]))
        .reply(200, json!({ "id": "g2", "workspaceId": "w1", "name": "budget", "color": "#ef4444", "createdBy": "u1", "createdAt": "x" }))
        .reply(200, json!([{ "id": "tm1", "workspaceId": "w1", "parentId": null, "name": "Elders", "color": "#6366f1", "position": 1, "memberIds": ["u1"] }]))
        .reply(200, json!({ "members": [{ "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "role": "owner" }], "invites": [] }))
        .reply(200, json!([
            { "id": "r1", "taskId": "t1", "userId": "u1", "kind": "before", "minutes": 30, "nextFireAt": "2026-12-01T09:00:00.000Z", "lastFiredAt": null, "createdAt": "x" },
            { "id": "r2", "taskId": "t1", "userId": "u1", "kind": "at", "at": "2026-12-01T07:00:00.000Z", "nextFireAt": null, "lastFiredAt": null, "createdAt": "x" }
        ]))
        .reply(200, json!({ "id": "r3", "taskId": "t1", "userId": "u1", "kind": "at", "at": "2026-12-02T07:00:00.000Z", "nextFireAt": "2026-12-02T07:00:00.000Z", "lastFiredAt": null, "createdAt": "x" }))
        .reply(200, json!({ "id": "r3", "taskId": "t1", "userId": "u1", "kind": "before", "minutes": 5, "nextFireAt": null, "lastFiredAt": null, "createdAt": "x" }))
        .reply(200, json!({ "ok": true }))
        .reply(200, json!({ "markdown": "- [ ] one\n- [x] two" }))
        .reply(200, json!([task_json("t9", "Old")]));
    let c = client(&s);
    c.login("a@b.c", "pw").unwrap();
    let patch = nv_api::TaskPatch {
        due_date: Some(None),
        priority: Some(2),
        ..Default::default()
    };
    c.patch_task("t1", &patch).unwrap();
    assert_eq!(c.tags("w1").unwrap()[0].name, "waiting");
    assert_eq!(
        c.create_tag("w1", "#budget", Some("#ef4444")).unwrap().id,
        "g2"
    );
    assert_eq!(c.teams("w1").unwrap()[0].member_ids, ["u1"]);
    assert_eq!(c.members("w1").unwrap()[0].role, "owner");
    let rs = c.reminders("t1").unwrap();
    assert_eq!(
        (rs[0].spec.clone(), rs[1].spec.clone()),
        (
            nv_api::ReminderSpec::Before { minutes: 30 },
            nv_api::ReminderSpec::At {
                at: "2026-12-01T07:00:00.000Z".into()
            }
        )
    );
    c.add_reminder(
        "t1",
        &nv_api::ReminderSpec::At {
            at: "2026-12-02T07:00:00.000Z".into(),
        },
    )
    .unwrap();
    let r = c
        .update_reminder("r3", &nv_api::ReminderSpec::Before { minutes: 5 })
        .unwrap();
    assert_eq!(r.spec, nv_api::ReminderSpec::Before { minutes: 5 });
    c.delete_reminder("r3").unwrap();
    assert_eq!(c.task_notes("t1").unwrap(), "- [ ] one\n- [x] two");
    assert_eq!(
        c.completed_tasks("w1", Some("2026-11-01T00:00:00.000Z"))
            .unwrap()[0]
            .id,
        "t9"
    );

    let seen = s.seen();
    let calls: Vec<_> = seen[1..]
        .iter()
        .map(|r| {
            format!(
                "{} {}",
                r.method,
                r.url.replace("http://localhost:4417/api", "")
            )
        })
        .collect();
    assert_eq!(
        calls,
        [
            "PATCH /tasks/t1",
            "GET /workspaces/w1/tags",
            "POST /workspaces/w1/tags",
            "GET /workspaces/w1/teams",
            "GET /workspaces/w1/members",
            "GET /tasks/t1/reminders",
            "POST /tasks/t1/reminders",
            "PATCH /reminders/r3",
            "DELETE /reminders/r3",
            "GET /tasks/t1/notes",
            "GET /workspaces/w1/tasks/completed?before=2026-11-01T00%3A00%3A00.000Z",
        ]
    );
    assert_eq!(
        seen[1].body.as_deref(),
        Some(r#"{"dueDate":null,"priority":2}"#)
    );
    let body = |i: usize| -> serde_json::Value {
        serde_json::from_str(seen[i].body.as_deref().unwrap()).unwrap()
    };
    assert_eq!(body(3), json!({ "name": "#budget", "color": "#ef4444" }));
    assert_eq!(
        body(7),
        json!({ "kind": "at", "at": "2026-12-02T07:00:00.000Z" })
    );
    assert_eq!(body(8), json!({ "kind": "before", "minutes": 5 }));
}
