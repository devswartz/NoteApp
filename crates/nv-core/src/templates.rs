//! Templates, push device tokens and reminder snooze in the Core API (docs: "For apple:
//! templates, push devices, box clipboard"). Online only, like the account calls: offline they
//! throw `CoreError::Network` and change nothing. Writing a template's content into a page is
//! `LivePage::insert_template_content`; saving a page as one starts at
//! `LivePage::canvas_template_json`.

use nv_api as api;

use crate::{Core, CoreError};

/// Where a template is offered.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TemplateSectionScope {
    pub section_id: String,
    /// Also offered in the section's subsections.
    pub include_subsections: bool,
}

/// A saved page template, without its content.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TemplateInfo {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    /// An emoji (at most 16 characters) or none.
    pub icon: Option<String>,
    /// "workspace" (everyone in it) or "private" (saved from a private notebook: its creator only).
    pub visibility: String,
    /// "canvas" or "document" (the kind of page it was saved from; new pages are all canvases).
    pub kind: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub task_count: u32,
    pub file_count: u32,
    /// The signed-in user may rename or delete it.
    pub can_manage: bool,
    /// Offered only in `sections` (and their subsections when `include_subsections`); false:
    /// offered everywhere. `sections` lists only those the user can see.
    pub scoped: bool,
    pub sections: Vec<TemplateSectionScope>,
}

/// What using a template (or claiming a new page's pending one) returns: content to write
/// into the page with `LivePage::insert_template_content`. New tasks and file copies for the
/// page were already made by the server.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TemplateContent {
    /// The template's name: the page's title when it has none.
    pub title: String,
    /// The template's icon, for a page that has none.
    pub icon: Option<String>,
    /// "canvas" or "document".
    pub kind: String,
    /// The editor JSON (a `doc`; for "canvas" a doc of `canvasBox` nodes).
    pub content_json: String,
    /// The tasks the server created (so "start blank" can delete them).
    pub task_ids: Vec<String>,
    /// Only from `claim_pending_template`.
    pub template_id: Option<String>,
}

/// The template a just-made page was made from; claim it once the page is open.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PendingTemplate {
    pub id: String,
    pub name: String,
}

/// A page just made by `create_page_from_template`.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CreatedPage {
    pub id: String,
    /// Some when the section has a default template (for "default") or one was named: open the
    /// page, then `claim_pending_template` and `insert_template_content`.
    pub pending_template: Option<PendingTemplate>,
}

/// A section's default template choice.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum DefaultTemplateChoice {
    /// Use the parent section's default (the "Inherit" state of a new section).
    Inherit,
    /// No default here, even if a parent section has one.
    NoDefault,
    /// This template: workspace-visible and offered in the section.
    Template { id: String },
}

/// A reminder snoozed from its notification.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SnoozeResult {
    pub task_id: String,
    /// ISO instant the reminder fires again.
    pub until: String,
}

fn count(n: u64) -> u32 {
    n.min(u32::MAX as u64) as u32
}

fn scope_in(s: Vec<TemplateSectionScope>) -> Vec<api::TemplateSection> {
    s.into_iter()
        .map(|s| api::TemplateSection {
            section_id: s.section_id,
            include_subsections: s.include_subsections,
        })
        .collect()
}

fn info(t: api::TemplateMeta) -> TemplateInfo {
    TemplateInfo {
        id: t.id,
        workspace_id: t.workspace_id,
        name: t.name,
        icon: t.icon,
        visibility: t.visibility,
        kind: t.kind,
        created_by: t.created_by,
        created_at: t.created_at,
        updated_at: t.updated_at,
        task_count: count(t.task_count),
        file_count: count(t.file_count),
        can_manage: t.can_manage,
        scoped: t.scoped,
        sections: t
            .sections
            .into_iter()
            .map(|s| TemplateSectionScope {
                section_id: s.section_id,
                include_subsections: s.include_subsections,
            })
            .collect(),
    }
}

fn content(u: api::TemplateUse) -> TemplateContent {
    TemplateContent {
        title: u.title,
        icon: u.icon,
        kind: if u.kind.is_empty() {
            "canvas".into()
        } else {
            u.kind
        },
        content_json: u.content.to_string(),
        task_ids: u.task_ids,
        template_id: u.template_id,
    }
}

#[uniffi::export]
impl Core {
    /// The workspace's saved templates the user may see, oldest first. The built-in templates
    /// (Meeting notes, To-do list ...) are the app's own and not listed here.
    pub fn templates(&self, workspace_id: String) -> Result<Vec<TemplateInfo>, CoreError> {
        Ok(self
            .api
            .templates(&workspace_id)?
            .into_iter()
            .map(info)
            .collect())
    }

    /// Save a page as a template: `content_json` from `LivePage::canvas_template_json()`, `kind`
    /// "canvas". `name` 1 to 100 characters; `sections` ties it to sections (none: everywhere).
    /// A page in a private notebook makes a private template; a locked page can't be saved (400);
    /// 403 for someone with only a page share. Counts: at most 100 templates per workspace.
    #[uniffi::method(default(icon = None, kind = "canvas", sections = None))]
    pub fn save_page_as_template(
        &self,
        page_id: String,
        name: String,
        icon: Option<String>,
        content_json: String,
        kind: String,
        sections: Option<Vec<TemplateSectionScope>>,
    ) -> Result<TemplateInfo, CoreError> {
        let content: serde_json::Value =
            serde_json::from_str(&content_json).map_err(|e| CoreError::InvalidPage {
                message: e.to_string(),
            })?;
        let scope = sections.map(scope_in);
        Ok(info(self.api.save_page_as_template(
            &page_id,
            &name,
            icon.as_deref(),
            &content,
            &kind,
            scope.as_deref(),
        )?))
    }

    /// Rename a template, change its icon (`Some("")` clears it) and/or where it is offered
    /// (`sections`: the whole list the user can see; empty: everywhere). Only its creator or a
    /// workspace admin (403 otherwise). Answers the template as it is now.
    #[uniffi::method(default(name = None, icon = None, sections = None))]
    pub fn update_template(
        &self,
        id: String,
        name: Option<String>,
        icon: Option<String>,
        sections: Option<Vec<TemplateSectionScope>>,
    ) -> Result<TemplateInfo, CoreError> {
        let scope = sections.map(scope_in);
        Ok(info(self.api.update_template(
            &id,
            name.as_deref(),
            icon.as_deref(),
            scope.as_deref(),
        )?))
    }

    /// Delete a template and its attachment copies (the pages made from it are untouched). Its
    /// creator or a workspace admin only.
    pub fn delete_template(&self, id: String) -> Result<(), CoreError> {
        Ok(self.api.delete_template(&id)?)
    }

    /// Use a template on a page the user can edit: the server makes new tasks and file copies
    /// for `page_id` and answers the content; then call
    /// `LivePage::insert_template_content(content_json, kind, date, time)` on the open page, and
    /// set its title and icon if it has none. The server does not replace page content: the
    /// client writes it (so it is one undoable edit).
    pub fn use_template(
        &self,
        template_id: String,
        page_id: String,
    ) -> Result<TemplateContent, CoreError> {
        Ok(content(self.api.use_template(&template_id, &page_id)?))
    }

    /// Choose the template new pages in a section start from (editors only; the template must
    /// be workspace-visible and offered in the section, else 400). Refreshes the cached tree:
    /// `Section.default_template_id` / `no_default_template` show the choice.
    pub fn set_section_default_template(
        &self,
        section_id: String,
        choice: DefaultTemplateChoice,
    ) -> Result<(), CoreError> {
        let ws = self.workspace_of("section", &section_id);
        let id = match &choice {
            DefaultTemplateChoice::Inherit => None,
            DefaultTemplateChoice::NoDefault => Some("none"),
            DefaultTemplateChoice::Template { id } => Some(id.as_str()),
        };
        self.api.set_section_default_template(&section_id, id)?;
        self.refresh_tree(ws);
        Ok(())
    }

    /// Like `create_page`, starting from a template: `template` "default" (the section's own or
    /// inherited default template, if it has a usable one: the app's New page), a template id
    /// (New page from template) or none (blank, as `create_page`). When the answer's
    /// `pending_template` is set, open the page and call `claim_pending_template(page_id, false)`.
    #[uniffi::method(default(title = None, template = None))]
    pub fn create_page_from_template(
        &self,
        section_id: String,
        title: Option<String>,
        template: Option<String>,
    ) -> Result<CreatedPage, CoreError> {
        let ws = self.workspace_of("section", &section_id);
        let r = self.api.create_page_from_template(
            &section_id,
            title.as_deref().unwrap_or(""),
            template.as_deref(),
        )?;
        self.refresh_tree(ws);
        Ok(CreatedPage {
            id: r.id,
            pending_template: r.pending_template.map(|p| PendingTemplate {
                id: p.id,
                name: p.name,
            }),
        })
    }

    /// Claim a new page's pending template, once (a compare-and-clear on the server: with
    /// several devices open only one gets it): the server makes the tasks and file copies and
    /// answers the content, which the caller writes with `LivePage::insert_template_content`.
    /// None when nothing is pending (already claimed, deleted, or the page isn't the user's).
    /// `discard` true clears it without using it (the page already has content). 403 for a page
    /// someone else made.
    pub fn claim_pending_template(
        &self,
        page_id: String,
        discard: bool,
    ) -> Result<Option<TemplateContent>, CoreError> {
        Ok(self
            .api
            .claim_pending_template(&page_id, discard)?
            .map(content))
    }

    /// Tell the server this device can receive push notifications: `token` the APNs device
    /// token as lowercase hex (the server accepts 20 to 4096 of letters, digits and `_:.-`),
    /// `platform` "ios" (or "android"). Idempotent; a token that was another user's moves to the
    /// signed-in one. Call after sign-in and whenever the system hands out a new token.
    pub fn register_push_device(&self, token: String, platform: String) -> Result<(), CoreError> {
        Ok(self.api.register_device(&platform, &token)?)
    }

    /// Remove this device's token (sign-out, notifications turned off). Idempotent; best done
    /// before `sign_out` (it needs the session).
    pub fn unregister_push_device(&self, token: String) -> Result<(), CoreError> {
        Ok(self.api.unregister_device(&token)?)
    }

    /// Snooze a reminder from its notification: `snooze_token` is the push's `snoozeToken` key,
    /// `option` "10m", "1h" or "tomorrow". Needs no session (the token is the credential, valid 7
    /// days), so it works from a notification action while the app is closed. 404 for an expired
    /// token or a task that is done or gone; 400 for another option.
    pub fn snooze_reminder(
        &self,
        snooze_token: String,
        option: String,
    ) -> Result<SnoozeResult, CoreError> {
        let r = self.api.snooze_reminder(&snooze_token, &option)?;
        Ok(SnoozeResult {
            task_id: r.task_id,
            until: r.until,
        })
    }
}
