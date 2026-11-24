//! Inbox, public share link and account deletion in the Core API (docs: "For apple: inbox,
//! share link, delete account"). Online only, like the account calls: offline they throw
//! `CoreError::Network` and change nothing.

use nv_api as api;

use crate::{Core, CoreError};

/// One in-app notification.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct AppNotification {
    pub id: String,
    /// "mention", "assigned", "shared", "comment", "reminder", "invite" or "other".
    pub kind: String,
    pub workspace_id: Option<String>,
    /// The user who caused it; none for system ones (reminders).
    pub actor_id: Option<String>,
    pub title: String,
    pub body: String,
    /// The web path to open, e.g. "/w/<ws>/p/<page>".
    pub link: Option<String>,
    /// The page it is about (from the server's `data.pageId`), if any.
    pub page_id: Option<String>,
    /// The task it is about (from `data.taskId`), if any.
    pub task_id: Option<String>,
    /// ISO instant; also the cursor for `notifications(before:)`.
    pub created_at: String,
    /// ISO instant; none while unread.
    pub read_at: Option<String>,
    pub is_read: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct NotificationPage {
    /// Newest first.
    pub items: Vec<AppNotification>,
    /// Unread count of the whole inbox, not only this page.
    pub unread: u32,
    /// Pass as `before` for the next older page; none when this page was the last.
    pub next_before: Option<String>,
}

/// A page's "anyone with the link can view" link.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageShareLink {
    /// The public address, `<app origin>/s/<token>`.
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct DeletionWorkspace {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TransferredWorkspace {
    pub id: String,
    pub name: String,
    pub new_owner_name: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct AccountDeletionPreview {
    /// Owned with nobody to hand over to: deleted for everyone.
    pub deleted_workspaces: Vec<DeletionWorkspace>,
    /// Owned, no other owner: the longest-standing admin becomes owner.
    pub transferred_workspaces: Vec<TransferredWorkspace>,
    /// Owned together with another owner, who carries on.
    pub shared_ownership: Vec<DeletionWorkspace>,
    /// Owned by someone else: the user is removed from them.
    pub left_workspaces: Vec<DeletionWorkspace>,
    /// Private notebooks the user created, deleted with everything in them.
    pub private_notebooks: u32,
}

fn notification(n: api::AppNotification) -> AppNotification {
    let field = |k: &str| {
        n.data
            .as_ref()
            .and_then(|d| d.get(k))
            .and_then(|v| v.as_str())
            .map(String::from)
    };
    AppNotification {
        page_id: field("pageId"),
        task_id: field("taskId"),
        is_read: n.read_at.is_some(),
        id: n.id,
        kind: n.kind,
        workspace_id: n.workspace_id,
        actor_id: n.actor_id,
        title: n.title,
        body: n.body,
        link: n.link,
        created_at: n.created_at,
        read_at: n.read_at,
    }
}

fn ws(w: api::WorkspaceRef) -> DeletionWorkspace {
    DeletionWorkspace {
        id: w.id,
        name: w.name,
    }
}

fn count(n: u64) -> u32 {
    n.min(u32::MAX as u64) as u32
}

#[uniffi::export]
impl Core {
    /// The inbox, newest first. `limit` 1 to 100 (default 30); `before` is the previous page's
    /// `next_before`.
    #[uniffi::method(default(limit = None, before = None))]
    pub fn notifications(
        &self,
        limit: Option<u32>,
        before: Option<String>,
    ) -> Result<NotificationPage, CoreError> {
        let l = self.api.notifications(limit, before.as_deref())?;
        let asked = limit.unwrap_or(30).clamp(1, 100) as usize;
        let items: Vec<AppNotification> = l.items.into_iter().map(notification).collect();
        let next_before = if items.len() >= asked {
            items.last().map(|n| n.created_at.clone())
        } else {
            None
        };
        Ok(NotificationPage {
            items,
            unread: count(l.unread),
            next_before,
        })
    }

    /// How many notifications are unread (the bell badge). One light request.
    pub fn unread_notification_count(&self) -> Result<u32, CoreError> {
        Ok(count(self.api.notifications(Some(1), None)?.unread))
    }

    /// Mark one read. Idempotent; an unknown id is ignored.
    pub fn mark_notification_read(&self, id: String) -> Result<(), CoreError> {
        Ok(self.api.mark_notification_read(&id)?)
    }

    /// Mark every notification read.
    pub fn mark_all_notifications_read(&self) -> Result<(), CoreError> {
        Ok(self.api.mark_all_notifications_read()?)
    }

    /// The page's public link, none when sharing by link is off. 403 without sharing rights,
    /// 409 for a locked page.
    pub fn page_share_link(&self, page_id: String) -> Result<Option<PageShareLink>, CoreError> {
        Ok(self
            .api
            .page_link(&page_id)?
            .map(|url| PageShareLink { url }))
    }

    /// Turn the link on (the same link if it already is). Anyone with it can read the page
    /// without signing in.
    pub fn create_page_share_link(&self, page_id: String) -> Result<PageShareLink, CoreError> {
        Ok(PageShareLink {
            url: self.api.create_page_link(&page_id)?,
        })
    }

    /// Turn the link off: it stops working at once; turning it on again gives a new one.
    pub fn delete_page_share_link(&self, page_id: String) -> Result<(), CoreError> {
        Ok(self.api.delete_page_link(&page_id)?)
    }

    /// What deleting the account would do to the user's workspaces and private notebooks.
    pub fn account_deletion_preview(&self) -> Result<AccountDeletionPreview, CoreError> {
        let p = self.api.account_deletion_preview()?;
        Ok(AccountDeletionPreview {
            deleted_workspaces: p.deleted_workspaces.into_iter().map(ws).collect(),
            transferred_workspaces: p
                .transferred_workspaces
                .into_iter()
                .map(|w| TransferredWorkspace {
                    id: w.id,
                    name: w.name,
                    new_owner_name: w.new_owner_name,
                })
                .collect(),
            shared_ownership: p.shared_ownership.into_iter().map(ws).collect(),
            left_workspaces: p.left_workspaces.into_iter().map(ws).collect(),
            private_notebooks: count(p.private_notebooks),
        })
    }

    /// Delete the account for good, after re-entering the password. On success this signs out
    /// the same way `sign_out` does (tokens dropped, on-device store cleared): the app returns
    /// to its sign-in screen. A wrong password is `CoreError::Server` status 401, code
    /// `wrong_password`, and nothing changes (stay signed in). Rate limited (429).
    pub fn delete_account(&self, password: String) -> Result<(), CoreError> {
        self.api.delete_account(&password)?;
        self.sign_out();
        Ok(())
    }
}
