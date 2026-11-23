//! Locked pages: the locked-notes password, unlocking and relocking, device (biometric)
//! secrets, and locking a page. The truth is the server: `server/routes/locks.ts` and
//! `server/locks.ts` (the web's side is `src/lib/lockedNotes.ts`).
//!
//! **Passwords.** The password and device secret only travel in the body of the one request
//! that needs them. Nothing here keeps, logs or echoes them (`Request`'s `Debug` hides bodies).

use serde_json::{json, Value};

use crate::*;

impl Client {
    /// The locked-notes status of this sign-in (GET /locked-notes).
    pub fn locked_notes(&self) -> Result<LockedNotes, ApiError> {
        self.call("GET", "/locked-notes", None)
    }

    /// Set the locked-notes password, or change it (`current` required then): POST
    /// /locked-notes/password. Every unlock and device secret ends; this sign-in is unlocked.
    /// Answers when the unlock lapses.
    pub fn set_locked_password(
        &self,
        password: &str,
        current: Option<&str>,
    ) -> Result<Option<String>, ApiError> {
        let mut body = json!({ "password": password });
        if let Some(c) = current {
            body["currentPassword"] = json!(c);
        }
        let v: Value = self.call("POST", "/locked-notes/password", Some(&body))?;
        Ok(v["expiresAt"].as_str().map(String::from))
    }

    /// Unlock this sign-in's locked pages with the password (POST /locked-notes/unlock).
    /// Answers when the unlock lapses without activity.
    pub fn unlock_locked(&self, password: &str) -> Result<String, ApiError> {
        let v: Value = self.call(
            "POST",
            "/locked-notes/unlock",
            Some(&json!({ "password": password })),
        )?;
        expires(&v)
    }

    /// Unlock with a device secret (Face ID / Touch ID), from the same app install that set it up.
    pub fn unlock_locked_with_device(
        &self,
        device_id: &str,
        secret: &str,
        install_id: &str,
    ) -> Result<String, ApiError> {
        let v: Value = self.call(
            "POST",
            "/locked-notes/unlock",
            Some(&json!({ "deviceId": device_id, "secret": secret, "installId": install_id })),
        )?;
        expires(&v)
    }

    /// "Lock now" for this sign-in (POST /locked-notes/lock).
    pub fn relock(&self) -> Result<(), ApiError> {
        let _: Value = self.call("POST", "/locked-notes/lock", Some(&json!({})))?;
        Ok(())
    }

    /// Activity while unlocked pushes the relock back (POST /locked-notes/keepalive):
    /// `(unlocked, expires_at)`.
    pub fn locked_keepalive(&self) -> Result<(bool, Option<String>), ApiError> {
        let v: Value = self.call("POST", "/locked-notes/keepalive", Some(&json!({})))?;
        Ok((
            v["unlocked"].as_bool().unwrap_or(false),
            v["expiresAt"].as_str().map(String::from),
        ))
    }

    /// A device secret for biometric unlock, handed out once and only to an unlocked sign-in
    /// (POST /locked-notes/devices). `install_id` is a random id of at least 16 characters the
    /// app keeps per install.
    pub fn create_lock_device(
        &self,
        install_id: &str,
        label: Option<&str>,
    ) -> Result<NewLockDevice, ApiError> {
        let mut body = json!({ "installId": install_id });
        if let Some(l) = label {
            body["label"] = json!(l);
        }
        self.call("POST", "/locked-notes/devices", Some(&body))
    }

    /// Forget a device secret (DELETE /locked-notes/devices/:id).
    pub fn delete_lock_device(&self, device_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/locked-notes/devices/{}", encode_component(device_id)),
            None,
        )?;
        Ok(())
    }

    /// Lock a page (POST /pages/:id/lock): needs a locked-notes password, edit access, and a
    /// page nobody else can see. The caller becomes its owner.
    pub fn lock_page(&self, page_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "POST",
            &format!("/pages/{}/lock", encode_component(page_id)),
            Some(&json!({})),
        )?;
        Ok(())
    }

    /// Remove a page's lock (POST /pages/:id/lock/remove; its owner, with the password).
    pub fn remove_page_lock(&self, page_id: &str, password: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "POST",
            &format!("/pages/{}/lock/remove", encode_component(page_id)),
            Some(&json!({ "password": password })),
        )?;
        Ok(())
    }
}

fn expires(v: &Value) -> Result<String, ApiError> {
    v["expiresAt"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| ApiError::Decode("no expiresAt".into()))
}
