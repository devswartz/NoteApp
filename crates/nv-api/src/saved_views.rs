//! Saved task views and page backlinks. The truth is the server: `server/routes/teams.ts`
//! (`/workspaces/:id/task-views`, `/task-views/:id`) and `server/routes/pages.ts`
//! (`/pages/:id/backlinks`). The server has no bulk task route.

use serde_json::{json, Value};

use crate::*;

impl Client {
    /// The caller's own saved views of a workspace plus the shared ones, in position order
    /// (GET /workspaces/:id/task-views).
    pub fn task_views(&self, workspace_id: &str) -> Result<Vec<TaskView>, ApiError> {
        self.call(
            "GET",
            &format!("/workspaces/{}/task-views", encode_component(workspace_id)),
            None,
        )
    }

    /// POST /workspaces/:id/task-views. `query` is `{filters, sort, group}`; `shared` needs an
    /// owner or admin.
    pub fn create_task_view(
        &self,
        workspace_id: &str,
        name: &str,
        query: &Value,
        shared: bool,
    ) -> Result<TaskView, ApiError> {
        self.call(
            "POST",
            &format!("/workspaces/{}/task-views", encode_component(workspace_id)),
            Some(&json!({ "name": name, "query": query, "shared": shared })),
        )
    }

    /// PATCH /task-views/:id: only what is given changes.
    pub fn update_task_view(
        &self,
        id: &str,
        name: Option<&str>,
        query: Option<&Value>,
        shared: Option<bool>,
        position: Option<f64>,
    ) -> Result<TaskView, ApiError> {
        let mut body = json!({});
        if let Some(n) = name {
            body["name"] = json!(n);
        }
        if let Some(q) = query {
            body["query"] = q.clone();
        }
        if let Some(s) = shared {
            body["shared"] = json!(s);
        }
        if let Some(p) = position {
            body["position"] = json!(p);
        }
        self.call(
            "PATCH",
            &format!("/task-views/{}", encode_component(id)),
            Some(&body),
        )
    }

    /// DELETE /task-views/:id.
    pub fn delete_task_view(&self, id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/task-views/{}", encode_component(id)),
            None,
        )?;
        Ok(())
    }

    /// Pages that link to this one with `[[...]]` (GET /pages/:id/backlinks), most recently
    /// edited first.
    pub fn backlinks(&self, page_id: &str) -> Result<Vec<PageBacklink>, ApiError> {
        self.call(
            "GET",
            &format!("/pages/{}/backlinks", encode_component(page_id)),
            None,
        )
    }
}
