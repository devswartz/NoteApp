//! Workspace, team and tag management and the activity feed. The truth is the server:
//! `server/routes/workspaces.ts` (`/workspaces`), `server/routes/teams.ts` (`/teams`, `/tags`)
//! and `server/routes/activity.ts`.

use serde_json::{json, Value};

use crate::*;

impl Client {
    /// A new workspace with the caller as owner (POST /workspaces); answers its id.
    pub fn create_workspace(&self, name: &str) -> Result<String, ApiError> {
        let v: Value = self.call("POST", "/workspaces", Some(&json!({ "name": name })))?;
        v["id"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| ApiError::Decode("no workspace id".into()))
    }

    /// Rename (PATCH /workspaces/:id; owners and admins).
    pub fn rename_workspace(&self, workspace_id: &str, name: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "PATCH",
            &format!("/workspaces/{}", encode_component(workspace_id)),
            Some(&json!({ "name": name })),
        )?;
        Ok(())
    }

    /// Delete the workspace with everything in it (DELETE /workspaces/:id; owners).
    pub fn delete_workspace(&self, workspace_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/workspaces/{}", encode_component(workspace_id)),
            None,
        )?;
        Ok(())
    }

    /// Rename and/or recolour a tag (PATCH /tags/:id; owners and admins).
    pub fn update_tag(
        &self,
        tag_id: &str,
        name: Option<&str>,
        color: Option<&str>,
    ) -> Result<Tag, ApiError> {
        let mut body = json!({});
        if let Some(n) = name {
            body["name"] = json!(n);
        }
        if let Some(c) = color {
            body["color"] = json!(c);
        }
        self.call(
            "PATCH",
            &format!("/tags/{}", encode_component(tag_id)),
            Some(&body),
        )
    }

    /// Delete a tag; it leaves every task (DELETE /tags/:id; owners and admins).
    pub fn delete_tag(&self, tag_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/tags/{}", encode_component(tag_id)),
            None,
        )?;
        Ok(())
    }

    /// A team or, with `parent_id`, a subteam (POST /workspaces/:id/teams; owners and admins).
    pub fn create_team(
        &self,
        workspace_id: &str,
        name: &str,
        color: Option<&str>,
        parent_id: Option<&str>,
        member_ids: &[String],
    ) -> Result<Team, ApiError> {
        let mut body = json!({ "name": name });
        if let Some(c) = color {
            body["color"] = json!(c);
        }
        if let Some(p) = parent_id {
            body["parentId"] = json!(p);
        }
        if !member_ids.is_empty() {
            body["memberIds"] = json!(member_ids);
        }
        self.call(
            "POST",
            &format!("/workspaces/{}/teams", encode_component(workspace_id)),
            Some(&body),
        )
    }

    /// Change a team (PATCH /teams/:id). `body` holds only what changes: `name`, `color`,
    /// `parentId` (null makes it top level) and `position`.
    pub fn update_team(&self, team_id: &str, body: &Value) -> Result<Team, ApiError> {
        self.call(
            "PATCH",
            &format!("/teams/{}", encode_component(team_id)),
            Some(body),
        )
    }

    /// Delete a team and its subteams (DELETE /teams/:id).
    pub fn delete_team(&self, team_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/teams/{}", encode_component(team_id)),
            None,
        )?;
        Ok(())
    }

    /// Replace a team's members (PUT /teams/:id/members).
    pub fn set_team_members(&self, team_id: &str, user_ids: &[String]) -> Result<Team, ApiError> {
        self.call(
            "PUT",
            &format!("/teams/{}/members", encode_component(team_id)),
            Some(&json!({ "userIds": user_ids })),
        )
    }

    /// The workspace's activity, newest first (GET /workspaces/:id/activity?limit=&before=).
    /// `before` is the id of the oldest entry already seen. The server caps `limit` at 100.
    pub fn activity(
        &self,
        workspace_id: &str,
        limit: Option<u32>,
        before: Option<i64>,
    ) -> Result<Vec<ActivityItem>, ApiError> {
        let mut path = format!("/workspaces/{}/activity", encode_component(workspace_id));
        let mut sep = '?';
        if let Some(l) = limit {
            path.push_str(&format!("{sep}limit={l}"));
            sep = '&';
        }
        if let Some(b) = before {
            path.push_str(&format!("{sep}before={b}"));
        }
        self.call("GET", &path, None)
    }
}
