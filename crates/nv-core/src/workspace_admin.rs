//! Workspaces, teams, tags and the activity feed in the Core API (docs: "For apple: workspaces,
//! teams, tags, activity, cursors, tables"). Each call mirrors a route of today's server
//! (`server/routes/workspaces.ts`, `teams.ts`, `activity.ts`).
//!
//! **Online only**: nothing is queued; offline they throw `CoreError::Network`.
//!
//! The server has no workspace icon or colour and no tag merge: those aren't here.

use nv_api as api;
use serde_json::json;

use crate::{Core, CoreError, TaskTag, TaskTeam};

/// One entry of a workspace's activity feed.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ActivityEntry {
    /// Also the cursor: pass the oldest id seen as `before` for older entries.
    pub id: i64,
    pub workspace_id: String,
    /// Who did it (a user id, see `members`); none for the system.
    pub actor_id: Option<String>,
    /// "created", "renamed", "moved", "deleted", "copied", "edited", "completed", "reopened",
    /// "assigned", "unassigned", "added", "invited", "role", "left", "removed", "commented",
    /// "shared", "made-private".
    pub verb: String,
    /// "page", "notebook", "section", "task", "member", "comment" or "workspace".
    pub target_type: String,
    pub target_id: String,
    /// A sentence to show after the actor's name, e.g. `renamed page "A" to "B"`.
    pub summary: String,
    /// ISO instant.
    pub created_at: String,
}

fn team(t: api::Team) -> TaskTeam {
    TaskTeam {
        id: t.id,
        name: t.name,
        color: t.color,
        parent_id: t.parent_id,
        member_ids: t.member_ids,
    }
}

fn tag(t: api::Tag) -> TaskTag {
    TaskTag {
        id: t.id,
        name: t.name,
        color: t.color,
    }
}

impl Core {
    fn refresh_workspace_list(&self) {
        if let (Some(store), Ok(ws)) = (&self.store, self.api.workspaces()) {
            let _ = store.put_workspaces(&ws);
        }
    }

    fn team_member_ids(&self, workspace_id: &str, team_id: &str) -> Result<Vec<String>, CoreError> {
        self.api
            .teams(workspace_id)?
            .into_iter()
            .find(|t| t.id == team_id)
            .map(|t| t.member_ids)
            .ok_or_else(|| {
                CoreError::from(api::ApiError::Http {
                    status: 404,
                    message: "Team not found".into(),
                    code: None,
                    request_id: None,
                })
            })
    }
}

#[uniffi::export]
impl Core {
    /// Make a workspace (1 to 100 characters, else 400) with you as owner, with the server's
    /// starting content. Answers its id; the stored workspace list is refreshed.
    pub fn create_workspace(&self, name: String) -> Result<String, CoreError> {
        let id = self.api.create_workspace(&name)?;
        self.refresh_workspace_list();
        Ok(id)
    }

    /// Rename a workspace (owners and admins, else 403; 1 to 100 characters). The stored list is
    /// refreshed.
    pub fn rename_workspace(&self, workspace_id: String, name: String) -> Result<(), CoreError> {
        self.api.rename_workspace(&workspace_id, &name)?;
        self.refresh_workspace_list();
        Ok(())
    }

    /// Delete a workspace for good with all its notebooks, pages, tasks and files (owners only,
    /// else 403; the server asks for no confirmation: the app must). Everyone in it loses it.
    /// The workspace goes from the stored list and its stored tree, tasks and documents are
    /// dropped. Close its open pages first.
    pub fn delete_workspace(&self, workspace_id: String) -> Result<(), CoreError> {
        self.api.delete_workspace(&workspace_id)?;
        self.refresh_workspace_list();
        Ok(())
    }

    /// Rename a tag (owners and admins; a leading # is dropped; at most 40 characters; a name
    /// another tag has is 409). Answers the tag as saved.
    pub fn rename_tag(&self, tag_id: String, name: String) -> Result<TaskTag, CoreError> {
        Ok(tag(self.api.update_tag(&tag_id, Some(&name), None)?))
    }

    /// Recolour a tag (owners and admins; `#rrggbb`, else 400).
    pub fn recolor_tag(&self, tag_id: String, color: String) -> Result<TaskTag, CoreError> {
        Ok(tag(self.api.update_tag(&tag_id, None, Some(&color))?))
    }

    /// Delete a tag (owners and admins): it leaves every task that had it.
    pub fn delete_tag(&self, tag_id: String) -> Result<(), CoreError> {
        Ok(self.api.delete_tag(&tag_id)?)
    }

    /// Make a team, or a subteam when `parent_id` is a top-level team (subteams are one level
    /// deep, else 400). Owners and admins; the name is 1 to 60 characters; `color` is #rrggbb or
    /// none to let the server pick; `member_ids` must be workspace members.
    pub fn create_team(
        &self,
        workspace_id: String,
        name: String,
        color: Option<String>,
        parent_id: Option<String>,
        member_ids: Vec<String>,
    ) -> Result<TaskTeam, CoreError> {
        Ok(team(self.api.create_team(
            &workspace_id,
            &name,
            color.as_deref(),
            parent_id.as_deref(),
            &member_ids,
        )?))
    }

    /// Rename a team (1 to 60 characters).
    pub fn rename_team(&self, team_id: String, name: String) -> Result<TaskTeam, CoreError> {
        Ok(team(
            self.api.update_team(&team_id, &json!({ "name": name }))?,
        ))
    }

    /// Recolour a team (`#rrggbb`).
    pub fn recolor_team(&self, team_id: String, color: String) -> Result<TaskTeam, CoreError> {
        Ok(team(
            self.api.update_team(&team_id, &json!({ "color": color }))?,
        ))
    }

    /// Move a team under a top-level team, or to the top level with none. A team that has
    /// subteams can't become a subteam, and a subteam can't have subteams (400).
    pub fn move_team(
        &self,
        team_id: String,
        parent_id: Option<String>,
    ) -> Result<TaskTeam, CoreError> {
        Ok(team(self.api.update_team(
            &team_id,
            &json!({ "parentId": parent_id }),
        )?))
    }

    /// Put a team at a sort position (the list is ordered by it).
    pub fn reorder_team(&self, team_id: String, position: f64) -> Result<TaskTeam, CoreError> {
        Ok(team(
            self.api
                .update_team(&team_id, &json!({ "position": position }))?,
        ))
    }

    /// Delete a team and its subteams; their tasks lose the team.
    pub fn delete_team(&self, team_id: String) -> Result<(), CoreError> {
        Ok(self.api.delete_team(&team_id)?)
    }

    /// Replace a team's members (workspace members only, else 400).
    pub fn set_team_members(
        &self,
        team_id: String,
        user_ids: Vec<String>,
    ) -> Result<TaskTeam, CoreError> {
        Ok(team(self.api.set_team_members(&team_id, &user_ids)?))
    }

    /// Add one member to a team (already in it: nothing changes).
    pub fn add_team_member(
        &self,
        workspace_id: String,
        team_id: String,
        user_id: String,
    ) -> Result<TaskTeam, CoreError> {
        let mut ids = self.team_member_ids(&workspace_id, &team_id)?;
        if !ids.contains(&user_id) {
            ids.push(user_id);
        }
        Ok(team(self.api.set_team_members(&team_id, &ids)?))
    }

    /// Take one member out of a team.
    pub fn remove_team_member(
        &self,
        workspace_id: String,
        team_id: String,
        user_id: String,
    ) -> Result<TaskTeam, CoreError> {
        let mut ids = self.team_member_ids(&workspace_id, &team_id)?;
        ids.retain(|u| *u != user_id);
        Ok(team(self.api.set_team_members(&team_id, &ids)?))
    }

    /// The workspace's activity, newest first: who changed what. `limit` 1 to 100 (none: 50);
    /// `before` is the `id` of the oldest entry already shown (none: the newest). Entries about
    /// notebooks, pages and tasks the caller can't see are left out. Needs the network.
    pub fn activity(
        &self,
        workspace_id: String,
        limit: Option<u32>,
        before: Option<i64>,
    ) -> Result<Vec<ActivityEntry>, CoreError> {
        Ok(self
            .api
            .activity(&workspace_id, limit, before)?
            .into_iter()
            .map(|a| ActivityEntry {
                id: a.id,
                workspace_id: a.workspace_id,
                actor_id: a.actor_id,
                verb: a.verb,
                target_type: a.target_type,
                target_id: a.target_id,
                summary: a.summary,
                created_at: a.created_at,
            })
            .collect())
    }
}
