//! Search and comment threads through the Core against a scripted transport.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

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
    fn fail(&self, n: usize) -> &Self {
        for _ in 0..n {
            self.replies
                .lock()
                .unwrap()
                .push_back(Err("connection refused".into()));
        }
        self
    }
    fn take(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .drain(..)
            .map(|r| format!("{} {}", r.method, r.url.trim_start_matches(SERVER)))
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

const SERVER: &str = "http://localhost:4417";

fn core(s: &Script) -> Arc<Core> {
    s.reply(
        200,
        json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
    );
    let core = Core::with_transport(SERVER, Box::new(s.clone()), None);
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    s.take();
    core
}

fn run(text: &str, matched: bool) -> SnippetRun {
    SnippetRun {
        text: text.into(),
        matched,
    }
}

#[test]
fn snippets_split_into_runs_like_the_web_does() {
    assert_eq!(
        parse_snippet("the \u{ab}plan\u{bb} for \u{ab}Q4\u{bb}".into()),
        vec![
            run("the ", false),
            run("plan", true),
            run(" for ", false),
            run("Q4", true)
        ]
    );
    // Marker first and last, no empty runs.
    assert_eq!(parse_snippet("\u{ab}a\u{bb}".into()), vec![run("a", true)]);
    assert_eq!(
        parse_snippet("\u{2026}x\u{ab}\u{bb}y".into()),
        vec![run("\u{2026}x", false), run("y", false)]
    );
    // An open marker without its close, and a close without an open, stay as text.
    assert_eq!(
        parse_snippet("a \u{ab}b".into()),
        vec![run("a \u{ab}b", false)]
    );
    assert_eq!(
        parse_snippet("a \u{bb} b".into()),
        vec![run("a \u{bb} b", false)]
    );
    // Up to the first close marker, as the web's regex: a nested open marker is matched text.
    assert_eq!(
        parse_snippet("\u{ab}a\u{ab}b\u{bb}".into()),
        vec![run("a\u{ab}b", true)]
    );
    assert!(parse_snippet(String::new()).is_empty());
}

#[test]
fn search_reads_pages_and_tasks_with_typed_snippets() {
    let s = Script::default();
    let core = core(&s);
    s.reply(
        200,
        json!({
            "pages": [
                { "id": "p1", "title": "Q4 roadmap", "icon": "M", "snippet": "ship the \u{ab}plan\u{bb} in \u{2026}",
                  "notebookName": "Work", "sectionName": "Roadmap", "path": "Work \u{203a} Roadmap" },
                { "id": "p2", "title": "Plan (locked)", "icon": null, "snippet": "",
                  "notebookName": "Work", "sectionName": "Private", "path": "Work \u{203a} Private" }],
            "tasks": [{ "id": "t1", "workspaceId": "w1", "title": "Write it", "status": "open", "priority": 2,
                        "createdBy": "u1", "createdAt": "2026-11-01", "updatedAt": "2026-11-02",
                        "snippet": "the \u{ab}plan\u{bb}" },
                      { "id": "t2", "workspaceId": "w1", "title": "Plan", "status": "open", "priority": 4,
                        "createdBy": "u1", "createdAt": "2026-11-01", "updatedAt": "2026-11-02" }]
        }),
    );
    let r = core
        .search("w1".into(), "  plan ".into(), Some(10))
        .unwrap();
    assert_eq!(s.take(), ["GET /api/workspaces/w1/search?q=plan&limit=10"]);
    assert_eq!(r.pages.len(), 2);
    assert_eq!(r.pages[0].page_id, "p1");
    assert_eq!(r.pages[0].path, "Work \u{203a} Roadmap");
    assert_eq!(r.pages[0].icon.as_deref(), Some("M"));
    assert_eq!(
        r.pages[0].snippet,
        vec![
            run("ship the ", false),
            run("plan", true),
            run(" in \u{2026}", false)
        ]
    );
    assert!(r.pages[1].snippet.is_empty());
    assert_eq!(r.tasks[0].task.priority, 2);
    assert_eq!(
        r.tasks[0].snippet,
        Some(vec![run("the ", false), run("plan", true)])
    );
    assert_eq!(r.tasks[1].snippet, None);
}

#[test]
fn a_blank_query_asks_nothing_and_offline_is_a_network_error() {
    let s = Script::default();
    let core = core(&s);
    let r = core.search("w1".into(), "   ".into(), None).unwrap();
    assert!(r.pages.is_empty() && r.tasks.is_empty());
    assert!(s.take().is_empty());
    s.fail(3);
    assert!(matches!(
        core.search("w1".into(), "plan".into(), None),
        Err(CoreError::Network { .. })
    ));
}

fn thread(resolved: bool, comments: &[(&str, &str, &str)]) -> Value {
    json!({ "id": "th1", "pageId": "p1", "workspaceId": "w1", "quote": "hello", "createdBy": "u1",
            "createdAt": "2026-11-01T10:00:00.000Z",
            "resolvedAt": if resolved { json!("2026-11-02T10:00:00.000Z") } else { json!(null) },
            "resolvedBy": if resolved { json!("u2") } else { json!(null) },
            "comments": comments.iter().map(|(id, author, body)| json!({
                "id": id, "threadId": "th1", "authorId": author, "body": body,
                "createdAt": "2026-11-01T10:00:00.000Z", "editedAt": null })).collect::<Vec<_>>() })
}

#[test]
fn a_comment_thread_round_trip() {
    let s = Script::default();
    let core = core(&s);
    let id = new_comment_thread_id();
    assert_eq!(id.len(), 36);

    s.reply(200, thread(false, &[("c1", "u1", "First")]));
    let t = core
        .add_comment_thread("p1".into(), id.clone(), "hello".into(), "First".into())
        .unwrap();
    assert!(!t.resolved && t.resolved_at.is_none());
    assert_eq!((t.quote.as_str(), t.comments.len()), ("hello", 1));
    assert_eq!(s.take(), ["POST /api/pages/p1/comments"]);

    s.reply(
        200,
        thread(false, &[("c1", "u1", "First"), ("c2", "u2", "Reply")]),
    );
    let t = core
        .reply_to_comment_thread("th1".into(), "Reply".into())
        .unwrap();
    assert_eq!(t.comments[1].author_id, "u2");

    s.reply(200, thread(true, &[("c1", "u1", "First")]));
    let t = core.resolve_comment_thread("th1".into()).unwrap();
    assert!(t.resolved);
    assert_eq!(t.resolved_by.as_deref(), Some("u2"));
    s.reply(200, thread(false, &[("c1", "u1", "First")]));
    assert!(!core.reopen_comment_thread("th1".into()).unwrap().resolved);

    s.reply(200, thread(false, &[("c1", "u1", "Edited")]));
    assert_eq!(
        core.edit_comment("c1".into(), "Edited".into())
            .unwrap()
            .comments[0]
            .body,
        "Edited"
    );

    s.reply(200, json!([thread(true, &[("c1", "u1", "x")])]));
    let list = core.page_comments("p1".into()).unwrap();
    assert!(list[0].resolved);

    s.reply(200, json!({ "ok": true, "threadDeleted": false }));
    assert!(!core.delete_comment("c2".into()).unwrap());
    s.reply(200, json!({ "ok": true }));
    core.delete_comment_thread("th1".into()).unwrap();
    assert_eq!(
        s.take(),
        [
            "POST /api/comment-threads/th1/replies",
            "PATCH /api/comment-threads/th1",
            "PATCH /api/comment-threads/th1",
            "PATCH /api/comments/c1",
            "GET /api/pages/p1/comments",
            "DELETE /api/comments/c2",
            "DELETE /api/comment-threads/th1",
        ]
    );
}

#[test]
fn comment_errors_come_through_as_server_errors() {
    let s = Script::default();
    let core = core(&s);
    s.reply(
        403,
        json!({ "error": "You can only edit your own comments" }),
    );
    match core.edit_comment("c1".into(), "x".into()) {
        Err(CoreError::Server {
            status, message, ..
        }) => {
            assert_eq!(
                (status, message.as_str()),
                (403, "You can only edit your own comments")
            );
        }
        other => panic!("{other:?}"),
    }
}
