//! The server's JSON types (shared/types.ts), as the REST API returns them. Fields the core
//! doesn't use yet are left out; unknown fields are ignored, so newer servers stay readable.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub color: String,
    /// False until the address is confirmed; unverified users can't open pages.
    #[serde(default)]
    pub email_verified: bool,
}

/// Returned by /auth/register, /auth/login and /auth/refresh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    /// Short-lived JWT for `Authorization: Bearer …` and the collab socket.
    pub access_token: String,
    /// Lifetime of the access token in seconds.
    pub expires_in: u64,
    /// Opaque, single-use token for /auth/refresh. The app stores it in the keychain.
    pub refresh_token: String,
    pub user: User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// owner, admin, member or viewer.
    pub role: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub color: String,
    /// shared or private.
    pub visibility: String,
    pub created_by: String,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub notebook_id: String,
    /// The section this one is nested in, or None at the top level.
    pub parent_id: Option<String>,
    pub name: String,
    pub color: String,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub id: String,
    pub section_id: String,
    pub title: String,
    pub icon: Option<String>,
    /// document or canvas.
    pub kind: String,
    pub position: f64,
    pub updated_at: String,
    pub updated_by: Option<String>,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub notebooks: Vec<Notebook>,
    pub sections: Vec<Section>,
    pub pages: Vec<PageMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Checklist {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// open or done.
    pub status: String,
    /// 1 urgent … 4 none.
    pub priority: u8,
    /// Local date, YYYY-MM-DD.
    pub due_date: Option<String>,
    /// Local time, HH:mm.
    pub due_time: Option<String>,
    /// The recurrence rule as the server stores it (shared/recurrence.ts); kept as JSON for now.
    #[serde(default)]
    pub recurrence: Option<Value>,
    pub reminder_at: Option<String>,
    pub assignee_id: Option<String>,
    pub created_by: String,
    pub page_id: Option<String>,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub checklist: Option<Checklist>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// On the caller's locked page that this sign-in hasn't unlocked: title and text withheld.
    #[serde(default)]
    pub locked: bool,
}

/// A new task (POST /workspaces/:id/tasks). The id is the client's (a UUID), so a retried create
/// can't duplicate it: the server returns the task it already made with that id (when the same
/// user made it in the same workspace; 409 otherwise). The web app always sends one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_ids: Option<Vec<String>>,
}
