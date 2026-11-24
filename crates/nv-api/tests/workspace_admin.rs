//! Workspace, team, tag and activity calls of the client against a scripted transport: what is
//! sent (method, path, body) and how the answers are read.

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

#[test]
fn workspace_calls_send_what_the_server_reads() {
    let (c, s) = client();
    s.reply(200, json!({ "id": "w9" }));
    assert_eq!(c.create_workspace("Home").unwrap(), "w9");
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/workspaces".into(),
            json!({ "name": "Home" })
        )
    );
    s.reply(200, json!({ "ok": true }));
    c.rename_workspace("w9", "Home 2").unwrap();
    assert_eq!(
        s.last(),
        (
            "PATCH".into(),
            "/workspaces/w9".into(),
            json!({ "name": "Home 2" })
        )
    );
    s.reply(200, json!({ "ok": true }));
    c.delete_workspace("w9").unwrap();
    assert_eq!(
        s.last(),
        ("DELETE".into(), "/workspaces/w9".into(), Value::Null)
    );
    s.reply(200, json!({}));
    assert!(c.create_workspace("x").is_err(), "an answer without an id");
}

#[test]
fn tag_calls_send_only_what_changes() {
    let (c, s) = client();
    let tag = json!({ "id": "t1", "workspaceId": "w1", "name": "blocked", "color": "#112233",
                      "createdBy": "u1", "createdAt": "2026-01-01T00:00:00.000Z" });
    s.reply(200, tag.clone());
    let t = c.update_tag("t1", Some("#blocked"), None).unwrap();
    assert_eq!(t.name, "blocked");
    assert_eq!(
        s.last(),
        (
            "PATCH".into(),
            "/tags/t1".into(),
            json!({ "name": "#blocked" })
        )
    );
    s.reply(200, tag);
    c.update_tag("t1", None, Some("#ABCDEF")).unwrap();
    assert_eq!(s.last().2, json!({ "color": "#ABCDEF" }));
    s.reply(200, json!({ "ok": true }));
    c.delete_tag("t1").unwrap();
    assert_eq!(s.last(), ("DELETE".into(), "/tags/t1".into(), Value::Null));
}

#[test]
fn team_calls() {
    let (c, s) = client();
    let team = json!({ "id": "g1", "workspaceId": "w1", "parentId": null, "name": "Eng",
                       "color": "#6366f1", "position": 1, "memberIds": ["u1"] });
    s.reply(200, team.clone());
    let t = c
        .create_team("w1", "Eng", None, None, &["u1".to_string()])
        .unwrap();
    assert_eq!(t.member_ids, ["u1"]);
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/workspaces/w1/teams".into(),
            json!({ "name": "Eng", "memberIds": ["u1"] })
        )
    );
    s.reply(200, team.clone());
    c.create_team("w1", "Web", Some("#0ea5e9"), Some("g1"), &[])
        .unwrap();
    assert_eq!(
        s.last().2,
        json!({ "name": "Web", "color": "#0ea5e9", "parentId": "g1" })
    );
    s.reply(200, team.clone());
    c.update_team("g2", &json!({ "parentId": null })).unwrap();
    assert_eq!(
        s.last(),
        (
            "PATCH".into(),
            "/teams/g2".into(),
            json!({ "parentId": null })
        )
    );
    s.reply(200, team);
    c.set_team_members("g2", &["u1".to_string(), "u2".to_string()])
        .unwrap();
    assert_eq!(
        s.last(),
        (
            "PUT".into(),
            "/teams/g2/members".into(),
            json!({ "userIds": ["u1", "u2"] })
        )
    );
    s.reply(200, json!({ "ok": true }));
    c.delete_team("g2").unwrap();
    assert_eq!(s.last(), ("DELETE".into(), "/teams/g2".into(), Value::Null));
}

#[test]
fn activity_pages_back_by_id() {
    let (c, s) = client();
    s.reply(
        200,
        json!([{ "id": 7, "workspaceId": "w1", "actorId": "u1", "verb": "renamed",
                 "targetType": "workspace", "targetId": "w1",
                 "summary": "renamed the workspace to “Q”",
                 "createdAt": "2026-01-01T00:00:00.000Z" },
               { "id": 6, "workspaceId": "w1", "actorId": null, "verb": "added",
                 "targetType": "member", "targetId": "u2", "summary": "added Bo as member",
                 "createdAt": "2026-01-01T00:00:00.000Z" }]),
    );
    let a = c.activity("w1", None, None).unwrap();
    assert_eq!(s.last().1, "/workspaces/w1/activity");
    assert_eq!((a[0].id, a[1].actor_id.clone()), (7, None));
    s.reply(200, json!([]));
    assert!(c.activity("w1", Some(20), Some(6)).unwrap().is_empty());
    assert_eq!(s.last().1, "/workspaces/w1/activity?limit=20&before=6");
    s.reply(200, json!([]));
    c.activity("w1", None, Some(6)).unwrap();
    assert_eq!(s.last().1, "/workspaces/w1/activity?before=6");
}
