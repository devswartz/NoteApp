//! Account calls of the client against a scripted transport: what is sent (method, path, body)
//! and how the answers and errors are read.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_api::{ApiError, Client, NotificationSettingsPatch, Request, Response, Transport};
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
fn profile_update_sends_only_what_changed_and_updates_the_user() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "id": "u1", "email": "a@b.c", "name": "Anna", "color": "#123456", "emailVerified": true }),
    );
    let u = c.update_profile(Some("Anna"), None).unwrap();
    assert_eq!(
        s.last(),
        ("PATCH".into(), "/me".into(), json!({ "name": "Anna" }))
    );
    assert_eq!(u.name, "Anna");
    assert_eq!(c.user().unwrap().name, "Anna");

    s.reply(
        200,
        json!({ "id": "u1", "email": "a@b.c", "name": "Anna", "color": "#abcdef", "emailVerified": true }),
    );
    c.update_profile(None, Some("#abcdef")).unwrap();
    assert_eq!(s.last().2, json!({ "color": "#abcdef" }));
    assert_eq!(c.user().unwrap().color, "#abcdef");

    s.reply(400, json!({ "error": "Name is required" }));
    match c.update_profile(Some(""), None) {
        Err(ApiError::Http { status: 400, .. }) => {}
        e => panic!("{e:?}"),
    }
    assert_eq!(c.user().unwrap().name, "Anna");
}

#[test]
fn password_change_adopts_the_new_session() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "accessToken": "acc2", "expiresIn": 900, "refreshToken": "ref2",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
    );
    let r = c.change_password("old pass 1", "new pass 22").unwrap();
    assert_eq!(
        s.last(),
        (
            "POST".into(),
            "/me/password".into(),
            json!({ "currentPassword": "old pass 1", "newPassword": "new pass 22" })
        )
    );
    assert_eq!(r.refresh_token, "ref2");
    assert_eq!(c.session_refresh_token().as_deref(), Some("ref2"));
}

#[test]
fn wrong_current_password_has_a_code_and_keeps_the_session() {
    let (c, s) = client();
    s.reply(
        400,
        json!({ "error": "Your current password is incorrect" }),
    );
    match c.change_password("nope", "new pass 22") {
        Err(ApiError::Http {
            status: 400,
            message,
            code,
            ..
        }) => {
            assert_eq!(message, "Your current password is incorrect");
            assert_eq!(code.as_deref(), Some("wrong_password"));
        }
        e => panic!("{e:?}"),
    }
    assert_eq!(c.session_refresh_token().as_deref(), Some("ref"));

    // A weak new password is a plain 400, not a wrong password.
    s.reply(
        400,
        json!({ "error": "Password must be at least 8 characters" }),
    );
    match c.change_password("old pass 1", "short") {
        Err(ApiError::Http {
            status: 400, code, ..
        }) => assert_eq!(code, None),
        e => panic!("{e:?}"),
    }
}

#[test]
fn notification_settings_read_and_patch() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "timeZone": "Europe/London", "emailEnabled": true, "defaultReminderTime": "09:00",
                "digestEnabled": false, "digestTime": "08:00" }),
    );
    let n = c.notification_settings().unwrap();
    assert_eq!(
        (s.last().0, s.last().1),
        ("GET".into(), "/notifications/settings".into())
    );
    assert_eq!(n.time_zone, "Europe/London");
    assert!(n.email_enabled && !n.digest_enabled);

    s.reply(
        200,
        json!({ "timeZone": "Europe/London", "emailEnabled": false, "defaultReminderTime": "09:00",
                "digestEnabled": true, "digestTime": "07:30" }),
    );
    let n = c
        .update_notification_settings(&NotificationSettingsPatch {
            email_enabled: Some(false),
            digest_enabled: Some(true),
            digest_time: Some("07:30".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(s.last().0, "PATCH");
    assert_eq!(s.last().1, "/notifications/settings");
    assert_eq!(
        s.last().2,
        json!({ "emailEnabled": false, "digestEnabled": true, "digestTime": "07:30" })
    );
    assert_eq!(n.digest_time, "07:30");

    s.reply(400, json!({ "error": "Invalid time zone" }));
    let bad = NotificationSettingsPatch {
        time_zone: Some("Mars/Base".into()),
        ..Default::default()
    };
    match c.update_notification_settings(&bad) {
        Err(ApiError::Http {
            status: 400,
            message,
            ..
        }) => assert_eq!(message, "Invalid time zone"),
        e => panic!("{e:?}"),
    }
}

#[test]
fn connected_apps_list_and_disconnect() {
    let (c, s) = client();
    s.reply(
        200,
        json!([
            { "clientId": "c 1", "name": "ChatGPT", "clientUri": "https://chatgpt.com", "kind": "dcr",
              "scopes": ["notes:read", "notes:write"], "connectedAt": "2026-11-01T10:00:00Z",
              "lastUsedAt": "2026-11-20T10:00:00Z" },
            { "clientId": "c2", "name": "Claude", "clientUri": null, "kind": "cimd",
              "scopes": ["notes:read"], "connectedAt": "2026-11-02T10:00:00Z", "lastUsedAt": null }
        ]),
    );
    let apps = c.connected_apps().unwrap();
    assert_eq!(s.last().1, "/me/connected-apps");
    assert_eq!(apps.len(), 2);
    assert_eq!(apps[0].scopes, vec!["notes:read", "notes:write"]);
    assert_eq!(
        apps[0].last_used_at.as_deref(),
        Some("2026-11-20T10:00:00Z")
    );
    assert_eq!(apps[1].client_uri, None);
    assert_eq!(apps[1].last_used_at, None);

    s.reply(200, json!({ "ok": true }));
    c.disconnect_app("c 1").unwrap();
    assert_eq!(s.last().0, "DELETE");
    assert_eq!(s.last().1, "/me/connected-apps/c%201");

    s.reply(404, json!({ "error": "That app isn’t connected" }));
    match c.disconnect_app("c 1") {
        Err(ApiError::Http { status: 404, .. }) => {}
        e => panic!("{e:?}"),
    }
}
