//! The Core API's online part (M3): a `Core` for one server. Sign-in and the session (the app
//! keeps the refresh token in the keychain: `refresh_token()` after every call that may rotate
//! it, `restore_session` at launch), the workspace list, tree and tasks, and live pages.
//!
//! Calls block until the server answers: apps call them off the main thread (Swift: from a
//! `Task`). Every call is safe from several threads at once: the session's tokens sit behind a
//! lock (one refresh at a time; the others wait and use its token), HTTP goes through one
//! thread-safe agent, and the store serialises its own reads and writes.
//!
//! **Live pages.** `open_live_page` returns at once and connects on the page's own thread,
//! reconnecting by itself after drops (with backoff), refreshing the session on 4401, keeping
//! local edits until the server has them (in the store, so they survive a restart), and reporting
//! all of it as `LiveStatus` to a `LivePageListener`. `open_page` is the older form (it blocks
//! for the first connect and reports `SyncStatus`); it reconnects the same way.
//!
//! **The on-device store** (`nv-store`, a Core made with `Core::with_store`). Reads come in pairs:
//!
//! - `cached_workspaces()`, `cached_tree(..)`, `cached_tasks(..)`, `cached_page_document(..)`
//!   are local and instant: the copy last stored, or none. Safe on the main thread.
//! - `workspaces()`, `tree(..)`, `tasks(..)`, `page_document(..)` ask the server and store what
//!   it sends. When the server can't be reached (`CoreError::Network`) they return the stored copy
//!   instead, if there is one.
//!
//! So an app shows the cached copy first, then calls the server one and shows its answer. Locked
//! pages are never stored (see `nv-store`); `sign_out` clears the store, and a sign-in as another
//! user clears it first. A Core from `Core::new` has no store: the cached reads return none.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nv_api::ApiError;
use nv_model::yrs::{ReadTxn, StateVector, Transact};
use nv_model::Page;
use nv_store::Store;
use nv_sync::{AuthError, Backoff, LiveDoc, Status};
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

pub(crate) fn user(u: nv_api::User) -> User {
    User {
        id: u.id,
        email: u.email,
        name: u.name,
        color: u.color,
        email_verified: u.email_verified,
    }
}

pub(crate) fn task(t: nv_api::Task) -> Task {
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

fn workspace(w: nv_api::Workspace) -> Workspace {
    Workspace {
        id: w.id,
        name: w.name,
        role: w.role,
        created_at: w.created_at,
    }
}

fn tree(t: nv_api::Tree) -> Tree {
    Tree {
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
    }
}

/// Open the database at `path`, replacing it when it can't be used (it is only a cache). If even
/// that fails, an in-memory store, so the app still works (just without an offline copy).
fn open_store(path: &Path) -> Option<Arc<Store>> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    Store::open_or_reset(path)
        .or_else(|_| Store::open_in_memory())
        .ok()
        .map(Arc::new)
}

/// The session as the live pages' threads see it.
struct CoreSession(Arc<nv_api::Client>);

fn auth_error(e: ApiError) -> AuthError {
    match e {
        ApiError::SignedOut => AuthError::SignedOut,
        e => AuthError::Unavailable(e.to_string()),
    }
}

impl Core {
    /// `tasks()` before it is turned into the Core API's `Task` (or `TaskDetail`).
    pub(crate) fn tasks_raw(&self, workspace_id: &str) -> Result<Vec<nv_api::Task>, CoreError> {
        self.send_queued_quietly();
        // Unlocked: tasks of locked pages arrive in full; know which pages are locked first.
        self.refresh_lock_knowledge(Some(workspace_id.to_string()));
        let mut ts = self.fetch(
            || self.api.tasks(workspace_id),
            |s, ts| {
                let _ = s.put_tasks(workspace_id, ts);
            },
            |s| s.tasks(workspace_id).ok().flatten(),
        )?;
        if self.overlay_queued(workspace_id) {
            if let Some(stored) = self
                .store
                .as_ref()
                .and_then(|s| s.tasks(workspace_id).ok().flatten())
            {
                ts = stored;
            }
        }
        Ok(ts)
    }
}

impl nv_sync::Session for CoreSession {
    fn token(&self) -> Result<String, AuthError> {
        self.0.access_token().map_err(auth_error)
    }
    fn refresh(&self, rejected: &str) -> Result<String, AuthError> {
        self.0.access_token_replacing(rejected).map_err(auth_error)
    }
}

/// A live page's queued edits, in the store (refused there unless the page is known unlocked:
/// then they stay in memory only).
struct StoreOutbox {
    store: Arc<Store>,
    page_id: String,
    /// Access ended (4403): keep nothing more.
    forbidden: Arc<AtomicBool>,
}

impl nv_sync::Outbox for StoreOutbox {
    fn keep(&self, updates: &[Vec<u8>]) -> Vec<Option<i64>> {
        if self.forbidden.load(Ordering::SeqCst) {
            return vec![None; updates.len()];
        }
        match self.store.queue_updates(&self.page_id, updates) {
            Ok(Some(keys)) => keys.into_iter().map(Some).collect(),
            _ => vec![None; updates.len()],
        }
    }
    fn confirmed(&self, keys: &[i64]) {
        let _ = self.store.unqueue(&self.page_id, keys);
    }
}

/// Save a page's document to the store (refused there for a locked page).
fn save_page(store: &Option<Arc<Store>>, page_id: &str, doc: &nv_model::yrs::Doc) {
    if let Some(s) = store {
        let update = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let _ = s.put_page_doc(page_id, &update);
    }
}

/// The core for one server.
#[derive(uniffi::Object)]
pub struct Core {
    pub(crate) api: Arc<nv_api::Client>,
    pub(crate) store: Option<Arc<Store>>,
    /// Reconnect delays of live pages (tests make them short).
    backoff: Mutex<Backoff>,
    /// Task writes: their order, deleted tasks for undo, the last refusal (`tasks.rs`).
    pub(crate) tasks: crate::tasks::TaskState,
    /// This sign-in may have its locked pages unlocked (set by the unlock calls and the status
    /// calls, cleared by locking and sign-out): see `locked.rs`.
    pub(crate) maybe_unlocked: AtomicBool,
}

impl Core {
    /// A core over any transport (tests use a scripted one), with a store at `db_path` (or none).
    /// Not exported over uniffi.
    pub fn with_transport(
        server_url: &str,
        transport: Box<dyn nv_api::Transport>,
        db_path: Option<String>,
    ) -> Arc<Core> {
        Arc::new(Core {
            api: Arc::new(nv_api::Client::with_transport(server_url, transport)),
            store: db_path.and_then(|p| open_store(Path::new(&p))),
            backoff: Mutex::new(Backoff::default()),
            tasks: Default::default(),
            maybe_unlocked: AtomicBool::new(false),
        })
    }

    /// Reconnect delays for live pages opened from now on: `base` doubling to `max`, with
    /// jitter (default 1 s to 30 s). Not exported over uniffi; for tests.
    pub fn set_reconnect_delays(&self, base: Duration, max: Duration) {
        *self.backoff.lock().unwrap() = Backoff {
            base,
            max,
            jitter: true,
        };
    }

    /// What a live page needs: its relay to the app, and how it keeps edits.
    fn live_parts(
        &self,
        page_id: &str,
        sink: Sink,
    ) -> (
        nv_model::yrs::Doc,
        Arc<AtomicBool>,
        Arc<Relay>,
        nv_sync::Options,
    ) {
        let doc = nv_model::new_doc();
        let forbidden = Arc::new(AtomicBool::new(false));
        let relay = Arc::new(Relay {
            page_id: page_id.to_string(),
            doc: doc.clone(),
            store: self.store.clone(),
            forbidden: forbidden.clone(),
            sink,
        });
        let options = nv_sync::Options {
            backoff: self.backoff.lock().unwrap().clone(),
            outbox: self.store.clone().map(|store| {
                Arc::new(StoreOutbox {
                    store,
                    page_id: page_id.to_string(),
                    forbidden: forbidden.clone(),
                }) as Arc<dyn nv_sync::Outbox>
            }),
            restored: self
                .store
                .as_ref()
                .and_then(|s| s.queued_updates(page_id).ok())
                .unwrap_or_default(),
            auth_retries: 3,
        };
        (doc, forbidden, relay, options)
    }

    fn live_page(
        &self,
        page_id: String,
        doc: nv_model::yrs::Doc,
        forbidden: Arc<AtomicBool>,
        live: LiveDoc,
    ) -> Arc<LivePage> {
        Arc::new(LivePage {
            page_id,
            me: self.user(),
            doc,
            store: self.store.clone(),
            forbidden,
            hooks: live.remote_hooks(),
            closed: AtomicBool::new(false),
            live: Mutex::new(Some(live)),
            ink_undo: Mutex::new(None),
            page_undo: Default::default(),
        })
    }

    pub(crate) fn signed_in(&self, s: nv_api::AuthSession) -> SignedIn {
        if let Some(store) = &self.store {
            let _ = store.set_account(&s.user.id);
        }
        SignedIn {
            user: user(s.user),
            refresh_token: s.refresh_token,
        }
    }

    /// A server read, stored when it arrives; the stored copy when the server can't be reached.
    fn fetch<T>(
        &self,
        fetch: impl FnOnce() -> Result<T, ApiError>,
        put: impl FnOnce(&Store, &T),
        cached: impl FnOnce(&Store) -> Option<T>,
    ) -> Result<T, CoreError> {
        match fetch() {
            Ok(v) => {
                if let Some(s) = &self.store {
                    put(s, &v);
                }
                Ok(v)
            }
            Err(e) => {
                let e = CoreError::from(e);
                if matches!(e, CoreError::Network { .. }) {
                    if let Some(v) = self.store.as_deref().and_then(cached) {
                        return Ok(v);
                    }
                }
                Err(e)
            }
        }
    }
}

#[uniffi::export]
impl Core {
    /// A core talking to `server_url`, e.g. `https://app.notiveloapp.com`, with no on-device
    /// store: every read goes to the server and the `cached_*` reads return none.
    #[uniffi::constructor]
    pub fn new(server_url: String) -> Arc<Core> {
        Arc::new(Core {
            api: Arc::new(nv_api::Client::new(&server_url)),
            store: None,
            backoff: Mutex::new(Backoff::default()),
            tasks: Default::default(),
            maybe_unlocked: AtomicBool::new(false),
        })
    }

    /// A core talking to `server_url` that keeps an on-device copy of the account's data in the
    /// SQLite database at `db_path` (created if missing, with its folder; replaced if it can't be
    /// read). Use one file per app install, e.g. in Application Support, excluded from backups.
    #[uniffi::constructor]
    pub fn with_store(server_url: String, db_path: String) -> Arc<Core> {
        Arc::new(Core {
            api: Arc::new(nv_api::Client::new(&server_url)),
            store: open_store(Path::new(&db_path)),
            backoff: Mutex::new(Backoff::default()),
            tasks: Default::default(),
            maybe_unlocked: AtomicBool::new(false),
        })
    }

    /// Whether this core keeps an on-device store.
    pub fn has_store(&self) -> bool {
        self.store.is_some()
    }

    /// The last store write that failed, if any (the store is a cache, so the calls that wrote
    /// carried on), for diagnostics.
    pub fn store_error(&self) -> Option<String> {
        self.store.as_ref()?.last_error()
    }

    /// Pages with local edits the server hasn't confirmed yet (kept in the store; they are sent
    /// the next time the page is open live). Empty without a store.
    pub fn unsent_pages(&self) -> Vec<String> {
        self.store
            .as_ref()
            .and_then(|s| s.queued_pages().ok())
            .unwrap_or_default()
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

    /// Sign out here, revoke the session on the server, and clear the on-device store.
    pub fn sign_out(&self) {
        self.api.logout();
        self.tasks.clear();
        self.set_maybe_unlocked(false);
        if let Some(s) = &self.store {
            let _ = s.clear();
        }
    }

    /// The workspace list as last stored on this device, or none (local, instant).
    pub fn cached_workspaces(&self) -> Option<Vec<Workspace>> {
        let ws = self.store.as_ref()?.workspaces().ok()??;
        Some(ws.into_iter().map(workspace).collect())
    }

    /// The workspace list from the server, stored on this device. Offline (`Network`): the
    /// stored copy when there is one.
    pub fn workspaces(&self) -> Result<Vec<Workspace>, CoreError> {
        let ws = self.fetch(
            || self.api.workspaces(),
            |s, ws| {
                let _ = s.put_workspaces(ws);
            },
            |s| s.workspaces().ok().flatten(),
        )?;
        Ok(ws.into_iter().map(workspace).collect())
    }

    /// A workspace's tree as last stored on this device, or none (local, instant).
    pub fn cached_tree(&self, workspace_id: String) -> Option<Tree> {
        Some(tree(self.store.as_ref()?.tree(&workspace_id).ok()??))
    }

    /// A workspace's tree from the server, stored on this device (dropping the stored documents
    /// of pages that are now locked or gone). Offline (`Network`): the stored copy when there is one.
    pub fn tree(&self, workspace_id: String) -> Result<Tree, CoreError> {
        Ok(tree(self.fetch(
            || self.api.tree(&workspace_id),
            |s, t| {
                let _ = s.put_tree(&workspace_id, t);
            },
            |s| s.tree(&workspace_id).ok().flatten(),
        )?))
    }

    /// A workspace's tasks as last stored on this device, or none (local, instant).
    pub fn cached_tasks(&self, workspace_id: String) -> Option<Vec<Task>> {
        let ts = self.store.as_ref()?.tasks(&workspace_id).ok()??;
        Some(ts.into_iter().map(task).collect())
    }

    /// The workspace's tasks from the server, as the task views list them, stored on this
    /// device. Task changes queued offline are sent first, and those still waiting are laid
    /// over the list. Offline (`Network`): the stored copy when there is one.
    pub fn tasks(&self, workspace_id: String) -> Result<Vec<Task>, CoreError> {
        Ok(self
            .tasks_raw(&workspace_id)?
            .into_iter()
            .map(task)
            .collect())
    }

    /// A new task, standalone or on a page (`page_id`), with an id the core makes. Added to the
    /// stored tasks; offline it is queued (as `create_task_with`).
    pub fn create_task(
        &self,
        workspace_id: String,
        title: String,
        page_id: Option<String>,
    ) -> Result<Task, CoreError> {
        self.create_task_with(
            workspace_id,
            crate::NewTaskInput {
                id: None,
                title,
                page_id,
                parent_id: None,
                done: false,
                ..Default::default()
            },
        )
    }

    /// Tick or untick a task. The stored copy is updated; offline the change is queued when the
    /// store knows the task (sent in order with the other task changes).
    pub fn set_task_done(&self, task_id: String, done: bool) -> Result<Task, CoreError> {
        self.edit_task(
            &task_id,
            json!({ "status": if done { "done" } else { "open" } }),
        )
    }

    /// A page's document as last stored on this device, or none (local, instant). Never one
    /// of a locked page.
    pub fn cached_page_document(&self, page_id: String) -> Option<Vec<u8>> {
        Some(self.store.as_ref()?.page_doc(&page_id).ok()??.doc)
    }

    /// A page's document as the server last saved it (a Yjs update; `read_page` reads it),
    /// stored on this device unless the page is locked. Offline (`Network`): the stored copy
    /// when there is one.
    pub fn page_document(&self, page_id: String) -> Result<Vec<u8>, CoreError> {
        self.refresh_lock_knowledge(self.page_workspace(&page_id));
        self.fetch(
            || self.api.page_doc(&page_id),
            |s, d| {
                let _ = s.put_page_doc(&page_id, d);
            },
            |s| s.page_doc(&page_id).ok().flatten().map(|d| d.doc),
        )
    }

    /// Open a page live and return at once: the page connects on its own thread and stays in
    /// sync until closed, reconnecting by itself. The listener hears every `LiveStatus` and
    /// every change (anyone's). Local edits (`LivePage::apply_update`) are kept until the server
    /// has them: in the store (unless the page is locked or not in a stored tree), so ones made
    /// offline are sent the next time the page opens, even after a restart; opening a page with
    /// such edits applies them to the document first. Close it when the page leaves the screen.
    /// With a store, the document is saved on this device each time it is in sync and when it
    /// closes, unless the page is locked.
    pub fn open_live_page(
        &self,
        page_id: String,
        listener: Arc<dyn LivePageListener>,
    ) -> Result<Arc<LivePage>, CoreError> {
        self.refresh_lock_knowledge(self.page_workspace(&page_id));
        let (doc, forbidden, relay, options) = self.live_parts(&page_id, Sink::Live(listener));
        let live = LiveDoc::start(
            &self.api.collab_url(&page_id),
            doc.clone(),
            Arc::new(CoreSession(self.api.clone())),
            relay,
            options,
        )?;
        Ok(self.live_page(page_id, doc, forbidden, live))
    }

    /// Open a page live, the older way: blocks until the socket is open (errors as before),
    /// then works like `open_live_page` (reconnects by itself, keeps edits), reporting
    /// `SyncStatus`: a drop is `Failed` (or `Closed` with the server's code, e.g. 4401 while it
    /// refreshes the session) and needs no reopening; the end is `Closed` 1000 (closed),
    /// 4403 (no access) or 4401 (signed out).
    pub fn open_page(
        &self,
        page_id: String,
        listener: Arc<dyn PageListener>,
    ) -> Result<Arc<LivePage>, CoreError> {
        self.refresh_lock_knowledge(self.page_workspace(&page_id));
        let token = self.api.access_token()?;
        let url = self.api.collab_url(&page_id);
        let socket = nv_sync::open_socket(&url, &token)?;
        let (doc, forbidden, relay, options) = self.live_parts(&page_id, Sink::Sync(listener));
        let live = LiveDoc::start_connected(
            socket,
            token,
            &url,
            doc.clone(),
            Arc::new(CoreSession(self.api.clone())),
            relay,
            options,
        )?;
        Ok(self.live_page(page_id, doc, forbidden, live))
    }
}

/// A live page's connection, as `open_live_page` reports it.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum LiveStatus {
    /// Opening the connection: `attempt` 0 the first time, else how many tries in a row failed.
    Connecting { attempt: u32 },
    /// Connected, waiting for the server's copy.
    Connected,
    /// Up to date with the server; edits flow both ways (and queued ones have been sent).
    Synced,
    /// Not connected; the core tries again in `in_ms` milliseconds (0: at once, after
    /// refreshing the session). `attempt` counts from 1 and starts again after a sync. `code`
    /// is the server's close code when it closed the connection (none: network). Local edits
    /// are kept meanwhile. Nothing to do: show "offline" or "reconnecting".
    Reconnecting {
        attempt: u32,
        in_ms: u64,
        code: Option<u16>,
        reason: String,
    },
    /// Stopped for good: the last status. No more reconnecting.
    Ended { reason: LiveEnd, message: String },
}

/// Why a live page stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LiveEnd {
    /// `close()` was called.
    Closed,
    /// The server says this user can't open the page (any more): it was locked, deleted, or
    /// shared away (close code 4403). Its stored copy and queued edits are deleted.
    NoAccess,
    /// The session couldn't be refreshed (the refresh token was rejected): sign in again.
    SignedOut,
}

/// Told about a page opened with `open_live_page`. Called on the page's own thread: hop to the
/// main thread to update UI.
#[uniffi::export(with_foreign)]
pub trait LivePageListener: Send + Sync {
    fn on_status(&self, status: LiveStatus);
    /// The page changed (the initial sync, or someone's edit): its new state.
    fn on_change(&self, page: PageInfo);
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

/// Told about a page opened with `open_page`. Called on the core's sync thread: hop to the main thread to update UI.
#[uniffi::export(with_foreign)]
pub trait PageListener: Send + Sync {
    fn on_status(&self, status: SyncStatus);
    /// The page changed (the initial sync, or someone's edit): its new state.
    fn on_change(&self, page: PageInfo);
}

/// Who hears a live page.
enum Sink {
    Live(Arc<dyn LivePageListener>),
    Sync(Arc<dyn PageListener>),
}

struct Relay {
    page_id: String,
    doc: nv_model::yrs::Doc,
    store: Option<Arc<Store>>,
    forbidden: Arc<AtomicBool>,
    sink: Sink,
}

fn live_status(s: Status) -> LiveStatus {
    match s {
        Status::Connecting { attempt } => LiveStatus::Connecting { attempt },
        Status::Connected => LiveStatus::Connected,
        Status::Synced => LiveStatus::Synced,
        Status::Reconnecting {
            attempt,
            in_ms,
            code,
            reason,
        } => LiveStatus::Reconnecting {
            attempt,
            in_ms,
            code,
            reason,
        },
        Status::Closed { code, reason } => LiveStatus::Ended {
            reason: match code {
                4403 => LiveEnd::NoAccess,
                4401 => LiveEnd::SignedOut,
                _ => LiveEnd::Closed,
            },
            message: reason,
        },
    }
}

/// The older statuses: a drop as `Failed` (or `Closed` with the server's code), as before.
fn sync_status(s: Status) -> Option<SyncStatus> {
    Some(match s {
        Status::Connecting { .. } => return None,
        Status::Connected => SyncStatus::Connected,
        Status::Synced => SyncStatus::Synced,
        Status::Reconnecting {
            code: Some(code),
            reason,
            ..
        } => SyncStatus::Closed { code, reason },
        Status::Reconnecting { reason, .. } => SyncStatus::Failed { message: reason },
        Status::Closed { code, reason } => SyncStatus::Closed { code, reason },
    })
}

impl nv_sync::Listener for Relay {
    fn on_status(&self, s: Status) {
        match &s {
            // In sync with the server: keep this copy (the store refuses a locked page).
            Status::Synced if !self.forbidden.load(Ordering::SeqCst) => {
                save_page(&self.store, &self.page_id, &self.doc)
            }
            // Access is gone (the page was locked, or moved out of reach): drop any copy.
            Status::Closed { code: 4403, .. } => {
                self.forbidden.store(true, Ordering::SeqCst);
                if let Some(store) = &self.store {
                    let _ = store.forget_page(&self.page_id);
                }
            }
            _ => {}
        }
        match &self.sink {
            Sink::Live(l) => l.on_status(live_status(s)),
            Sink::Sync(l) => {
                if let Some(s) = sync_status(s) {
                    l.on_status(s)
                }
            }
        }
    }
    fn on_doc_changed(&self) {
        let page = page_info(&Page::read(&self.doc));
        match &self.sink {
            Sink::Live(l) => l.on_change(page),
            Sink::Sync(l) => l.on_change(page),
        }
    }
}

/// A page open live.
#[derive(uniffi::Object)]
pub struct LivePage {
    page_id: String,
    me: Option<User>,
    doc: nv_model::yrs::Doc,
    store: Option<Arc<Store>>,
    /// Set when the server closed with 4403: nothing is saved after that.
    forbidden: Arc<AtomicBool>,
    /// Run around every remote update of `doc`, on the connection's thread.
    hooks: nv_sync::RemoteHooks,
    /// `close()` was called: edits made on `doc` from now on aren't sent.
    closed: AtomicBool,
    live: Mutex<Option<LiveDoc>>,
    /// Ink undo (see `ink.rs`), made at the first ink edit.
    pub(crate) ink_undo: Mutex<Option<nv_model::yrs::undo::UndoManager<u64>>>,
    /// Page-level undo: the shared stamp counter and the live text sessions (`page_undo.rs`).
    pub(crate) page_undo: crate::page_undo::PageUndo,
}

// Used by the editor stream's `EditorSession::open_live` (not written yet) and the tests.
#[cfg_attr(not(test), allow(dead_code))]
/// For code in this crate that binds to the live document itself (the editor session's
/// `open_live`). See docs/rewrite/status/core.md, "For editor: the live doc".
///
/// - **Local edits.** Any transaction on `doc()` whose origin isn't `nv_sync::REMOTE_ORIGIN`
///   is a local edit: LiveDoc's update observer takes it (on the editing thread, when the
///   transaction commits), keeps it in the outbox (the store) and sends it, exactly like
///   `apply_update`. It isn't reported back as a remote change (`on_change` and the remote hooks
///   fire only for updates that arrive from the server; the server's echo of it changes nothing,
///   so hooks are told `false`).
/// - **Remote edits.** Each update from the server is applied on the page's connection thread
///   inside every hook added with `add_remote_hook` (first added outermost). That thread holds
///   no lock of the core's or nv-sync's while it calls a hook, and no yrs transaction; `apply()`
///   opens a write transaction on `doc()` and commits it before it returns. So a hook may take
///   its own mutex, then call `apply()`; it must hold no yrs transaction on `doc()` while it does,
///   and must not wait for the connection's thread (`close()`).
/// - Edits queued while offline (from the store) are in `doc()` before `open_live_page`
///   returns; nothing is applied through the hooks for them.
impl LivePage {
    /// The page's live document (shared, not a copy: `Doc` is a handle).
    pub(crate) fn doc(&self) -> &nv_model::yrs::Doc {
        &self.doc
    }

    /// Run `hook` around every remote update from now on. Returns its id for
    /// `remove_remote_hook`. Hold the hooked state through a `Weak` if it holds this page.
    pub(crate) fn add_remote_hook(&self, hook: Arc<dyn nv_sync::RemoteHook>) -> u64 {
        self.hooks.add(hook)
    }

    pub(crate) fn remove_remote_hook(&self, id: u64) {
        self.hooks.remove(id);
    }

    /// `close()` was called (or the page was never connected): edits on `doc()` aren't sent.
    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
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

    /// Local edits the server hasn't confirmed yet (0 when everything is on the server).
    pub fn unsent_updates(&self) -> u32 {
        self.live
            .lock()
            .unwrap()
            .as_ref()
            .map_or(0, |l| l.unconfirmed() as u32)
    }

    /// Close the connection, promptly (also while it waits to reconnect): the listener hears
    /// `Ended { Closed }` (`Closed { code: 1000 }` for `open_page`) last. Edits not yet
    /// confirmed stay in the store for next time. With a store, the document is saved on this
    /// device, unless the page is locked or access ended.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(mut l) = self.live.lock().unwrap().take() {
            l.close();
            if !self.forbidden.load(Ordering::SeqCst) {
                save_page(&self.store, &self.page_id, &self.doc);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nv_model::yrs::{Text, WriteTxn};
    use nv_sync::Listener;

    struct Quiet;
    impl PageListener for Quiet {
        fn on_status(&self, _: SyncStatus) {}
        fn on_change(&self, _: PageInfo) {}
    }

    /// A live page and its relay with no connection, sharing one store.
    fn page(store: &Arc<Store>, page_id: &str) -> (Relay, LivePage) {
        let doc = nv_model::new_doc();
        {
            let mut txn = doc.transact_mut();
            let text = txn.get_or_insert_text("t");
            text.push(&mut txn, "hello");
        }
        let forbidden = Arc::new(AtomicBool::new(false));
        let relay = Relay {
            page_id: page_id.into(),
            doc: doc.clone(),
            store: Some(store.clone()),
            forbidden: forbidden.clone(),
            sink: Sink::Sync(Arc::new(Quiet)),
        };
        let live = LivePage {
            page_id: page_id.into(),
            me: None,
            doc,
            store: Some(store.clone()),
            forbidden,
            hooks: Default::default(),
            closed: AtomicBool::new(true),
            live: Mutex::new(None),
            ink_undo: Mutex::new(None),
            page_undo: Default::default(),
        };
        (relay, live)
    }

    fn tree_with(pages: &[(&str, bool)]) -> nv_api::Tree {
        nv_api::Tree {
            trashed_pages: vec![],
            notebooks: vec![],
            sections: vec![],
            pages: pages
                .iter()
                .map(|(id, locked)| nv_api::PageMeta {
                    id: (*id).into(),
                    section_id: "s1".into(),
                    title: String::new(),
                    icon: None,
                    kind: "canvas".into(),
                    position: 0.0,
                    updated_at: String::new(),
                    updated_by: None,
                    locked: *locked,
                })
                .collect(),
        }
    }

    #[test]
    fn a_live_page_is_saved_on_sync_unless_locked() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store
            .put_tree("w1", &tree_with(&[("open", false), ("locked", true)]))
            .unwrap();
        let (relay, live) = page(&store, "open");
        relay.on_status(Status::Synced);
        assert_eq!(
            store.page_doc("open").unwrap().unwrap().doc,
            live.document()
        );

        let (relay, _) = page(&store, "locked");
        relay.on_status(Status::Synced);
        assert_eq!(store.page_doc("locked").unwrap(), None);
    }

    #[test]
    fn a_page_whose_access_ended_is_forgotten_and_not_saved_again() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.put_tree("w1", &tree_with(&[("p1", false)])).unwrap();
        let (relay, live) = page(&store, "p1");
        relay.on_status(Status::Synced);
        assert!(store.page_doc("p1").unwrap().is_some());
        relay.on_status(Status::Closed {
            code: 4403,
            reason: "no access".into(),
        });
        assert_eq!(store.page_doc("p1").unwrap(), None);
        live.close();
        relay.on_status(Status::Synced);
        assert_eq!(store.page_doc("p1").unwrap(), None);
    }
}

#[cfg(test)]
#[path = "live_doc_tests.rs"]
mod live_doc_tests;
