//! Saved task views, backlinks and the page outline in the Core API (docs: "For apple: saved
//! views, backlinks, outline, block moves"). Views and backlinks are online only, like the
//! account calls: offline they throw `CoreError::Network` and change nothing. The server has no
//! bulk task route: loop over `update_task` for bulk actions.

use nv_api as api;

use crate::{Core, CoreError, LivePage};

/// A saved view of All Tasks.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TaskViewInfo {
    pub id: String,
    pub workspace_id: String,
    pub owner_id: String,
    /// Every member sees it (only owners and admins can share).
    pub shared: bool,
    pub name: String,
    /// The view as the web stores it: a JSON object `{"filters": {...}, "sort": "...", "group":
    /// "..."}` (at most 8 KB). Pass it back unchanged to apply or save it; the app validates
    /// the field values (`src/lib/taskViews.ts`).
    pub query_json: String,
    /// Sort order of the views (ascending).
    pub position: f64,
    pub created_at: String,
}

/// A page that links to another with `[[...]]`.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct BacklinkInfo {
    pub page_id: String,
    pub title: String,
    /// An emoji or none.
    pub icon: Option<String>,
    pub section_name: String,
    pub notebook_name: String,
    pub updated_at: String,
}

fn view(v: api::TaskView) -> TaskViewInfo {
    TaskViewInfo {
        id: v.id,
        workspace_id: v.workspace_id,
        owner_id: v.owner_id,
        shared: v.shared,
        name: v.name,
        query_json: v.query.to_string(),
        position: v.position,
        created_at: v.created_at,
    }
}

fn query(json: &str) -> Result<serde_json::Value, CoreError> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| CoreError::InvalidPage {
        message: format!("query_json: {e}"),
    })?;
    if !v.is_object() {
        return Err(CoreError::InvalidPage {
            message: "query_json is not a JSON object".into(),
        });
    }
    Ok(v)
}

#[uniffi::export]
impl Core {
    /// The signed-in user's own saved views of the workspace plus the shared ones, in
    /// `position` order.
    pub fn task_views(&self, workspace_id: String) -> Result<Vec<TaskViewInfo>, CoreError> {
        Ok(self
            .api
            .task_views(&workspace_id)?
            .into_iter()
            .map(view)
            .collect())
    }

    /// Save a view. `name` 1 to 60 characters; `query_json` `{"filters": {}, "sort": "", "group":
    /// ""}`. `shared` true needs a workspace owner or admin (403 otherwise). At most 100 views
    /// per person per workspace (400).
    pub fn create_task_view(
        &self,
        workspace_id: String,
        name: String,
        query_json: String,
        shared: bool,
    ) -> Result<TaskViewInfo, CoreError> {
        let q = query(&query_json)?;
        Ok(view(self.api.create_task_view(
            &workspace_id,
            &name,
            &q,
            shared,
        )?))
    }

    /// Change a view; none leaves a field. Own views, or shared ones for owners and admins
    /// (404 for someone else's personal view, 403 for a shared one without the role). Sharing
    /// or unsharing needs owner or admin.
    #[uniffi::method(default(name = None, query_json = None, shared = None, position = None))]
    pub fn update_task_view(
        &self,
        id: String,
        name: Option<String>,
        query_json: Option<String>,
        shared: Option<bool>,
        position: Option<f64>,
    ) -> Result<TaskViewInfo, CoreError> {
        let q = query_json.as_deref().map(query).transpose()?;
        Ok(view(self.api.update_task_view(
            &id,
            name.as_deref(),
            q.as_ref(),
            shared,
            position,
        )?))
    }

    /// Delete a view (same rights as `update_task_view`).
    pub fn delete_task_view(&self, id: String) -> Result<(), CoreError> {
        Ok(self.api.delete_task_view(&id)?)
    }

    /// Pages the user can see that link to this page with `[[...]]` (never locked pages), most
    /// recently edited first. There is no snippet or section id: open the page for those.
    pub fn backlinks(&self, page_id: String) -> Result<Vec<BacklinkInfo>, CoreError> {
        Ok(self
            .api
            .backlinks(&page_id)?
            .into_iter()
            .map(|b| BacklinkInfo {
                page_id: b.id,
                title: b.title,
                icon: b.icon,
                section_name: b.section_name,
                notebook_name: b.notebook_name,
                updated_at: b.updated_at,
            })
            .collect())
    }
}

/// A heading of the page, with where it is in its box's `text_for_view()`.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct OutlineItem {
    pub box_id: String,
    pub level: u32,
    pub text: String,
    /// UTF-16 offset of the heading's line in the box's `text_for_view()`: pass it to
    /// `set_view_selection` to put the caret at the start of the heading.
    pub offset: u32,
}

#[uniffi::export]
impl LivePage {
    /// The page's non-empty headings, box by box in reading order (inside callouts and toggles
    /// too), as the web's outline lists them. Read from the live document, so it includes boxes
    /// no `EditorSession` is open on.
    pub fn outline(&self) -> Vec<OutlineItem> {
        let page = nv_model::Page::read(self.doc());
        let mut seen: Vec<String> = Vec::new();
        for h in nv_model::page_headings(&page) {
            if !seen.contains(&h.box_id) {
                seen.push(h.box_id);
            }
        }
        let mut out = Vec::new();
        for id in seen {
            let tree = nv_editor::bind::read_tree(self.doc(), &nv_model::page::box_field(&id));
            let v = nv_editor::input::ViewText::of(&tree);
            let units: Vec<u16> = v.text.encode_utf16().collect();
            for l in v.lines.iter().filter(|l| l.kind == "heading") {
                let end = (l.offset + l.len).min(units.len());
                let text = String::from_utf16_lossy(&units[l.offset.min(end)..end]);
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                out.push(OutlineItem {
                    box_id: id.clone(),
                    level: u32::from(l.level.max(1)),
                    text: text.to_string(),
                    offset: l.offset as u32,
                });
            }
        }
        out
    }
}
