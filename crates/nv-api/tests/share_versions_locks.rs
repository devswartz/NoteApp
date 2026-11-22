//! Sharing, version history and locked-page calls of the client against a scripted transport:
//! what is sent (method, path, body) and how the answers are read.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use base64::Engine;
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
    fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
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
fn members_and_invites() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "members": [{ "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#111111", "role": "owner" }],
                "invites": [{ "email": "n@x.y", "role": "viewer", "invitedBy": "u1", "createdAt": "t", "expiresAt": "t2" }] }),
    );
    let l = c.member_list("w 1").unwrap();
    assert_eq!(s.last().1, "/workspaces/w%201/members");
    assert_eq!(l.members[0].role, "owner");
    assert_eq!(l.invites[0].email, "n@x.y");
    assert_eq!(l.invites[0].expires_at.as_deref(), Some("t2"));

    s.reply(
        200,
        json!({ "status": "invited", "emailed": false, "inviteUrl": "http://x/invite/tok" }),
    );
    let r = c.invite_member("w1", "n@x.y", Some("viewer")).unwrap();
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/workspaces/w1/members".into(),
            json!({ "email": "n@x.y", "role": "viewer" })
        )
    );
    assert_eq!(
        (r.status.as_str(), r.emailed, r.invite_url.as_deref()),
        ("invited", false, Some("http://x/invite/tok"))
    );
    s.reply(200, json!({ "status": "added", "emailed": false }));
    let r = c.invite_member("w1", "m@x.y", None).unwrap();
    assert_eq!(s.last().2, json!({ "email": "m@x.y" }));
    assert_eq!((r.status.as_str(), r.invite_url), ("added", None));

    s.reply(
        200,
        json!({ "status": "invited", "emailed": false, "inviteUrl": "u2" }),
    );
    c.resend_invite("w1", "a+b@x.y").unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        (
            "POST".into(),
            "/workspaces/w1/invites/a%2Bb%40x.y/resend".into()
        )
    );
    s.reply(200, json!({ "ok": true }));
    c.revoke_invite("w1", "n@x.y").unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        ("DELETE".into(), "/workspaces/w1/invites/n%40x.y".into())
    );
    s.reply(200, json!({ "ok": true }));
    c.set_member_role("w1", "u2", "admin").unwrap();
    assert_eq!(
        s.last(),
        (
            "PATCH".into(),
            "/workspaces/w1/members/u2".into(),
            json!({ "role": "admin" })
        )
    );
    s.reply(200, json!({ "ok": true }));
    c.remove_member("w1", "u2").unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        ("DELETE".into(), "/workspaces/w1/members/u2".into())
    );

    // A refusal keeps the server's message.
    s.reply(
        403,
        json!({ "error": "Only owners can change owners", "code": "x" }),
    );
    match c.set_member_role("w1", "u2", "owner") {
        Err(ApiError::Http {
            status, message, ..
        }) => assert_eq!(
            (status, message.as_str()),
            (403, "Only owners can change owners")
        ),
        other => panic!("{other:?}"),
    }
}

#[test]
fn invite_links_and_shares() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "workspaceId": "w1", "workspaceName": "Space", "invitedByName": "Ann", "email": "n@x.y",
                "role": "member", "expired": false, "page": { "id": "p1", "title": "T", "canEdit": true } }),
    );
    let i = c.invite_info("t/k").unwrap();
    assert_eq!(s.last().1, "/invites/t%2Fk");
    assert_eq!(i.page.unwrap().id, "p1");
    s.reply(200, json!({ "workspaceId": "w1" }));
    let a = c.accept_invite("tok").unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        ("POST".into(), "/invites/tok/accept".into())
    );
    assert_eq!((a.workspace_id.as_str(), a.page_id), ("w1", None));
    s.reply(200, json!({ "workspaceId": "w1", "pageId": "p1" }));
    assert_eq!(
        c.accept_invite("tok").unwrap().page_id.as_deref(),
        Some("p1")
    );

    s.reply(
        200,
        json!({ "visibility": "private", "createdBy": "u1", "userIds": ["u2"] }),
    );
    let n = c.notebook_shares("n1").unwrap();
    assert_eq!(s.last().1, "/notebooks/n1/shares");
    assert_eq!(
        (n.visibility.as_str(), n.user_ids),
        ("private", vec!["u2".to_string()])
    );
    s.reply(200, json!({ "userIds": ["u2", "u3"] }));
    let ids = c
        .set_notebook_shares("n1", &["u2".into(), "u3".into()])
        .unwrap();
    assert_eq!(
        s.last(),
        (
            "PUT".into(),
            "/notebooks/n1/shares".into(),
            json!({ "userIds": ["u2", "u3"] })
        )
    );
    assert_eq!(ids, ["u2", "u3"]);

    let lists = json!({ "shares": [{ "userId": "u2", "name": "Bo", "email": "b@x.y", "color": "#222222", "canEdit": true, "member": true }],
                        "invites": [{ "email": "n@x.y", "canEdit": false, "expiresAt": null, "createdAt": "t" }] });
    s.reply(200, lists.clone());
    let p = c.page_shares("p1").unwrap();
    assert_eq!(s.last().1, "/pages/p1/shares");
    assert!(p.shares[0].can_edit && p.shares[0].member);
    assert_eq!(p.invites[0].email, "n@x.y");

    let mut shared = lists.clone();
    shared["status"] = json!("shared");
    shared["emailed"] = json!(false);
    s.reply(200, shared);
    let r = c.share_page("p1", Some("u2"), None, true).unwrap();
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/pages/p1/shares".into(),
            json!({ "canEdit": true, "userId": "u2" })
        )
    );
    assert_eq!(r.status, "shared");
    assert_eq!(r.lists.shares.len(), 1);
    let mut invited = lists.clone();
    invited["status"] = json!("invited");
    invited["inviteUrl"] = json!("http://x/invite/t");
    s.reply(200, invited);
    let r = c.share_page("p1", None, Some("n@x.y"), false).unwrap();
    assert_eq!(s.last().2, json!({ "canEdit": false, "email": "n@x.y" }));
    assert_eq!(r.invite_url.as_deref(), Some("http://x/invite/t"));

    s.reply(200, lists.clone());
    c.set_page_share_edit("p1", "u2", false).unwrap();
    assert_eq!(
        s.last(),
        (
            "PATCH".into(),
            "/pages/p1/shares/u2".into(),
            json!({ "canEdit": false })
        )
    );
    s.reply(200, lists.clone());
    c.remove_page_share("p1", "u2").unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        ("DELETE".into(), "/pages/p1/shares/u2".into())
    );
    s.reply(200, lists);
    c.revoke_page_invite("p1", "n@x.y").unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        ("DELETE".into(), "/pages/p1/invites/n%40x.y".into())
    );
    s.reply(
        200,
        json!([{ "id": "p9", "title": "Shared", "icon": null, "workspaceId": "w2", "workspaceName": "Other",
                 "member": false, "canEdit": false, "sharedByName": "Bo", "sharedAt": "t" }]),
    );
    let sp = c.shared_pages().unwrap();
    assert_eq!(s.last().1, "/shared-pages");
    assert_eq!((sp[0].workspace_id.as_str(), sp[0].member), ("w2", false));
}

#[test]
fn version_history_calls() {
    let (c, s) = client();
    s.reply(
        200,
        json!([{ "id": "v2", "title": "T", "authorId": "u1", "reason": "restore", "at": "a", "createdAt": "c" },
               { "id": "v1", "title": "T", "authorId": null, "reason": "auto", "at": "a0", "createdAt": "c0" }]),
    );
    let v = c.page_versions("p1").unwrap();
    assert_eq!(s.last().1, "/pages/p1/versions");
    assert_eq!(
        (v[0].reason.as_str(), v[1].author_id.clone()),
        ("restore", None)
    );

    let doc = vec![1u8, 2, 3, 250];
    s.reply(
        200,
        json!({ "id": "v1", "title": "T", "authorId": null, "reason": "auto", "at": "a0", "createdAt": "c0",
                "ydoc": base64::engine::general_purpose::STANDARD.encode(&doc) }),
    );
    let (meta, bytes) = c.page_version("p1", "v1").unwrap();
    assert_eq!(s.last().1, "/pages/p1/versions/v1");
    assert_eq!((meta.id.as_str(), bytes), ("v1", doc));

    s.reply(200, json!({ "id": "v3" }));
    assert_eq!(
        c.snapshot_page("p1", "restore").unwrap().as_deref(),
        Some("v3")
    );
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/pages/p1/versions".into(),
            json!({ "reason": "restore" })
        )
    );
    s.reply(200, json!({ "id": null }));
    assert_eq!(c.snapshot_page("p1", "manual").unwrap(), None);
}

#[test]
fn locked_page_calls_and_their_bodies() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "hasPassword": true, "unlocked": true, "expiresAt": "e", "idleMs": 300000, "lockedPages": 2,
                "failures": 1, "blockedUntil": null, "triesBeforeLockout": 4,
                "devices": [{ "id": "d1", "label": "iPhone", "createdAt": "c", "lastUsedAt": null, "expiresAt": "x" }] }),
    );
    let st = c.locked_notes().unwrap();
    assert_eq!(s.last().1, "/locked-notes");
    assert_eq!(
        (
            st.unlocked,
            st.idle_ms,
            st.tries_before_lockout,
            st.devices[0].id.as_str()
        ),
        (true, 300_000, 4, "d1")
    );

    s.reply(200, json!({ "ok": true, "expiresAt": "e1" }));
    assert_eq!(
        c.set_locked_password("secret1", None).unwrap().as_deref(),
        Some("e1")
    );
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/locked-notes/password".into(),
            json!({ "password": "secret1" })
        )
    );
    s.reply(200, json!({ "ok": true, "expiresAt": null }));
    assert_eq!(
        c.set_locked_password("secret2", Some("secret1")).unwrap(),
        None
    );
    assert_eq!(
        s.last().2,
        json!({ "password": "secret2", "currentPassword": "secret1" })
    );

    s.reply(200, json!({ "expiresAt": "e2" }));
    assert_eq!(c.unlock_locked("secret2").unwrap(), "e2");
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/locked-notes/unlock".into(),
            json!({ "password": "secret2" })
        )
    );
    s.reply(200, json!({ "expiresAt": "e3" }));
    c.unlock_locked_with_device("d1", "sec", "install-0123456789abcdef")
        .unwrap();
    assert_eq!(
        s.last().2,
        json!({ "deviceId": "d1", "secret": "sec", "installId": "install-0123456789abcdef" })
    );
    s.reply(200, json!({ "ok": true }));
    c.relock().unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        ("POST".into(), "/locked-notes/lock".into())
    );
    s.reply(200, json!({ "unlocked": false, "expiresAt": null }));
    assert_eq!(c.locked_keepalive().unwrap(), (false, None));
    s.reply(
        200,
        json!({ "id": "d2", "secret": "s3cr3t", "expiresAt": "x" }),
    );
    let d = c
        .create_lock_device("install-0123456789abcdef", Some("iPhone"))
        .unwrap();
    assert_eq!(
        s.last().2,
        json!({ "installId": "install-0123456789abcdef", "label": "iPhone" })
    );
    assert_eq!(d.secret, "s3cr3t");
    assert!(
        !format!("{d:?}").contains("s3cr3t"),
        "Debug hides the secret"
    );
    s.reply(200, json!({ "ok": true }));
    c.delete_lock_device("d2").unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        ("DELETE".into(), "/locked-notes/devices/d2".into())
    );
    s.reply(200, json!({ "ok": true }));
    c.lock_page("p1").unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        ("POST".into(), "/pages/p1/lock".into())
    );
    s.reply(200, json!({ "ok": true }));
    c.remove_page_lock("p1", "secret2").unwrap();
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/pages/p1/lock/remove".into(),
            json!({ "password": "secret2" })
        )
    );
}

#[test]
fn a_requests_debug_output_hides_bodies_and_tokens() {
    let r = Request {
        method: "POST",
        url: "http://x/api/locked-notes/unlock".into(),
        bearer: Some("access-token-123".into()),
        body: Some(r#"{"password":"hunter2-secret"}"#.into()),
    };
    let shown = format!("{r:?}");
    assert!(!shown.contains("hunter2") && !shown.contains("access-token-123"));
    assert!(shown.contains("locked-notes/unlock"));
}

#[test]
fn a_revoked_device_is_an_answer_not_a_reason_to_refresh_and_send_again() {
    let (c, s) = client();
    let before = s.count();
    s.reply(
        401,
        json!({ "error": "This device can no longer unlock locked notes", "code": "device_revoked" }),
    );
    match c.unlock_locked_with_device("d1", "old", "install-0123456789abcdef") {
        Err(ApiError::Http { status, code, .. }) => {
            assert_eq!((status, code.as_deref()), (401, Some("device_revoked")))
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        s.count() - before,
        1,
        "sent once: no refresh, no second try"
    );

    // Any other 401 still refreshes the token and sends the request again.
    s.reply(401, json!({ "error": "expired" }));
    s.reply(
        200,
        json!({ "accessToken": "acc2", "expiresIn": 900, "refreshToken": "ref2",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
    );
    s.reply(200, json!({ "hasPassword": false }));
    c.locked_notes().unwrap();
}
