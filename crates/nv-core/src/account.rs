//! The account in the Core API (docs/rewrite/status/core.md, "For apple, windows and android:
//! account and settings"): profile, password, notification settings and connected AI apps. Each
//! call mirrors a route of today's server (`server/routes/auth.ts`, `reminders.ts`,
//! `server/oauth/routes.ts`; the web's side is `src/components/AccountSettings.tsx`).
//!
//! **Online only**, like the tree calls: nothing is queued; offline they throw
//! `CoreError::Network` and change nothing. Nothing here is stored on the device.
//!
//! The server has no avatar image (an avatar is the user's colour), no calendar task filters
//! (the web keeps them in the page URL) and no way to list the sign-ins of an account.

use nv_api as api;

use crate::{user, Core, CoreError, SignedIn, User};

/// Reminder and email settings.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct NotificationSettings {
    /// IANA time zone, e.g. "Europe/London": due dates and times are read in it.
    pub time_zone: String,
    pub email_enabled: bool,
    /// HH:mm for "before" reminders on tasks with a due date but no time.
    pub default_reminder_time: String,
    /// A daily email listing today's tasks.
    pub digest_enabled: bool,
    /// HH:mm, local time, the digest is sent at.
    pub digest_time: String,
}

/// What to change in the notification settings: a field left none stays as it is.
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct NotificationSettingsChange {
    pub time_zone: Option<String>,
    pub email_enabled: Option<bool>,
    pub default_reminder_time: Option<String>,
    pub digest_enabled: Option<bool>,
    pub digest_time: Option<String>,
}

/// An AI app (a connector such as ChatGPT or Claude) the user allowed to read or write notes.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ConnectedApp {
    /// What `disconnect_app` takes.
    pub client_id: String,
    pub name: String,
    pub client_uri: Option<String>,
    /// "notes:read" and/or "notes:write".
    pub scopes: Vec<String>,
    /// When it was connected (ISO instant).
    pub connected_at: String,
    /// When it last used the connection (ISO instant); none if never.
    pub last_used_at: Option<String>,
}

fn settings(s: api::NotificationSettings) -> NotificationSettings {
    NotificationSettings {
        time_zone: s.time_zone,
        email_enabled: s.email_enabled,
        default_reminder_time: s.default_reminder_time,
        digest_enabled: s.digest_enabled,
        digest_time: s.digest_time,
    }
}

#[uniffi::export]
impl Core {
    /// The signed-in user as the server has it now (`user()` is the copy from sign-in).
    pub fn profile(&self) -> Result<User, CoreError> {
        Ok(user(self.api.me()?))
    }

    /// Change the display name (1 to 100 characters, else 400) and/or the avatar colour
    /// (`#rrggbb`; anything else is ignored by the server). Answers the user as saved; `user()`
    /// follows. Members of the user's workspaces see it live.
    pub fn update_profile(
        &self,
        name: Option<String>,
        color: Option<String>,
    ) -> Result<User, CoreError> {
        Ok(user(
            self.api.update_profile(name.as_deref(), color.as_deref())?,
        ))
    }

    /// Change the sign-in password (at least 8 characters, else 400). The server signs out every
    /// other device and every connected app, and this sign-in gets a fresh session: **store the
    /// returned `refresh_token`** (the old one no longer works). Locked pages lock again. A wrong
    /// current password is `CoreError::Server` with status 400 and code `wrong_password`.
    pub fn change_password(
        &self,
        current_password: String,
        new_password: String,
    ) -> Result<SignedIn, CoreError> {
        let s = self.api.change_password(&current_password, &new_password)?;
        self.maybe_unlocked
            .store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(self.signed_in(s))
    }

    /// The reminder and email settings.
    pub fn notification_settings(&self) -> Result<NotificationSettings, CoreError> {
        Ok(settings(self.api.notification_settings()?))
    }

    /// Change some of the settings; answers all of them as saved. 400 for a time zone or an
    /// HH:mm time the server doesn't accept. Changing the time zone or default time recomputes
    /// the user's reminders.
    pub fn update_notification_settings(
        &self,
        change: NotificationSettingsChange,
    ) -> Result<NotificationSettings, CoreError> {
        let patch = api::NotificationSettingsPatch {
            time_zone: change.time_zone,
            email_enabled: change.email_enabled,
            default_reminder_time: change.default_reminder_time,
            digest_enabled: change.digest_enabled,
            digest_time: change.digest_time,
        };
        Ok(settings(self.api.update_notification_settings(&patch)?))
    }

    /// The AI apps the user has connected.
    pub fn connected_apps(&self) -> Result<Vec<ConnectedApp>, CoreError> {
        Ok(self
            .api
            .connected_apps()?
            .into_iter()
            .map(|a| ConnectedApp {
                client_id: a.client_id,
                name: a.name,
                client_uri: a.client_uri,
                scopes: a.scopes,
                connected_at: a.connected_at,
                last_used_at: a.last_used_at,
            })
            .collect())
    }

    /// Disconnect an app: its tokens stop working at once. 404 when it isn't connected (already
    /// disconnected elsewhere).
    pub fn disconnect_app(&self, client_id: String) -> Result<(), CoreError> {
        Ok(self.api.disconnect_app(&client_id)?)
    }
}
