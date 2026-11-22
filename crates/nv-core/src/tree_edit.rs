//! Tree management in the Core API (docs/rewrite/status/core.md, "For apple: tree management"):
//! create, rename, recolour, move, duplicate and delete notebooks, sections (nested ones too) and
//! pages, and the Trash. Every call mirrors a route of today's server (`server/routes/tree.ts`,
//! `pages.ts`, `trash.ts`; the web's callers are `src/components/shell/treeDnd.ts`,
//! `notesRows.tsx`, `NewNotebookDialog.tsx` and `src/lib/trash.ts`).
//!
//! **Online only.** The server makes every id for these (a client-chosen id is ignored), so a
//! change made offline could not be named or ordered until it arrived; nothing is queued, and a
//! `CoreError::Network` is returned unchanged. The server's refusals (permissions, locked pages,
//! the 3-level limit, cross-workspace moves) come back as `CoreError::Server`.
//!
//! **The stored tree.** After a write that the server accepted, the core fetches the workspace's
//! tree again and stores it (`nv_store::Store::put_tree`), so `cached_tree` shows the change as
//! soon as the call returns, with the server's own positions and ordering. That also applies the
//! locked-page rules (the stored document of a page that is now locked is dropped) and keeps the
//! stored documents of pages that went to the Trash. Without a store nothing is fetched. If that
//! fetch fails, the write still counts as done (it is on the server): the stored tree is then
//! stale until the next `tree()`.

use nv_api::TrashKind as ApiKind;
use serde_json::json;

use crate::{Core, CoreError};

/// What a Trash entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TrashKind {
    Page,
    Section,
    Notebook,
}

fn api_kind(k: TrashKind) -> ApiKind {
    match k {
        TrashKind::Page => ApiKind::Page,
        TrashKind::Section => ApiKind::Section,
        TrashKind::Notebook => ApiKind::Notebook,
    }
}

fn kind(k: ApiKind) -> TrashKind {
    match k {
        ApiKind::Page => TrashKind::Page,
        ApiKind::Section => TrashKind::Section,
        ApiKind::Notebook => TrashKind::Notebook,
    }
}

/// A notebook just made: its id and the id of the "General" section it starts with.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct NewNotebook {
    pub id: String,
    pub section_id: String,
}

/// Where a page ended up after a move.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PagePlace {
    pub section_id: String,
    pub position: f64,
}

/// Where a section ended up after a move.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SectionPlace {
    pub notebook_id: String,
    /// The section it is nested in, or none at the top level.
    pub parent_id: Option<String>,
    pub position: f64,
}

/// What a delete put in the Trash.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Trashed {
    /// The entry's id in the Trash (the deleted item's own id).
    pub trash_id: String,
    /// Tasks that were on what went to the Trash; they stay in the task list.
    pub tasks: u32,
}

/// A page in the Trash, as the tree lists it (what a task on it shows as "<title> in Trash").
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrashedPage {
    pub id: String,
    pub title: String,
}

/// One entry of the Trash: the item at the top of what was deleted, with everything that went
/// with it.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrashEntry {
    pub kind: TrashKind,
    pub id: String,
    /// The page's title, or the section's or notebook's name.
    pub name: String,
    pub icon: Option<String>,
    /// ISO instant, UTC.
    pub deleted_at: String,
    /// User id and name of who deleted it.
    pub deleted_by: Option<String>,
    pub deleted_by_name: Option<String>,
    /// When the daily job removes it for good (60 days after `deleted_at`), ISO instant.
    pub expires_at: String,
    pub days_left: u32,
    /// Where it was, "Notebook > Section" (empty for a notebook).
    pub path: String,
    /// How many pages and (sub)sections went with it.
    pub pages: u32,
    pub sections: u32,
}

/// The position that puts an item at `index` among its siblings (the web's `positionAt` in
/// `src/components/shell/treePosition.ts`, and the server's, with the same results).
/// `sibling_positions` are the siblings' positions sorted ascending and **without the item
/// itself**; `index` 0 is first. Empty: 1. At or past the end: last + 1. First: first - 1. Else
/// the average of its two neighbours. For showing a drop at once; the move calls return the
/// position the server really chose.
#[uniffi::export]
pub fn position_at(sibling_positions: Vec<f64>, index: u32) -> f64 {
    let sibs = &sibling_positions;
    let index = index as usize;
    match sibs.len() {
        0 => 1.0,
        n if index >= n => sibs[n - 1] + 1.0,
        _ if index == 0 => sibs[0] - 1.0,
        _ => (sibs[index - 1] + sibs[index]) / 2.0,
    }
}

/// The index to give a move call for a drop next to `target_id` (the web's `indexFor` in
/// `treeDnd.ts`). `sibling_ids` are the new siblings in position order **without the item being
/// moved**. `after`: the drop is below the target, else above. A target that is not among them
/// (or a drop into a section or notebook, which has no target) gives the end.
#[uniffi::export]
pub fn drop_index(sibling_ids: Vec<String>, target_id: String, after: bool) -> u32 {
    match sibling_ids.iter().position(|s| *s == target_id) {
        None => sibling_ids.len() as u32,
        Some(i) => (if after { i + 1 } else { i }) as u32,
    }
}

impl Core {
    /// The workspace a stored tree shows a notebook, section or page in.
    fn workspace_of(&self, kind: &str, id: &str) -> Option<String> {
        self.store.as_ref()?.workspace_of(kind, id).ok().flatten()
    }

    /// After a tree write: fetch the tree again and store it. `workspace` is the one that
    /// changed; when it is not known (the id is in no stored tree), every stored tree is fetched.
    fn refresh_tree(&self, workspace: Option<String>) {
        let Some(store) = &self.store else { return };
        let workspaces = match workspace {
            Some(w) => vec![w],
            None => store.tree_workspaces().unwrap_or_default(),
        };
        for w in workspaces {
            if let Ok(t) = self.api.tree(&w) {
                let _ = store.put_tree(&w, &t);
            }
        }
    }
}

#[uniffi::export]
impl Core {
    // ───────── Notebooks ─────────

    /// A new notebook in the workspace (members and up), starting with one section named
    /// "General". `color` is #rrggbb (none: the server picks one from its palette);
    /// `visibility` is "shared" (the default) or "private" (only its creator and whoever it is
    /// shared with can see it). The name is trimmed by the server, 1 to 100 characters.
    #[uniffi::method(default(color = None, visibility = None))]
    pub fn create_notebook(
        &self,
        workspace_id: String,
        name: String,
        color: Option<String>,
        visibility: Option<String>,
    ) -> Result<NewNotebook, CoreError> {
        let nb = self.api.create_notebook(
            &workspace_id,
            &name,
            color.as_deref(),
            visibility.as_deref(),
        )?;
        self.refresh_tree(Some(workspace_id));
        Ok(NewNotebook {
            id: nb.id,
            section_id: nb.section_id,
        })
    }

    /// Rename a notebook (1 to 100 characters, trimmed by the server).
    pub fn rename_notebook(&self, notebook_id: String, name: String) -> Result<(), CoreError> {
        let ws = self.workspace_of("notebook", &notebook_id);
        self.api
            .patch_notebook(&notebook_id, &json!({ "name": name }))?;
        self.refresh_tree(ws);
        Ok(())
    }

    /// Set a notebook's colour (#rrggbb; anything else is refused with 400).
    pub fn set_notebook_color(&self, notebook_id: String, color: String) -> Result<(), CoreError> {
        let ws = self.workspace_of("notebook", &notebook_id);
        self.api
            .patch_notebook(&notebook_id, &json!({ "color": color }))?;
        self.refresh_tree(ws);
        Ok(())
    }

    /// Make a notebook "shared" or "private" (its creator only; a notebook with locked pages
    /// cannot be made shared). Answers how many single-page shares ended (making it private).
    pub fn set_notebook_visibility(
        &self,
        notebook_id: String,
        visibility: String,
    ) -> Result<u32, CoreError> {
        let ws = self.workspace_of("notebook", &notebook_id);
        let n = self
            .api
            .patch_notebook(&notebook_id, &json!({ "visibility": visibility }))?;
        self.refresh_tree(ws);
        Ok(n)
    }

    /// Reorder a notebook among the workspace's notebooks: `index` is its place among the
    /// others, without itself (0 first; none: last). Answers its new position.
    #[uniffi::method(default(index = None))]
    pub fn move_notebook(&self, notebook_id: String, index: Option<u32>) -> Result<f64, CoreError> {
        let ws = self.workspace_of("notebook", &notebook_id);
        let position = self.api.move_notebook(&notebook_id, index)?;
        self.refresh_tree(ws);
        Ok(position)
    }

    /// Delete a notebook: it goes to the Trash for 60 days with its sections and pages (its
    /// creator or a workspace admin may). Its tasks stay in the task list.
    pub fn delete_notebook(&self, notebook_id: String) -> Result<Trashed, CoreError> {
        let ws = self.workspace_of("notebook", &notebook_id);
        let t = self.api.delete_notebook(&notebook_id)?;
        self.refresh_tree(ws);
        Ok(trashed(t))
    }

    // ───────── Sections ─────────

    /// A new section at the end of a notebook (or of `parent_id`'s subsections: nested up to 3
    /// levels, in the same notebook). `color` is #rrggbb (none: the server picks one). Answers
    /// its id.
    #[uniffi::method(default(parent_id = None, color = None))]
    pub fn create_section(
        &self,
        notebook_id: String,
        name: String,
        parent_id: Option<String>,
        color: Option<String>,
    ) -> Result<String, CoreError> {
        let ws = self.workspace_of("notebook", &notebook_id);
        let id =
            self.api
                .create_section(&notebook_id, parent_id.as_deref(), &name, color.as_deref())?;
        self.refresh_tree(ws);
        Ok(id)
    }

    /// Rename a section (1 to 100 characters, trimmed by the server).
    pub fn rename_section(&self, section_id: String, name: String) -> Result<(), CoreError> {
        let ws = self.workspace_of("section", &section_id);
        self.api
            .patch_section(&section_id, &json!({ "name": name }))?;
        self.refresh_tree(ws);
        Ok(())
    }

    /// Set a section's colour (#rrggbb).
    pub fn set_section_color(&self, section_id: String, color: String) -> Result<(), CoreError> {
        let ws = self.workspace_of("section", &section_id);
        self.api
            .patch_section(&section_id, &json!({ "color": color }))?;
        self.refresh_tree(ws);
        Ok(())
    }

    /// Move a section (with its subsections and pages), as a drop in the web's sidebar does:
    /// under `parent_id` (none: at the top level of `notebook_id`), at `index` among its new
    /// siblings without itself (0 first; none: last). It may go to another notebook of the same
    /// workspace; when `parent_id` is given, that section's notebook wins. Refused (400): into
    /// itself or one of its subsections, past 3 levels, another workspace, or a section with
    /// locked pages into a notebook others can see. Answers where it ended up.
    #[uniffi::method(default(parent_id = None, index = None))]
    pub fn move_section(
        &self,
        section_id: String,
        notebook_id: String,
        parent_id: Option<String>,
        index: Option<u32>,
    ) -> Result<SectionPlace, CoreError> {
        let ws = self.workspace_of("section", &section_id);
        let m = self
            .api
            .move_section(&section_id, &notebook_id, parent_id.as_deref(), index)?;
        self.refresh_tree(ws);
        Ok(SectionPlace {
            notebook_id: m.notebook_id,
            parent_id: m.parent_id,
            position: m.position,
        })
    }

    /// Duplicate a section with its subsections, pages and the tasks on them (locked pages are
    /// left out). Without `notebook_id` the copy is named "<name> (copy)" and sits at the end of
    /// the original's siblings; into another notebook of the workspace it keeps the name and is
    /// at the top level. `name` overrides. Answers the copy's id.
    #[uniffi::method(default(notebook_id = None, name = None))]
    pub fn copy_section(
        &self,
        section_id: String,
        notebook_id: Option<String>,
        name: Option<String>,
    ) -> Result<String, CoreError> {
        let ws = self.workspace_of("section", &section_id);
        let id = self
            .api
            .copy_section(&section_id, notebook_id.as_deref(), name.as_deref())?;
        self.refresh_tree(ws);
        Ok(id)
    }

    /// Delete a section: it goes to the Trash for 60 days with its subsections and pages. Its
    /// tasks stay in the task list.
    pub fn delete_section(&self, section_id: String) -> Result<Trashed, CoreError> {
        let ws = self.workspace_of("section", &section_id);
        let t = self.api.delete_section(&section_id)?;
        self.refresh_tree(ws);
        Ok(trashed(t))
    }

    // ───────── Pages ─────────

    /// A new blank page at the end of a section, titled `title` (none: no title, which the app
    /// shows as "Untitled", as the web does). Answers its id. (The web's "default template"
    /// start, a client-side fill, is not part of this call.)
    #[uniffi::method(default(title = None))]
    pub fn create_page(
        &self,
        section_id: String,
        title: Option<String>,
    ) -> Result<String, CoreError> {
        let ws = self.workspace_of("section", &section_id);
        let id = self
            .api
            .create_page(&section_id, title.as_deref().unwrap_or(""))?;
        self.refresh_tree(ws);
        Ok(id)
    }

    /// Change a page's title (at most 300 characters; may be empty). Works on one's own locked
    /// page too.
    pub fn rename_page(&self, page_id: String, title: String) -> Result<(), CoreError> {
        let ws = self.workspace_of("page", &page_id);
        self.api.patch_page(&page_id, &json!({ "title": title }))?;
        self.refresh_tree(ws);
        Ok(())
    }

    /// Set a page's icon (an emoji or short text, cut to 16 characters by the server); none
    /// clears it.
    pub fn set_page_icon(&self, page_id: String, icon: Option<String>) -> Result<(), CoreError> {
        let ws = self.workspace_of("page", &page_id);
        self.api.patch_page(&page_id, &json!({ "icon": icon }))?;
        self.refresh_tree(ws);
        Ok(())
    }

    /// Move a page to `section_id` (none: stay in its section, reorder) at `index` among that
    /// section's other pages (0 first; none: last). Any section of the same workspace the caller
    /// can edit (another workspace is refused with 400). A locked page may only go where nobody
    /// else can see it. Answers where it ended up.
    #[uniffi::method(default(section_id = None, index = None))]
    pub fn move_page(
        &self,
        page_id: String,
        section_id: Option<String>,
        index: Option<u32>,
    ) -> Result<PagePlace, CoreError> {
        let ws = self.workspace_of("page", &page_id);
        let m = self.api.move_page(&page_id, section_id.as_deref(), index)?;
        self.refresh_tree(ws);
        Ok(PagePlace {
            section_id: m.section_id,
            position: m.position,
        })
    }

    /// Duplicate a page and the tasks written on it. In its own section the copy sits right
    /// after the original and is titled "<title> (copy)" ("Untitled (copy)" when it has none);
    /// into another section (`section_id`, same workspace) it goes to the end and keeps the
    /// title; `title` overrides. A locked page cannot be duplicated (400). Answers the copy's id.
    #[uniffi::method(default(section_id = None, title = None))]
    pub fn copy_page(
        &self,
        page_id: String,
        section_id: Option<String>,
        title: Option<String>,
    ) -> Result<String, CoreError> {
        let ws = self.workspace_of("page", &page_id);
        let id = self
            .api
            .copy_page(&page_id, section_id.as_deref(), title.as_deref())?;
        self.refresh_tree(ws);
        Ok(id)
    }

    /// Delete a page: it goes to the Trash for 60 days (its owner may also trash a locked page).
    /// Its tasks stay in the task list, shown as on a page "in Trash". The page's stored
    /// document stays on the device while it is in the Trash.
    pub fn delete_page(&self, page_id: String) -> Result<Trashed, CoreError> {
        let ws = self.workspace_of("page", &page_id);
        let t = self.api.delete_page(&page_id)?;
        self.refresh_tree(ws);
        Ok(trashed(t))
    }

    // ───────── Trash ─────────

    /// The workspace's Trash as the caller may see it, newest first: pages, sections and
    /// notebooks deleted in the last 60 days, each the top of what went with it. Members and up
    /// only (viewers get an empty list); someone else's locked page is never listed. Online only.
    pub fn trash(&self, workspace_id: String) -> Result<Vec<TrashEntry>, CoreError> {
        Ok(self
            .api
            .trash(&workspace_id)?
            .into_iter()
            .map(|i| TrashEntry {
                kind: kind(i.kind),
                id: i.id,
                name: i.name,
                icon: i.icon,
                deleted_at: i.deleted_at,
                deleted_by: i.deleted_by,
                deleted_by_name: i.deleted_by_name,
                expires_at: i.expires_at,
                days_left: i.days_left,
                path: i.path,
                pages: i.pages,
                sections: i.sections,
            })
            .collect())
    }

    /// Put a Trash entry back with everything that was trashed with it (the toast's Undo).
    /// Answers where it went when its old place is gone (a page: the notebook's first section;
    /// a section: the top of its notebook; the section or notebook name), none when it went
    /// back as it was. A page or section whose notebook is also in the Trash is refused (409):
    /// restore the notebook first.
    pub fn restore_from_trash(
        &self,
        workspace_id: String,
        kind: TrashKind,
        id: String,
    ) -> Result<Option<String>, CoreError> {
        let r = self.api.restore_from_trash(api_kind(kind), &id)?;
        self.refresh_tree(Some(workspace_id));
        Ok((!r.moved_to.is_empty()).then_some(r.moved_to))
    }

    /// Delete a Trash entry for good, with everything in it (its tasks become standalone tasks).
    /// Cannot be undone.
    pub fn delete_forever(
        &self,
        workspace_id: String,
        kind: TrashKind,
        id: String,
    ) -> Result<(), CoreError> {
        self.api.purge_from_trash(api_kind(kind), &id)?;
        self.refresh_tree(Some(workspace_id));
        Ok(())
    }

    /// Delete everything in the workspace's Trash for good (owners and admins; others get 403).
    /// Answers how many entries went. Cannot be undone.
    pub fn empty_trash(&self, workspace_id: String) -> Result<u32, CoreError> {
        let n = self.api.empty_trash(&workspace_id)?;
        self.refresh_tree(Some(workspace_id));
        Ok(n)
    }

    /// The workspace's pages that are in the Trash, as the last stored tree listed them (local,
    /// instant; none if no tree was stored). A task on one of them is shown "in Trash".
    pub fn cached_trashed_pages(&self, workspace_id: String) -> Option<Vec<TrashedPage>> {
        let t = self.store.as_ref()?.tree(&workspace_id).ok()??;
        Some(
            t.trashed_pages
                .into_iter()
                .map(|p| TrashedPage {
                    id: p.id,
                    title: p.title,
                })
                .collect(),
        )
    }
}

fn trashed(t: nv_api::Trashed) -> Trashed {
    Trashed {
        trash_id: t.trash_id,
        tasks: t.tasks,
    }
}
