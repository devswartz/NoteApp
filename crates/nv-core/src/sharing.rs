//! Sharing in the Core API (docs/rewrite/status/core.md, "For apple: sharing"): workspace
//! members and invites, notebook shares, page shares and the pages shared with you. Every call
//! mirrors a route of today's server (`server/routes/workspaces.ts`; the web's callers are
//! `src/components/sharing/*`), and the server enforces the permissions: these calls send what
//! was asked and return its refusal as `CoreError::Server` (403 role, 404 gone or not visible,
//! 400 and 409 rules, 410 expired invite).
//!
//! **Online only**, like the tree calls: nothing is queued; offline they throw
//! `CoreError::Network` and change nothing.
//!
//! **The stored data.** After a call that changes what this account can see (leaving a
//! workspace, accepting an invite, changing your own role, sharing a notebook) the core fetches
//! the workspace list or tree again and stores it, so `cached_workspaces` / `cached_tree` follow;
//! a workspace you left is dropped from the store with its tree, tasks and page documents.
//! The core never stores invite links, emails of people you invited, or share lists.

use nv_api as api;

use crate::{Core, CoreError, WorkspaceMember};

/// A pending workspace invite (owners and admins see these).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PendingInvite {
    pub email: String,
    /// owner, admin, member or viewer: what the invitee will be.
    pub role: String,
    /// User id of who invited.
    pub invited_by: Option<String>,
    pub created_at: Option<String>,
    /// When the emailed link stops working (resend for a fresh one), ISO instant.
    pub expires_at: Option<String>,
}

/// The workspace's members and pending invites. `invites` is empty for members and viewers
/// (only owners and admins get them).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct WorkspacePeople {
    pub members: Vec<WorkspaceMember>,
    pub invites: Vec<PendingInvite>,
}

/// What an invite did. `status` is "added" (the person had a confirmed account and is a member
/// now) or "invited" (an invite link was made for them). `emailed` says whether the server
/// could send mail: **a server with no mail set up (a test or self-hosted server) answers
/// `emailed` false, and then `invite_url` is how the invitee gets the invite**: show it to be
/// copied. `invite_url` is none for "added".
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InviteResult {
    pub status: String,
    pub emailed: bool,
    pub invite_url: Option<String>,
}

/// The page a single-page invite is for.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InvitedPage {
    pub id: String,
    pub title: String,
    pub can_edit: bool,
}

/// What an invite link is for, to show before accepting.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InviteInfo {
    pub workspace_id: String,
    pub workspace_name: String,
    pub invited_by_name: String,
    /// The address the invite was sent to: only that account may accept it.
    pub email: String,
    pub role: String,
    pub expired: bool,
    /// Set for an invite to one page: accepting shares that page and adds no membership.
    pub page: Option<InvitedPage>,
}

/// Where an accepted invite led.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct AcceptedInvite {
    pub workspace_id: String,
    /// The shared page, for a single-page invite.
    pub page_id: Option<String>,
}

/// Who a notebook is shared with.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct NotebookShares {
    /// shared (every member sees it) or private (its creator and `user_ids`).
    pub visibility: String,
    /// User id of the notebook's creator, who alone may change the list.
    pub created_by: String,
    pub user_ids: Vec<String>,
}

/// One person a page is shared with.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageShareEntry {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub color: String,
    /// What the share grants. For a workspace member their role still caps it (a viewer only views).
    pub can_edit: bool,
    /// Is a member of the page's workspace.
    pub member: bool,
}

/// A pending invite to a page (someone without an account here yet).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageInviteEntry {
    pub email: String,
    pub can_edit: bool,
    pub expires_at: Option<String>,
    pub created_at: String,
}

/// Who a page is shared with, and its pending invites.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageShares {
    pub shares: Vec<PageShareEntry>,
    pub invites: Vec<PageInviteEntry>,
}

/// What sharing a page did: "shared" (the person has access now) or "invited" (an invite link
/// was made: see `InviteResult` for `emailed` and `invite_url`), and the lists as they are now.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageShareResult {
    pub status: String,
    pub emailed: bool,
    pub invite_url: Option<String>,
    pub shares: PageShares,
}

/// A page someone shared with you.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SharedPageEntry {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub workspace_id: String,
    pub workspace_name: String,
    /// Are you a member of the page's workspace? If not, this page is all you can see there.
    pub member: bool,
    /// What you can do (the share, capped by your role when you are a member).
    pub can_edit: bool,
    pub shared_by_name: Option<String>,
    /// ISO instant.
    pub shared_at: String,
}

fn invite(i: api::PendingInvite) -> PendingInvite {
    PendingInvite {
        email: i.email,
        role: i.role,
        invited_by: i.invited_by,
        created_at: i.created_at,
        expires_at: i.expires_at,
    }
}

fn invite_result(r: api::InviteResult) -> InviteResult {
    InviteResult {
        status: r.status,
        emailed: r.emailed,
        invite_url: r.invite_url,
    }
}

fn page_shares(p: api::PageShares) -> PageShares {
    PageShares {
        shares: p
            .shares
            .into_iter()
            .map(|s| PageShareEntry {
                user_id: s.user_id,
                name: s.name,
                email: s.email,
                color: s.color,
                can_edit: s.can_edit,
                member: s.member,
            })
            .collect(),
        invites: p
            .invites
            .into_iter()
            .map(|i| PageInviteEntry {
                email: i.email,
                can_edit: i.can_edit,
                expires_at: i.expires_at,
                created_at: i.created_at,
            })
            .collect(),
    }
}

fn share_result(r: api::PageShareResult) -> PageShareResult {
    PageShareResult {
        status: r.status,
        emailed: r.emailed,
        invite_url: r.invite_url,
        shares: page_shares(r.lists),
    }
}

impl Core {
    /// Fetch the workspace list again and store it (best effort): after leaving a workspace or
    /// accepting an invite. A workspace that is gone from the list is dropped from the store.
    fn refresh_workspaces(&self) {
        if let (Some(store), Ok(ws)) = (&self.store, self.api.workspaces()) {
            let _ = store.put_workspaces(&ws);
        }
    }

    fn my_id(&self) -> Result<String, CoreError> {
        self.api.user().map(|u| u.id).ok_or(CoreError::SignedOut)
    }
}

#[uniffi::export]
impl Core {
    // ───────── Workspace members and invites ─────────

    /// The workspace's members and (owners and admins only) its pending invites. `members()`
    /// returns the same members without the invites.
    pub fn workspace_people(&self, workspace_id: String) -> Result<WorkspacePeople, CoreError> {
        let l = self.api.member_list(&workspace_id)?;
        Ok(WorkspacePeople {
            members: l
                .members
                .into_iter()
                .map(|m| WorkspaceMember {
                    id: m.id,
                    name: m.name,
                    email: m.email,
                    color: m.color,
                    role: m.role,
                })
                .collect(),
            invites: l.invites.into_iter().map(invite).collect(),
        })
    }

    /// Invite someone by email, as owner or admin (only an owner may invite an owner). `role` is
    /// owner, admin, member (the default) or viewer. A person with a confirmed account is added
    /// at once ("added"); anyone else gets an invite link ("invited", valid 14 days), mailed when
    /// the server can send mail. 409: already a member; 400: not an email, or the workspace has a
    /// locked page outside a private notebook (a locked page may not become visible to the
    /// newcomer: move it or remove its lock first).
    #[uniffi::method(default(role = None))]
    pub fn invite_member(
        &self,
        workspace_id: String,
        email: String,
        role: Option<String>,
    ) -> Result<InviteResult, CoreError> {
        Ok(invite_result(self.api.invite_member(
            &workspace_id,
            &email,
            role.as_deref(),
        )?))
    }

    /// Send a pending invite again with a fresh link (the old link stops working). Owners and
    /// admins.
    pub fn resend_invite(
        &self,
        workspace_id: String,
        email: String,
    ) -> Result<InviteResult, CoreError> {
        Ok(invite_result(
            self.api.resend_invite(&workspace_id, &email)?,
        ))
    }

    /// Take back a pending invite. Owners and admins.
    pub fn revoke_invite(&self, workspace_id: String, email: String) -> Result<(), CoreError> {
        Ok(self.api.revoke_invite(&workspace_id, &email)?)
    }

    /// Change a member's role (owner, admin, member or viewer). Owners and admins; **only an
    /// owner** may make or change an owner, and a workspace keeps at least one owner (400).
    /// Changing your own role refreshes the stored workspace list.
    pub fn set_member_role(
        &self,
        workspace_id: String,
        user_id: String,
        role: String,
    ) -> Result<(), CoreError> {
        self.api.set_member_role(&workspace_id, &user_id, &role)?;
        if self.api.user().is_some_and(|u| u.id == user_id) {
            self.refresh_workspaces();
        }
        Ok(())
    }

    /// Remove a member (owners and admins; only an owner may remove an owner; the last owner
    /// cannot be removed). Their open tasks are unassigned and their shares in this workspace end.
    pub fn remove_member(&self, workspace_id: String, user_id: String) -> Result<(), CoreError> {
        self.api.remove_member(&workspace_id, &user_id)?;
        if self.api.user().is_some_and(|u| u.id == user_id) {
            self.refresh_workspaces();
        }
        Ok(())
    }

    /// Leave a workspace (any role; the last owner cannot: 400, make someone else an owner
    /// first). The workspace goes from the stored list, and its tree, tasks and page documents
    /// from the store. Close its open pages first (they end with `noAccess`).
    pub fn leave_workspace(&self, workspace_id: String) -> Result<(), CoreError> {
        let me = self.my_id()?;
        self.api.remove_member(&workspace_id, &me)?;
        self.refresh_workspaces();
        Ok(())
    }

    /// What an invite link (or just its token, the last part of `…/invite/<token>`) is for.
    pub fn invite_info(&self, token: String) -> Result<InviteInfo, CoreError> {
        let i = self.api.invite_info(&token)?;
        Ok(InviteInfo {
            workspace_id: i.workspace_id,
            workspace_name: i.workspace_name,
            invited_by_name: i.invited_by_name,
            email: i.email,
            role: i.role,
            expired: i.expired,
            page: i.page.map(|p| InvitedPage {
                id: p.id,
                title: p.title,
                can_edit: p.can_edit,
            }),
        })
    }

    /// Accept an invite as the signed-in user. The account's email must be the invited one
    /// (403 otherwise); 410: the invite expired (ask for a new one); 404: no longer valid. For a
    /// workspace invite the stored workspace list is refreshed.
    pub fn accept_invite(&self, token: String) -> Result<AcceptedInvite, CoreError> {
        let a = self.api.accept_invite(&token)?;
        self.refresh_workspaces();
        Ok(AcceptedInvite {
            workspace_id: a.workspace_id,
            page_id: a.page_id,
        })
    }

    // ───────── Notebook visibility and shares ─────────

    /// Who a private notebook is shared with. Anyone who can see the notebook may ask.
    pub fn notebook_shares(&self, notebook_id: String) -> Result<NotebookShares, CoreError> {
        let s = self.api.notebook_shares(&notebook_id)?;
        Ok(NotebookShares {
            visibility: s.visibility,
            created_by: s.created_by,
            user_ids: s.user_ids,
        })
    }

    /// Replace the members a private notebook is shared with. **Its creator only** (403), only
    /// workspace members (400), and not while the notebook holds a locked page (400,
    /// `has_locked_page`). Answers the list as it is now; the stored tree is refreshed. (A
    /// notebook's visibility itself is `set_notebook_visibility`.)
    pub fn set_notebook_shares(
        &self,
        notebook_id: String,
        user_ids: Vec<String>,
    ) -> Result<Vec<String>, CoreError> {
        let ws = self.workspace_of("notebook", &notebook_id);
        let ids = self.api.set_notebook_shares(&notebook_id, &user_ids)?;
        self.refresh_tree(ws);
        Ok(ids)
    }

    // ───────── Page shares ─────────

    /// Who a page is shared with. Anyone who can manage the page may ask (in a private
    /// notebook: its creator).
    pub fn page_shares(&self, page_id: String) -> Result<PageShares, CoreError> {
        Ok(page_shares(self.api.page_shares(&page_id)?))
    }

    /// Share a page with a workspace member, who may edit it or only view. Needs edit access to
    /// the page's notebook (in a private notebook, its creator). A locked page cannot be shared.
    pub fn share_page_with_member(
        &self,
        page_id: String,
        user_id: String,
        can_edit: bool,
    ) -> Result<PageShareResult, CoreError> {
        Ok(share_result(self.api.share_page(
            &page_id,
            Some(&user_id),
            None,
            can_edit,
        )?))
    }

    /// Share a page by email: with someone who already has an account ("shared", at once) or
    /// with someone who has not ("invited", an invite link: see `PageShareResult`). **Only
    /// workspace owners and admins** may share with someone who is not a workspace member (403);
    /// a page has at most 200 shares and invites together.
    pub fn share_page_by_email(
        &self,
        page_id: String,
        email: String,
        can_edit: bool,
    ) -> Result<PageShareResult, CoreError> {
        Ok(share_result(self.api.share_page(
            &page_id,
            None,
            Some(&email),
            can_edit,
        )?))
    }

    /// Change what a page share grants. Answers the lists as they are now.
    pub fn set_page_share_edit(
        &self,
        page_id: String,
        user_id: String,
        can_edit: bool,
    ) -> Result<PageShares, CoreError> {
        Ok(page_shares(
            self.api.set_page_share_edit(&page_id, &user_id, can_edit)?,
        ))
    }

    /// Stop sharing a page with someone (their open copy closes). Anyone may remove **their
    /// own** share ("Remove from Shared with me"): pass your own id.
    pub fn remove_page_share(
        &self,
        page_id: String,
        user_id: String,
    ) -> Result<PageShares, CoreError> {
        Ok(page_shares(self.api.remove_page_share(&page_id, &user_id)?))
    }

    /// Take back a pending page invite.
    pub fn revoke_page_invite(
        &self,
        page_id: String,
        email: String,
    ) -> Result<PageShares, CoreError> {
        Ok(page_shares(self.api.revoke_page_invite(&page_id, &email)?))
    }

    /// Pages shared with you, newest first, across workspaces (the sidebar's "Shared with
    /// me"). Not stored on the device.
    pub fn shared_pages(&self) -> Result<Vec<SharedPageEntry>, CoreError> {
        Ok(self
            .api
            .shared_pages()?
            .into_iter()
            .map(|p| SharedPageEntry {
                id: p.id,
                title: p.title,
                icon: p.icon,
                workspace_id: p.workspace_id,
                workspace_name: p.workspace_name,
                member: p.member,
                can_edit: p.can_edit,
                shared_by_name: p.shared_by_name,
                shared_at: p.shared_at,
            })
            .collect())
    }
}
