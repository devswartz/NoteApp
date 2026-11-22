//! Sharing: workspace members and invites, notebook shares, page shares, and the pages shared
//! with the caller. The truth is the server: `server/routes/workspaces.ts` (the web's callers
//! are `src/components/sharing/*`).

use serde_json::{json, Value};

use crate::*;

impl Client {
    /// The workspace's members and, for owners and admins, its pending invites
    /// (GET /workspaces/:id/members).
    pub fn member_list(&self, workspace_id: &str) -> Result<MemberList, ApiError> {
        self.call(
            "GET",
            &format!("/workspaces/{}/members", encode_component(workspace_id)),
            None,
        )
    }

    /// Invite by email (POST /workspaces/:id/members; owners and admins, only owners may make
    /// an owner). An existing, verified account joins at once (`added`); anyone else gets an
    /// invite link (`invited`, `invite_url`, mailed when the server can send mail).
    pub fn invite_member(
        &self,
        workspace_id: &str,
        email: &str,
        role: Option<&str>,
    ) -> Result<InviteResult, ApiError> {
        let mut body = json!({ "email": email });
        if let Some(r) = role {
            body["role"] = json!(r);
        }
        self.call(
            "POST",
            &format!("/workspaces/{}/members", encode_component(workspace_id)),
            Some(&body),
        )
    }

    /// Send a pending invite again with a fresh link; the old link stops working
    /// (POST /workspaces/:id/invites/:email/resend; owners and admins).
    pub fn resend_invite(&self, workspace_id: &str, email: &str) -> Result<InviteResult, ApiError> {
        self.call(
            "POST",
            &format!(
                "/workspaces/{}/invites/{}/resend",
                encode_component(workspace_id),
                encode_component(email)
            ),
            Some(&json!({})),
        )
    }

    /// Take back a pending invite (DELETE /workspaces/:id/invites/:email; owners and admins).
    pub fn revoke_invite(&self, workspace_id: &str, email: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!(
                "/workspaces/{}/invites/{}",
                encode_component(workspace_id),
                encode_component(email)
            ),
            None,
        )?;
        Ok(())
    }

    /// Change a member's role (PATCH /workspaces/:id/members/:userId).
    pub fn set_member_role(
        &self,
        workspace_id: &str,
        user_id: &str,
        role: &str,
    ) -> Result<(), ApiError> {
        let _: Value = self.call(
            "PATCH",
            &format!(
                "/workspaces/{}/members/{}",
                encode_component(workspace_id),
                encode_component(user_id)
            ),
            Some(&json!({ "role": role })),
        )?;
        Ok(())
    }

    /// Remove a member, or leave (DELETE /workspaces/:id/members/:userId with your own id).
    pub fn remove_member(&self, workspace_id: &str, user_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!(
                "/workspaces/{}/members/{}",
                encode_component(workspace_id),
                encode_component(user_id)
            ),
            None,
        )?;
        Ok(())
    }

    /// What an invite link is for (GET /invites/:token; the server needs no sign-in for it,
    /// this one is sent signed in).
    pub fn invite_info(&self, token: &str) -> Result<InviteInfo, ApiError> {
        self.call(
            "GET",
            &format!("/invites/{}", encode_component(token)),
            None,
        )
    }

    /// Accept an invite link as the signed-in user (POST /invites/:token/accept). The account's
    /// email must be the invited one (403 otherwise); an expired invite is 410.
    pub fn accept_invite(&self, token: &str) -> Result<AcceptedInvite, ApiError> {
        self.call(
            "POST",
            &format!("/invites/{}/accept", encode_component(token)),
            Some(&json!({})),
        )
    }

    /// Who a notebook is shared with (GET /notebooks/:id/shares).
    pub fn notebook_shares(&self, notebook_id: &str) -> Result<NotebookShares, ApiError> {
        self.call(
            "GET",
            &format!("/notebooks/{}/shares", encode_component(notebook_id)),
            None,
        )
    }

    /// Replace the people a private notebook is shared with (PUT /notebooks/:id/shares; its
    /// creator only). Answers the list as it is now.
    pub fn set_notebook_shares(
        &self,
        notebook_id: &str,
        user_ids: &[String],
    ) -> Result<Vec<String>, ApiError> {
        let v: Value = self.call(
            "PUT",
            &format!("/notebooks/{}/shares", encode_component(notebook_id)),
            Some(&json!({ "userIds": user_ids })),
        )?;
        serde_json::from_value(v["userIds"].clone()).map_err(|e| ApiError::Decode(e.to_string()))
    }

    /// Who a page is shared with (GET /pages/:id/shares).
    pub fn page_shares(&self, page_id: &str) -> Result<PageShares, ApiError> {
        self.call(
            "GET",
            &format!("/pages/{}/shares", encode_component(page_id)),
            None,
        )
    }

    /// Share a page with a workspace member (`user_id`) or by email (POST /pages/:id/shares).
    pub fn share_page(
        &self,
        page_id: &str,
        user_id: Option<&str>,
        email: Option<&str>,
        can_edit: bool,
    ) -> Result<PageShareResult, ApiError> {
        let mut body = json!({ "canEdit": can_edit });
        if let Some(u) = user_id {
            body["userId"] = json!(u);
        }
        if let Some(e) = email {
            body["email"] = json!(e);
        }
        self.call(
            "POST",
            &format!("/pages/{}/shares", encode_component(page_id)),
            Some(&body),
        )
    }

    /// Change what a page share grants (PATCH /pages/:id/shares/:userId).
    pub fn set_page_share_edit(
        &self,
        page_id: &str,
        user_id: &str,
        can_edit: bool,
    ) -> Result<PageShares, ApiError> {
        self.call(
            "PATCH",
            &format!(
                "/pages/{}/shares/{}",
                encode_component(page_id),
                encode_component(user_id)
            ),
            Some(&json!({ "canEdit": can_edit })),
        )
    }

    /// Stop sharing a page with someone, or remove your own share
    /// (DELETE /pages/:id/shares/:userId).
    pub fn remove_page_share(&self, page_id: &str, user_id: &str) -> Result<PageShares, ApiError> {
        self.call(
            "DELETE",
            &format!(
                "/pages/{}/shares/{}",
                encode_component(page_id),
                encode_component(user_id)
            ),
            None,
        )
    }

    /// Take back a pending page invite (DELETE /pages/:id/invites/:email).
    pub fn revoke_page_invite(&self, page_id: &str, email: &str) -> Result<PageShares, ApiError> {
        self.call(
            "DELETE",
            &format!(
                "/pages/{}/invites/{}",
                encode_component(page_id),
                encode_component(email)
            ),
            None,
        )
    }

    /// Pages shared with the caller, newest first, across workspaces (GET /shared-pages).
    pub fn shared_pages(&self) -> Result<Vec<SharedPage>, ApiError> {
        self.call("GET", "/shared-pages", None)
    }
}
