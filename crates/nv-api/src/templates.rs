//! Page templates, push device tokens and reminder snooze. The truth is the server:
//! `server/routes/templates.ts`, `server/routes/reminders.ts`, `server/routes/pages.ts`.

use serde_json::{json, Value};

use crate::*;

impl Client {
    /// The templates this user may see in a workspace (GET /workspaces/:id/templates), oldest
    /// first. Built-in templates are not on the server; only the workspace's saved ones.
    pub fn templates(&self, workspace_id: &str) -> Result<Vec<TemplateMeta>, ApiError> {
        self.call(
            "GET",
            &format!("/workspaces/{}/templates", encode_component(workspace_id)),
            None,
        )
    }

    /// Save a page as a template (POST /pages/:id/templates). `content` is the editor JSON
    /// (for `kind` "canvas": a doc of `canvasBox` nodes); `sections` ties it to sections.
    pub fn save_page_as_template(
        &self,
        page_id: &str,
        name: &str,
        icon: Option<&str>,
        content: &Value,
        kind: &str,
        sections: Option<&[TemplateSection]>,
    ) -> Result<TemplateMeta, ApiError> {
        let mut body = json!({ "name": name, "content": content, "kind": kind });
        if let Some(i) = icon {
            body["icon"] = json!(i);
        }
        if let Some(s) = sections {
            body["sections"] = serde_json::to_value(s).unwrap_or(Value::Null);
        }
        self.call(
            "POST",
            &format!("/pages/{}/templates", encode_component(page_id)),
            Some(&body),
        )
    }

    /// Rename / change the icon / change where it is offered (PATCH /templates/:id). `icon`:
    /// none leaves it, `Some("")` clears it.
    pub fn update_template(
        &self,
        id: &str,
        name: Option<&str>,
        icon: Option<&str>,
        sections: Option<&[TemplateSection]>,
    ) -> Result<TemplateMeta, ApiError> {
        let mut body = json!({});
        if let Some(n) = name {
            body["name"] = json!(n);
        }
        if let Some(i) = icon {
            body["icon"] = json!(i);
        }
        if let Some(s) = sections {
            body["sections"] = serde_json::to_value(s).unwrap_or(Value::Null);
        }
        self.call(
            "PATCH",
            &format!("/templates/{}", encode_component(id)),
            Some(&body),
        )
    }

    /// DELETE /templates/:id.
    pub fn delete_template(&self, id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/templates/{}", encode_component(id)),
            None,
        )?;
        Ok(())
    }

    /// POST /templates/:id/use: makes new tasks and file copies for `page_id` and answers the
    /// content to insert. Nothing is written to the page.
    pub fn use_template(&self, id: &str, page_id: &str) -> Result<TemplateUse, ApiError> {
        self.call(
            "POST",
            &format!("/templates/{}/use", encode_component(id)),
            Some(&json!({ "pageId": page_id })),
        )
    }

    /// PUT /sections/:id/default-template. `template_id`: a template id, `"none"` (no default
    /// here, even if a parent has one) or none (inherit the parent's).
    pub fn set_section_default_template(
        &self,
        section_id: &str,
        template_id: Option<&str>,
    ) -> Result<(), ApiError> {
        let _: Value = self.call(
            "PUT",
            &format!(
                "/sections/{}/default-template",
                encode_component(section_id)
            ),
            Some(&json!({ "templateId": template_id })),
        )?;
        Ok(())
    }

    /// POST /sections/:id/pages with a `template` ("default" or a template id; none: blank).
    pub fn create_page_from_template(
        &self,
        section_id: &str,
        title: &str,
        template: Option<&str>,
    ) -> Result<PageCreated, ApiError> {
        let mut body = json!({ "title": title });
        if let Some(t) = template {
            body["template"] = json!(t);
        }
        self.call(
            "POST",
            &format!("/sections/{}/pages", encode_component(section_id)),
            Some(&body),
        )
    }

    /// POST /pages/:id/pending-template: claim the template a just-made page was made from
    /// (once; none when nothing is pending). `discard` clears it without using it.
    pub fn claim_pending_template(
        &self,
        page_id: &str,
        discard: bool,
    ) -> Result<Option<TemplateUse>, ApiError> {
        let body = if discard {
            json!({ "discard": true })
        } else {
            json!({})
        };
        self.call(
            "POST",
            &format!("/pages/{}/pending-template", encode_component(page_id)),
            Some(&body),
        )
    }

    /// POST /notifications/devices.
    pub fn register_device(&self, platform: &str, token: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "POST",
            "/notifications/devices",
            Some(&json!({ "platform": platform, "token": token })),
        )?;
        Ok(())
    }

    /// DELETE /notifications/devices.
    pub fn unregister_device(&self, token: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            "/notifications/devices",
            Some(&json!({ "token": token })),
        )?;
        Ok(())
    }

    /// POST /reminders/snooze: no sign-in needed, the push's `snoozeToken` is the credential.
    /// `option`: "10m", "1h" or "tomorrow".
    pub fn snooze_reminder(&self, token: &str, option: &str) -> Result<Snoozed, ApiError> {
        let res = self.send(
            "POST",
            "/reminders/snooze",
            None,
            Some(&json!({ "token": token, "option": option })),
        )?;
        Self::decode(res)
    }
}
