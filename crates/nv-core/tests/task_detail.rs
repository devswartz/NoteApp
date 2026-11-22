//! The full task model through the Core against a scripted transport: every field read, set and
//! cleared (`update_task`), queued offline like a rename, checked before it is sent, and the
//! lists a task points into (tags, teams, members, reminders, notes).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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

fn full(id: &str) -> Value {
    json!({
        "id": id, "workspaceId": "w1", "title": "Plan the fête", "description": "Bring chairs", "status": "open",
        "priority": 2, "dueDate": "2026-12-01", "dueTime": "09:30",
        "recurrence": { "freq": "week", "interval": 2, "byWeekday": [1, 4], "until": "2027-06-01", "basis": "completion" },
        "reminderAt": "2026-12-01T08:00:00.000Z", "assigneeId": "u2", "assignedBy": "u1", "createdBy": "u1",
        "pageId": "p1", "parentId": null, "teamId": "tm1", "tagIds": ["g1", "g2"],
        "checklist": { "done": 1, "total": 3 }, "completedAt": null, "completedBy": null,
        "createdAt": "2026-11-01T00:00:00.000Z", "updatedAt": "2026-11-02T00:00:00.000Z",
    })
}

fn rule(freq: &str, interval: Option<u32>) -> TaskRecurrence {
    TaskRecurrence {
        freq: freq.into(),
        interval,
        by_weekday: None,
        by_month_day: None,
        by_nth_weekday: None,
        until: None,
        count: None,
        basis: None,
    }
}

#[test]
fn a_task_detail_has_every_field() {
    let (s, dir) = (Script::default(), TempDir::new("read"));
    let core = core(&s, &dir, json!([full(A)]));
    let d = core.cached_task_detail(A.into()).unwrap();
    assert_eq!(
        (d.title.as_str(), d.description.as_str(), d.done, d.priority),
        ("Plan the fête", "Bring chairs", false, 2)
    );
    assert_eq!(
        (
            d.due_date.as_deref(),
            d.due_time.as_deref(),
            d.reminder_at.as_deref()
        ),
        (
            Some("2026-12-01"),
            Some("09:30"),
            Some("2026-12-01T08:00:00.000Z")
        )
    );
    assert_eq!(
        (
            d.assignee_id.as_deref(),
            d.assigned_by.as_deref(),
            d.created_by.as_str(),
            d.team_id.as_deref()
        ),
        (Some("u2"), Some("u1"), "u1", Some("tm1"))
    );
    assert_eq!(
        (d.tag_ids.clone(), d.checklist_done, d.checklist_total),
        (vec!["g1".to_string(), "g2".to_string()], Some(1), Some(3))
    );
    let r = d.recurrence.unwrap();
    assert_eq!(
        (
            r.freq.as_str(),
            r.interval,
            r.by_weekday.clone(),
            r.until.as_deref(),
            r.basis.as_deref()
        ),
        (
            "week",
            Some(2),
            Some(vec![1, 4]),
            Some("2027-06-01"),
            Some("completion")
        )
    );
    // The list form has them too, from the server and from the store.
    s.reply(200, json!([full(A)]));
    assert_eq!(
        core.task_details("w1".into()).unwrap()[0]
            .assigned_by
            .as_deref(),
        Some("u1")
    );
    assert_eq!(
        core.cached_task_details("w1".into()).unwrap()[0].completed_by,
        None
    );
}

#[test]
fn update_task_sends_only_what_is_set_and_null_for_clears() {
    let (s, dir) = (Script::default(), TempDir::new("update"));
    let core = core(&s, &dir, json!([full(A)]));
    let mut after = full(A);
    after["priority"] = json!(1);
    after["dueDate"] = Value::Null;
    after["dueTime"] = Value::Null;
    after["recurrence"] = Value::Null;
    after["tagIds"] = json!([]);
    after["description"] = json!("");
    after["assigneeId"] = Value::Null;
    after["assignedBy"] = Value::Null;
    s.reply(200, after);
    let d = core
        .update_task(
            A.into(),
            TaskChanges {
                priority: Some(1),
                clear_due_date: true,
                clear_due_time: true,
                clear_recurrence: true,
                clear_assignee: true,
                tag_ids: Some(vec![]),
                description: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        s.bodies()[0],
        Some(json!({
            "description": "", "priority": 1, "dueDate": null, "dueTime": null, "recurrence": null,
            "assigneeId": null, "tagIds": []
        }))
    );
    assert_eq!(s.take(), [format!("PATCH /api/tasks/{A}")]);
    assert_eq!(
        (d.priority, d.due_date, d.recurrence, d.assignee_id),
        (1, None, None, None)
    );
    // The stored copy is the server's answer.
    assert_eq!(
        core.cached_task_detail(A.into()).unwrap().tag_ids,
        Vec::<String>::new()
    );

    // Setting every settable field: the body, field by field.
    s.reply(200, full(A));
    core.update_task(
        A.into(),
        TaskChanges {
            title: Some(" New ".into()),
            description: Some("Notes".into()),
            done: Some(true),
            priority: Some(3),
            due_date: Some("2027-01-31".into()),
            due_time: Some("08:05".into()),
            recurrence: Some(TaskRecurrence {
                by_month_day: Some(-1),
                count: Some(5),
                ..rule("month", Some(1))
            }),
            reminder_at: Some("2027-01-30T08:00:00.000Z".into()),
            assignee_id: Some("u2".into()),
            team_id: Some("tm1".into()),
            tag_ids: Some(vec!["g1".into()]),
            page_id: Some("p1".into()),
            parent_id: Some("t0".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        s.bodies()[0],
        Some(json!({
            "title": " New ", "description": "Notes", "status": "done", "priority": 3, "dueDate": "2027-01-31",
            "dueTime": "08:05", "recurrence": { "freq": "month", "interval": 1, "byMonthDay": -1, "count": 5 },
            "reminderAt": "2027-01-30T08:00:00.000Z", "assigneeId": "u2", "pageId": "p1", "parentId": "t0",
            "teamId": "tm1", "tagIds": ["g1"]
        }))
    );
    s.take();

    // The other clears: reminder, team, page, parent; and reopening.
    s.reply(200, full(A));
    core.update_task(
        A.into(),
        TaskChanges {
            clear_reminder_at: true,
            clear_team: true,
            clear_page: true,
            clear_parent: true,
            done: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        s.bodies()[0],
        Some(
            json!({ "status": "open", "reminderAt": null, "pageId": null, "parentId": null, "teamId": null })
        )
    );
    s.take();
    // Nothing to change sends nothing.
    assert_eq!(
        core.update_task(A.into(), TaskChanges::default())
            .unwrap()
            .id,
        A
    );
    assert!(s.take().is_empty());
}

#[test]
fn bad_values_are_refused_before_anything_is_sent_or_queued() {
    let (s, dir) = (Script::default(), TempDir::new("invalid"));
    let core = core(&s, &dir, json!([full(A)]));
    let bad = |c: TaskChanges| match core.update_task(A.into(), c) {
        Err(CoreError::Server {
            status: 400,
            message,
            ..
        }) => message,
        other => panic!("expected a 400, got {other:?}"),
    };
    let only = TaskChanges::default;
    assert_eq!(
        bad(TaskChanges {
            priority: Some(5),
            ..only()
        }),
        "Invalid priority"
    );
    assert_eq!(
        bad(TaskChanges {
            priority: Some(0),
            ..only()
        }),
        "Invalid priority"
    );
    assert_eq!(
        bad(TaskChanges {
            due_date: Some("2026-02-30".into()),
            ..only()
        }),
        "Invalid due date"
    );
    assert_eq!(
        bad(TaskChanges {
            due_date: Some("5 Nov".into()),
            ..only()
        }),
        "Invalid due date"
    );
    assert_eq!(
        bad(TaskChanges {
            due_time: Some("9:30".into()),
            ..only()
        }),
        "Invalid due time"
    );
    assert_eq!(
        bad(TaskChanges {
            title: Some("x".repeat(1001)),
            ..only()
        }),
        "Invalid title"
    );
    assert_eq!(
        bad(TaskChanges {
            description: Some("x".repeat(50_001)),
            ..only()
        }),
        "Invalid description"
    );
    assert_eq!(
        bad(TaskChanges {
            tag_ids: Some(vec!["g".into(); 51]),
            ..only()
        }),
        "Invalid tags"
    );
    assert_eq!(
        bad(TaskChanges {
            recurrence: Some(rule("hour", Some(1))),
            ..only()
        }),
        "Invalid recurrence frequency"
    );
    assert_eq!(
        bad(TaskChanges {
            recurrence: Some(rule("day", Some(0))),
            ..only()
        }),
        "Invalid recurrence interval"
    );
    assert_eq!(
        bad(TaskChanges {
            recurrence: Some(rule("day", None)),
            ..only()
        }),
        "Invalid recurrence interval"
    );
    assert_eq!(
        bad(TaskChanges {
            recurrence: Some(TaskRecurrence {
                by_month_day: Some(32),
                ..rule("month", Some(1))
            }),
            ..only()
        }),
        "Invalid day of month"
    );
    assert_eq!(
        bad(TaskChanges {
            recurrence: Some(TaskRecurrence {
                until: Some("soon".into()),
                ..rule("day", Some(1))
            }),
            ..only()
        }),
        "Invalid end date"
    );
    assert!(s.take().is_empty(), "nothing was sent");
    assert_eq!(core.unsent_task_changes(), 0);
    // A new task is checked the same way.
    let r = core.create_task_with(
        "w1".into(),
        NewTaskInput {
            title: "x".into(),
            priority: Some(9),
            ..Default::default()
        },
    );
    assert!(matches!(r, Err(CoreError::Server { status: 400, .. })));
}

#[test]
fn offline_changes_are_queued_applied_to_the_stored_task_and_sent_in_order() {
    let (s, dir) = (Script::default(), TempDir::new("offline"));
    let core = core(&s, &dir, json!([full(A), task(B, "Other", "open", None)]));
    // A write is tried once: one failure each.
    s.fail(1);
    let q = core
        .update_task(
            A.into(),
            TaskChanges {
                priority: Some(1),
                clear_due_date: true,
                assignee_id: Some("u3".into()),
                tag_ids: Some(vec!["g9".into()]),
                done: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        (q.priority, q.due_date.clone(), q.assignee_id.as_deref()),
        (1, None, Some("u3"))
    );
    assert_eq!(
        (q.assigned_by.as_deref(), q.completed_by.as_deref(), q.done),
        (Some("u1"), Some("u1"), true)
    );
    assert!(q.completed_at.is_some());
    s.fail(1);
    core.update_task(
        A.into(),
        TaskChanges {
            description: Some("Later".into()),
            clear_assignee: true,
            due_time: Some("10:00".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(core.unsent_task_changes(), 2);
    let stored = core.cached_task_detail(A.into()).unwrap();
    assert_eq!(
        (
            stored.description.as_str(),
            stored.assignee_id,
            stored.assigned_by,
            stored.due_time.as_deref(),
            stored.tag_ids
        ),
        ("Later", None, None, Some("10:00"), vec!["g9".to_string()])
    );
    s.take();

    // Back online: both are sent, in order, each with its own fields.
    s.reply(200, full(A)).reply(200, full(A));
    assert_eq!(core.send_task_changes().unwrap(), 0);
    assert_eq!(
        s.take(),
        [
            format!("PATCH /api/tasks/{A}"),
            format!("PATCH /api/tasks/{A}")
        ]
    );
    assert_eq!(core.unsent_task_changes(), 0);
}

#[test]
fn a_new_task_can_carry_every_quick_add_field() {
    let (s, dir) = (Script::default(), TempDir::new("create"));
    let core = core(&s, &dir, json!([]));
    let q = parse_quick_add(
        "Call Sam tomorrow 3pm p1 @sam #waiting every week".into(),
        "2026-11-05".into(),
    );
    let mut made = full(A);
    made["title"] = json!("Call Sam");
    s.reply(200, made);
    core.create_task_with(
        "w1".into(),
        NewTaskInput {
            id: Some(A.into()),
            title: q.title.clone(),
            due_date: q.due_date.clone(),
            due_time: q.due_time.clone(),
            priority: q.priority,
            recurrence: q.recurrence.clone(),
            assignee_id: Some("u2".into()),
            tag_ids: Some(vec!["g1".into()]),
            team_id: Some("tm1".into()),
            description: Some("d".into()),
            reminder_at: Some("2026-11-06T14:00:00.000Z".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        s.bodies()[0],
        Some(json!({
            "id": A, "title": "Call Sam", "description": "d", "dueDate": "2026-11-06", "priority": 1,
            "dueTime": "15:00", "recurrence": { "freq": "week", "interval": 1 },
            "reminderAt": "2026-11-06T14:00:00.000Z", "assigneeId": "u2", "teamId": "tm1", "tagIds": ["g1"]
        }))
    );
}

#[test]
fn lists_reminders_and_notes() {
    let (s, dir) = (Script::default(), TempDir::new("lists"));
    let core = core(&s, &dir, json!([full(A)]));
    s.reply(200, json!([{ "id": "g1", "workspaceId": "w1", "name": "waiting", "color": "#10b981", "createdBy": "u1", "createdAt": "x" }]))
        .reply(200, json!({ "id": "g2", "workspaceId": "w1", "name": "budget", "color": "#ef4444", "createdBy": "u1", "createdAt": "x" }))
        .reply(200, json!([{ "id": "tm1", "workspaceId": "w1", "parentId": null, "name": "Church Elders", "color": "#6366f1", "position": 1, "memberIds": ["u1", "u2"] }]))
        .reply(200, json!({ "members": [
            { "id": "u1", "email": "ann@b.c", "name": "Ann Lee", "color": "#123456", "role": "owner" },
            { "id": "u2", "email": "sam@b.c", "name": "Samuel Jones", "color": "#654321", "role": "member" }
        ], "invites": [] }))
        .reply(200, json!([{ "id": "r1", "taskId": A, "userId": "u1", "kind": "before", "minutes": 30,
                              "nextFireAt": "2026-12-01T09:00:00.000Z", "lastFiredAt": null, "createdAt": "x" }]))
        .reply(200, json!({ "id": "r2", "taskId": A, "userId": "u1", "kind": "at", "at": "2026-12-02T07:00:00.000Z",
                             "nextFireAt": "2026-12-02T07:00:00.000Z", "lastFiredAt": null, "createdAt": "x" }))
        .reply(200, json!({ "id": "r2", "taskId": A, "userId": "u1", "kind": "before", "minutes": 5,
                             "nextFireAt": null, "lastFiredAt": null, "createdAt": "x" }))
        .reply(200, json!({ "ok": true }))
        .reply(200, json!({ "markdown": "- [ ] one\n- [x] two" }));
    let tags = core.tags("w1".into()).unwrap();
    assert_eq!(
        (tags[0].name.as_str(), tags[0].color.as_str()),
        ("waiting", "#10b981")
    );
    assert_eq!(
        core.create_tag("w1".into(), "#budget".into(), None)
            .unwrap()
            .id,
        "g2"
    );
    let teams = core.teams("w1".into()).unwrap();
    let members = core.members("w1".into()).unwrap();
    assert_eq!(teams[0].member_ids, ["u1", "u2"]);
    let rs = core.task_reminders(A.into()).unwrap();
    assert_eq!(rs[0].spec, ReminderSpec::Before { minutes: 30 });
    let added = core
        .add_reminder(
            A.into(),
            ReminderSpec::At {
                at: "2026-12-02T07:00:00.000Z".into(),
            },
        )
        .unwrap();
    assert_eq!(
        added.spec,
        ReminderSpec::At {
            at: "2026-12-02T07:00:00.000Z".into()
        }
    );
    let changed = core
        .update_reminder("r2".into(), ReminderSpec::Before { minutes: 5 })
        .unwrap();
    assert_eq!(
        (changed.next_fire_at, changed.spec),
        (None, ReminderSpec::Before { minutes: 5 })
    );
    core.delete_reminder("r2".into()).unwrap();
    assert_eq!(core.task_notes(A.into()).unwrap(), "- [ ] one\n- [x] two");
    assert_eq!(
        s.take(),
        [
            "GET /api/workspaces/w1/tags".to_string(),
            "POST /api/workspaces/w1/tags".into(),
            "GET /api/workspaces/w1/teams".into(),
            "GET /api/workspaces/w1/members".into(),
            format!("GET /api/tasks/{A}/reminders"),
            format!("POST /api/tasks/{A}/reminders"),
            "PATCH /api/reminders/r2".into(),
            "DELETE /api/reminders/r2".into(),
            format!("GET /api/tasks/{A}/notes"),
        ]
    );
    // A reminder the server would refuse is refused first.
    assert!(matches!(
        core.add_reminder(A.into(), ReminderSpec::Before { minutes: 90_000 }),
        Err(CoreError::Server { status: 400, .. })
    ));

    // Quick add's "@sam" and "+church" mean these people and teams.
    let m = |q: &str| resolve_member(q.into(), members.clone(), "u1".into());
    assert_eq!(m("ann").as_deref(), Some("u1")); // first name
    assert_eq!(m("sam").as_deref(), Some("u2")); // start of the name
    assert_eq!(m("annlee").as_deref(), Some("u1")); // start of the name without spaces
    assert_eq!(m("SAM@").as_deref(), Some("u2")); // the email, any case
    assert_eq!(m("sam@b").as_deref(), Some("u2")); // start of the email
    assert_eq!(m("me").as_deref(), Some("u1"));
    assert_eq!(m("jones").as_deref(), None);
    assert_eq!(
        resolve_team("churchelders".into(), teams.clone()).as_deref(),
        Some("tm1")
    );
    assert_eq!(
        resolve_team("church".into(), teams.clone()).as_deref(),
        Some("tm1")
    );
    assert_eq!(resolve_team("youth".into(), teams), None);
}
