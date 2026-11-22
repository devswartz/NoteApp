//! Tree management: notebooks, sections and pages (create, change, move, duplicate, delete) and
//! the Trash. The truth is the server: `server/routes/tree.ts`, `pages.ts`, `trash.ts`.
//!
//! Positions are REAL numbers the server computes from an `index` ("put it at index i among its
//! new siblings, without itself"; 0 first, no index = last), so the client never sends one.
//! The server makes every id, so none of these can be queued offline.

use serde_json::{json, Value};

use crate::*;

/// `{ index }`, or `{}` for "at the end" (JSON has no infinity, which is what the web's omitted
/// index means to the server).
fn index_body(index: Option<u32>) -> Value {
    match index {
        Some(i) => json!({ "index": i }),
        None => json!({}),
    }
}

fn id_of(v: &Value) -> Result<String, ApiError> {
    v["id"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| ApiError::Decode("no id".into()))
}

impl Client {
    /// A new notebook (POST /workspaces/:id/notebooks; members). It starts with one section,
    /// "General". `color` is #rrggbb (none: the server picks one); `visibility` is `shared` or
    /// `private` (anything else is shared).
    pub fn create_notebook(
        &self,
        workspace_id: &str,
        name: &str,
        color: Option<&str>,
        visibility: Option<&str>,
    ) -> Result<NewNotebook, ApiError> {
        let mut body = json!({ "name": name });
        if let Some(c) = color {
            body["color"] = json!(c);
        }
        if let Some(v) = visibility {
            body["visibility"] = json!(v);
        }
        self.call(
            "POST",
            &format!("/workspaces/{}/notebooks", encode_component(workspace_id)),
            Some(&body),
        )
    }

    /// Change a notebook (PATCH /notebooks/:id): the fields set in `patch` (`name`, `color`,
    /// `visibility`). Answers how many page shares ended (a notebook made private).
    pub fn patch_notebook(&self, notebook_id: &str, patch: &Value) -> Result<u32, ApiError> {
        let v: Value = self.call(
            "PATCH",
            &format!("/notebooks/{}", encode_component(notebook_id)),
            Some(patch),
        )?;
        Ok(v["removedPageShares"].as_u64().unwrap_or(0) as u32)
    }

    /// Reorder a notebook (POST /notebooks/:id/move): `index` among the workspace's other
    /// notebooks (0 first; none: last). Answers its new position.
    pub fn move_notebook(&self, notebook_id: &str, index: Option<u32>) -> Result<f64, ApiError> {
        let v: Value = self.call(
            "POST",
            &format!("/notebooks/{}/move", encode_component(notebook_id)),
            Some(&index_body(index)),
        )?;
        v["position"]
            .as_f64()
            .ok_or_else(|| ApiError::Decode("no position".into()))
    }

    /// Delete a notebook (DELETE /notebooks/:id): to the Trash, with its sections and pages.
    pub fn delete_notebook(&self, notebook_id: &str) -> Result<Trashed, ApiError> {
        self.call(
            "DELETE",
            &format!("/notebooks/{}", encode_component(notebook_id)),
            None,
        )
    }

    /// A new section (POST /notebooks/:id/sections), a subsection of `parent_id` when given
    /// (same notebook, at most 3 levels). Answers its id.
    pub fn create_section(
        &self,
        notebook_id: &str,
        parent_id: Option<&str>,
        name: &str,
        color: Option<&str>,
    ) -> Result<String, ApiError> {
        let mut body = json!({ "name": name });
        if let Some(p) = parent_id {
            body["parentId"] = json!(p);
        }
        if let Some(c) = color {
            body["color"] = json!(c);
        }
        let v: Value = self.call(
            "POST",
            &format!("/notebooks/{}/sections", encode_component(notebook_id)),
            Some(&body),
        )?;
        id_of(&v)
    }

    /// Change a section (PATCH /sections/:id): `name` and `color` (moves go through
    /// `move_section`).
    pub fn patch_section(&self, section_id: &str, patch: &Value) -> Result<(), ApiError> {
        let _: Value = self.call(
            "PATCH",
            &format!("/sections/{}", encode_component(section_id)),
            Some(patch),
        )?;
        Ok(())
    }

    /// Reorder, nest, un-nest or move a section (POST /sections/:id/move), with its subsections
    /// and pages. `parent_id` is always sent: a section id nests it there (that section's
    /// notebook wins), none puts it at the top level of `notebook_id`. `index` is among its new
    /// siblings without itself (0 first; none: last).
    pub fn move_section(
        &self,
        section_id: &str,
        notebook_id: &str,
        parent_id: Option<&str>,
        index: Option<u32>,
    ) -> Result<SectionMoved, ApiError> {
        let mut body = index_body(index);
        body["notebookId"] = json!(notebook_id);
        body["parentId"] = json!(parent_id);
        self.call(
            "POST",
            &format!("/sections/{}/move", encode_component(section_id)),
            Some(&body),
        )
    }

    /// Duplicate a section with its subsections, pages and their tasks (POST /sections/:id/copy).
    /// Locked pages are not copied. In the same notebook the copy sits at the end of the
    /// original's siblings and is named "<name> (copy)" unless `name` is given; in another
    /// notebook of the workspace it is at the top level. Answers the copy's id.
    pub fn copy_section(
        &self,
        section_id: &str,
        notebook_id: Option<&str>,
        name: Option<&str>,
    ) -> Result<String, ApiError> {
        let mut body = json!({});
        if let Some(n) = notebook_id {
            body["notebookId"] = json!(n);
        }
        if let Some(n) = name {
            body["name"] = json!(n);
        }
        let v: Value = self.call(
            "POST",
            &format!("/sections/{}/copy", encode_component(section_id)),
            Some(&body),
        )?;
        id_of(&v)
    }

    /// Delete a section (DELETE /sections/:id): to the Trash, with its subsections and pages.
    pub fn delete_section(&self, section_id: &str) -> Result<Trashed, ApiError> {
        self.call(
            "DELETE",
            &format!("/sections/{}", encode_component(section_id)),
            None,
        )
    }

    /// A new blank page at the end of a section (POST /sections/:id/pages). Answers its id.
    pub fn create_page(&self, section_id: &str, title: &str) -> Result<String, ApiError> {
        let v: Value = self.call(
            "POST",
            &format!("/sections/{}/pages", encode_component(section_id)),
            Some(&json!({ "title": title })),
        )?;
        id_of(&v)
    }

    /// Change a page's metadata (PATCH /pages/:id): `title` and `icon` (null clears it). Moves go
    /// through `move_page`.
    pub fn patch_page(&self, page_id: &str, patch: &Value) -> Result<(), ApiError> {
        let _: Value = self.call(
            "PATCH",
            &format!("/pages/{}", encode_component(page_id)),
            Some(patch),
        )?;
        Ok(())
    }

    /// Move a page (POST /pages/:id/move) to `section_id` (none: stay), at `index` among that
    /// section's other pages (0 first; none: last).
    pub fn move_page(
        &self,
        page_id: &str,
        section_id: Option<&str>,
        index: Option<u32>,
    ) -> Result<PageMoved, ApiError> {
        let mut body = index_body(index);
        if let Some(s) = section_id {
            body["sectionId"] = json!(s);
        }
        self.call(
            "POST",
            &format!("/pages/{}/move", encode_component(page_id)),
            Some(&body),
        )
    }

    /// Duplicate a page and the tasks written on it (POST /pages/:id/copy). In its own section
    /// the copy sits right after it and is titled "<title> (copy)"; elsewhere it goes to the end
    /// and keeps the title; `title` overrides. A locked page can't be copied. Answers its id.
    pub fn copy_page(
        &self,
        page_id: &str,
        section_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<String, ApiError> {
        let mut body = json!({});
        if let Some(s) = section_id {
            body["sectionId"] = json!(s);
        }
        if let Some(t) = title {
            body["title"] = json!(t);
        }
        let v: Value = self.call(
            "POST",
            &format!("/pages/{}/copy", encode_component(page_id)),
            Some(&body),
        )?;
        id_of(&v)
    }

    /// Delete a page (DELETE /pages/:id): to the Trash. Its tasks stay in the task list.
    pub fn delete_page(&self, page_id: &str) -> Result<Trashed, ApiError> {
        self.call(
            "DELETE",
            &format!("/pages/{}", encode_component(page_id)),
            None,
        )
    }

    /// The workspace's Trash as the caller may see it, newest first (GET /workspaces/:id/trash);
    /// empty for viewers.
    pub fn trash(&self, workspace_id: &str) -> Result<Vec<TrashItem>, ApiError> {
        self.call(
            "GET",
            &format!("/workspaces/{}/trash", encode_component(workspace_id)),
            None,
        )
    }

    /// Put a trashed item back with everything trashed with it (POST /trash/:kind/:id/restore).
    pub fn restore_from_trash(&self, kind: TrashKind, id: &str) -> Result<Restored, ApiError> {
        self.call(
            "POST",
            &format!("/trash/{}/{}/restore", kind.as_str(), encode_component(id)),
            Some(&json!({})),
        )
    }

    /// Delete a trashed item for good (DELETE /trash/:kind/:id).
    pub fn purge_from_trash(&self, kind: TrashKind, id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/trash/{}/{}", kind.as_str(), encode_component(id)),
            None,
        )?;
        Ok(())
    }

    /// Delete everything in the workspace's Trash for good (DELETE /workspaces/:id/trash; owners
    /// and admins). Answers how many entries went.
    pub fn empty_trash(&self, workspace_id: &str) -> Result<u32, ApiError> {
        let v: Value = self.call(
            "DELETE",
            &format!("/workspaces/{}/trash", encode_component(workspace_id)),
            None,
        )?;
        Ok(v["removed"].as_u64().unwrap_or(0) as u32)
    }
}
