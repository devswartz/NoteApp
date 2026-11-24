//! The notification inbox, the public share link of a page and account deletion. The truth is
//! the server: `server/routes/notifications.ts`, `server/routes/pageLinks.ts` and
//! `server/routes/auth.ts` (`/auth/account`).

use serde_json::{json, Value};

use crate::*;

impl Client {
    /// The inbox, newest first (GET /notifications?limit=&before=). `before` is a `createdAt`
    /// to page back from. The server caps `limit` at 100 (default 30).
    pub fn notifications(
        &self,
        limit: Option<u32>,
        before: Option<&str>,
    ) -> Result<NotificationList, ApiError> {
        let mut path = String::from("/notifications");
        let mut sep = '?';
        if let Some(l) = limit {
            path.push_str(&format!("{sep}limit={l}"));
            sep = '&';
        }
        if let Some(b) = before {
            path.push_str(&format!("{sep}before={}", encode_component(b)));
        }
        self.call("GET", &path, None)
    }

    /// POST /notifications/:id/read (a notification that isn't yours is ignored).
    pub fn mark_notification_read(&self, id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "POST",
            &format!("/notifications/{}/read", encode_component(id)),
            Some(&json!({})),
        )?;
        Ok(())
    }

    /// POST /notifications/read-all.
    pub fn mark_all_notifications_read(&self) -> Result<(), ApiError> {
        let _: Value = self.call("POST", "/notifications/read-all", Some(&json!({})))?;
        Ok(())
    }

    fn link_url(v: Value) -> Option<String> {
        v.get("url").and_then(|u| u.as_str()).map(String::from)
    }

    /// The page's public link (GET /pages/:id/link), none when there is none.
    pub fn page_link(&self, page_id: &str) -> Result<Option<String>, ApiError> {
        let v: Value = self.call(
            "GET",
            &format!("/pages/{}/link", encode_component(page_id)),
            None,
        )?;
        Ok(Self::link_url(v))
    }

    /// Make the link if there is none (PUT /pages/:id/link); answers its URL.
    pub fn create_page_link(&self, page_id: &str) -> Result<String, ApiError> {
        let v: Value = self.call(
            "PUT",
            &format!("/pages/{}/link", encode_component(page_id)),
            Some(&json!({})),
        )?;
        Self::link_url(v).ok_or_else(|| ApiError::Decode("no url in the answer".into()))
    }

    /// Turn the link off (DELETE /pages/:id/link).
    pub fn delete_page_link(&self, page_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/pages/{}/link", encode_component(page_id)),
            None,
        )?;
        Ok(())
    }

    /// What deleting the account would do (GET /auth/account/deletion-preview).
    pub fn account_deletion_preview(&self) -> Result<AccountDeletionPreview, ApiError> {
        self.call("GET", "/auth/account/deletion-preview", None)
    }

    /// Delete the account (DELETE /auth/account with the password in the body). A wrong
    /// password is a 401 with code `wrong_password`. The caller must then sign out locally.
    pub fn delete_account(&self, password: &str) -> Result<(), ApiError> {
        let r: Result<Value, ApiError> = self.call(
            "DELETE",
            "/auth/account",
            Some(&json!({ "password": password })),
        );
        match r {
            Ok(_) => Ok(()),
            Err(ApiError::Http {
                status: 401,
                message,
                code: None,
                request_id,
            }) if message == "Incorrect password" => Err(ApiError::Http {
                status: 401,
                message,
                code: Some("wrong_password".into()),
                request_id,
            }),
            Err(e) => Err(e),
        }
    }
}
