//! The Core API's online part (M3): a `Core` for one server. Sign-in and the session (the app
//! keeps the refresh token in the keychain: `refresh_token()` after every call that may rotate
//! it, `restore_session` at launch), the workspace list, tree and tasks, and live pages.
//!
//! Calls block until the server answers: apps call them off the main thread (Swift: from a
//! `Task`). Local-first reads from the on-device store replace most of these in M5/M7.

use std::sync::{Arc, Mutex};

use nv_api::ApiError;
use nv_model::yrs::{ReadTxn, StateVector, Transact};
use nv_model::Page;
use nv_sync::{LiveDoc, Status};
use serde_json::json;

use crate::{page_info, CoreError, PageInfo};

impl From<ApiError> for CoreError {
    fn from(e: ApiError) -> Self {
        match e {
            ApiError::Network(message) => CoreError::Network { message },
            ApiError::Http {
                status,
                message,
                code,
                ..
            } => CoreError::Server {
                status,
                message,
                code,
            },
            ApiError::SignedOut => CoreError::SignedOut,
            ApiError::Decode(message) => CoreError::Network {
                message: format!("unexpected response: {message}"),
            },
        }
    }
}

impl From<nv_sync::ConnectError> for CoreError {
    fn from(e: nv_sync::ConnectError) -> Self {
        match e {
            nv_sync::ConnectError::Refused(401) => CoreError::SignedOut,
            nv_sync::ConnectError::Refused(status) => CoreError::Server {
                status,
                message: e.to_string(),
                code: None,
            },
            e => CoreError::Network {
                message: e.to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    /// The user's colour (#rrggbb), for avatars and cursors.
    pub color: String,
    pub email_verified: bool,
}

/// A sign-in: who, and the refresh token to keep in the keychain.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SignedIn {
    pub user: User,
    pub refresh_token: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// owner, admin, member or viewer.
    pub role: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub color: String,
    /// shared or private.
    pub visibility: String,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Section {
    pub id: String,
    pub notebook_id: String,
    /// The section this one is nested in, or none at the top level.
    pub parent_id: Option<String>,
    pub name: String,
    pub color: String,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageMeta {
    pub id: String,
    pub section_id: String,
    pub title: String,
    pub icon: Option<String>,
    pub position: f64,
    pub updated_at: String,
    pub locked: bool,
}

/// What the sidebar shows: notebooks, sections and pages, each list in no particular order (sort by `position`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Tree {
    pub notebooks: Vec<Notebook>,
    pub sections: Vec<Section>,
    pub pages: Vec<PageMeta>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Task {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: String,
    pub done: bool,
    /// 1 urgent … 4 none.
    pub priority: u8,
    /// Local date, YYYY-MM-DD.
    pub due_date: Option<String>,
    /// Local time, HH:mm.
    pub due_time: Option<String>,
    pub assignee_id: Option<String>,
    /// The page the task is written on, if any.
    pub page_id: Option<String>,
    /// The task this is a subtask of.
    pub parent_id: Option<String>,
    pub tag_ids: Vec<String>,
    /// Ticked and total items of the checklists under the task on its page.
    pub checklist_done: Option<u32>,
    pub checklist_total: Option<u32>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// On a locked page this sign-in hasn't unlocked: title and text are withheld.
    pub locked: bool,
}

fn user(u: nv_api::User) -> User {
    User {
        id: u.id,
        email: u.email,
        name: u.name,
        color: u.color,
        email_verified: u.email_verified,
    }
}

fn task(t: nv_api::Task) -> Task {
    Task {
        done: t.status == "done",
        checklist_done: t.checklist.as_ref().map(|c| c.done),
        checklist_total: t.checklist.as_ref().map(|c| c.total),
        id: t.id,
        workspace_id: t.workspace_id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        due_date: t.due_date,
        due_time: t.due_time,
        assignee_id: t.assignee_id,
        page_id: t.page_id,
        parent_id: t.parent_id,
        tag_ids: t.tag_ids,
        completed_at: t.completed_at,
        created_at: t.created_at,
        updated_at: t.updated_at,
        locked: t.locked,
    }
}

/// The core for one server.
#[derive(uniffi::Object)]
pub struct Core {
    api: nv_api::Client,
}

impl Core {
    fn signed_in(&self, s: nv_api::AuthSession) -> SignedIn {
        SignedIn {
            user: user(s.user),
            refresh_token: s.refresh_token,
        }
    }
}

#[uniffi::export]
impl Core {
    /// A core talking to `server_url`, e.g. `https://app.notiveloapp.com`.
    #[uniffi::constructor]
    pub fn new(server_url: String) -> Arc<Core> {
        Arc::new(Core {
            api: nv_api::Client::new(&server_url),
        })
    }

    pub fn sign_in(&self, email: String, password: String) -> Result<SignedIn, CoreError> {
        Ok(self.signed_in(self.api.login(&email, &password)?))
    }

    /// Create an account (when the server allows sign-ups) and sign in to it.
    pub fn register(
        &self,
        name: String,
        email: String,
        password: String,
    ) -> Result<SignedIn, CoreError> {
        Ok(self.signed_in(self.api.register(&name, &email, &password)?))
    }

    /// Resume a sign-in kept from before (its refresh token). `SignedOut` when it no longer works.
    pub fn restore_session(&self, refresh_token: String) -> Result<SignedIn, CoreError> {
        Ok(self.signed_in(self.api.restore(&refresh_token)?))
    }

    /// The current refresh token. It rotates when the session refreshes: store it again after calls.
    pub fn refresh_token(&self) -> Option<String> {
        self.api.session_refresh_token()
    }

    pub fn user(&self) -> Option<User> {
        self.api.user().map(user)
    }

    /// Sign out here and revoke the session on the server.
    pub fn sign_out(&self) {
        self.api.logout()
    }

    pub fn workspaces(&self) -> Result<Vec<Workspace>, CoreError> {
        Ok(self
            .api
            .workspaces()?
            .into_iter()
            .map(|w| Workspace {
                id: w.id,
                name: w.name,
                role: w.role,
                created_at: w.created_at,
            })
            .collect())
    }

    pub fn tree(&self, workspace_id: String) -> Result<Tree, CoreError> {
        let t = self.api.tree(&workspace_id)?;
        Ok(Tree {
            notebooks: t
                .notebooks
                .into_iter()
                .map(|n| Notebook {
                    id: n.id,
                    name: n.name,
                    color: n.color,
                    visibility: n.visibility,
                    position: n.position,
                })
                .collect(),
            sections: t
                .sections
                .into_iter()
                .map(|s| Section {
                    id: s.id,
                    notebook_id: s.notebook_id,
                    parent_id: s.parent_id,
                    name: s.name,
                    color: s.color,
                    position: s.position,
                })
                .collect(),
            pages: t
                .pages
                .into_iter()
                .map(|p| PageMeta {
                    id: p.id,
                    section_id: p.section_id,
                    title: p.title,
                    icon: p.icon,
                    position: p.position,
                    updated_at: p.updated_at,
                    locked: p.locked,
                })
                .collect(),
        })
    }

    /// The workspace's tasks, as the task views list them.
    pub fn tasks(&self, workspace_id: String) -> Result<Vec<Task>, CoreError> {
        Ok(self
            .api
            .tasks(&workspace_id)?
            .into_iter()
            .map(task)
            .collect())
    }

    /// A new task, standalone or on a page (`page_id`).
    pub fn create_task(
        &self,
        workspace_id: String,
        title: String,
        page_id: Option<String>,
    ) -> Result<Task, CoreError> {
        let new = nv_api::NewTask {
            title,
            page_id,
            ..Default::default()
        };
        Ok(task(self.api.create_task(&workspace_id, &new)?))
    }

    pub fn set_task_done(&self, task_id: String, done: bool) -> Result<Task, CoreError> {
        Ok(task(self.api.update_task(
            &task_id,
            &json!({ "status": if done { "done" } else { "open" } }),
        )?))
    }

    /// A page's document as the server last saved it (a Yjs update; `read_page` reads it).
    pub fn page_document(&self, page_id: String) -> Result<Vec<u8>, CoreError> {
        Ok(self.api.page_doc(&page_id)?)
    }

    /// Open a page live: the listener hears the sync status and every change (anyone's).
    /// Close it when the page leaves the screen. On `Closed { code: 4401 }` open it again (the
    /// session refreshes first); 4403 means access is gone.
    pub fn open_page(
        &self,
        page_id: String,
        listener: Arc<dyn PageListener>,
    ) -> Result<Arc<LivePage>, CoreError> {
        let token = self.api.access_token()?;
        let doc = nv_model::new_doc();
        let relay = Arc::new(Relay {
            doc: doc.clone(),
            listener,
        });
        let live = LiveDoc::connect(&self.api.collab_url(&page_id), &token, doc.clone(), relay)?;
        Ok(Arc::new(LivePage {
            page_id,
            me: self.user(),
            doc,
            live: Mutex::new(Some(live)),
        }))
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum SyncStatus {
    /// Connected, waiting for the server's copy.
    Connected,
    /// Up to date with the server; edits flow both ways.
    Synced,
    /// The connection closed: 1000 by us, 4401 token expired (reopen), 4403 no access.
    Closed {
        code: u16,
        reason: String,
    },
    Failed {
        message: String,
    },
}

/// Told about a live page's changes. Called on the core's sync thread: hop to the main thread to update UI.
#[uniffi::export(with_foreign)]
pub trait PageListener: Send + Sync {
    fn on_status(&self, status: SyncStatus);
    /// The page changed (the initial sync, or someone's edit): its new state.
    fn on_change(&self, page: PageInfo);
}

struct Relay {
    doc: nv_model::yrs::Doc,
    listener: Arc<dyn PageListener>,
}

impl nv_sync::Listener for Relay {
    fn on_status(&self, s: Status) {
        self.listener.on_status(match s {
            Status::Connected => SyncStatus::Connected,
            Status::Synced => SyncStatus::Synced,
            Status::Closed { code, reason } => SyncStatus::Closed { code, reason },
            Status::Failed(message) => SyncStatus::Failed { message },
        })
    }
    fn on_doc_changed(&self) {
        self.listener.on_change(page_info(&Page::read(&self.doc)))
    }
}

/// A page open live.
#[derive(uniffi::Object)]
pub struct LivePage {
    page_id: String,
    me: Option<User>,
    doc: nv_model::yrs::Doc,
    live: Mutex<Option<LiveDoc>>,
}

#[uniffi::export]
impl LivePage {
    pub fn page_id(&self) -> String {
        self.page_id.clone()
    }

    /// The page as it is now.
    pub fn info(&self) -> PageInfo {
        page_info(&Page::read(&self.doc))
    }

    /// The whole document as a Yjs update (to save, or to read with `read_page`).
    pub fn document(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// Apply a local edit (a Yjs update); it is sent to everyone on the page.
    pub fn apply_update(&self, update: Vec<u8>) -> Result<(), CoreError> {
        let live = self.live.lock().unwrap();
        let live = live.as_ref().ok_or(CoreError::Network {
            message: "the page is closed".into(),
        })?;
        live.apply_local_update(&update)
            .map_err(|e| CoreError::InvalidPage {
                message: e.to_string(),
            })
    }

    /// Show the signed-in user to the others on the page, as the web app does (src/editor/collab.ts).
    pub fn announce_presence(&self, can_edit: bool) {
        let live = self.live.lock().unwrap();
        let (Some(me), Some(l)) = (&self.me, live.as_ref()) else {
            return;
        };
        l.set_presence(&json!({ "user": { "id": me.id, "name": me.name, "color": me.color, "canEdit": can_edit } }).to_string());
    }

    /// Everyone's presence on the page as JSON states (this user's included).
    pub fn presence(&self) -> Vec<String> {
        self.live
            .lock()
            .unwrap()
            .as_ref()
            .map(|l| l.presence().into_iter().map(|(_, s)| s).collect())
            .unwrap_or_default()
    }

    /// Close the connection (the listener hears `Closed { code: 1000 }`).
    pub fn close(&self) {
        if let Some(mut l) = self.live.lock().unwrap().take() {
            l.close();
        }
    }
}
