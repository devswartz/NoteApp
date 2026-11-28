//! The signed-in account: profile, password, notification settings and connected apps. The truth
//! is the server: `server/routes/auth.ts` (`/me`, `/me/password`), `server/routes/reminders.ts`
//! (`/notifications/settings`) and `server/oauth/routes.ts` (`/me/connected-apps`); the web's
//! callers are `src/components/AccountSettings.tsx` and the Settings pages.

use serde_json::{json, Value};

use crate::*;

/// The message the server answers (400) for a wrong current password; it has no code for it.
const WRONG_PASSWORD: &str = "Your current password is incorrect";

impl Client {
    /// Change the name and/or colour (PATCH /me); answers the user as saved. The client's own
    /// copy of the user is updated.
    pub fn update_profile(
        &self,
        name: Option<&str>,
        color: Option<&str>,
    ) -> Result<User, ApiError> {
        let mut body = json!({});
        if let Some(n) = name {
            body["name"] = json!(n);
        }
        if let Some(c) = color {
            body["color"] = json!(c);
        }
        let u: User = self.call("PATCH", "/me", Some(&body))?;
        self.set_user(&u);
        Ok(u)
    }

    /// Change the password (POST /me/password). The server signs out every other device and
    /// answers a fresh session for this one, which the client adopts: store the new refresh
    /// token. A wrong current password is a 400 with code `wrong_password` (the server sends no
    /// code of its own).
    pub fn change_password(&self, current: &str, new: &str) -> Result<AuthSession, ApiError> {
        let s: AuthSession = self
            .call(
                "POST",
                "/me/password",
                Some(&json!({ "currentPassword": current, "newPassword": new })),
            )
            .map_err(|e| match e {
                ApiError::Http {
                    status: 400,
                    message,
                    code: None,
                    request_id,
                } if message == WRONG_PASSWORD => ApiError::Http {
                    status: 400,
                    message,
                    code: Some("wrong_password".into()),
                    request_id,
                },
                e => e,
            })?;
        self.adopt(&s);
        Ok(s)
    }

    /// The reminder and email settings (GET /notifications/settings).
    pub fn notification_settings(&self) -> Result<NotificationSettings, ApiError> {
        self.call("GET", "/notifications/settings", None)
    }

    /// Change some of them (PATCH /notifications/settings); answers all as saved.
    pub fn update_notification_settings(
        &self,
        patch: &NotificationSettingsPatch,
    ) -> Result<NotificationSettings, ApiError> {
        let body = serde_json::to_value(patch).map_err(|e| ApiError::Decode(e.to_string()))?;
        self.call("PATCH", "/notifications/settings", Some(&body))
    }

    /// The AI apps the user has connected (GET /me/connected-apps).
    pub fn connected_apps(&self) -> Result<Vec<ConnectedApp>, ApiError> {
        self.call("GET", "/me/connected-apps", None)
    }

    /// Disconnect an app and revoke its tokens (DELETE /me/connected-apps/:clientId); 404 when
    /// it isn't connected.
    pub fn disconnect_app(&self, client_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/me/connected-apps/{}", encode_component(client_id)),
            None,
        )?;
        Ok(())
    }
}

impl Client {
    /// Send a new confirmation email, the older link stops working (POST
    /// /auth/resend-verification; the one call an unverified account may make besides GET /me).
    /// Rate limited by the server (429: one a minute, five an hour).
    pub fn resend_verification(&self) -> Result<VerificationSent, ApiError> {
        self.call("POST", "/auth/resend-verification", Some(&json!({})))
    }

    /// Send feedback to the instance's admins (POST /feedback), with the body the web sends:
    /// `message` (1 to 4000 characters), `page` (an in-app path such as `/w/<id>`, no query),
    /// and `client` {version, platform}.
    pub fn send_feedback(
        &self,
        message: &str,
        page: Option<&str>,
        client_version: &str,
        platform: &str,
    ) -> Result<FeedbackSent, ApiError> {
        let mut body = json!({
            "message": message,
            "client": { "version": client_version, "platform": platform },
        });
        if let Some(p) = page.filter(|p| !p.is_empty()) {
            body["page"] = json!(p);
        }
        self.call("POST", "/feedback", Some(&body))
    }

    /// The caller's own data as a zip (GET /me/export): 403 `locked` while locked notes are
    /// locked, 429 when asked too often.
    pub fn export_my_data(&self) -> Result<DataExport, ApiError> {
        let url = format!("{}/api/me/export", self.base);
        let send = |bearer: String| {
            self.transport
                .download_authed(&AuthedDownloadRequest {
                    url: url.clone(),
                    bearer,
                })
                .map_err(ApiError::Network)
        };
        let mut res = send(self.access_token()?)?;
        if res.status == 401 {
            let token = self.refresh()?.access_token;
            res = send(token)?;
        }
        if !(200..300).contains(&res.status) {
            // The error is JSON: read it like any other answer.
            return Err(Self::decode::<Value>(Response {
                status: res.status,
                body: String::from_utf8_lossy(&res.body).into_owned(),
                request_id: res.request_id,
            })
            .err()
            .unwrap_or_else(|| ApiError::Decode("export failed".into())));
        }
        let filename = res
            .content_disposition
            .as_deref()
            .and_then(disposition_name);
        Ok(DataExport {
            bytes: res.body,
            filename,
        })
    }
}

/// The file name in a `Content-Disposition` header: `filename*=UTF-8''...` first, else
/// `filename="..."` or an unquoted `filename=...`. Only the last path component is kept, so a
/// server cannot point a save outside the chosen folder.
fn disposition_name(cd: &str) -> Option<String> {
    let lower = cd.to_ascii_lowercase();
    let name = star_name(cd, &lower).or_else(|| plain_name(cd, &lower))?;
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    (!base.is_empty() && base != "." && base != "..").then(|| base.to_string())
}

fn star_name(cd: &str, lower: &str) -> Option<String> {
    let key = "filename*=utf-8''";
    let i = lower.find(key)?;
    let rest = &cd[i + key.len()..];
    let raw = rest.split(';').next().unwrap_or("").trim();
    let mut out = Vec::new();
    let b = raw.as_bytes();
    let mut k = 0;
    while k < b.len() {
        if b[k] == b'%' && k + 2 < b.len() {
            let hex = std::str::from_utf8(&b[k + 1..k + 3]).unwrap_or("");
            if hex.bytes().all(|c| c.is_ascii_hexdigit()) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    k += 3;
                    continue;
                }
            }
        }
        out.push(b[k]);
        k += 1;
    }
    String::from_utf8(out).ok().filter(|s| !s.is_empty())
}

fn plain_name(cd: &str, lower: &str) -> Option<String> {
    let key = "filename=";
    let i = lower.find(key)? + key.len();
    let rest = cd[i..].trim_start();
    let name = match rest.strip_prefix('"') {
        Some(q) => &q[..q.find('"')?],
        None => rest.split(';').next().unwrap_or("").trim(),
    };
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::disposition_name;

    #[test]
    fn file_names_from_content_disposition() {
        let n = |s| disposition_name(s);
        assert_eq!(
            n("attachment; filename=\"a.zip\"; filename*=UTF-8''Notivelo%20data%20-%20%C3%85.zip"),
            Some("Notivelo data - Å.zip".into())
        );
        assert_eq!(
            n("attachment; filename=\"a b.zip\""),
            Some("a b.zip".into())
        );
        assert_eq!(
            n("attachment; filename=data.zip; size=3"),
            Some("data.zip".into())
        );
        assert_eq!(
            n("attachment; filename=\"../../x.zip\""),
            Some("x.zip".into())
        );
        assert_eq!(n("attachment; filename=\"..\""), None);
        assert_eq!(n("attachment"), None);
    }
}
