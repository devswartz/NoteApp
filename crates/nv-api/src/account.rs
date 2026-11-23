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
