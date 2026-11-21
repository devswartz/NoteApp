//! The on-device store for one signed-in account (docs/ARCHITECTURE.md 3.3): the last copy of the
//! workspace list, each workspace's tree and tasks, and page documents (Yjs updates), in SQLite.
//!
//! It is a cache of what the server sent, as the web app's `src/lib/offlineCache.ts` and
//! `src/lib/pageCache.ts` are today, and follows their rules:
//!
//! - **Locked pages are never stored.** `put_tree` deletes the stored document of every page the
//!   tree marks locked (in any workspace), and of every page stored for that workspace that the
//!   tree no longer shows. `put_page_doc` refuses a page the store knows is locked. A page the
//!   store has never seen in a tree is stored; the next `put_tree` that shows it locked drops it.
//! - Tasks are stored as the server sent them. Tasks on a locked page arrive with `locked: true`
//!   and their title and text already withheld, so they are safe to keep (as the web app does).
//! - `clear()` on sign-out drops everything; `set_account` clears too when another user signs in.
//!
//! Records are JSON columns (the `nv-api` types) keyed by id and workspace. The schema has a
//! version (`SCHEMA_VERSION`) and explicit upgrade steps (`UPGRADES`): a database from an older
//! app is upgraded in place on open; one from a newer app is refused (`StoreError::TooNew`), and
//! since the store is only a cache the caller can delete the file and start again.
//!
//! Every write is one transaction. Deleted rows are overwritten on disk (`secure_delete`).

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use nv_api::{Notebook, PageMeta, Section, Task, Tree, Workspace};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::de::DeserializeOwned;
use serde::Serialize;

/// The schema version this build writes. Add an upgrade step to `UPGRADES` with every bump.
pub const SCHEMA_VERSION: u32 = 1;

/// One step per version: `UPGRADES[n]` takes a database from version `n` to `n + 1`.
const UPGRADES: &[fn(&Transaction) -> rusqlite::Result<()>] = &[upgrade_to_1];

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
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn write<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
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
                insert.execute(params!["notebook", n.id, workspace_id, i as i64, 0, to_json(n)?])?;
            }
            for (i, s) in tree.sections.iter().enumerate() {
                insert.execute(params!["section", s.id, workspace_id, i as i64, 0, to_json(s)?])?;
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
                "DELETE FROM page_docs WHERE workspace_id = ?1 AND page_id NOT IN
                     (SELECT id FROM nodes WHERE kind = 'page' AND workspace_id = ?1 AND locked = 0)",
                [workspace_id],
            )?;
            mark_stored(tx, "tree", workspace_id)?;
            Ok(())
        })
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
        }))
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
                insert.execute(params![workspace_id, t.id, i as i64, to_json(t)?])?;
            }
            drop(insert);
            mark_stored(tx, "tasks", workspace_id)?;
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

    /// Store a page's document. Refused for a page a stored tree marks locked: returns false and
    /// stores nothing.
    pub fn put_page_doc(&self, page_id: &str, doc: &[u8]) -> Result<bool> {
        self.write(|tx| {
            let page: Option<(String, i64)> = tx
                .query_row(
                    "SELECT workspace_id, locked FROM nodes WHERE kind = 'page' AND id = ?1",
                    [page_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if matches!(page, Some((_, 1))) {
                return Ok(false);
            }
            tx.execute(
                "INSERT OR REPLACE INTO page_docs (page_id, workspace_id, doc, stored_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![page_id, page.map(|(ws, _)| ws), doc, now_ms()],
            )?;
            Ok(true)
        })
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

    /// Delete a page's stored document (it was locked, deleted, or access ended).
    pub fn forget_page(&self, page_id: &str) -> Result<()> {
        self.write(|tx| {
            tx.execute("DELETE FROM page_docs WHERE page_id = ?1", [page_id])?;
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
