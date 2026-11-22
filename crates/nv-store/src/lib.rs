//! The on-device store for one signed-in account (docs/ARCHITECTURE.md 3.3): the last copy of the
//! workspace list, each workspace's tree and tasks, and page documents (Yjs updates), in SQLite.
//!
//! It is a cache of what the server sent, as the web app's `src/lib/offlineCache.ts` and
//! `src/lib/pageCache.ts` are today, and follows their rules:
//!
//! - **Locked pages are never stored.** `put_tree` deletes the stored document (and queued edits)
//!   of every page the tree marks locked (in any workspace), and the document of every page stored
//!   for that workspace that the tree no longer shows. `put_page_doc` and `queue_updates` store
//!   only pages a stored tree shows unlocked: a page no tree has shown yet might be locked, so it
//!   is refused too (the apps always load the tree before opening a page). **Pages in the Trash**
//!   (the tree's `trashed_pages`) keep their stored documents, since the page may be restored; a
//!   page gone from both lists (deleted for good, or access ended) loses its document.
//! - **The outbox** (`queue_updates`, `queued_updates`, `unqueue`) keeps a live page's local edits
//!   (Yjs updates) until the server is known to have them, so edits made offline survive an app
//!   restart. `nv-sync` decides when they are confirmed.
//! - **Task changes waiting for the server** (`queue_task_op`, `task_ops`, `unqueue_task_op`):
//!   creates, edits and deletes made while the server couldn't be reached, in order, replayed by
//!   the Core. A change to a task on a page is kept only when a stored tree shows the page
//!   unlocked (its title is the user's text); `put_tree` drops those of pages now locked.
//! - Tasks are stored as the server sent them, except **tasks on a page a stored tree shows
//!   locked**: those are redacted before they are written (`redact_locked_task`: title "Locked
//!   task", no text, no tags, `locked: true`, as the server's `redactTask` does). The server
//!   sends such tasks in full while the sign-in has the locked pages unlocked, so this rule is
//!   what keeps a locked page's task titles off the disk. `put_tree` and `mark_page_locked`
//!   redact the already stored tasks of a page that has become locked.
//! - `clear()` on sign-out drops everything; `set_account` clears too when another user signs in.
//!
//! Records are JSON columns (the `nv-api` types) keyed by id and workspace. The schema has a
//! version (`SCHEMA_VERSION`) and explicit upgrade steps (`UPGRADES`): a database from an older
//! app is upgraded in place on open; one from a newer app is refused (`StoreError::TooNew`), and
//! since the store is only a cache the caller can delete the file and start again.
//!
//! Every write is one transaction. Deleted rows are overwritten on disk (`secure_delete`). The
//! last write that failed is kept (`last_error`) and printed to stderr, for diagnostics: callers
//! treat the store as a cache and carry on.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use nv_api::{NewTask, Notebook, PageMeta, Section, Task, TrashedPage, Tree, Workspace};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// The schema version this build writes. Add an upgrade step to `UPGRADES` with every bump.
pub const SCHEMA_VERSION: u32 = 3;

/// One step per version: `UPGRADES[n]` takes a database from version `n` to `n + 1`.
const UPGRADES: &[fn(&Transaction) -> rusqlite::Result<()>] =
    &[upgrade_to_1, upgrade_to_2, upgrade_to_3];

/// Version 1: workspaces, tree nodes, tasks, page documents, and when each list was stored.
fn upgrade_to_1(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE workspaces (
             id TEXT PRIMARY KEY,
             ord INTEGER NOT NULL,
             json TEXT NOT NULL
         );
         -- Notebooks, sections and pages; `locked` is only ever 1 for a page.
         CREATE TABLE nodes (
             kind TEXT NOT NULL,
             id TEXT NOT NULL,
             workspace_id TEXT NOT NULL,
             ord INTEGER NOT NULL,
             locked INTEGER NOT NULL DEFAULT 0,
             json TEXT NOT NULL,
             PRIMARY KEY (kind, id)
         );
         CREATE INDEX nodes_workspace ON nodes (workspace_id, kind, ord);
         CREATE TABLE tasks (
             workspace_id TEXT NOT NULL,
             id TEXT NOT NULL,
             ord INTEGER NOT NULL,
             json TEXT NOT NULL,
             PRIMARY KEY (workspace_id, id)
         );
         -- workspace_id is NULL until a stored tree shows the page.
         CREATE TABLE page_docs (
             page_id TEXT PRIMARY KEY,
             workspace_id TEXT,
             doc BLOB NOT NULL,
             stored_at INTEGER NOT NULL
         );
         -- Which lists have been stored, and when: scope is workspaces, tree or tasks
         -- (workspace_id '' for the workspace list).
         CREATE TABLE stored (
             scope TEXT NOT NULL,
             workspace_id TEXT NOT NULL,
             stored_at INTEGER NOT NULL,
             PRIMARY KEY (scope, workspace_id)
         );",
    )
}

/// Version 2: the outbox, local edits of live pages not yet confirmed by the server.
fn upgrade_to_2(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE outbox (
             seq INTEGER PRIMARY KEY AUTOINCREMENT,
             page_id TEXT NOT NULL,
             update_v1 BLOB NOT NULL,
             queued_at INTEGER NOT NULL
         );
         CREATE INDEX outbox_page ON outbox (page_id, seq);",
    )
}

/// Version 3: task changes made offline, waiting to be sent (`op` is a `TaskOp` as JSON).
fn upgrade_to_3(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE task_ops (
             seq INTEGER PRIMARY KEY AUTOINCREMENT,
             workspace_id TEXT NOT NULL,
             task_id TEXT NOT NULL,
             page_id TEXT,
             op TEXT NOT NULL,
             queued_at INTEGER NOT NULL
         );
         -- The editor looks tasks up by id alone (`task`).
         CREATE INDEX tasks_id ON tasks (id);",
    )
}

/// A task change waiting for the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum TaskOp {
    /// POST /workspaces/:id/tasks (with the client's id, so a retry can't duplicate it).
    Create { task: Box<NewTask> },
    /// PATCH /tasks/:id with these fields.
    Update { patch: serde_json::Value },
    /// DELETE /tasks/:id.
    Delete,
}

/// A queued task change, as `task_ops` lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct QueuedTaskOp {
    /// Its key, for `unqueue_task_op`; also the order the changes were made in.
    pub seq: i64,
    pub workspace_id: String,
    pub task_id: String,
    pub op: TaskOp,
}

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    /// The database was written by a newer app (schema `found`; this build knows up to `supported`).
    TooNew {
        found: u32,
        supported: u32,
    },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "database error: {e}"),
            StoreError::Json(e) => write!(f, "stored record unreadable: {e}"),
            StoreError::TooNew { found, supported } => write!(
                f,
                "the database has schema version {found}; this app knows up to {supported}"
            ),
        }
    }
}
impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Json(e)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// A stored page document.
#[derive(Debug, Clone, PartialEq)]
pub struct PageDoc {
    /// The whole document as a Yjs update.
    pub doc: Vec<u8>,
    /// When it was stored, in milliseconds since the Unix epoch.
    pub stored_at: i64,
}

/// The local database for one account. Safe to share between threads (calls are serialised).
pub struct Store {
    conn: Mutex<Connection>,
    last_error: Mutex<Option<String>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn to_json<T: Serialize>(v: &T) -> Result<String> {
    Ok(serde_json::to_string(v)?)
}

fn from_json<T: DeserializeOwned>(s: &str) -> Result<T> {
    Ok(serde_json::from_str(s)?)
}

fn mark_stored(tx: &Transaction, scope: &str, workspace_id: &str) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR REPLACE INTO stored (scope, workspace_id, stored_at) VALUES (?1, ?2, ?3)",
        params![scope, workspace_id, now_ms()],
    )?;
    Ok(())
}

/// The workspace of a page a stored tree shows unlocked; None when it is locked or unknown.
fn unlocked_page(tx: &Transaction, page_id: &str) -> rusqlite::Result<Option<String>> {
    tx.query_row(
        "SELECT workspace_id FROM nodes WHERE kind = 'page' AND id = ?1 AND locked = 0",
        [page_id],
        |r| r.get(0),
    )
    .optional()
}

/// What the server's `redactTask` leaves of a task on a locked page nobody has unlocked.
pub const LOCKED_TASK_TITLE: &str = "Locked task";

/// Withhold a task's text as the server does for a locked page: the title, description and tags
/// go, everything else (status, dates, assignee, checklist counts) stays.
pub fn redact_locked_task(t: &mut Task) {
    t.title = LOCKED_TASK_TITLE.into();
    t.description = String::new();
    t.tag_ids = Vec::new();
    t.locked = true;
}

/// Whether a stored tree marks this page locked.
fn page_locked(tx: &Transaction, page_id: &str) -> rusqlite::Result<bool> {
    Ok(tx
        .query_row(
            "SELECT locked FROM nodes WHERE kind = 'page' AND id = ?1",
            [page_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        == Some(1))
}

/// Redact a task to be stored if its page is locked in a stored tree.
fn redacted_for_store(tx: &Transaction, t: &Task) -> rusqlite::Result<Option<Task>> {
    match &t.page_id {
        Some(p) if !(t.locked && t.title == LOCKED_TASK_TITLE) && page_locked(tx, p)? => {
            let mut r = t.clone();
            redact_locked_task(&mut r);
            Ok(Some(r))
        }
        _ => Ok(None),
    }
}

/// Redact the stored tasks (of one workspace, or all) that sit on a locked page.
fn redact_stored_tasks(tx: &Transaction, workspace_id: Option<&str>) -> Result<()> {
    let rows: Vec<(String, String, String)> = {
        let mut st = tx.prepare(
            "SELECT workspace_id, id, json FROM tasks WHERE (?1 IS NULL OR workspace_id = ?1)",
        )?;
        let rows = st.query_map([workspace_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (ws, id, json) in rows {
        let Ok(t) = from_json::<Task>(&json) else {
            continue;
        };
        if let Some(r) = redacted_for_store(tx, &t)? {
            tx.execute(
                "UPDATE tasks SET json = ?3 WHERE workspace_id = ?1 AND id = ?2",
                params![ws, id, to_json(&r)?],
            )?;
        }
    }
    Ok(())
}

fn schema_version(conn: &Connection) -> rusqlite::Result<u32> {
    Ok(conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0))
}

/// Bring the database up to `SCHEMA_VERSION`, one upgrade step at a time, in one transaction.
fn migrate(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    )?;
    let found = schema_version(conn)?;
    if found > SCHEMA_VERSION {
        return Err(StoreError::TooNew {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    if found == SCHEMA_VERSION {
        return Ok(());
    }
    let tx = conn.transaction()?;
    for step in &UPGRADES[found as usize..SCHEMA_VERSION as usize] {
        step(&tx)?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
        [SCHEMA_VERSION.to_string()],
    )?;
    tx.commit()?;
    Ok(())
}

impl Store {
    /// Open (or create) the database at `path` and upgrade it to this build's schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Store> {
        let conn = Connection::open(path)?;
        // WAL: readers don't wait for a writer. Returns the new mode as a row.
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        Store::setup(conn)
    }

    /// Open the database at `path`; if it can't be used (written by a newer app, or damaged),
    /// delete it and start an empty one. Everything in it is a copy of the server's, so nothing is lost.
    pub fn open_or_reset(path: impl AsRef<Path>) -> Result<Store> {
        let path = path.as_ref();
        match Store::open(path) {
            Ok(s) => Ok(s),
            Err(_) => {
                for ext in ["", "-wal", "-shm"] {
                    let mut p = path.as_os_str().to_owned();
                    p.push(ext);
                    let _ = std::fs::remove_file(p);
                }
                Store::open(path)
            }
        }
    }

    /// A store that lives only as long as this value (tests, or no database path).
    pub fn open_in_memory() -> Result<Store> {
        Store::setup(Connection::open_in_memory()?)
    }

    fn setup(mut conn: Connection) -> Result<Store> {
        conn.pragma_update(None, "secure_delete", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        Ok(Store {
            conn: Mutex::new(conn),
            last_error: Mutex::new(None),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn write<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let out: Result<T> = (|| {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let out = f(&tx)?;
            tx.commit()?;
            Ok(out)
        })();
        if let Err(e) = &out {
            eprintln!("[nv-store] write failed: {e}");
            *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.to_string());
        }
        out
    }

    /// The last write that failed (the store is a cache: callers carry on), for diagnostics.
    pub fn last_error(&self) -> Option<String> {
        self.last_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The database's schema version (`SCHEMA_VERSION` once open).
    pub fn schema_version(&self) -> Result<u32> {
        Ok(schema_version(&self.conn())?)
    }

    /// The user whose data this is, if one has been set.
    pub fn account(&self) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM meta WHERE key = 'account'", [], |r| {
                r.get(0)
            })
            .optional()?)
    }

    /// Record who is signed in. When the store held another user's data, it is cleared first
    /// (returns true then).
    pub fn set_account(&self, user_id: &str) -> Result<bool> {
        let current = self.account()?;
        if current.as_deref() == Some(user_id) {
            return Ok(false);
        }
        let cleared = current.is_some();
        if cleared {
            self.clear()?;
        }
        self.write(|tx| {
            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('account', ?1)",
                [user_id],
            )?;
            Ok(())
        })?;
        Ok(cleared)
    }

    /// When a list was last stored (ms since the epoch): `scope` is `workspaces` (with
    /// `workspace_id` ""), `tree` or `tasks`.
    pub fn stored_at(&self, scope: &str, workspace_id: &str) -> Result<Option<i64>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT stored_at FROM stored WHERE scope = ?1 AND workspace_id = ?2",
                params![scope, workspace_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Replace the workspace list. Everything stored for a workspace that is no longer listed
    /// (its tree, tasks and page documents) is deleted.
    pub fn put_workspaces(&self, workspaces: &[Workspace]) -> Result<()> {
        self.write(|tx| {
            tx.execute("DELETE FROM workspaces", [])?;
            for (i, w) in workspaces.iter().enumerate() {
                tx.execute(
                    "INSERT OR REPLACE INTO workspaces (id, ord, json) VALUES (?1, ?2, ?3)",
                    params![w.id, i as i64, to_json(w)?],
                )?;
            }
            tx.execute_batch(
                "DELETE FROM nodes WHERE workspace_id NOT IN (SELECT id FROM workspaces);
                 DELETE FROM tasks WHERE workspace_id NOT IN (SELECT id FROM workspaces);
                 DELETE FROM task_ops WHERE workspace_id NOT IN (SELECT id FROM workspaces);
                 DELETE FROM page_docs WHERE workspace_id IS NOT NULL
                     AND workspace_id NOT IN (SELECT id FROM workspaces);
                 DELETE FROM stored WHERE workspace_id <> ''
                     AND workspace_id NOT IN (SELECT id FROM workspaces);",
            )?;
            mark_stored(tx, "workspaces", "")?;
            Ok(())
        })
    }

    /// The stored workspace list, in the server's order; None if it was never stored.
    pub fn workspaces(&self) -> Result<Option<Vec<Workspace>>> {
        if self.stored_at("workspaces", "")?.is_none() {
            return Ok(None);
        }
        let conn = self.conn();
        let mut st = conn.prepare("SELECT json FROM workspaces ORDER BY ord")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for json in rows {
            out.push(from_json(&json?)?);
        }
        Ok(Some(out))
    }

    /// Replace a workspace's tree. Drops the stored documents of every page it marks locked, and
    /// of pages stored for this workspace that it no longer shows (as `prunePageCaches` does).
    pub fn put_tree(&self, workspace_id: &str, tree: &Tree) -> Result<()> {
        self.write(|tx| {
            tx.execute("DELETE FROM nodes WHERE workspace_id = ?1", [workspace_id])?;
            let mut insert = tx.prepare(
                "INSERT OR REPLACE INTO nodes (kind, id, workspace_id, ord, locked, json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (i, n) in tree.notebooks.iter().enumerate() {
                insert.execute(params![
                    "notebook",
                    n.id,
                    workspace_id,
                    i as i64,
                    0,
                    to_json(n)?
                ])?;
            }
            for (i, s) in tree.sections.iter().enumerate() {
                insert.execute(params![
                    "section",
                    s.id,
                    workspace_id,
                    i as i64,
                    0,
                    to_json(s)?
                ])?;
            }
            for (i, p) in tree.pages.iter().enumerate() {
                insert.execute(params![
                    "page",
                    p.id,
                    workspace_id,
                    i as i64,
                    p.locked as i64,
                    to_json(p)?
                ])?;
            }
            // Pages in the Trash keep their stored documents (the page may be restored; the
            // rows only say so, `unlocked_page` and the locked-page rules look at `page` rows).
            for (i, p) in tree.trashed_pages.iter().enumerate() {
                insert.execute(params![
                    "trashed_page",
                    p.id,
                    workspace_id,
                    i as i64,
                    0,
                    to_json(p)?
                ])?;
            }
            drop(insert);
            // Documents stored before their page was in a tree now belong to this workspace.
            tx.execute(
                "UPDATE page_docs SET workspace_id = ?1 WHERE page_id IN
                     (SELECT id FROM nodes WHERE kind = 'page' AND workspace_id = ?1)",
                [workspace_id],
            )?;
            tx.execute(
                "DELETE FROM page_docs WHERE page_id IN
                     (SELECT id FROM nodes WHERE kind = 'page' AND locked = 1)",
                [],
            )?;
            tx.execute(
                "DELETE FROM outbox WHERE page_id IN
                     (SELECT id FROM nodes WHERE kind = 'page' AND locked = 1)",
                [],
            )?;
            tx.execute(
                "DELETE FROM task_ops WHERE page_id IN
                     (SELECT id FROM nodes WHERE kind = 'page' AND locked = 1)",
                [],
            )?;
            tx.execute(
                "DELETE FROM page_docs WHERE workspace_id = ?1 AND page_id NOT IN
                     (SELECT id FROM nodes WHERE workspace_id = ?1
                        AND ((kind = 'page' AND locked = 0) OR kind = 'trashed_page'))",
                [workspace_id],
            )?;
            // A page that has become locked: its stored tasks hold full titles until now.
            if tree.pages.iter().any(|p| p.locked) {
                redact_stored_tasks(tx, Some(workspace_id))?;
            }
            mark_stored(tx, "tree", workspace_id)?;
            Ok(())
        })
    }

    /// A page was just locked (by this device, or the server said so): mark it locked in the
    /// stored tree at once, without waiting for the next tree load, and drop what was stored
    /// of it: its document, queued edits and queued task changes; its stored tasks are
    /// redacted. Returns false when no stored tree has the page.
    pub fn mark_page_locked(&self, page_id: &str) -> Result<bool> {
        let found = self.write(|tx| {
            let json: Option<String> = tx
                .query_row(
                    "SELECT json FROM nodes WHERE kind = 'page' AND id = ?1",
                    [page_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(json) = json else {
                // Not in a stored tree: nothing is stored for it either, by the other rules.
                tx.execute("DELETE FROM page_docs WHERE page_id = ?1", [page_id])?;
                tx.execute("DELETE FROM outbox WHERE page_id = ?1", [page_id])?;
                tx.execute("DELETE FROM task_ops WHERE page_id = ?1", [page_id])?;
                return Ok(false);
            };
            let mut meta: PageMeta = from_json(&json)?;
            meta.locked = true;
            tx.execute(
                "UPDATE nodes SET locked = 1, json = ?2 WHERE kind = 'page' AND id = ?1",
                params![page_id, to_json(&meta)?],
            )?;
            tx.execute("DELETE FROM page_docs WHERE page_id = ?1", [page_id])?;
            tx.execute("DELETE FROM outbox WHERE page_id = ?1", [page_id])?;
            tx.execute("DELETE FROM task_ops WHERE page_id = ?1", [page_id])?;
            redact_stored_tasks(tx, None)?;
            Ok(true)
        })?;
        // The old text must not linger in the write-ahead log: fold it into the database file.
        let _ = self
            .conn()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        Ok(found)
    }

    fn nodes<T: DeserializeOwned>(
        conn: &Connection,
        workspace_id: &str,
        kind: &str,
    ) -> Result<Vec<T>> {
        let mut st = conn
            .prepare("SELECT json FROM nodes WHERE workspace_id = ?1 AND kind = ?2 ORDER BY ord")?;
        let rows = st.query_map(params![workspace_id, kind], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for json in rows {
            out.push(from_json(&json?)?);
        }
        Ok(out)
    }

    /// The stored tree of a workspace; None if it was never stored.
    pub fn tree(&self, workspace_id: &str) -> Result<Option<Tree>> {
        if self.stored_at("tree", workspace_id)?.is_none() {
            return Ok(None);
        }
        let conn = self.conn();
        Ok(Some(Tree {
            notebooks: Self::nodes::<Notebook>(&conn, workspace_id, "notebook")?,
            sections: Self::nodes::<Section>(&conn, workspace_id, "section")?,
            pages: Self::nodes::<PageMeta>(&conn, workspace_id, "page")?,
            trashed_pages: Self::nodes::<TrashedPage>(&conn, workspace_id, "trashed_page")?,
        }))
    }

    /// The workspace a stored tree shows a notebook, section or page in (`kind`: "notebook",
    /// "section" or "page"); None when no stored tree has it.
    pub fn workspace_of(&self, kind: &str, id: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT workspace_id FROM nodes WHERE kind = ?1 AND id = ?2",
                params![kind, id],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    /// The workspaces that have a stored tree.
    pub fn tree_workspaces(&self) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut st = conn.prepare(
            "SELECT workspace_id FROM stored WHERE scope = 'tree' ORDER BY workspace_id",
        )?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Whether a stored tree marks the page locked.
    pub fn is_locked(&self, page_id: &str) -> Result<bool> {
        Ok(self
            .conn()
            .query_row(
                "SELECT locked FROM nodes WHERE kind = 'page' AND id = ?1",
                [page_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            == Some(1))
    }

    /// Replace a workspace's tasks. Locked tasks are stored as sent (already redacted).
    pub fn put_tasks(&self, workspace_id: &str, tasks: &[Task]) -> Result<()> {
        self.write(|tx| {
            tx.execute("DELETE FROM tasks WHERE workspace_id = ?1", [workspace_id])?;
            let mut insert = tx.prepare(
                "INSERT OR REPLACE INTO tasks (workspace_id, id, ord, json) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (i, t) in tasks.iter().enumerate() {
                let json = match redacted_for_store(tx, t)? {
                    Some(r) => to_json(&r)?,
                    None => to_json(t)?,
                };
                insert.execute(params![workspace_id, t.id, i as i64, json])?;
            }
            drop(insert);
            mark_stored(tx, "tasks", workspace_id)?;
            Ok(())
        })
    }

    /// Store one task the server returned (after a create or an edit): replaced in place, or
    /// added at the end of its workspace's list.
    pub fn put_task(&self, task: &Task) -> Result<()> {
        self.write(|tx| {
            let ord: i64 = tx
                .query_row(
                    "SELECT ord FROM tasks WHERE workspace_id = ?1 AND id = ?2",
                    params![task.workspace_id, task.id],
                    |r| r.get(0),
                )
                .optional()?
                .map_or_else(
                    || {
                        tx.query_row(
                            "SELECT COALESCE(MAX(ord) + 1, 0) FROM tasks WHERE workspace_id = ?1",
                            [&task.workspace_id],
                            |r| r.get(0),
                        )
                    },
                    Ok,
                )?;
            let json = match redacted_for_store(tx, task)? {
                Some(r) => to_json(&r)?,
                None => to_json(task)?,
            };
            tx.execute(
                "INSERT OR REPLACE INTO tasks (workspace_id, id, ord, json) VALUES (?1, ?2, ?3, ?4)",
                params![task.workspace_id, task.id, ord, json],
            )?;
            Ok(())
        })
    }

    /// The stored tasks of a workspace, in the server's order; None if they were never stored.
    pub fn tasks(&self, workspace_id: &str) -> Result<Option<Vec<Task>>> {
        if self.stored_at("tasks", workspace_id)?.is_none() {
            return Ok(None);
        }
        let conn = self.conn();
        let mut st = conn.prepare("SELECT json FROM tasks WHERE workspace_id = ?1 ORDER BY ord")?;
        let rows = st.query_map([workspace_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for json in rows {
            out.push(from_json(&json?)?);
        }
        Ok(Some(out))
    }

    /// One stored task by id (in any workspace), if there is one.
    pub fn task(&self, task_id: &str) -> Result<Option<Task>> {
        let json: Option<String> = self
            .conn()
            .query_row("SELECT json FROM tasks WHERE id = ?1", [task_id], |r| {
                r.get(0)
            })
            .optional()?;
        json.map(|j| from_json(&j)).transpose()
    }

    /// Delete a stored task and its subtasks, all levels (the server deletes them together);
    /// returns what was removed, the task first.
    pub fn remove_task(&self, task_id: &str) -> Result<Vec<Task>> {
        self.write(|tx| {
            let mut all: Vec<Task> = Vec::new();
            {
                let mut st = tx.prepare(
                    "SELECT json FROM tasks WHERE workspace_id IN
                         (SELECT workspace_id FROM tasks WHERE id = ?1)",
                )?;
                for json in st.query_map([task_id], |r| r.get::<_, String>(0))? {
                    all.push(from_json(&json?)?);
                }
            }
            let mut gone: Vec<Task> = all.iter().filter(|t| t.id == task_id).cloned().collect();
            let mut i = 0;
            while i < gone.len() {
                let parent = gone[i].id.clone();
                for t in &all {
                    if t.parent_id.as_deref() == Some(parent.as_str())
                        && !gone.iter().any(|g| g.id == t.id)
                    {
                        gone.push(t.clone());
                    }
                }
                i += 1;
            }
            let mut del = tx.prepare("DELETE FROM tasks WHERE workspace_id = ?1 AND id = ?2")?;
            for t in &gone {
                del.execute(params![t.workspace_id, t.id])?;
            }
            Ok(gone)
        })
    }

    /// Keep a task change until the server has it; returns its key. A change to a task on a
    /// page (`page_id`) is refused (None, nothing kept) unless a stored tree shows that page
    /// unlocked.
    pub fn queue_task_op(
        &self,
        workspace_id: &str,
        task_id: &str,
        page_id: Option<&str>,
        op: &TaskOp,
    ) -> Result<Option<i64>> {
        self.write(|tx| {
            if let Some(page) = page_id {
                if unlocked_page(tx, page)?.is_none() {
                    return Ok(None);
                }
            }
            tx.execute(
                "INSERT INTO task_ops (workspace_id, task_id, page_id, op, queued_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![workspace_id, task_id, page_id, to_json(op)?, now_ms()],
            )?;
            Ok(Some(tx.last_insert_rowid()))
        })
    }

    /// Every queued task change, oldest first. One that can't be read is left out.
    pub fn task_ops(&self) -> Result<Vec<QueuedTaskOp>> {
        let conn = self.conn();
        let mut st =
            conn.prepare("SELECT seq, workspace_id, task_id, op FROM task_ops ORDER BY seq")?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, workspace_id, task_id, op) = row?;
            if let Ok(op) = from_json(&op) {
                out.push(QueuedTaskOp {
                    seq,
                    workspace_id,
                    task_id,
                    op,
                });
            }
        }
        Ok(out)
    }

    /// The server has this task change (or refused it for good): forget it.
    pub fn unqueue_task_op(&self, seq: i64) -> Result<()> {
        self.write(|tx| {
            tx.execute("DELETE FROM task_ops WHERE seq = ?1", [seq])?;
            Ok(())
        })
    }

    /// Store a page's document. Only for a page a stored tree shows unlocked: otherwise (locked,
    /// or not in any stored tree, so possibly locked) returns false and stores nothing.
    pub fn put_page_doc(&self, page_id: &str, doc: &[u8]) -> Result<bool> {
        self.write(|tx| {
            let Some(workspace_id) = unlocked_page(tx, page_id)? else {
                return Ok(false);
            };
            tx.execute(
                "INSERT OR REPLACE INTO page_docs (page_id, workspace_id, doc, stored_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![page_id, workspace_id, doc, now_ms()],
            )?;
            Ok(true)
        })
    }

    /// Keep local edits (Yjs updates) of a page until the server has them; returns their keys
    /// in order. Refused (None, nothing kept) unless a stored tree shows the page unlocked.
    pub fn queue_updates(&self, page_id: &str, updates: &[Vec<u8>]) -> Result<Option<Vec<i64>>> {
        self.write(|tx| {
            if unlocked_page(tx, page_id)?.is_none() {
                return Ok(None);
            }
            let mut insert = tx.prepare(
                "INSERT INTO outbox (page_id, update_v1, queued_at) VALUES (?1, ?2, ?3)",
            )?;
            let now = now_ms();
            let mut keys = Vec::with_capacity(updates.len());
            for u in updates {
                insert.execute(params![page_id, u, now])?;
                keys.push(tx.last_insert_rowid());
            }
            Ok(Some(keys))
        })
    }

    /// A page's queued edits, oldest first, with their keys.
    pub fn queued_updates(&self, page_id: &str) -> Result<Vec<(i64, Vec<u8>)>> {
        let conn = self.conn();
        let mut st =
            conn.prepare("SELECT seq, update_v1 FROM outbox WHERE page_id = ?1 ORDER BY seq")?;
        let rows = st.query_map([page_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The server has these queued edits: forget them.
    pub fn unqueue(&self, page_id: &str, keys: &[i64]) -> Result<()> {
        self.write(|tx| {
            let mut del = tx.prepare("DELETE FROM outbox WHERE page_id = ?1 AND seq = ?2")?;
            for k in keys {
                del.execute(params![page_id, k])?;
            }
            Ok(())
        })
    }

    /// Pages with queued edits (not yet confirmed by the server).
    pub fn queued_pages(&self) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut st = conn.prepare("SELECT DISTINCT page_id FROM outbox ORDER BY page_id")?;
        let rows = st.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A page's stored document, if there is one.
    pub fn page_doc(&self, page_id: &str) -> Result<Option<PageDoc>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT doc, stored_at FROM page_docs WHERE page_id = ?1",
                [page_id],
                |r| {
                    Ok(PageDoc {
                        doc: r.get(0)?,
                        stored_at: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    /// Delete a page's stored document and queued edits (it was locked, deleted, or access ended).
    pub fn forget_page(&self, page_id: &str) -> Result<()> {
        self.write(|tx| {
            tx.execute("DELETE FROM page_docs WHERE page_id = ?1", [page_id])?;
            tx.execute("DELETE FROM outbox WHERE page_id = ?1", [page_id])?;
            Ok(())
        })
    }

    /// Delete everything (sign-out). The schema stays; so does nothing else.
    pub fn clear(&self) -> Result<()> {
        self.write(|tx| {
            tx.execute_batch(
                "DELETE FROM workspaces;
                 DELETE FROM nodes;
                 DELETE FROM tasks;
                 DELETE FROM page_docs;
                 DELETE FROM outbox;
                 DELETE FROM task_ops;
                 DELETE FROM stored;
                 DELETE FROM meta WHERE key = 'account';",
            )?;
            Ok(())
        })?;
        // Push the deletions out of the write-ahead log too (no-op for an in-memory store).
        let _ = self
            .conn()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        Ok(())
    }
}

#[cfg(test)]
mod tests;
