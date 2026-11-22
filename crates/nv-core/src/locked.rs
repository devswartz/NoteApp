//! Locked pages in the Core API (docs/rewrite/status/core.md, "For apple: locked pages"): the
//! one locked-notes password, unlocking this sign-in (password or Face ID / Touch ID device
//! secret), locking again, and locking a page. The rules and every check are the server's
//! (`server/locks.ts`, `server/routes/locks.ts`); the web's side is `src/lib/lockedNotes.ts`.
//!
//! A page is **locked, not encrypted**: the server withholds its content (document, versions,
//! comments, files, task text) until its owner unlocks **this sign-in** (the refresh-token
//! family). The unlock lapses after `idle_ms` (5 minutes) without activity; `keep_unlocked`,
//! and edits on an open locked page, push it back; `lock_now`, sign-out and a password change
//! end it. When it ends the server closes the locked pages' sockets with 4403, which ends a
//! `LivePage` with `LiveEnd::NoAccess`.
//!
//! **What is never stored.**
//! - The password and device secret: never kept, never logged (`nv_api::Request`'s `Debug`
//!   hides bodies; `NewUnlockDevice`'s hides the secret). The one device secret is returned
//!   once for the app's keychain.
//! - The content of a locked page, unlocked or not: the page document, queued edits and queued
//!   task changes of a page a stored tree shows locked are refused by `nv-store`, and live edits
//!   of an unlocked page stay in memory.
//! - Task titles and text of locked pages: the server sends them in full while the sign-in is
//!   unlocked; `nv-store` redacts them (title "Locked task", no text or tags, `locked: true`)
//!   before they are written. The call that fetched them still returns them in full.
//!
//! While this core believes the sign-in may be unlocked (`unlocked` below) it first refreshes
//! the workspace's tree before it stores tasks, a page document or opens a page, so a page
//! locked from another device is recognised as locked.

use std::sync::atomic::Ordering;

use nv_api as api;

use crate::{Core, CoreError};

/// A device that can unlock with Face ID / Touch ID.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct UnlockDevice {
    pub id: String,
    /// The label the app gave it ("iPhone").
    pub label: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    /// A device secret lapses after 30 days; set the device up again with the password.
    pub expires_at: String,
}

/// The locked-notes status of this sign-in.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LockedNotesStatus {
    /// A locked-notes password is set (there is one per account, separate from the sign-in password).
    pub has_password: bool,
    /// This sign-in has the account's locked pages unlocked now.
    pub unlocked: bool,
    /// When the unlock lapses if nothing happens (ISO instant); none when locked.
    pub expires_at: Option<String>,
    /// Idle time after which locked pages lock again, in milliseconds (5 minutes).
    pub idle_ms: u64,
    /// How many pages the account has locked.
    pub locked_pages: u32,
    /// Wrong tries in a row.
    pub failures: u32,
    /// Unlocking is refused until then (ISO instant) after 5 wrong tries in a row; none: it is not.
    pub blocked_until: Option<String>,
    /// Wrong tries left before unlocking is paused (15 minutes, doubling).
    pub tries_before_lockout: u32,
    pub devices: Vec<UnlockDevice>,
}

/// A new device secret for biometric unlock. Handed out **once**: keep `secret` in the keychain
/// behind biometrics and send it back with `unlock_locked_notes_with_device`. Its `Debug` hides
/// the secret.
#[derive(Clone, PartialEq, uniffi::Record)]
pub struct NewUnlockDevice {
    pub id: String,
    pub secret: String,
    /// ISO instant, 30 days out.
    pub expires_at: String,
}

impl std::fmt::Debug for NewUnlockDevice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewUnlockDevice")
            .field("id", &self.id)
            .field("secret", &"<hidden>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// The answer of a keep-alive.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LockKeepalive {
    /// False: it lapsed (or was never unlocked); unlock again.
    pub unlocked: bool,
    pub expires_at: Option<String>,
}

fn status(s: api::LockedNotes) -> LockedNotesStatus {
    LockedNotesStatus {
        has_password: s.has_password,
        unlocked: s.unlocked,
        expires_at: s.expires_at,
        idle_ms: s.idle_ms,
        locked_pages: s.locked_pages,
        failures: s.failures,
        blocked_until: s.blocked_until,
        tries_before_lockout: s.tries_before_lockout,
        devices: s
            .devices
            .into_iter()
            .map(|d| UnlockDevice {
                id: d.id,
                label: d.label,
                created_at: d.created_at,
                last_used_at: d.last_used_at,
                expires_at: d.expires_at,
            })
            .collect(),
    }
}

impl Core {
    /// Whether this core thinks the sign-in may be unlocked right now.
    pub(crate) fn maybe_unlocked(&self) -> bool {
        self.maybe_unlocked.load(Ordering::SeqCst)
    }

    /// While the sign-in may be unlocked, fetch the tree of `workspace` again and store it, so
    /// that a page locked elsewhere is known to be locked before anything of it is stored.
    pub(crate) fn refresh_lock_knowledge(&self, workspace: Option<String>) {
        if self.maybe_unlocked() && self.store.is_some() {
            self.refresh_tree(workspace);
        }
    }

    /// The workspace a stored tree shows a page in.
    pub(crate) fn page_workspace(&self, page_id: &str) -> Option<String> {
        self.workspace_of("page", page_id)
    }
}

#[uniffi::export]
impl Core {
    /// The locked-notes status of this sign-in: whether a password is set, whether it is unlocked
    /// and until when, the lockout state, the Face ID devices. Also tells this core whether to
    /// treat locked pages as unlocked (see the module docs).
    pub fn locked_notes_status(&self) -> Result<LockedNotesStatus, CoreError> {
        let s = self.api.locked_notes()?;
        self.maybe_unlocked.store(s.unlocked, Ordering::SeqCst);
        Ok(status(s))
    }

    /// Set the locked-notes password (6 to 72 bytes), or change it when one is set
    /// (`current_password` is then required, and wrong tries count towards the lockout). It is
    /// separate from the sign-in password. Changing it locks every sign-in and removes every
    /// device; this sign-in is unlocked. Answers when the unlock lapses (ISO instant).
    #[uniffi::method(default(current_password = None))]
    pub fn set_locked_notes_password(
        &self,
        password: String,
        current_password: Option<String>,
    ) -> Result<Option<String>, CoreError> {
        let r = self
            .api
            .set_locked_password(&password, current_password.as_deref())?;
        self.maybe_unlocked.store(true, Ordering::SeqCst);
        Ok(r)
    }

    /// Unlock this sign-in's locked pages with the password. Answers when it lapses without
    /// activity (ISO instant, 5 minutes on). Wrong password: `Server` 400 with code
    /// `wrong_password` and the tries left in the message; after 5 in a row 429 `locked_out` (the
    /// owner is emailed); no password set: 409 `no_lock_password`. The password is sent and
    /// forgotten.
    pub fn unlock_locked_notes(&self, password: String) -> Result<String, CoreError> {
        let r = self.api.unlock_locked(&password)?;
        self.maybe_unlocked.store(true, Ordering::SeqCst);
        Ok(r)
    }

    /// Unlock with a device secret (Face ID / Touch ID: the app reads `secret` from the
    /// keychain after the biometric check). `install_id` is the random id (16 characters or
    /// more) the app kept when it called `register_unlock_device`. A secret the server no
    /// longer accepts (another sign-in, another install, expired, password changed) is `Server`
    /// 401 with code `device_revoked`: ask for the password instead (this counts as a wrong try).
    pub fn unlock_locked_notes_with_device(
        &self,
        device_id: String,
        secret: String,
        install_id: String,
    ) -> Result<String, CoreError> {
        let r = self
            .api
            .unlock_locked_with_device(&device_id, &secret, &install_id)?;
        self.maybe_unlocked.store(true, Ordering::SeqCst);
        Ok(r)
    }

    /// Set up Face ID / Touch ID: needs this sign-in unlocked with the password (403 `locked`
    /// otherwise). Returns the device secret once; keep it in the keychain behind biometrics.
    /// One device per sign-in and `install_id`: setting up again replaces it.
    #[uniffi::method(default(label = None))]
    pub fn register_unlock_device(
        &self,
        install_id: String,
        label: Option<String>,
    ) -> Result<NewUnlockDevice, CoreError> {
        let d = self.api.create_lock_device(&install_id, label.as_deref())?;
        Ok(NewUnlockDevice {
            id: d.id,
            secret: d.secret,
            expires_at: d.expires_at,
        })
    }

    /// Forget a device (Face ID turned off for it).
    pub fn remove_unlock_device(&self, device_id: String) -> Result<(), CoreError> {
        Ok(self.api.delete_lock_device(&device_id)?)
    }

    /// "Lock now": locked pages lock again for this sign-in; the server closes their open
    /// sockets (4403, `LiveEnd::NoAccess`). Close open locked pages yourself as well.
    pub fn lock_locked_notes(&self) -> Result<(), CoreError> {
        self.api.relock()?;
        self.maybe_unlocked.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Activity while unlocked pushes the lapse back (the server does this itself while a locked
    /// page is being edited). Call it about every minute while a locked page is on screen.
    pub fn keep_locked_notes_unlocked(&self) -> Result<LockKeepalive, CoreError> {
        let (unlocked, expires_at) = self.api.locked_keepalive()?;
        self.maybe_unlocked.store(unlocked, Ordering::SeqCst);
        Ok(LockKeepalive {
            unlocked,
            expires_at,
        })
    }

    /// Lock a page. Needs a locked-notes password (409 `no_lock_password`), edit access, and a
    /// page **only you can see** (a private notebook nobody else is shared into, or a workspace
    /// with no other member, and not shared page by page: 403 `not_private` otherwise). You become
    /// its owner: nobody else, admins included, can see it any more. Its stored document, queued
    /// edits and queued task changes are dropped from the device and its stored tasks redacted;
    /// the stored tree is refreshed. Open pages of it close (4403).
    pub fn lock_page(&self, page_id: String) -> Result<(), CoreError> {
        let ws = self.page_workspace(&page_id);
        self.api.lock_page(&page_id)?;
        if let Some(store) = &self.store {
            let _ = store.mark_page_locked(&page_id);
        }
        self.refresh_tree(ws);
        Ok(())
    }

    /// Remove a page's lock (its owner, with the password: 404 for anyone else; a wrong password
    /// counts towards the lockout). The page is ordinary again, and the stored tree is refreshed.
    pub fn remove_page_lock(&self, page_id: String, password: String) -> Result<(), CoreError> {
        let ws = self.page_workspace(&page_id);
        self.api.remove_page_lock(&page_id, &password)?;
        self.refresh_tree(ws);
        Ok(())
    }
}
