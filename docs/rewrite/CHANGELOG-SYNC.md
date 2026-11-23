# CHANGELOG-SYNC: the server's durable change log (M7 design)

Status: **design, for the owner's review.** Nothing here is built. It is the proposal for a series
of PRs to `main` (server only) plus the core work that uses them. Written 2026-11-22 on
`rewrite/core-changelog` from reading `server/collab.ts`, `server/events.ts`, `server/tasks.ts`,
`server/routes/*`, `server/versions.ts`, `server/db.ts`, the web's `src/store/events.ts`,
`src/lib/offlineCache.ts`, `src/lib/pageCache.ts`, `src/store/taskWrites.ts`, and the core's
`crates/nv-sync`, `crates/nv-store`, `crates/nv-core/src/tasks.rs`. Things I could not confirm by
reading are marked **(unsure)**. This extends `docs/ARCHITECTURE.md` section 3.5; where they differ,
this document is the newer thinking.

## 1. Problem and goals

Today the server is correct while it stays up and every client stays connected. Three things break
that picture, and M7 ("local-first") needs all three fixed:

1. **An acknowledged page edit can be lost.** The core treats an edit as safe once the server's
   receipt comes back, and then deletes it from its outbox. But the server only holds the edit in
   memory at that point (section 2.1).
2. **A client that was away cannot catch up.** The live-event channel keeps the last 2,000 events in
   memory. After a server restart, or a long absence, the only way back is "reload everything".
3. **Tasks cannot be edited offline safely.** The server has no idea which version of a task an
   offline edit was based on, and a retried "tick" on a repeating task can complete it twice.

Goals, in priority order:

- **G1 Durability.** An edit the server has acknowledged survives a crash (`kill -9`, OOM, deploy
  gone wrong). Process crash is the bar; see section 3.1 for power loss.
- **G2 Catch-up from a cursor.** A client holding a cursor asks "what changed since?" and gets
  deltas for the tree, tasks, comments, tags, teams and members. Pages catch up the way they do now
  (Yjs state vectors), which already sends only the missing part.
- **G3 Offline task editing** with defined conflict rules, safe retries, and a clear result for each
  queued change.
- **G4 Store-backed screens.** Every screen can draw from `nv-store` and be told when the store
  changed. The network becomes a background refresh, not a precondition.
- **G5 No regression for today's apps.** The web app and the shipped iOS/Mac apps work unchanged
  while this lands and after. Everything is behind flags and additive.

Non-goals (decided here so nobody builds them by accident):

- **No change to the page wire protocol.** y-websocket messages stay exactly as they are.
- **No offline editing of the tree** (rename, move, create or delete notebooks, sections, pages) and
  **no offline comments, tags, teams or reminders** in M7. They are read offline (they arrive through
  the feed) and written online. The feed and the `was` rule (3.4) leave room to add them later.
- **No event sourcing.** The feed says *which records changed*, not a history of how. There is no
  per-field audit trail and no undo-from-log.
- **No end-to-end encryption**, and no change to what "locked" means (still not encrypted).
- **No real-time presence changes.** Awareness stays as is.
- **No change to authentication.** The feed uses the same tokens and the same permission functions.
- **Not solved here:** local full-text search (that is `nv-search`, M10) and pages shared into a
  workspace the user is not a member of (open question 3).

## 2. Today's behaviour, and the gaps

### 2.1 Page content (Yjs): `server/collab.ts`

How it works:

- One `Room` per open page (`rooms` map, `getRoom`). The room holds the `Y.Doc` in memory, loaded
  from `pages.ydoc` (a full-state BLOB) on first connect, and is destroyed when the last socket
  leaves (`closeConn`).
- A client message goes through `syncProtocol.readSyncMessage(dec, enc, room.doc, conn)`. That
  applies the update to the in-memory doc, fires `doc.on('update')`, which relays it to the other
  sockets and calls `scheduleSave`. Nothing is written to disk at this point.
- `scheduleSave` sets a timer: 1 s after the last edit (`SAVE_DEBOUNCE_MS`), but never later than 5 s
  after the first unsaved edit (`SAVE_MAX_WAIT_MS`). `persist` then runs `persistNow`: it writes
  `pages.ydoc` (whole state), `text`, `updated_at`, `updated_by` and the `pages_fts` row in one
  SQLite transaction, then runs derived work: `syncPageTasks`, `placePageTasks`,
  `setChecklistCounts`, mention notifications, the activity hook, and `publish({type:'tree'})`.
- On failure `persist` logs and retries in 5 s (`SAVE_RETRY_MS`). On last disconnect it saves at
  once. On `SIGTERM` `shutdownCollab` calls `flushAll`. Other server code that needs current content
  calls `flushAll()` first (for example `copyPage` in `server/tree.ts`, `POST /pages/:id/versions`).
- Server-side edits (`editPageDoc`, `seedPageDoc`) write `pages.ydoc` directly.
- Version history (`server/versions.ts`): `snapshot()` copies `pages.ydoc` into `page_versions`
  (every 5 minutes for pages edited since the last snapshot, when someone opens history, and before a
  restore). Retention: all of the last 24 h, hourly for 7 days, then daily, at most 200. **Restore is
  done by the client**: `src/editor/VersionHistory.tsx` loads the old state, applies the difference
  to the live doc as ordinary edits, after asking `POST /pages/:id/versions {reason:'restore'}` to
  snapshot "before restore". So a restore is just another Yjs update from the server's point of view.

The receipt the core relies on (`crates/nv-sync/src/live.rs`): after sending queued edits it sends a
sync step 1 and treats the server's step 2 reply as the receipt, because the server answers in order
after applying everything before it. Then it removes those edits from the `outbox` table.

**Gap G-A (the main one).** The receipt proves "applied to the in-memory room", not "saved". The
window is up to 5 s per active page (`SAVE_MAX_WAIT_MS`), plus any time the 5 s retry loop is
running because saves are failing. A `kill -9`, an OOM kill, a crashed process or a power loss in the
window loses edits the client was told were safe. A clean restart does not (it flushes).

How much is really lost today, stated exactly:

- If the device is still running the live page, the edit is not lost: on reconnect the server sends
  its state vector (step 1) and the client's doc answers with what the server lacks. Both the web and
  the core do this.
- It **is** lost if the editing device closed the page (or the app) after the receipt and before the
  crash. The core has already dropped the edit from its outbox and builds each live page from the
  server's state, not from its stored copy (`docs/rewrite/status/core.md`, "nv-store (done)"). The web
  is better off only by accident: `y-indexeddb` keeps the whole doc forever and re-sends it on the
  next open.
- A second device that received the edit live (via the relay) holds it too, but only as long as it
  keeps that page open.

**Gap G-B.** `persistNow` also does the derived work (task attachment by who inserted the reference,
mention notifications). After a crash that data (`taskAuthors`, `mentionAuthors`) is gone with the
room, so recovery cannot just load `pages.ydoc` and carry on. See 3.1.

**Gap G-C.** Readers other than the room (`snapshot`, `pageDocState` when the room is closed,
export, search indexing) read `pages.ydoc` and trust that `flushAll()` ran. Fine today. It must stay
true after the change, so the design keeps `pages.ydoc` as the compacted truth and has flush mean
"compact".

**Crash settings, for the record.** `server/db.ts` uses WAL. `better-sqlite3` is compiled with
`SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` (I found it in `node_modules/better-sqlite3/deps/defines.gypi`),
so WAL commits are `synchronous=NORMAL`: a committed transaction survives a process crash but the last
few commits can vanish on power loss or OS crash. That is an acceptable bar for G1 (section 3.1 says
what to do if the owner wants more).

### 2.2 Records over REST

Reads and writes, as they are today:

| Data | Routes | Per-row version? | Delete |
|---|---|---|---|
| Tree | `GET /workspaces/:id/tree` (`routes/tree.ts`), `PATCH /pages/:id`, tree and trash routes | `pages.updated_at` only (bumped by content saves and title edits). **None** on notebooks, sections | Notebooks, sections, pages go to Trash (`deleted_at`, `trash_id`, 60 days, `server/trash.ts`), then hard-deleted by `purgeItem` / `purgeExpired` |
| Tasks | `GET /workspaces/:id/tasks`, `POST` (client id allowed), `PATCH /tasks/:id`, `DELETE /tasks/:id` (`routes/tasks.ts`, `server/tasks.ts`) | `tasks.updated_at` (set on every change, and by server-side moves) | `DELETE FROM tasks`, hard. Subtasks cascade |
| Comments | `routes/comments.ts` | `created_at`, `edited_at`, `resolved_at` on threads/comments | Hard |
| Tags, teams, views, members | `routes/teams.ts`, `routes/workspaces.ts` | none | Hard |
| Reminders | `routes/reminders.ts` (per user) | `task_reminders.updated_at` | Hard |

PATCH semantics: `updateTask` writes only the fields present in the body, so two edits to different
fields merge, and two edits to the same field are decided by arrival order. There is **no precondition
on tasks** (`PATCH /pages/:id` has an optimistic `titleWas`/`iconWas` check, a useful precedent).

### 2.3 Live events: `server/events.ts`

`publish(ev, {userIds?})` is called from about 60 sites (grep `publish(`). Each event gets a number
`seq` and goes into an in-memory array capped at 2,000 (`BUFFER_MAX`). Clients connect to
`/api/events?since=<boot>:<seq>`; the server replays what they missed, filtered for them as of now
(`messageFor`, and `forSocket` which redacts locked tasks per sign-in), or sends `resync`.
`BOOT` is a random id per process, so **every deploy invalidates every cursor**. The web handles that
in `src/store/events.ts` (`resync()` refetches workspaces, tree, tasks, members, tags, teams, views).

Event types (`shared/types.ts` `ServerEvent`): `task` (carries the whole task), `task-deleted`,
`tree`, `members`, `workspaces`, `comments`, `notification`, `activity`, `templates`, `tags`,
`teams`, `task-views`, `shared-pages`, `resync`, `page-locked`.

Gaps:

- **G-D, not durable.** A cursor older than 2,000 events, or from before the last restart, means a
  full refetch. Offline for a day on a busy workspace is enough.
- **G-E, `tree` carries no ids.** It means "refetch the tree". The page-save path publishes it on
  every save (`persistNow`), so busy pages cause many tree reloads.
- **G-F, payloads are stored unredacted.** The buffer holds whole `Task` objects including locked
  titles and redacts at delivery (`forSocket`). Fine in memory. It must not be copied as-is into a
  database table; the design below stores no payloads.
- **G-G, the core has no events client at all.** `grep` finds no use of `/api/events` in
  `crates/`. Apple gets changes only by calling `tasks()` / `tree()` again, and the core has no
  change notification for tasks or comments (`status/core.md`, "Not done").

### 2.4 Today's clients

- **Web:** read-through cache (`src/store/cache.ts`: fetch, store in IndexedDB via
  `offlineCache.ts`, fall back to the copy on a network error, **read-only**). Pages are cached by
  `y-indexeddb` (`pageCache.ts`) and are editable offline. Tasks are read-only offline; writes are
  ordered per task in memory by `TaskWrites` (`src/store/taskWrites.ts`) and lost on reload.
- **Core:** `nv-store` v3 (SQLite): `workspaces`, `nodes`, `tasks`, `page_docs`, `stored`, `outbox`
  (page edits until receipt), `task_ops` (queued task create/PATCH/delete as stored request bodies).
  `nv-core/src/tasks.rs` sends the queue first, in order, one at a time, drops a 4xx-refused op and
  notes it in `taskError()`, keeps it on 5xx or network error. Known gaps from the handover: no
  change notification for task lists, queued edits of tasks the store doesn't know, a create and a
  delete of the same task cannot be merged. Tags, teams, members, reminders, notes and comments are
  online only.

### 2.5 Task-specific gaps (offline)

- **G-H, retried completion is not idempotent for repeating tasks.** `updateTask` with
  `status:'done'` on a recurring task writes a history row and rolls `due_date` forward. If the
  response is lost and the client retries (today's core retries on network error), the second PATCH
  rolls it forward again and a whole occurrence disappears. Create is already idempotent (client id,
  `createTask` returns the existing row), PATCH and DELETE are not safe to repeat blindly.
- **G-I, no base version.** The server cannot tell "edited from the current state" from "edited from a
  week-old state". An offline edit made last Monday silently overwrites a teammate's change from
  Tuesday if they touched the same field.
- **G-J, no per-op result.** A refused queued op is just dropped with a log line.

## 3. Design

Three independent mechanisms, each shippable alone:

- **A. A per-page write-ahead log** for Yjs updates (fixes G-A, G-B, G-C).
- **B. A per-workspace change feed** for records, pull plus a push nudge (fixes G-D to G-G).
- **C. A batch endpoint for task operations** with ids and base values (fixes G-H, G-I, G-J).

### 3.1 A: Yjs updates are logged before they are acknowledged

**Table** (migration `NNN-page-update-log.sql`):

```sql
CREATE TABLE page_updates (
  id        INTEGER PRIMARY KEY,                 -- rowid: increasing, never reused within a page's life
  page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  update_v1 BLOB NOT NULL,                       -- the Yjs update exactly as applied
  user_id   TEXT,                                -- who sent it (null: server edit)
  at        TEXT NOT NULL
);
CREATE INDEX page_updates_page ON page_updates (page_id, id);
ALTER TABLE pages ADD COLUMN log_upto INTEGER NOT NULL DEFAULT 0;  -- last log id folded into pages.ydoc
```

`ALTER TABLE ... ADD COLUMN` with a constant default does not rewrite rows, so it is instant even
with large `ydoc` blobs.

**Write path.** In `getRoom`, the existing `doc.on('update', ...)` handler already sees every applied
update, after sanitising and after the held-update merge (the point where it relays to other sockets).
Add one statement there, before the relay:

```ts
logUpdate.run(pageId, update, userId, now());   // better-sqlite3 is synchronous: committed when it returns
```

The reply to a receipt (sync step 2) is written into `enc` by `readSyncMessage` and sent after it
returns (`send(room, conn, ...)` at the end of the message handler), so **by the time any receipt
leaves the server, every update before it has been committed to the log.** No protocol change, no
client change: today's receipt simply becomes durable. This is the whole point of the design.

What "ack" means after this change (to be written into the core's docs too): *the server has committed
the update to SQLite. It survives a process crash. It may be lost on power loss only if the owner keeps
`synchronous=NORMAL`.* If the owner wants power-loss safety for acks, set `PRAGMA synchronous=FULL`
(an fsync per commit; about 1 to 10 ms on SSD, **(unsure, measure on the homelab disk)**). Typing is
5 to 10 updates per second per user, so FULL is affordable at today's scale. Recommended: ship NORMAL,
measure, decide (open question 2).

**Edge cases in the write path:**

- Page deleted while open: the FK makes the insert fail. Catch it, close the room (like
  `closeRoom`), do not crash the socket handler. (`persistNow` already returns early for a missing
  page.)
- An update that sanitising holds back (`r.held`) is not logged until it is merged with its cleanup,
  because that merged update is what gets relayed. If the sanitiser itself throws, today the update is
  relayed anyway; the log appends at the same point, so behaviour is unchanged.
- Messages over 4 MB are already refused (`MAX_SYNC_MESSAGE_BYTES`), so a row is at most that.
- Awareness (presence) is not logged. It is ephemeral.

**Compaction (what `persistNow` becomes).** `persistNow` keeps all its derived work and still runs on
the same timers. Inside its transaction it additionally:

1. reads `max(id)` for the page's log rows, call it `upto`;
2. writes `pages.ydoc` = `encodeStateAsUpdate(room.doc)` (unchanged), `log_upto = upto`;
3. `DELETE FROM page_updates WHERE page_id = ? AND id <= upto`.

So the log is a short tail, normally seconds of data, never a history. `pages.ydoc` stays the full
truth after compaction, which keeps G-C satisfied: `flushAll()` still means "everything is in
`pages.ydoc`". A later step can lengthen the compaction interval (30 s or 256 KB of tail) to cut the
write amplification of rewriting whole docs every 1 to 5 s; the derived work could then move to its
own debounce. Not needed for correctness, so not in the first PR.

**Crash recovery.** At boot, before listening (`server/index.ts`), `recoverPageLogs()`:

```
for each page_id in SELECT DISTINCT page_id FROM page_updates:
  doc = Y.Doc; apply pages.ydoc; apply every row with id > pages.log_upto, in id order
  run the same cleanup as getRoom (clearPositionMigrations, sanitizePageDoc, upgradePageDoc)
  write pages.ydoc, text, updated_at = last row's `at`, updated_by = last row's user, FTS row,
  log_upto; delete the folded rows; all in one transaction
```

Then derived work that does not depend on who typed (text, FTS, checklist counts, task places) is
recomputed. What is lost with the room is `taskAuthors` and `mentionAuthors` (G-B): the "who inserted
this task reference or @mention" attribution. Because each log row carries `user_id`, recovery can
replay rows through the real room code with a stand-in origin carrying that user, which restores the
attribution exactly. I propose replaying through `getRoom` (open the room, apply the tail as if
those users sent it, save, close) so there is one code path. **(unsure)** whether `getRoom`'s
`observePageContent` hook can take a synthetic origin without refactoring; if not, recovery skips
attribution and the worst case is that a task reference inserted in the last 5 s before a crash is
not attached to the page until it is re-inserted (no data loss, a missed attach). The first PR may
accept that and say so.

**Versions and restore.** Unchanged in behaviour:

- `snapshot()` reads `pages.ydoc`. After the change, anything that must see "now" calls `flushAll()`
  first, as `POST /pages/:id/versions` already does. The 5-minute sweep sees edits within seconds of
  compaction, so no change.
- Restore is client-driven and arrives as normal updates, so it is logged like any edit.
  "Before restore" is taken by the existing `POST /versions {reason:'restore'}` (which flushes).
  Nothing in the log is ever replayed to "go back": the log is a write-ahead log, not history.
- After a crash, a snapshot taken by the sweep before recovery may predate the tail. Recovery sets
  `updated_at` so the next sweep takes a new one.
- Deleting a page (`ON DELETE CASCADE`) or purging from Trash removes its log rows.

**Alternatives rejected.**

- *Write `pages.ydoc` on every update:* simple but rewrites the whole doc per keystroke batch; docs
  reach megabytes (`docMaxBytes` metric exists; the position-migration bug produced 4.6 MB docs).
- *A new "saved" message after the debounced save, with clients holding edits until it arrives:*
  needs a protocol change, and every client would keep large outboxes for seconds. The WAL is
  invisible to clients.
- *Keep only the debounce and tell clients to keep confirmed edits for 10 s:* a client-side bandage
  that cannot cover a device that closes the page.

**Cost.** One row insert per applied update (roughly 50 to 500 bytes plus about 40 bytes of row and
index). Steady-state table size is near zero (compaction removes rows within seconds). Added latency
per update: one WAL append, tens of microseconds with NORMAL. **(unsure)**: needs a measurement with
the real `syncMetrics.applyMs` numbers before and after; the soak test records it (section 5).

### 3.2 B: a per-workspace change feed for records

**Idea.** The feed is a table that says *which record changed, and at which position*, one row per
record, updated in place. It stores no content. A client holding position N asks "which records
changed after N?" and the server answers with the **current** version of each, filtered for that
user at that moment. This is "last-modified index" sync, not an append-only log. Consequences:

- Fifty edits to one task between two syncs arrive as one entry (the latest).
- **Permissions and locked pages are evaluated when the answer is built, never when the change
  happened**, exactly like `messageFor`/`forSocket` do now. The stored data contains no titles and no
  text, so there is nothing to redact in the table and nothing stale to leak.
- Size is bounded by the number of records plus a short-lived set of delete tombstones, not by
  how much people type.

**Tables:**

```sql
CREATE TABLE feed_state (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 0,    -- head: last position handed out
  floor        INTEGER NOT NULL DEFAULT 0,    -- cursors below this can't be served (tombstones forgotten)
  epoch        TEXT NOT NULL                  -- random; changed if the feed is ever rebuilt
);
CREATE TABLE changes (
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL,                 -- see below
  entity_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,              -- position of the last change to this record
  gone         INTEGER NOT NULL DEFAULT 0,    -- 1: the row no longer exists (tombstone)
  audience     TEXT,                          -- user id: only this user may be told. NULL: workspace
  PRIMARY KEY (workspace_id, kind, entity_id)
) WITHOUT ROWID;
CREATE INDEX changes_seq ON changes (workspace_id, seq);
```

**Position (`seq`).** One counter per workspace, `feed_state.seq`, incremented inside the same
transaction as the data change. SQLite has a single writer, so **positions are handed out in commit
order with no gaps from rolled-back transactions**. That removes the classic "a lower number commits
late and a client skips it" bug that sequence-based feeds have on Postgres. The cursor the client
sees is the string `"<epoch>.<seq>"`; the client treats it as opaque.

**Kinds** (what the entry's `data` looks like is "the same JSON the REST endpoint returns for it"):

| kind | entity_id | data = | Source of truth |
|---|---|---|---|
| `workspace` | workspace id | workspace summary | `GET /workspaces` item |
| `notebook`, `section` | id | tree node | `GET .../tree` |
| `page` | page id | page meta: title, icon, kind, section, position, `updatedAt`, `locked` (**never content**) | `GET .../tree` |
| `task` | task id | the Task (redacted if locked, see 3.3) | `GET .../tasks` |
| `thread` | thread id | the thread with its comments | `GET /pages/:id/comments` item |
| `tag`, `team`, `view` | id | the record | teams routes |
| `member` | user id | `{userId, name, color, role}` | members route |
| `access` | `*` | none | "who can see what changed: resync" (3.3) |

Reminders (`task_reminders`, per user) are left for a later PR; the core keeps them online-only.

**How entries get written: SQLite triggers.** Today there is no single place that changes tree data:
`publish` is called from about 60 sites, the `tree` event has no ids, and writes also come from the AI
connector (`server/mcp/tools.ts`), imports (`server/onenote.ts`), account deletion
(`server/accounts.ts`), trash (`server/trash.ts`) and foreign-key side effects (a purged page sets
`tasks.page_id` to NULL). Hooking each site is how a record gets missed. So the proposal is
**`AFTER INSERT/UPDATE/DELETE` triggers on the source tables**, written in one migration, each doing
three things in the same transaction as the write:

```sql
UPDATE feed_state SET seq = seq + 1 WHERE workspace_id = <ws>;
INSERT INTO changes (workspace_id, kind, entity_id, seq, gone, audience)
  VALUES (<ws>, 'task', NEW.id, (SELECT seq FROM feed_state WHERE workspace_id = <ws>), 0, <audience>)
  ON CONFLICT (workspace_id, kind, entity_id) DO UPDATE SET seq = excluded.seq, gone = 0, audience = excluded.audience;
```

Details that matter:

- `<ws>` is `NEW.workspace_id` for `tasks`, `notebooks`, `comment_threads`, `tags`, `teams`,
  `workspace_members`, `task_views`; it is a join for `sections` (via `notebooks`), `pages` (via
  `sections` then `notebooks`), `comments` (via the thread), `task_tags` (via the task, entry is for
  the task).
- `pages` triggers fire `UPDATE OF title, icon, kind, section_id, position, deleted_at, locked_by,
  ydoc`. The `ydoc` column is included so server-side edits (`editPageDoc`, `seedPageDoc`, imports)
  appear without code changes; compaction also fires it, which only re-stamps the entry (harmless,
  clients compare `updatedAt`). Appending to `page_updates` also fires a page trigger, so a page shows
  as changed at ack time, not at compaction time.
- **Deletes.** A `DELETE` trigger writes the row with `gone = 1`. Soft deletes (Trash) are `UPDATE`s of
  `deleted_at`: the trigger writes `gone = 1` (and `gone = 0` again on restore). Cascaded deletes (a
  notebook purge deleting its sections and pages) fire the child triggers too, **but by then the
  parent row may be gone, so the workspace lookup could return NULL.** Rule: if the lookup returns
  NULL the trigger writes nothing, and the *purge function* (`purgeItem` in `trash.ts`) writes the
  tombstones for the subtree before its `DELETE`. There are only four hard-delete paths (`purgeItem`,
  `purgeExpired`, `emptyTrash`, `deleteWorkspace`/account deletion), far fewer than the update paths.
  **(unsure)**: I believe SQLite fires triggers for foreign-key cascade actions but did not test it;
  the first PR's test must settle this (see 5, step 3).
- **Audience.** Tombstones for things only one person could see carry that person in `audience`: a
  deleted private task (`private_owner_only`) gets its creator, a deleted page in a private notebook
  gets the notebook owner, a deleted locked page gets `locked_by`. Everyone else's answer skips
  entries whose audience is not them. This keeps "someone deleted something private" from showing up
  as an id in other members' feeds. (Today's hub sends `task-deleted` ids to members for tasks they
  cannot see, `messageFor`; the feed is stricter.)
- **Triggers must never break a write.** They use `INSERT OR IGNORE` for the `feed_state` row and
  skip when the workspace lookup is NULL. A mistake in a trigger would otherwise turn into 500s on
  every write, so the first feed PR also runs the entire existing test suite (`tests/*.test.ts`)
  with the triggers on, plus a new test that walks every write route and asserts the head moved.

**Why not "call `touch()` from the code" instead of triggers?** It is the other reasonable choice.
It can be turned off at runtime and is easy to read. Its cost is that every current and future write
path must remember to call it, and the AI connector, import and account-deletion paths are exactly
where people forget. I recommend triggers plus the route-walking test, and list it as open question 1.

**Reading: `GET /api/workspaces/:id/changes?since=<cursor>&limit=500`.**

```jsonc
// 200
{
  "cursor": "k3f9a.1042",       // pass this as `since` next time; set to the last entry returned
  "hasMore": false,             // true: call again at once with the new cursor
  "reconcile": false,           // true: an access change is in this range; do a full resync (3.3)
  "changes": [
    { "seq": 1031, "kind": "task",  "id": "…", "op": "upsert", "data": { /* Task, as GET /tasks */ } },
    { "seq": 1033, "kind": "page",  "id": "…", "op": "upsert", "data": { /* PageMeta */ } },
    { "seq": 1040, "kind": "task",  "id": "…", "op": "remove" }
  ]
}
// 410 Gone  { "code": "cursor_too_old" | "epoch_changed" }  -> full resync, then start from head
// 403/404   no access to the workspace any more                -> forget the workspace locally
```

- `since=head` returns `{cursor, changes: []}`: used to take a cursor *before* a full fetch (below).
- Paging: `ORDER BY seq LIMIT n` using `changes_seq`. `limit` is capped at 1,000. The next cursor is
  the `seq` of the last entry **before** filtering, so entries the user may not see still advance the
  cursor and are not rescanned. A page of results may therefore be shorter than `limit` or empty
  with `hasMore: true`; clients must loop on `hasMore`, not on result length.
- Ordering: ascending `seq`. A kind that depends on another (a task needs its page's title, a page
  needs its section) is not ordered by dependency; clients store records independently and tolerate a
  record pointing at one they don't have yet (they already do for tasks and pages today).
- Cost per request: one indexed range scan, then one batched fetch per kind
  (`WHERE id IN (…)` with the existing visibility predicates such as `NOTEBOOK_VISIBLE` and
  `TASK_VISIBLE` from `server/access.ts`), so about six queries per request regardless of `limit`.
- **Bootstrap.** A new client calls `since=head`, keeps that cursor, then does today's full fetches
  (`/tree`, `/tasks`, `/members`, …), then pulls from the kept cursor. Anything changed between the
  head read and the fetches is replayed; entries are state, so replaying is harmless (upserts are
  idempotent). This is how "no gap before first hello" (BUG-4 in `src/store/events.ts`) is solved
  durably.
- **No backfill.** Records that have never changed since the migration have no `changes` row, and
  nobody needs one: clients get them from the full fetch, not the feed. The initial `floor` is the
  head at migration time, so a cursor that predates the feed gets `cursor_too_old`.

**Retention and "cursor too old".** Live-record entries are kept for as long as the record exists.
Tombstones are kept 90 days (longer than the 60-day Trash, so a purged item's tombstone outlives
Trash), then a nightly job (next to `purgeExpired`) deletes them and sets `floor` to the highest seq
it deleted. A request with `since < floor` or a different `epoch` gets 410, and the client does a full
resync. So a device offline for 3 months resyncs; for 3 weeks it catches up with deltas. The set size
is bounded: one row per record that changed since the migration, plus 90 days of tombstones
(rough size: about 100 bytes per row including its index, so 100,000 records is about 10 MB
**(unsure: I do not know production row counts; the first PR should log the counts)**).

**Push: a nudge, not a payload.** After a transaction that touched a workspace commits, the server
publishes `{type:'changes', workspaceId, seq}` on the existing `/api/events` socket, **only to sockets
that connected with `?feed=1`** (so the shipped web and Capacitor apps never see a type they don't
know), coalesced to at most one nudge per workspace per 100 ms. The client then pulls
`/changes?since=`. Reasons for "nudge then pull" over pushing entries:

- one place builds a filtered view (the endpoint), so push and pull cannot disagree about permissions
  or locked pages;
- a dropped nudge costs nothing: the client also pulls on connect, on app foreground and every few
  minutes, and the in-memory buffer and `BOOT` id stop mattering for these clients.

The old events keep flowing unchanged to everyone else. The feed adds a second, durable channel
beside them; it does not replace the hub (the web can move later, M10).

**Comments, tags, teams, members** are plain extra kinds, so "refetch on `comments`/`tags`/`teams`/
`members` event" turns into one mechanism for all of them. Thread entries are visible only to people
who can open the page (`pageAccess`), computed at answer time, and withheld while a page is locked
(see below).

### 3.3 Locked pages, permissions, losing access

Rules, each enforced where the answer is built (the `changes` handler runs inside
`runAsViewer({userId, sid})`, as `forSocket` does, so `lockOpen` sees this sign-in):

1. **Content never travels in the feed.** `page` entries carry what `GET /tree` carries today: for
   the owner of a locked page, its title, icon and `locked: true`; for everyone else, nothing (the
   tree query already excludes `locked_by != me`, and the feed reuses that predicate).
2. **Tasks on a locked page** are served through `viewTasks` (`server/locks.ts`): "Locked task", no
   description, no tags, `locked: true`, unless this sign-in has unlocked. Tasks on someone else's
   locked page are not visible at all (`TASK_VISIBLE`) and so are skipped.
3. **Threads** on a locked page are withheld unless unlocked (matches the hub's current rule), and
   when they would be withheld the entry is skipped without a tombstone.
4. **Locking and unlocking change what the same entry says, not whether it exists.** The `locked_by`
   column is in the page trigger's column list, and `republishTasks` today re-publishes the tasks on
   the page; the trigger on `tasks` is not fired by a lock (no task row changes), so `lockPage`
   and `removeLock` must additionally touch the page's tasks (a one-line `UPDATE tasks SET
   updated_at = updated_at WHERE page_id = ?`, which fires the trigger without changing data). On
   unlock/relock (the `lock_unlocks` rows, no data change) the client's view of locked tasks changes
   with no entry: the core must refetch tasks on page when the user unlocks or relocks, as the web
   does today. **(unsure)** whether this needs a feed entry of kind `access` per user; I think not.
5. **Visibility changes that are not row changes** (a member removed, a private notebook shared or
   un-shared, a page share added or removed, `notebooks.visibility` flipped, `private_owner_only`
   flipped) write one `access` entry for the workspace. A client that pulls over an `access` entry
   gets `reconcile: true` and does a full resync of that workspace, the same as `cursor_too_old`. These
   events are rare, so full resync is acceptable and it avoids having to tell people which ids they
   lost (which would itself leak ids). It reuses the existing `accessChanged()` hook points
   (`server/access.ts`), which already mark "permissions changed".
6. **Losing access mid-feed.** The next request gets 403/404 (the workspace check runs on every call)
   and the client forgets that workspace's data. The in-flight page of a paginated pull was already
   filtered at its own request time, so at worst it contains records the user could see a moment ago.
   The push nudge goes only to current members (`membersOf`), as events do now.
7. **Page-share holders outside the workspace** (people who see one page and its tasks without being
   members) are not served by `/workspaces/:id/changes` (it requires `requireRole(…,'viewer')`).
   They keep today's `shared-pages` event and refetch. Open question 3.
8. **The store stays honest too:** the core's `nv-store` already refuses documents of locked pages and
   drops them when a tree marks a page locked; the feed does not change that rule.

### 3.4 C: offline task edits (`POST /api/workspaces/:id/task-ops`)

**Request.** The client sends its queue in order, in one request:

```jsonc
{ "ops": [
  { "opId": "uuid", "type": "create", "task": { /* id = client uuid, plus fields, as POST /tasks */ } },
  { "opId": "uuid", "type": "update", "taskId": "…", "patch": { "title": "B" }, "was": { "title": "A" },
    "at": "2026-11-22T10:00:00Z" },
  { "opId": "uuid", "type": "delete", "taskId": "…" }
] }
```

**Response**, one result per op, same order:

```jsonc
{ "results": [
  { "opId": "…", "status": "applied",   "task": { /* Task after, redacted if locked */ } },
  { "opId": "…", "status": "duplicate", "task": { … } },                                  // seen this opId before
  { "opId": "…", "status": "conflict",  "applied": ["priority"],
    "conflicts": [ { "field": "title", "yours": "B", "current": "C" } ], "task": { … } },
  { "opId": "…", "status": "rejected",  "code": 403, "message": "…" },                    // as the REST route would
  { "opId": "…", "status": "gone" },                                                        // task no longer exists
  { "opId": "…", "status": "skipped",   "reason": "create_failed" }                         // depends on a failed op
] }
```

**Idempotency.** `opId` is stored in a new table `task_op_log (op_id PRIMARY KEY, user_id, task_id,
result_json, at)` in the same transaction as the op, and kept 30 days. A repeated `opId` from the same
user returns its stored result with status `duplicate`, so a lost response cannot apply an op twice.
This fixes G-H (the retried tick of a repeating task) for this endpoint. The existing PATCH route is
left as is; the core uses the new endpoint when the server advertises it, otherwise today's path.
Creates stay doubly safe (client id, `createTask` is already idempotent).

**Conflict rule: field-level, "first to reach the server wins unless the client's base is current".**

For each field in `patch`, with `was[field]` = what the client's copy held when the edit was made:

| Server's current value | Result for that field |
|---|---|
| equals `was` | apply `patch` value |
| equals the new value | nothing to do, counts as applied |
| anything else | **not applied**; reported in `conflicts` with `yours` and `current` |

Fields with no `was` (an old client, or a new one that does not care) behave as today:
last writer wins. Fields in one op are decided independently, so `applied` and `conflicts` can both be
present; the server applies the non-conflicting part through the existing `updateTask` (so all its
validation, permission and cascade rules are reused) inside one transaction. Reasons for this rule over
timestamps: it needs no trust in device clocks, it is deterministic, and conflicts are rare (the same
field of the same task changed on two devices while one was offline). The cost is that the edit made
*later* in wall-clock time can lose to an *earlier* one that reached the server first. The user sees it
(below), and nothing is silently overwritten, which is the property that matters.

Per field:

- **`status` and `dueDate` on repeating tasks** carry the occurrence they apply to: for a tick,
  `was: { "dueDate": "2026-11-23" }`. If the task's `dueDate` is no longer that date, someone already
  completed that occurrence: result `conflict` with reason `already_completed`, the task is **not**
  rolled again. Two devices ticking the same occurrence offline therefore produce one history row, and
  a retry never skips an occurrence (G-H). A tick of a non-repeating task whose `status` is already
  `done` is simply `applied` (no change).
- **`completedAt`**: the history row's time is the client's `at` if it is within the last 30 days and
  not in the future, otherwise server time. This puts "ticked at 10:00 offline" in the history at
  10:00, not at sync time. Whether to trust the client clock at all is open question 5.
- **`tagIds`** are sent as `{ add: [...], remove: [...] }` in this endpoint, merged against the
  current set, so two devices adding different tags both win. (`was` is not used for it.)
- **`description`**: a text conflict is reported, not merged. A later improvement can run a three-way
  text merge using `was` as the base; non-goal for M7.
- **Assignee, team, page, parent** follow the table; `checkAssignee` and the page/subtask rules in
  `updateTask` still apply and can turn into `rejected`.

**Order and dependencies.** Ops run in the order sent, each in its own transaction. A failed `create`
makes later ops on that task `skipped`. A `delete` of a task another device already deleted is
`applied` (nothing to do). An `update` of a deleted task is `gone`: the client drops it and shows it.
An `update` that the user may no longer make (viewer, lost page access) is `rejected` with the same
code and message the REST route would give.

**Recurrence roll-forward, who computes what.** The server stays the authority: it writes the history
row and the next `dueDate`/`reminderAt` (`updateTask`, unchanged). The core also shows the roll
immediately while offline, using `crates/nv-core/src/recurrence.rs` (`step_after` already exists) so
the user sees the task move to its next date, not just a tick. When the batch result arrives, the
server's task replaces the local guess. If the guess and the server differ (a different time zone,
`nextDueDate` uses the completing user's zone in `server/tasks.ts`), the server wins. **(unsure)**
whether `step_after` matches `nextDueDate` for every rule (end dates, counts, nth weekdays); the corpus
should cover it before it is relied on.

**What the client sees afterwards** is the task in the result (applied to its store at once) and the
same task again through the feed (the later `seq` wins; applying twice is harmless).

### 3.5 Schema changes, indexes, cost

Migrations (numbers are reserved per PR in this repo, `server/db.ts`; next free is 024):

| Migration | Contents | Cost |
|---|---|---|
| `page-update-log` | `page_updates` + index; `pages.log_upto` | DDL only; no row rewrite; table empty at rest |
| `change-feed` | `feed_state` (+ one row per existing workspace, `epoch` random), `changes` + index, triggers on 12 tables | DDL only; workspaces count rows inserted; no backfill |
| `task-op-log` | `task_op_log` + index on `at` | DDL only |

Per-write cost with the feed on: two extra small writes (counter bump, upsert) per changed record,
in the same transaction. Hot cases: a page save is one per `persistNow` (every 1 to 5 s per active
page); typing also touches the page entry per logged update, but they all hit the same row
(`ON CONFLICT DO UPDATE`), one indexed write each. No coalescing is planned for the first version
**(unsure; measure)**. A mass operation (purging a notebook with 5,000 pages) does 5,000 tombstone
writes inside its existing transaction. Read side: one range scan plus batched fetches.

Forward-only: nothing here has a down migration (the repo's migration runner has none). Rollback is
the flags in section 3.6; the tables stay, unused.

### 3.6 Backwards compatibility and flags

- **Web, Capacitor/iOS 1.x, Mac:** untouched. They never call `/changes` or `/task-ops`, never ask for
  `?feed=1`, and the write routes behave identically (triggers are invisible to them). Receipts behave
  identically; they are just durable.
- **Flags** (environment, read at boot; per-user via an allow-list env var for the feed endpoints so
  the owner can enable the core's own account first):
  - `PAGE_UPDATE_LOG=1`: write and recover the log. Off: current behaviour exactly.
  - `CHANGE_FEED=1`: serve `/changes`, send nudges. Triggers always write once migrated (cheap, and
    avoids a gap when switching on); off means the endpoint 404s.
  - `TASK_OPS=1`: serve `/task-ops`.
- **Discovery:** `GET /api/health` returns `{ok, version}`. Add `features: ["page-log","changes","task-ops"]`
  (additive, no auth, still a one-line change) so the core decides at launch which path to use and
  falls back to today's REST path against an old server (self-hosted servers will lag). Without it
  the core would have to probe and cache a 404.
- **Mixed-version clients and the page log:** none needed; the log is server-internal.

## 4. Client side (the core)

### 4.1 nv-api

New calls: `changes(workspace_id, since, limit) -> ChangesPage` (typed `Change { seq, kind, id, op,
data: serde_json::Value }`; 410 maps to `ApiError::CursorTooOld`), `head(workspace_id)`,
`task_ops(workspace_id, ops) -> Vec<OpResult>`, and `features()` from health. No existing call changes.

### 4.2 nv-store (schema 4, one `UPGRADES` step)

```sql
CREATE TABLE feed (workspace_id TEXT PRIMARY KEY, cursor TEXT NOT NULL, synced_at INTEGER NOT NULL);
CREATE TABLE records (                      -- kinds the store did not hold: thread, member, tag, team, view
  workspace_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  scope TEXT,                               -- thread: its page id (for cachedPageComments)
  json TEXT NOT NULL, PRIMARY KEY (workspace_id, kind, id));
CREATE INDEX records_scope ON records (workspace_id, kind, scope);
ALTER TABLE task_ops ADD COLUMN op_id TEXT;        -- uuid, stable across retries
ALTER TABLE task_ops ADD COLUMN was TEXT;          -- JSON: the base values of the patched fields
CREATE TABLE task_conflicts (seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL);   -- until the user dismisses it
```

`nodes` and `tasks` keep their shape: applying a `notebook`/`section`/`page`/`task` entry is an
upsert of that row, `remove` a delete. **Applying a page of changes and advancing `feed.cursor` is one
transaction**, so a crash leaves the cursor and the data consistent (the cursor never runs ahead of
what is stored). On `cursor_too_old` / `epoch_changed` / `reconcile`, the core runs today's full
fetches and replaces the workspace's rows (existing `put_tree`, `put_tasks`, plus the new kinds) and
sets the cursor from the `head` it read first. `signOut` and an account switch clear `feed` with the
rest. The locked-page rule (`is_locked`, no docs for locked pages) is unchanged. `task_ops` rows
queued by an older app version have no `op_id`; the sender generates one when it first sends.

### 4.3 nv-sync

- New `events.rs`: a small `/api/events?feed=1` client reusing `open_socket`, `Backoff` and the
  `Session` trait that `LiveDoc` already uses. It only needs to hear `changes` nudges (and `hello`).
- New `feed.rs`: `FeedSync` per signed-in account, one worker thread, for each stored workspace:
  `pull()` loops `changes(since)` while `hasMore`, applies each page to the store in one transaction
  (through a `FeedSink` trait implemented by `nv-core`, like `Outbox`), advances the cursor, then
  tells listeners. It runs on: start, every nudge, reconnect, app foreground (core call
  `Core.refresh()`), and a 5-minute timer as a backstop. A 403/404 for a workspace forgets it locally.
  Backoff, token refresh and close behave as in `live.rs`.
- Receipt semantics for pages are unchanged. The core's docs gain one sentence: with a server that
  advertises `page-log`, a receipt is durable. Against an older server the core keeps confirmed
  updates a little longer (proposal: retain for 30 s after the receipt before deleting) as a cheap
  hedge for the tiny window while the server is old. **(unsure)** that this is worth the code; it is
  optional.

### 4.4 nv-core and the Core API

Changes apple will see (all additions):

```swift
core.syncState(workspaceId:) -> SyncState      // .upToDate(at) / .catchingUp / .offline / .resyncing, pending task ops, cursor age
core.refresh(workspaceId:) throws              // pull now (foreground, pull-to-refresh); no-op offline
core.subscribe(workspaceId:, scope: ChangeScope, listener: ChangeListener) -> Subscription
//   ChangeScope: .tree, .tasks, .comments(pageId:), .members, .tags, .teams, .views, .syncState
//   ChangeListener.onChange(scope:)   "this scope changed in the store; re-read the cached* call"
core.cachedPageComments(pageId:) -> [CommentThread]?      // new: from `records`
core.cachedMembers(workspaceId:), cachedTags(...), cachedTeams(...)     // new
core.taskConflicts() -> [TaskConflict]; core.dismissTaskConflict(id:)    // replaces the dropped-op line in taskError()
```

Rules for the screens (the point of G4): a screen reads `cached*` (instant), subscribes to its scope,
and never waits on the network. The existing paired calls (`tasks()`, `tree()`, `pageComments()`)
keep working unchanged and become "pull now, then return the stored copy". Notifications are
coarse by design (one scope-changed callback, the screen re-reads); this is cheaper to keep correct
than diffs across Swift, Kotlin and C#. They fire from the feed sink after each committed page, and
also for the core's own optimistic writes, so a screen needs only one code path. `ChangeListener`
callbacks run on a core thread with no core locks held (same rule as `PageListener` and the
`RemoteHook`s), so apple hops to the main thread itself.

Task queue changes: `send_task_changes` sends the stored queue through `task_ops` when the server
advertises it, with `op_id` and `was` filled in at queue time (the `was` values are the stored task's
values when the op is queued, which is exactly "the client's base"); applies each `OpResult` to the
store (`applied`/`duplicate`: replace the task; `conflict`: replace with `current`, record a
`task_conflicts` row and notify; `gone`: remove the task and the rest of its queued ops;
`rejected`: drop and record; `skipped`: drop). The optimistic local application (`apply_locally`)
stays; it gains the local recurrence roll. Merging a queued create with a queued delete of the same
task (known gap) becomes possible and is cheap: cancel both before sending.

## 5. Rollout plan

Each step is its own PR to `main` (server) and needs the owner's OK before it is opened and before it
is merged and tagged; the core steps live on `rewrite/*` and wait for the matching server release to
be live. Every step is shippable alone and leaves the web unchanged.

| # | PR | Ship | Must be tested before merge |
|---|---|---|---|
| 1 | **Page update log** (3.1), behind `PAGE_UPDATE_LOG` | flag off in prod first, then on for a day, watch `/admin/metrics` | Unit: update is in `page_updates` before the step-2 reply is sent; compaction deletes exactly the folded rows; page delete cascades; deleting page while open does not crash. Crash test: start server, send updates over a real socket, `kill -9` immediately after the receipt, restart, assert the content is in `pages.ydoc`, text/FTS updated and (if attribution lands) tasks attached. Existing `tests/` collab suite green with flag on and off. Measure `applyMs` and `saveMs` before/after |
| 2 | **Health `features`** (tiny) | with 1 | health test |
| 3 | **Change feed: migration, triggers, `GET /changes`**, flag `CHANGE_FEED` | endpoint on for the owner's account only at first | Trigger tests per table (insert, update, delete, trash, restore, purge, FK cascade and SET NULL: settles the open "do cascades fire triggers" question); the route-walking test (every write route moves the head); redaction tests (locked task redacted, locked page invisible to others and title visible to owner, comments withheld while locked, audience-scoped tombstones, member removed gets 403, `access` entry gives `reconcile`); pagination with filtered-out entries; `cursor_too_old` after tombstone GC; bootstrap race (writes between head and fetch). Full existing test suite with triggers on. Size and timing numbers on a copy of the production DB |
| 4 | **Push nudge** `?feed=1` | with 3 | web socket test: a socket without `feed=1` receives no `changes`; coalescing; nudge reaches only members |
| 5 | **Task ops** `POST /task-ops` + `task_op_log` | after 3 | per-field matrix (equal/new/other), tick of a repeating task twice (second is `duplicate` by opId; second device is `conflict already_completed`), create then delete in one batch, delete vs. concurrent edit, `rejected` parity with REST for viewer/locked/page-share cases, tag add/remove merge, 30-day log GC |
| 6 | **Core: nv-api, nv-store schema 4, `FeedSync`, task queue via `task-ops`, Core API additions** | on `rewrite/*`, tested against the real server (`NV_TEST_SERVER`, per the handover) | store upgrade from v3 (`task_ops` rows keep working), crash-between-apply-and-cursor test, offline week with a stand-in server, listener tests, fallback to the old path against a server without `features` |
| 7 | **Apple screens on `cached*` + `subscribe`** | TestFlight 1.99.x as allowed | on-device manual pass (owner's gate) |
| 8 | **Soak test** (below) in CI nightly, then the exit run | | the exit criterion |

Order notes: 1 is independent and is the one the owner may want soonest (it fixes a real loss window
for today's clients too). 3 and 5 can be built in parallel; 5 does not need the feed. Android and
Windows reuse step 6 as is.

### The soak test (M7's exit criterion)

**What it is.** A seeded, replayable simulation that runs real clients against a real server for a long
time while faults are injected, and then checks invariants. Lives in `tests/soak/` (driver) and uses
the core's test binary for native clients and Node `yjs` for a web-like client.

- **Cast:** one server (`server/index.ts` with a scratch `DATA_DIR`), behind a fault proxy; 2 users in
  one workspace plus one outside viewer; per user 2 to 3 clients: two core clients (separate stores)
  and one web-like client; one user with a locked page.
- **Workload (seeded RNG, every action logged with its seed and step number):** typing and pasting
  into shared pages from several clients at once; create, tick, edit, move, delete tasks including
  repeating ones and subtasks; comment threads; rename and move in the tree; tag and team edits; lock
  and unlock; member removed and re-added; version restores.
- **Faults:** clients go offline for random periods (seconds to simulated days, using a server clock
  offset to age tombstones past the floor on demand); the proxy drops and delays connections and
  truncates responses (to make lost-response retries); the server is `kill -9`'d at random times and
  restarted (also with a deploy-style restart); access tokens expire; a client's app is "killed" and
  restarted from its store at random.
- **Invariants, checked after a quiet period (everyone online, feed drained):**
  1. **Convergence:** each client's store equals what the server serves that user (tree, tasks,
     threads, members, tags) and every page's text hash is the same everywhere.
  2. **No acknowledged loss:** every page update that a client received a receipt for appears in the
     final doc, including those followed by a `kill -9` (this is the check that fails today).
  3. **Tasks:** no duplicates; no lost task unless deleted; a repeating task has exactly one history
     row per distinct completed occurrence, however many devices and retries; no task op applied twice.
  4. **Conflicts are visible:** every `conflict` result produces a `task_conflicts` row; no queued op
     disappears without a result.
  5. **Locked data:** scan every byte of every feed response, event and store row seen by a user other
     than the owner for locked titles, locked text, locked task titles and locked comments: zero hits.
     The owner's store holds no locked page doc and no unredacted locked task while locked.
  6. **Cursor behaviour:** cursors only move forward; `cursor_too_old` occurs only past the floor;
     a full resync leaves the same state as catching up would have.
  7. **Budgets:** catching up after 7 simulated days with about 10,000 changes takes under N seconds
     and transfers under M MB (N and M set from the first runs and then held); `applyMs` p99 and
     DB growth per hour stay inside limits.
- **Runs:** a 10-minute seeded run on every PR touching `server/` or `crates/nv-sync|nv-store|nv-core`
  (CI); a 6-hour run nightly with fresh seeds; and for M7's exit, **three consecutive green nightlies
  with a "week offline" scenario included**, plus the owner using the TestFlight build with
  flight-mode edits for real. Any failure prints its seed so the run replays exactly.

## 6. Open questions and risks (for the owner)

1. **Triggers or explicit `touch()` calls?** I recommend triggers (nothing can be forgotten, atomic
   with the write) guarded by a test that walks every write route. The risk is that a trigger bug
   breaks all writes and the migration cannot be turned off at runtime. The alternative is flaggable
   but easy to miss in new code. Your call.
2. **Durability bar for an acknowledgement.** Process crash (today's SQLite setting, nothing to
   change) or power loss too (`synchronous=FULL`, an fsync per commit, to be measured)? Recommended:
   ship with the default, measure on the homelab disk, then decide.
3. **People with only a page share (not in the workspace).** The feed is per workspace and for
   members. Page-share holders keep the old `shared-pages` event and refetch. Is that acceptable for
   M7, with a per-user feed as a later step?
4. **Conflict rule.** Proposed: per field, "first to reach the server wins when the client's base is
   stale", conflicts shown to the user. The alternative is "the later edit wins" using client
   timestamps. I prefer the first (no clock trust, nothing overwritten silently). Confirm.
5. **Trusting the device clock for history.** Should an offline tick record the device's time as
   `completedAt` (clamped to the last 30 days and not in the future), or the time it reached the
   server? The first is more truthful to the user; the second is simpler and can't be gamed.
6. **Tombstone retention:** 90 days (clients offline longer do a full resync). Is that right next to
   the 60-day Trash, or do you want to allow longer for devices left in a drawer?
7. **Page-attribution loss on crash recovery** (3.1): accept "a task reference inserted in the last
   seconds before a crash may not attach" for the first PR, or require exact replay?
8. **Production size.** I do not know the production row counts or DB size, so the feed's size and the
   trigger cost are estimates. Step 3 logs counts; I would like a copy of the DB (or the counts) to
   check them before enabling the flag.
9. **Self-hosted servers** will lag behind. The core falls back to today's REST path without
   `features`; is there any policy on how long that fallback has to live?
10. **Web migration.** The design lets the web adopt the feed in M10 (WASM core). Until then web and
    native use different mechanisms for the same data. Fine, but worth saying out loud.

Risks, in order of how much they worry me: (a) a trigger or migration mistake on the production DB
(mitigated by flags on the endpoints, the full-suite run, and trying the migration on a copy first);
(b) write-amplification surprises on very active pages (measure in step 1 and 3); (c) a permission edge
case that lets a feed answer reveal more than the tree does today (mitigated by reusing the exact
visibility predicates and by soak invariant 5); (d) the core's optimistic recurrence roll disagreeing
with the server (the server always wins; the corpus should cover it).
