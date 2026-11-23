//! Sharing through the Core against a scripted transport: what each call sends and returns, the
//! server's refusals, and how the stored workspace list and tree follow.

#![allow(clippy::type_complexity)]

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use nv_api::{Request, Response, Transport};
use nv_core::*;
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct Script {
    replies: Arc<Mutex<VecDeque<(u16, Value)>>>,
    seen: Arc<Mutex<Vec<(String, String, Option<String>)>>>,
}
impl Script {
    fn reply(&self, status: u16, body: Value) -> &Self {
        self.replies.lock().unwrap().push_back((status, body));
        self
    }
    /// The requests since the last call, as "METHOD /path".
    fn take(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .drain(..)
            .map(|(m, u, _)| format!("{m} {}", u.split("/api").nth(1).unwrap_or(&u)))
            .collect()
    }
    fn body_of(&self, n: usize) -> Value {
        let b = self.seen.lock().unwrap()[n].2.clone();
        serde_json::from_str(&b.unwrap_or_else(|| "null".into())).unwrap()
    }
}
impl Transport for Script {
    fn send(&self, req: &Request) -> Result<Response, String> {
        self.seen
            .lock()
            .unwrap()
            .push((req.method.into(), req.url.clone(), req.body.clone()));
        let (status, body) = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("unscripted: {} {}", req.method, req.url));
        Ok(Response {
            status,
            body: body.to_string(),
            request_id: None,
        })
    }
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> TempDir {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        TempDir(std::env::temp_dir().join(format!("nv-share-{}-{nanos}", std::process::id())))
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

fn session() -> Value {
    json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
            "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } })
}

fn ws(id: &str) -> Value {
    json!({ "id": id, "name": format!("Space {id}"), "role": "owner", "createdAt": "2026-11-01" })
}

fn tree(visibility: &str) -> Value {
    json!({ "notebooks": [{ "id": "n1", "workspaceId": "w1", "name": "NB", "color": "#336699",
                            "visibility": visibility, "createdBy": "u1", "position": 1.0 }],
            "sections": [], "pages": [], "trashedPages": [] })
}

fn core(s: &Script, dir: &TempDir) -> Arc<Core> {
    s.reply(200, session());
    let core = Core::with_transport("http://localhost:4417", Box::new(s.clone()), Some(dir.db()));
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    s.reply(200, json!([ws("w1"), ws("w2")]));
    core.workspaces().unwrap();
    s.reply(200, tree("private"));
    core.tree("w1".into()).unwrap();
    let mut other = tree("shared");
    other["notebooks"][0]["id"] = json!("n2");
    other["notebooks"][0]["workspaceId"] = json!("w2");
    s.reply(200, other);
    core.tree("w2".into()).unwrap();
    s.take();
    core
}

fn server_error(e: CoreError) -> (u16, String) {
    match e {
        CoreError::Server {
            status, message, ..
        } => (status, message),
        e => panic!("{e:?}"),
    }
}

#[test]
fn members_invites_and_their_refusals() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core(&s, &dir);

    s.reply(
        200,
        json!({ "members": [{ "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#111111", "role": "owner" },
                            { "id": "u2", "email": "b@b.c", "name": "Bo", "color": "#222222", "role": "viewer" }],
                "invites": [{ "email": "n@x.y", "role": "member", "invitedBy": "u1", "createdAt": "c", "expiresAt": "e" }] }),
    );
    let p = core.workspace_people("w1".into()).unwrap();
    assert_eq!(s.take(), ["GET /workspaces/w1/members"]);
    assert_eq!(
        (
            p.members.len(),
            p.members[1].role.as_str(),
            p.invites[0].email.as_str()
        ),
        (2, "viewer", "n@x.y")
    );
    // A member (not admin) gets no invites.
    s.reply(200, json!({ "members": [], "invites": [] }));
    assert!(core
        .workspace_people("w1".into())
        .unwrap()
        .invites
        .is_empty());
    s.take();

    // Invite: with no mail on the server the link comes back for the caller to hand over.
    s.reply(
        200,
        json!({ "status": "invited", "emailed": false, "inviteUrl": "http://localhost:5173/invite/tok123" }),
    );
    let r = core
        .invite_member("w1".into(), "n@x.y".into(), Some("viewer".into()))
        .unwrap();
    assert_eq!(
        (r.status.as_str(), r.emailed, r.invite_url.as_deref()),
        (
            "invited",
            false,
            Some("http://localhost:5173/invite/tok123")
        )
    );
    assert_eq!(s.body_of(0), json!({ "email": "n@x.y", "role": "viewer" }));
    s.take();
    s.reply(409, json!({ "error": "That person is already a member" }));
    assert_eq!(
        server_error(
            core.invite_member("w1".into(), "b@b.c".into(), None)
                .unwrap_err()
        ),
        (409, "That person is already a member".into())
    );
    s.take();
    s.reply(
        400,
        json!({ "error": "This workspace has a locked page outside a private notebook.", "code": "has_locked_page" }),
    );
    assert!(matches!(
        core.invite_member("w1".into(), "z@b.c".into(), None),
        Err(CoreError::Server { status: 400, code: Some(c), .. }) if c == "has_locked_page"
    ));
    s.take();

    s.reply(
        200,
        json!({ "status": "invited", "emailed": false, "inviteUrl": "u2" }),
    );
    core.resend_invite("w1".into(), "n@x.y".into()).unwrap();
    s.reply(200, json!({ "ok": true }));
    core.revoke_invite("w1".into(), "n@x.y".into()).unwrap();
    assert_eq!(
        s.take(),
        [
            "POST /workspaces/w1/invites/n%40x.y/resend",
            "DELETE /workspaces/w1/invites/n%40x.y"
        ]
    );

    // Roles: the server's rules reach the caller.
    s.reply(200, json!({ "ok": true }));
    core.set_member_role("w1".into(), "u2".into(), "member".into())
        .unwrap();
    assert_eq!(s.body_of(0), json!({ "role": "member" }));
    s.take();
    s.reply(403, json!({ "error": "Only owners can change owners" }));
    assert_eq!(
        server_error(
            core.set_member_role("w1".into(), "u2".into(), "owner".into())
                .unwrap_err()
        )
        .0,
        403
    );
    s.reply(
        400,
        json!({ "error": "A workspace needs at least one owner" }),
    );
    assert_eq!(
        server_error(core.remove_member("w1".into(), "u1".into()).unwrap_err()).0,
        400
    );
    s.take();
    s.reply(200, json!({ "ok": true }));
    core.remove_member("w1".into(), "u2".into()).unwrap();
    assert_eq!(s.take(), ["DELETE /workspaces/w1/members/u2"]);
    assert_eq!(
        core.cached_workspaces().unwrap().len(),
        2,
        "removing someone else changes nothing here"
    );
}

#[test]
fn leaving_a_workspace_drops_it_and_what_was_stored_of_it() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core(&s, &dir);
    assert!(core.cached_tree("w2".into()).is_some());

    s.reply(200, json!({ "ok": true }));
    s.reply(200, json!([ws("w1")])); // the list without w2
    core.leave_workspace("w2".into()).unwrap();
    assert_eq!(
        s.take(),
        ["DELETE /workspaces/w2/members/u1", "GET /workspaces"]
    );
    assert_eq!(core.cached_workspaces().unwrap().len(), 1);
    assert!(core.cached_tree("w2".into()).is_none(), "its tree is gone");
    assert!(core.cached_tree("w1".into()).is_some());

    // The last owner cannot leave; nothing is refetched.
    s.reply(
        400,
        json!({ "error": "A workspace needs at least one owner" }),
    );
    assert_eq!(
        server_error(core.leave_workspace("w1".into()).unwrap_err()).0,
        400
    );
    assert_eq!(s.take(), ["DELETE /workspaces/w1/members/u1"]);
    assert_eq!(core.cached_workspaces().unwrap().len(), 1);
}

#[test]
fn invite_links_are_read_and_accepted() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core(&s, &dir);
    s.reply(
        200,
        json!({ "workspaceId": "w3", "workspaceName": "Team", "invitedByName": "Bo", "email": "a@b.c",
                "role": "member", "expired": false }),
    );
    let i = core.invite_info("tok".into()).unwrap();
    assert_eq!(
        (i.workspace_name.as_str(), i.role.as_str(), i.page.is_none()),
        ("Team", "member", true)
    );
    assert_eq!(s.take(), ["GET /invites/tok"]);

    s.reply(200, json!({ "workspaceId": "w3" }));
    s.reply(200, json!([ws("w1"), ws("w2"), ws("w3")]));
    let a = core.accept_invite("tok".into()).unwrap();
    assert_eq!((a.workspace_id.as_str(), a.page_id), ("w3", None));
    assert_eq!(s.take(), ["POST /invites/tok/accept", "GET /workspaces"]);
    assert_eq!(
        core.cached_workspaces().unwrap().len(),
        3,
        "the list is current"
    );

    // Someone else's invite (403) and an expired one (410).
    s.reply(403, json!({ "error": "This invite was sent to z@z.z. Sign in with that email address to accept it." }));
    assert_eq!(
        server_error(core.accept_invite("tok2".into()).unwrap_err()).0,
        403
    );
    s.reply(
        410,
        json!({ "error": "This invite has expired. Ask for a new one." }),
    );
    assert_eq!(
        server_error(core.accept_invite("tok3".into()).unwrap_err()).0,
        410
    );
    assert_eq!(s.take().len(), 2, "no list refetch after a refusal");

    // A single-page invite.
    s.reply(
        200,
        json!({ "workspaceId": "w9", "workspaceName": "Far", "invitedByName": "Bo", "email": "a@b.c",
                "role": "viewer", "expired": false, "page": { "id": "p7", "title": "Plan", "canEdit": false } }),
    );
    let i = core.invite_info("tok4".into()).unwrap();
    assert_eq!(i.page.unwrap().id, "p7");
    s.reply(200, json!({ "workspaceId": "w9", "pageId": "p7" }));
    s.reply(200, json!([ws("w1"), ws("w2"), ws("w3")]));
    assert_eq!(
        core.accept_invite("tok4".into())
            .unwrap()
            .page_id
            .as_deref(),
        Some("p7")
    );
}

#[test]
fn notebook_and_page_shares() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core(&s, &dir);

    s.reply(
        200,
        json!({ "visibility": "private", "createdBy": "u1", "userIds": ["u2"] }),
    );
    let n = core.notebook_shares("n1".into()).unwrap();
    assert_eq!(
        (n.visibility.as_str(), n.created_by.as_str(), n.user_ids),
        ("private", "u1", vec!["u2".to_string()])
    );
    s.take();
    // Setting them fetches the tree again (the creator's view can change: tasks, access).
    s.reply(200, json!({ "userIds": ["u2", "u3"] }));
    s.reply(200, tree("private"));
    assert_eq!(
        core.set_notebook_shares("n1".into(), vec!["u2".into(), "u3".into()])
            .unwrap(),
        ["u2", "u3"]
    );
    assert_eq!(s.body_of(0), json!({ "userIds": ["u2", "u3"] }));
    assert_eq!(
        s.take(),
        ["PUT /notebooks/n1/shares", "GET /workspaces/w1/tree"]
    );
    s.reply(
        403,
        json!({ "error": "Only the notebook’s creator can change who it’s shared with" }),
    );
    assert_eq!(
        server_error(core.set_notebook_shares("n1".into(), vec![]).unwrap_err()).0,
        403
    );
    s.take();

    let lists = json!({ "shares": [{ "userId": "u2", "name": "Bo", "email": "b@b.c", "color": "#222222", "canEdit": false, "member": true }],
                        "invites": [{ "email": "n@x.y", "canEdit": true, "expiresAt": null, "createdAt": "c" }] });
    s.reply(200, lists.clone());
    let sh = core.page_shares("p1".into()).unwrap();
    assert_eq!(
        (
            sh.shares[0].name.as_str(),
            sh.shares[0].member,
            sh.invites[0].can_edit
        ),
        ("Bo", true, true)
    );
    let mut r = lists.clone();
    r["status"] = json!("shared");
    r["emailed"] = json!(false);
    s.reply(200, r);
    let res = core
        .share_page_with_member("p1".into(), "u2".into(), false)
        .unwrap();
    assert_eq!(
        (res.status.as_str(), res.shares.shares.len()),
        ("shared", 1)
    );
    let mut r = lists.clone();
    r["status"] = json!("invited");
    r["emailed"] = json!(false);
    r["inviteUrl"] = json!("http://localhost:5173/invite/pt");
    s.reply(200, r);
    let res = core
        .share_page_by_email("p1".into(), "n@x.y".into(), true)
        .unwrap();
    assert_eq!(
        (res.status.as_str(), res.emailed, res.invite_url.as_deref()),
        ("invited", false, Some("http://localhost:5173/invite/pt"))
    );
    s.reply(
        403,
        json!({ "error": "Only workspace owners and admins can share with people outside the workspace" }),
    );
    assert_eq!(
        server_error(
            core.share_page_by_email("p1".into(), "o@x.y".into(), false)
                .unwrap_err()
        )
        .0,
        403
    );
    s.reply(200, lists.clone());
    core.set_page_share_edit("p1".into(), "u2".into(), true)
        .unwrap();
    s.reply(200, lists.clone());
    core.remove_page_share("p1".into(), "u2".into()).unwrap();
    s.reply(200, lists);
    core.revoke_page_invite("p1".into(), "n@x.y".into())
        .unwrap();
    assert_eq!(
        s.take(),
        [
            "GET /pages/p1/shares",
            "POST /pages/p1/shares",
            "POST /pages/p1/shares",
            "POST /pages/p1/shares",
            "PATCH /pages/p1/shares/u2",
            "DELETE /pages/p1/shares/u2",
            "DELETE /pages/p1/invites/n%40x.y"
        ]
    );

    s.reply(
        200,
        json!([{ "id": "p9", "title": "Shared", "icon": null, "workspaceId": "w5", "workspaceName": "Other",
                 "member": false, "canEdit": true, "sharedByName": "Bo", "sharedAt": "t" }]),
    );
    let sp = core.shared_pages().unwrap();
    assert_eq!(
        (
            sp[0].id.as_str(),
            sp[0].member,
            sp[0].can_edit,
            sp[0].shared_by_name.as_deref()
        ),
        ("p9", false, true, Some("Bo"))
    );
}
