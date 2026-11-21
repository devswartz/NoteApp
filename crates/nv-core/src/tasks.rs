//! Task writes for the editor (docs/rewrite/status/core.md, "For apple: task calls"): tasks
//! created with the client's id (the engine makes ids: `/task`, Mod+Enter), renamed and deleted,
//! as the web app's `src/store/tasks.ts` does, plus `PageTasks`, a ready-made `TaskCallbacks`
//! over them for `EditorSession`.
//!
//! **Order.** Task writes go to the server one at a time, in the order they were made (the
//! Core holds one lock across them), so a rename never reaches the server before its create
//! (as `src/store/taskWrites.ts` orders them).
//!
//! **Offline.** With a store, a write the server can't be reached for (`CoreError::Network`) is
//! kept in the store's queue (`nv_store::TaskOp`), applied to the stored tasks at once, and
//! the call returns as if it had worked (with the task as it will be). Queued writes are sent,
//! in order, by `send_task_changes()`, which `tasks()` and every task write call first. A queued
//! write the server then refuses (4xx) is dropped and its message kept in `task_error()`; the
//! next `tasks()` puts the stored list right. A write isn't queued (the call throws `Network`
//! as before) without a store, for a task on a page the stored tree doesn't show unlocked, or
//! for an edit of a task the store doesn't know.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use nv_api::ApiError;
use nv_store::{Store, TaskOp};
use serde_json::{json, Value};

use crate::client::task;
use crate::{Core, CoreError, Task, TaskCallbacks};

/// A new task for `Core::create_task_with`.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct NewTaskInput {
    /// The task's id, a UUID (`new_task_id()`, or the editor's `TaskCallbacks::new_id`); none:
    /// the core makes one. Creating again with the same id returns the task already made.
    #[uniffi(default = None)]
    pub id: Option<String>,
    /// May be empty: a task line gets its title after it is created.
    pub title: String,
    /// The page the task is written on.
    #[uniffi(default = None)]
    pub page_id: Option<String>,
    /// The task this is a subtask of (it then lives on the parent's page).
    #[uniffi(default = None)]
    pub parent_id: Option<String>,
    /// Create it ticked (an undo bringing back a done task): a second write, after the create.
    #[uniffi(default = false)]
    pub done: bool,
}

/// A new task id: a random UUID (version 4), lower case, as `crypto.randomUUID()` makes them.
#[uniffi::export]
pub fn new_task_id() -> String {
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        // No system randomness (never seen): the standard library's randomly keyed hasher.
        use std::hash::BuildHasher;
        for (i, chunk) in b.chunks_mut(8).enumerate() {
            let h = std::collections::hash_map::RandomState::new().hash_one((
                i,
                SystemTime::now(),
                std::thread::current().id(),
            ));
            chunk.copy_from_slice(&h.to_le_bytes());
        }
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The Core's task-write state.
#[derive(Default)]
pub(crate) struct TaskState {
    /// Held across each write and across sending the queue: one at a time, in order.
    order: Mutex<()>,
    /// Tasks deleted through this Core, with their subtasks (task first), for `restore_task`.
    deleted: Mutex<HashMap<String, Vec<nv_api::Task>>>,
    /// The last task write the server refused.
    error: Mutex<Option<String>>,
}

impl TaskState {
    pub(crate) fn clear(&self) {
        self.deleted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        *self.error.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// What a write did.
enum Wrote {
    /// The server has it (and answered with this task, for a create or an edit).
    Sent(Option<Box<nv_api::Task>>),
    /// Kept in the store's queue, applied to the stored tasks.
    Queued,
}

/// Now as the server writes times (`new Date().toISOString()`).
fn now_iso() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

/// The task as it will be once the server has the create (`updatedAt` empty, as the web app's
/// optimistic copy: the server's always wins).
fn optimistic(workspace_id: &str, new: &nv_api::NewTask, user_id: &str) -> Option<nv_api::Task> {
    serde_json::from_value(json!({
        "id": new.id, "workspaceId": workspace_id, "title": new.title.trim(),
        "description": new.description.clone().unwrap_or_default(), "status": "open",
        "priority": new.priority.unwrap_or(4), "dueDate": new.due_date, "dueTime": new.due_time,
        "recurrence": new.recurrence, "reminderAt": new.reminder_at, "assigneeId": new.assignee_id,
        "createdBy": user_id, "pageId": new.page_id, "parentId": new.parent_id, "teamId": new.team_id,
        "tagIds": new.tag_ids.clone().unwrap_or_default(), "completedAt": null,
        "createdAt": now_iso(), "updatedAt": "",
    }))
    .ok()
}

/// `patch` (TaskPatch fields) laid over a task.
fn patched(t: &nv_api::Task, patch: &Value) -> Option<nv_api::Task> {
    let mut v = serde_json::to_value(t).ok()?;
    if let (Some(obj), Some(p)) = (v.as_object_mut(), patch.as_object()) {
        for (k, x) in p {
            let x = match (k.as_str(), x) {
                ("title", Value::String(s)) => Value::String(s.trim().to_string()),
                _ => x.clone(),
            };
            obj.insert(k.clone(), x);
        }
        match patch.get("status").and_then(Value::as_str) {
            Some("done") if t.status != "done" => {
                obj.insert("completedAt".into(), Value::String(now_iso()));
            }
            Some("open") => {
                obj.insert("completedAt".into(), Value::Null);
            }
            _ => {}
        }
    }
    serde_json::from_value(v).ok()
}

/// A queued write's effect on the stored tasks.
fn apply_locally(store: &Store, workspace_id: &str, task_id: &str, op: &TaskOp, user_id: &str) {
    match op {
        TaskOp::Create { task } => {
            if store.task(task_id).ok().flatten().is_none() {
                if let Some(t) = optimistic(workspace_id, task, user_id) {
                    let _ = store.put_task(&t);
                }
            }
        }
        TaskOp::Update { patch } => {
            if let Some(t) = store.task(task_id).ok().flatten() {
                if let Some(t) = patched(&t, patch) {
                    let _ = store.put_task(&t);
                }
            }
        }
        TaskOp::Delete => {
            let _ = store.remove_task(task_id);
        }
    }
}

/// Whether the server's answer means the write can never succeed (drop it from the queue).
fn refused(e: &ApiError) -> bool {
    match e {
        ApiError::Http { status, .. } => *status < 500,
        ApiError::Decode(_) => true,
        ApiError::Network(_) | ApiError::SignedOut => false,
    }
}

impl Core {
    fn user_id(&self) -> String {
        self.api.user().map(|u| u.id).unwrap_or_default()
    }

    fn task_failed(&self, what: &str, e: &ApiError) {
        let msg = format!("{what}: {e}");
        eprintln!("[nv-core] task write refused: {msg}");
        *self.tasks.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg);
    }

    /// Send one write to the server.
    fn send_op(
        &self,
        workspace_id: &str,
        task_id: &str,
        op: &TaskOp,
    ) -> Result<Option<nv_api::Task>, ApiError> {
        match op {
            TaskOp::Create { task } => self.api.create_task(workspace_id, task).map(Some),
            TaskOp::Update { patch } => self.api.update_task(task_id, patch).map(Some),
            TaskOp::Delete => match self.api.delete_task(task_id) {
                // Gone already (deleted elsewhere, or a retry after the first one arrived).
                Err(ApiError::Http { status: 404, .. }) | Ok(()) => Ok(None),
                Err(e) => Err(e),
            },
        }
    }

    /// Send queued writes in order, with `order` held. Stops at the first one the server can't
    /// be reached for; drops ones it refuses. Returns how many still wait.
    fn send_queued(&self) -> Result<u32, CoreError> {
        let Some(store) = &self.store else {
            return Ok(0);
        };
        let ops = store.task_ops().unwrap_or_default();
        let mut left = ops.len() as u32;
        for q in ops {
            match self.send_op(&q.workspace_id, &q.task_id, &q.op) {
                Ok(Some(t)) => {
                    let _ = store.put_task(&t);
                }
                Ok(None) => {
                    let _ = store.remove_task(&q.task_id);
                }
                Err(e) if refused(&e) => {
                    self.task_failed(&format!("queued change to task {}", q.task_id), &e);
                    if matches!(q.op, TaskOp::Create { .. }) {
                        let _ = store.remove_task(&q.task_id);
                    }
                }
                Err(e) => {
                    return match CoreError::from(e) {
                        CoreError::Network { .. } | CoreError::Server { .. } => Ok(left),
                        e => Err(e),
                    };
                }
            }
            let _ = store.unqueue_task_op(q.seq);
            left -= 1;
        }
        Ok(left)
    }

    /// One write: after the queue, straight to the server, or into the queue when the server
    /// can't be reached (or earlier writes still wait). `page_id` is the task's page, for the
    /// store's locked-page rule.
    fn task_write(
        &self,
        workspace_id: &str,
        task_id: &str,
        page_id: Option<&str>,
        op: TaskOp,
    ) -> Result<Wrote, CoreError> {
        let _one = self.tasks.order.lock().unwrap_or_else(|e| e.into_inner());
        let waiting = self.send_queued()? > 0;
        let err = if waiting {
            CoreError::Network {
                message: "earlier task changes are still waiting".into(),
            }
        } else {
            match self.send_op(workspace_id, task_id, &op) {
                Ok(t) => return Ok(Wrote::Sent(t.map(Box::new))),
                Err(e) => CoreError::from(e),
            }
        };
        let (CoreError::Network { .. }, Some(store)) = (&err, &self.store) else {
            return Err(err);
        };
        match store.queue_task_op(workspace_id, task_id, page_id, &op) {
            Ok(Some(_)) => {
                apply_locally(store, workspace_id, task_id, &op, &self.user_id());
                Ok(Wrote::Queued)
            }
            _ => Err(err),
        }
    }

    /// The stored tasks with the queued writes laid over them again (after `put_tasks` stored
    /// the server's list, which doesn't have them yet).
    /// Returns whether there were any.
    pub(crate) fn overlay_queued(&self, workspace_id: &str) -> bool {
        let Some(store) = &self.store else {
            return false;
        };
        let user = self.user_id();
        let mut any = false;
        for q in store.task_ops().unwrap_or_default() {
            if q.workspace_id == workspace_id {
                apply_locally(store, workspace_id, &q.task_id, &q.op, &user);
                any = true;
            }
        }
        any
    }

    /// Send queued task writes before a read of the task list (errors are left for the read).
    pub(crate) fn send_queued_quietly(&self) {
        if self.store.is_some() {
            let _one = self.tasks.order.lock().unwrap_or_else(|e| e.into_inner());
            let _ = self.send_queued();
        }
    }

    /// The stored task, or what the server sent for it.
    fn stored_or(&self, task_id: &str, sent: Option<nv_api::Task>) -> Result<Task, CoreError> {
        sent.or_else(|| self.store.as_ref()?.task(task_id).ok().flatten())
            .map(task)
            .ok_or_else(|| CoreError::Network {
                message: "the task isn't stored".into(),
            })
    }

    /// An edit of an existing task (PATCH).
    pub(crate) fn edit_task(&self, task_id: &str, patch: Value) -> Result<Task, CoreError> {
        let known = self
            .store
            .as_ref()
            .and_then(|s| s.task(task_id).ok().flatten());
        let (ws, page) = known
            .as_ref()
            .map(|t| (t.workspace_id.clone(), t.page_id.clone()))
            .unwrap_or_default();
        let op = TaskOp::Update { patch };
        // A task the store doesn't know can't be queued: send it, or fail.
        if known.is_none() {
            let _one = self.tasks.order.lock().unwrap_or_else(|e| e.into_inner());
            let t = self.send_op("", task_id, &op)?;
            if let (Some(s), Some(t)) = (&self.store, &t) {
                let _ = s.put_task(t);
            }
            return self.stored_or(task_id, t);
        }
        match self.task_write(&ws, task_id, page.as_deref(), op)? {
            Wrote::Sent(t) => {
                let t = t.map(|t| *t);
                if let (Some(s), Some(t)) = (&self.store, &t) {
                    let _ = s.put_task(t);
                }
                self.stored_or(task_id, t)
            }
            Wrote::Queued => self.stored_or(task_id, None),
        }
    }

    fn create(
        &self,
        workspace_id: &str,
        new: nv_api::NewTask,
        done: bool,
    ) -> Result<Task, CoreError> {
        let id = new.id.clone().unwrap_or_default();
        // A subtask lives on its parent's page.
        let page = new.page_id.clone().or_else(|| {
            let parent = new.parent_id.as_ref()?;
            self.store.as_ref()?.task(parent).ok().flatten()?.page_id
        });
        let t = match self.task_write(
            workspace_id,
            &id,
            page.as_deref(),
            TaskOp::Create {
                task: Box::new(new),
            },
        )? {
            Wrote::Sent(t) => {
                let t = t.map(|t| *t);
                if let (Some(s), Some(t)) = (&self.store, &t) {
                    let _ = s.put_task(t);
                }
                self.stored_or(&id, t)?
            }
            Wrote::Queued => self.stored_or(&id, None)?,
        };
        if done && !t.done {
            return self.edit_task(&id, json!({ "status": "done" }));
        }
        Ok(t)
    }
}

#[uniffi::export]
impl Core {
    /// A new task with the fields given; `task.id` is the client's (one is made when none). With
    /// a store it is added to the stored tasks; offline it is queued (see `send_task_changes`)
    /// and returned as it will be.
    pub fn create_task_with(
        &self,
        workspace_id: String,
        task: NewTaskInput,
    ) -> Result<Task, CoreError> {
        let new = nv_api::NewTask {
            id: Some(task.id.unwrap_or_else(new_task_id)),
            title: task.title,
            page_id: task.page_id,
            parent_id: task.parent_id,
            ..Default::default()
        };
        self.create(&workspace_id, new, task.done)
    }

    /// Set a task's title (the server trims it). The stored copy is updated; offline the change
    /// is queued when the store knows the task.
    pub fn set_task_title(&self, task_id: String, title: String) -> Result<Task, CoreError> {
        self.edit_task(&task_id, json!({ "title": title }))
    }

    /// Delete a task; its subtasks go with it (on the server and in the store). A task that is
    /// already gone counts as deleted. `restore_task` can bring it back (with a store, which
    /// knows its fields). Offline it is queued.
    pub fn delete_task(&self, task_id: String) -> Result<(), CoreError> {
        let removed = match &self.store {
            Some(s) => s.remove_task(&task_id).unwrap_or_default(),
            None => Vec::new(),
        };
        let (ws, page) = removed
            .first()
            .map(|t| (t.workspace_id.clone(), t.page_id.clone()))
            .unwrap_or_default();
        let put_back = |store: &Option<Arc<Store>>| {
            if let Some(s) = store {
                for t in &removed {
                    let _ = s.put_task(t);
                }
            }
        };
        let result = if removed.is_empty() {
            // Not stored (no store, or a task this device hasn't listed): send it, or fail.
            let _one = self.tasks.order.lock().unwrap_or_else(|e| e.into_inner());
            self.send_op("", &task_id, &TaskOp::Delete)
                .map(|_| ())
                .map_err(CoreError::from)
        } else {
            self.task_write(&ws, &task_id, page.as_deref(), TaskOp::Delete)
                .map(|_| ())
        };
        match result {
            Ok(()) => {
                if !removed.is_empty() {
                    self.tasks
                        .deleted
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(task_id, removed);
                }
                Ok(())
            }
            Err(e) => {
                put_back(&self.store);
                Err(e)
            }
        }
    }

    /// Whether `restore_task` can bring this task back (this Core deleted it, knowing its fields).
    pub fn can_restore_task(&self, task_id: String) -> bool {
        self.tasks
            .deleted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&task_id)
    }

    /// Bring back a task this Core deleted, with its subtasks, the same ids and fields (done
    /// ones done again), as the web app's undo does. False when it can't (`can_restore_task`).
    pub fn restore_task(&self, task_id: String) -> Result<bool, CoreError> {
        let Some(group) = self
            .tasks
            .deleted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&task_id)
        else {
            return Ok(false);
        };
        // Parents come before their subtasks in the group.
        for t in group {
            let new = nv_api::NewTask {
                id: Some(t.id.clone()),
                title: t.title.clone(),
                description: Some(t.description.clone()),
                due_date: t.due_date.clone(),
                priority: Some(t.priority),
                page_id: t.page_id.clone(),
                parent_id: t.parent_id.clone(),
                due_time: t.due_time.clone(),
                recurrence: t.recurrence.clone(),
                reminder_at: t.reminder_at.clone(),
                assignee_id: t.assignee_id.clone(),
                team_id: t.team_id.clone(),
                tag_ids: Some(t.tag_ids.clone()),
            };
            self.create(&t.workspace_id, new, t.status == "done")?;
        }
        Ok(true)
    }

    /// One task as stored on this device (local, instant), with queued changes applied. None
    /// without a store or for a task not stored.
    pub fn cached_task(&self, task_id: String) -> Option<Task> {
        self.store.as_ref()?.task(&task_id).ok()?.map(task)
    }

    /// Send the task changes queued while offline, in order. Returns how many still wait (0:
    /// all sent); stops at the first one the server can't be reached for. Changes the server
    /// refuses are dropped (`task_error`). `tasks()` and every task write call this first.
    pub fn send_task_changes(&self) -> Result<u32, CoreError> {
        let _one = self.tasks.order.lock().unwrap_or_else(|e| e.into_inner());
        self.send_queued()
    }

    /// Task changes queued while offline, not yet sent (0 without a store).
    pub fn unsent_task_changes(&self) -> u32 {
        self.store
            .as_ref()
            .and_then(|s| s.task_ops().ok())
            .map_or(0, |ops| ops.len() as u32)
    }

    /// The last task change the server refused (a queued one, or one `PageTasks` sent), for
    /// diagnostics or a notice. None when none was.
    pub fn task_error(&self) -> Option<String> {
        self.tasks
            .error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The editor's task store for a page, over this Core: pass it as `tasks` to
    /// `EditorSession::open` (or `open_live`). Its calls return at once (the session calls
    /// them with its lock held, on the caller's thread): titles come from the stored tasks and
    /// this page's own changes, and creates, renames, deletes and restores go to the server on
    /// its own thread, in order (queued offline as above). Tasks are made in `workspace_id`,
    /// on `page_id`. Refused writes show in `task_error()`.
    pub fn page_tasks(
        self: Arc<Self>,
        workspace_id: String,
        page_id: Option<String>,
    ) -> Arc<dyn TaskCallbacks> {
        PageTasks::start(self, workspace_id, page_id)
    }
}

enum Job {
    Create {
        id: String,
        title: String,
        done: bool,
    },
    Title {
        id: String,
        title: String,
    },
    Delete {
        id: String,
    },
    Restore {
        id: String,
        title: String,
    },
}

type Local = Arc<Mutex<HashMap<String, Option<String>>>>;

/// The job is done: the store has its result (or it failed and the store was put back), so
/// titles come from the store again, unless a newer change of the same task waits.
fn settled(core: &Core, local: &Local, id: &str, value: &Option<String>) {
    if core.has_store() {
        let mut l = local.lock().unwrap_or_else(|e| e.into_inner());
        if l.get(id) == Some(value) {
            l.remove(id);
        }
    }
}

/// `Core::page_tasks`: the editor's `TaskCallbacks` over the Core.
struct PageTasks {
    core: Arc<Core>,
    jobs: Mutex<Sender<Job>>,
    /// This page's changes not yet in the store (kept for good without a store): a title, or
    /// None for a task deleted here.
    local: Local,
    /// Tasks deleted here, with their titles, for `restore`.
    deleted: Mutex<HashMap<String, String>>,
}

impl PageTasks {
    fn start(core: Arc<Core>, workspace_id: String, page_id: Option<String>) -> Arc<PageTasks> {
        let (tx, rx) = channel::<Job>();
        let worker = core.clone();
        let local: Local = Arc::default();
        let mine = local.clone();
        let fail = |core: &Core, what: String, r: Result<(), CoreError>| {
            if let Err(e) = r {
                if !matches!(e, CoreError::Network { .. }) {
                    eprintln!("[nv-core] {what}: {e}");
                }
                *core.tasks.error.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(format!("{what}: {e}"));
            }
        };
        let spawned = std::thread::Builder::new()
            .name("nv-core-tasks".into())
            .spawn(move || {
                let core = worker;
                let create = |id: String, title: String, done: bool| {
                    core.create_task_with(
                        workspace_id.clone(),
                        NewTaskInput {
                            id: Some(id),
                            title,
                            page_id: page_id.clone(),
                            parent_id: None,
                            done,
                        },
                    )
                    .map(|_| ())
                };
                // Ends when the PageTasks is dropped (the sender goes).
                for job in rx {
                    let (id, value, what, r) = match job {
                        Job::Create { id, title, done } => {
                            let r = create(id.clone(), title.clone(), done);
                            (id, Some(title), "create", r)
                        }
                        Job::Title { id, title } => {
                            let r = core.set_task_title(id.clone(), title.clone()).map(|_| ());
                            (id, Some(title), "rename", r)
                        }
                        Job::Delete { id } => {
                            let r = core.delete_task(id.clone());
                            (id, None, "delete", r)
                        }
                        Job::Restore { id, title } => {
                            let r = match core.restore_task(id.clone()) {
                                Ok(true) => Ok(()),
                                // Not known to the Core (no store): make it again by its title.
                                Ok(false) => create(id.clone(), title.clone(), false),
                                Err(e) => Err(e),
                            };
                            (id, Some(title), "restore", r)
                        }
                    };
                    fail(&core, format!("{what} task {id}"), r);
                    settled(&core, &mine, &id, &value);
                }
            });
        if let Err(e) = spawned {
            eprintln!("[nv-core] no task thread: {e}");
        }
        Arc::new(PageTasks {
            core,
            jobs: Mutex::new(tx),
            local,
            deleted: Mutex::default(),
        })
    }

    fn send(&self, job: Job) {
        let _ = self
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send(job);
    }

    fn set_local(&self, id: &str, title: Option<String>) {
        self.local
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), title);
    }
}

impl TaskCallbacks for PageTasks {
    fn new_id(&self) -> String {
        new_task_id()
    }

    fn create(&self, id: String, title: String, done: bool) {
        self.set_local(&id, Some(title.clone()));
        self.send(Job::Create { id, title, done });
    }

    fn delete(&self, id: String) {
        let title = self.title(id.clone()).unwrap_or_default();
        self.deleted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), title);
        self.set_local(&id, None);
        self.send(Job::Delete { id });
    }

    fn restore(&self, id: String) -> bool {
        let Some(title) = self
            .deleted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
        else {
            return false;
        };
        self.set_local(&id, Some(title.clone()));
        self.send(Job::Restore { id, title });
        true
    }

    fn title(&self, id: String) -> Option<String> {
        if let Some(local) = self
            .local
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
        {
            return local.clone();
        }
        self.core.cached_task(id).map(|t| t.title)
    }

    fn set_title(&self, id: String, title: String) {
        self.set_local(&id, Some(title.clone()));
        self.send(Job::Title { id, title });
    }
}
