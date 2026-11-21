# core stream: status and handover

The **core** stream owns `crates/` (except `crates/nv-editor`), `tests/corpus/`, `scripts/corpus/`
and the Rust parts of CI. The overseeing session folds this file into `docs/rewrite/STATUS.md`.

## Now

- **nv-sync robustness done** on branch `rewrite/core-sync`, ready to merge: live pages reconnect
  by themselves (backoff, 4401 refresh, 4403 stop), keep local edits until the server has them
  (in the store, across restarts), connect without blocking (`openLivePage`), and TLS uses the
  system's trust store. Notes for apple below ("For apple: live pages").
- **Next, in order** (for a fresh session; see the handover below): the editor stream's requests
  in `docs/rewrite/status/editor.md` (share the live doc with `EditorSession`; the public fragment
  reader in nv-model), then Kotlin bindings with an Android build in CI (including the platform
  verifier's Android init, below), then the CHANGELOG-SYNC.md design.

## For apple: live pages (2026-11-21, `rewrite/core-sync`)

All additions; nothing was renamed, so today's Swift compiles unchanged.

- **New: `Core.openLivePage(pageId:listener: LivePageListener) throws -> LivePage`.** Returns at
  once (it throws only for a server URL that can't be used): the page connects on its own thread
  and reports through `LivePageListener { onStatus(status: LiveStatus); onChange(page: PageInfo) }`
  (called on that thread; hop to the main thread). It stays in sync until `close()`:
  - `LiveStatus.connecting(attempt:)`: opening the socket (attempt 0 the first time, else how
    many tries in a row failed).
  - `.connected`: socket open, waiting for the server's copy.
  - `.synced`: up to date; edits flow; queued edits have been sent. Heard once per connection.
  - `.reconnecting(attempt:inMs:code:reason:)`: not connected; the core tries again by itself in
    `inMs` ms (0 = at once, after refreshing the session on a 4401). `attempt` counts from 1 and
    starts again after a sync; `code` is the server's close code (nil: network). Delays: 1 s
    doubling to 30 s, times 0.75–1.25 (as the web app). Show "Offline, reconnecting…"; nothing to do.
  - `.ended(reason:message:)`, always the last status, no more reconnecting:
    `LiveEnd.closed` (you called `close()`), `.noAccess` (4403: locked, deleted or unshared; the
    stored copy and queued edits are deleted), `.signedOut` (the refresh token was rejected:
    end the session as for `CoreError.SignedOut`).
  - 4401 (token expired) is handled inside: the core refreshes through the same session (one
    refresh at a time across threads; the refresh token rotates, so store `refreshToken()` again
    when you next touch the keychain) and reconnects at once, up to 3 times in a row, then with
    the usual delays.
- **So apple can drop its reopen loop** (`retryLater`, `attempts`, the 4401 reopen and the
  `dropConnection` on `Failed`/`Closed`): open once with `openLivePage`, map the statuses to the
  badge, end on `.ended`, call `close()` when the page leaves the screen. `close()` returns at once
  while waiting to reconnect, and within about 1 s if a connect is hanging (the thread then
  finishes on its own, silently); keep calling it off the main thread to be safe.
- **`Core.openPage` still works** and its `SyncStatus` is unchanged, but it now reconnects by
  itself as well: a drop is reported as `.failed(message)` (network) or `.closed(code, reason)`
  (the server's code, e.g. 1012 or 4401 while it refreshes), and is followed by `.connected` /
  `.synced` again; the end is `.closed` 1000 (closed), 4403 (no access) or 4401 (signed out).
  Today's loop (close on `Failed`/`Closed`, reopen) keeps working on top of that; it is just no
  longer needed. `openPage` still blocks for the first connect.
- **Local edits are kept until the server has them.** `LivePage.applyUpdate` (and the editor
  session later) edits go into a queue that is saved in the store (new table, schema 2), sent once
  the sync handshake is done (again after each reconnect) and removed when the server's receipt
  comes back. Opening a page with queued edits (e.g. after a restart while offline) applies them to
  the document and sends them. New: `LivePage.unsentUpdates() -> UInt32` (0 = all on the server)
  and `Core.unsentPages() -> [String]` (pages with edits not yet sent; for an "unsynced" mark).
  Locked pages and pages not in a stored tree keep edits in memory only; sign-out clears them.
- **Store rule change:** a page's document (and its queued edits) is stored only when a stored
  tree shows the page unlocked. Before, a page no tree had shown yet was stored; it might have
  been a locked one. Apple loads the tree before opening pages, so nothing changes in practice.
- **New: `Core.storeError() -> String?`**, the last store write that failed (the store is a cache,
  so calls carry on), also printed to stderr as `[nv-store] write failed: …`. For diagnostics.
- **TLS now uses the system's trust store and checks** (Security.framework through
  `rustls-platform-verifier`) instead of a bundled Mozilla root list, for HTTP and the collab
  socket. So a user-installed or MDM root works, and revocation follows the system. The
  NotiveloCore package now links `Security` and `CoreFoundation` (in its `Package.swift`).
  Apple's guidance is not to evaluate trust on the main thread; all TLS happens inside network
  calls, which apple already makes off the main thread.

### Answers to apple's requests

- **Is `Core.openPage` blocking? Which calls are safe concurrently?** `openPage` blocks for the
  first connect (up to about 10 s per step when the network hangs); `openLivePage` doesn't. Every
  `Core` and `LivePage` call is safe from several threads at once, so apple can use a concurrent
  queue: the session's tokens are behind a mutex and refreshes are serialised (when several
  calls find the token stale at once, one refreshes and the others use its token; refresh tokens
  are never spent twice), HTTP goes through one thread-safe ureq agent (each call blocks only its
  own thread), and the store serialises its reads and writes behind its own mutex (WAL mode;
  each write is one short transaction). What blocks: every server call (sign-in, `workspaces()`,
  `tree`, `tasks`, `pageDocument`, task writes; GETs retry up to 3 times on network errors),
  `openPage`, and `signOut` (it revokes the session on the server). Instant: the `cached*` reads,
  `hasStore`, `user`, `refreshToken`, `unsentPages`, `storeError`, `openLivePage`, and the
  `LivePage` calls (`info`, `document`, `applyUpdate`, `presence`, `announcePresence`,
  `unsentUpdates`); `LivePage.close()` as above. One ordering note: `signOut` while pages are open
  should close them first (their threads would otherwise end with `.signedOut` on their next
  refresh, which is harmless).
- **Unlocking locked pages in the Core API** (not built; low priority). What it would take:
  - Server (server/routes/locks.ts, read only): `GET /locked-notes` (status), `POST
    /locked-notes/unlock` with `{ password }` or `{ deviceId, secret }` → `{ expiresAt }` (rate
    limited), `POST /locked-notes/lock`, `POST /locked-notes/keepalive`, `POST
    /locked-notes/devices` `{ label }` → `{ id, secret }` (only while unlocked; for Face ID /
    Touch ID), `DELETE /locked-notes/devices/:id`. An unlock is per sign-in (the refresh-token
    family, `sid` in the access token) and lapses after idle time; typing on an unlocked page keeps
    it alive (the collab server does that itself every 30 s of activity).
  - Core: nv-api calls for those, and `Core.lockedNotesStatus()`, `unlockLockedNotes(password:)`,
    `unlockWithDevice(deviceId:secret:)`, `registerUnlockDevice(label:) -> {id, secret}` (apple keeps
    the secret in the keychain behind biometrics), `lockNow()`. Then `openLivePage` on a locked page
    works as for any page (the server lets the socket in for an unlocked sign-in).
  - Care needed: the store must keep refusing locked pages' documents (it does: the tree still
    marks them locked) and must not keep unredacted tasks: after an unlock `GET .../tasks` sends
    locked pages' task titles in full, which `tasks()` would store today. So tasks on locked pages
    would have to be redacted before storing (or not stored) while unlocked. Also relock on
    background/timeout like the web app (`lockNow`, and the server closes locked pages' sockets
    with 4403 when the unlock lapses, which now ends the page with `.noAccess` and drops its copy).
  - Roughly a day with tests against the real server.

## For apple: the on-device store (2026-11-21)

- Construct with `Core.withStore(serverUrl:dbPath:)`, e.g. a file in Application Support
  (excluded from backups). The folder is created if missing; a file that can't be read (damaged,
  or written by a newer app) is replaced by an empty one. `Core(serverUrl:)` still works and has
  no store (`hasStore()` is false, every `cached*` returns nil).
- Reads come in pairs. `cachedWorkspaces()`, `cachedTree(workspaceId:)`,
  `cachedTasks(workspaceId:)`, `cachedPageDocument(pageId:)` are local and instant (nil when
  nothing is stored; fine on the main thread). `workspaces()`, `tree(workspaceId:)`,
  `tasks(workspaceId:)`, `pageDocument(pageId:)` ask the server, store the answer, and when the
  server can't be reached (`CoreError.Network`) return the stored copy instead (they still throw
  when nothing is stored, and on `Server`/`SignedOut`). So: show the cached copy, then call the
  server one and show its answer.
- Offline launch: `restoreSession` throws `Network`; keep the refresh token and carry on: the
  network reads then fall back to the stored copies.
- `createTask` and `setTaskDone` update the stored tasks. `signOut()` clears the store; signing in
  as a different user clears it first.
- A `LivePage` saves its document to the store each time it is `Synced` and when it is closed; a
  `Closed(4403)` deletes the stored copy.
- Locked pages are never stored: a tree that marks a page locked deletes its stored document, and
  the store refuses to save one. Tasks on locked pages are stored as the server sent them
  (already redacted), as the web app does.

## For apple: box content (2026-11-21)

- `readPage(update:)` now returns `PageInfo.content: [BoxContent]`, and so does every
  `PageListener.onChange(page:)`. There's also `pageContent(update:) -> [BoxContent]` on its own;
  for a live page, use `livePage.info().content`.
- `BoxContent { boxId: String?, nodes: [ContentNode] }`: `default` first (`boxId == nil`, the old
  document column, usually empty), then each box in reading order (matching `PageInfo.boxes`).
- `ContentNode { kind: NodeKind, attrs: [Attr], runs: [TextRun], children: [ContentNode], markers: [String] }`:
  - `kind` is an enum of the editor's nodes (`.paragraph`, `.heading`, `.bulletList`,
    `.orderedList`, `.taskList`, `.taskItem`, `.taskRef`, `.callout`, `.details`, `.table`,
    `.image`, `.fileAttachment`, `.mention`, `.pageLink`, `.hardBreak`, …), `.text` for a text
    node, and `.unknown(name:)` for something a newer app wrote (show its children, or "update to
    see this").
  - `attrs` are the stored attributes (`level`, `checked`, `taskId`, `emoji`, `src`, …) as
    `AttrValue` (`.null`, `.bool`, `.number`, `.text`, `.json`).
  - `runs` (text nodes only): `TextRun { text, marks: [Mark] }` with `Mark` = `.bold`, `.italic`,
    `.underline`, `.strike`, `.code`, `.link(href:)`, `.textColor(color:)`,
    `.highlight(color: String?)` (nil = default yellow), `.comment(threadId:)`, `.unknown(name:)`.
  - `markers` (ordered lists only): each item's marker as exports number it ("1.", "b)", "iv."),
    with continued numbering already applied.
- The XCFramework now has an iOS simulator slice and a macOS slice that are both arm64 + x86_64,
  so Intel builds link. The iOS device slice is still arm64 only.

## Done

- 2026-11-21, nv-sync robustness (`rewrite/core-sync`): `LiveDoc` reconnects with backoff
  (injectable `Backoff`), refreshes on 4401 through a `Session` (`access_token_replacing` in nv-api,
  serialised refreshes), stops on 4403 / signed out, closes promptly; local edits queue until a
  receipt (a step 1 after sending, answered in order) with an `Outbox` in nv-store (schema 2,
  `outbox` table, upgrade step); `openLivePage` + `LiveStatus`/`LiveEnd`/`LivePageListener`;
  `openPage` kept (reconnects too, old statuses); `unsentUpdates`, `unsentPages`, `storeError`;
  store refuses docs and queued edits of pages not known unlocked; TLS through
  `rustls-platform-verifier` (ureq `platform-verifier`, own rustls config for the socket;
  webpki-roots gone). Tests: `crates/nv-sync/tests/sync.rs` (stand-in server in
  `tests/support`, shared with `crates/nv-core/tests/live.rs`): drops, 1012, backoff timing and
  reset, 4401 refresh, signed out, a refresh that keeps failing, 4403, close while waiting and
  while connecting, offline edits sent after reconnecting, queue restored into a new LiveDoc;
  Core-level: restart with the same store, 4401 through the Core, `NoAccess` forgetting the queue,
  locked pages in memory only, `openPage` mapping; nv-store: outbox, upgrade from version 1, failed
  writes; Swift `testALivePageWithoutASessionEnds`; the real-server test now also opens a page
  with `openLivePage` and waits for the receipt (passed locally against `server/index.ts`).

- 2026-11-21, nv-store (`rewrite/core-store`): `crates/nv-store` (rusqlite bundled; records as
  JSON columns; `schema_version` 1 with an `UPGRADES` list; locked pages never stored; pruning as
  `prunePageCaches`), `Core::with_store` and the `cached_*` reads in `client.rs`, a non-exported
  `Core::with_transport` for tests. Tests: nv-store unit tests, `crates/nv-core/tests/store.rs`
  (scripted transport: cached-first, offline fallback, locked pages, sign-out, offline launch),
  LivePage save tests in `client.rs`, the Swift `testCoreWithAStore`.
- 2026-11-21, M4 step 1 (`rewrite/core-m4`): `crates/nv-core/src/content.rs`, tests in
  `crates/nv-core/tests/api.rs` and the Swift `testBoxContent`; `build-xcframework.sh` uses
  `lipo` for the simulator and macOS slices and now runs `rustup target add` for its own targets (so apple-native.yml needs no change); rust.yml and apple-native.yml are both green on it.
- 2026-11-21, M3 (`rewrite/core-m3`, merged): `nv-api`, `nv-sync`, the online Core API, `rewrite.yml`.
- 2026-11-21, M1 (`rewrite/core-m1`, merged): corpus, `nv-model`, `nv-core` + XCFramework.

## Handover (for the next core session)

The context of the session that did M1–M4 step 1 is large, so the next steps should start
fresh. What they need to know:

- **Layout.** `nv-model` reads a page into an owned `Page` (fragments as `tree::Node`) and must
  keep passing `tests/corpus` (`crates/nv-model/tests/corpus.rs`). `nv-api::Client` is blocking
  (ureq + rustls/ring) behind a `Transport` trait, so unit tests use a scripted transport.
  `nv-sync` has `protocol::SyncDoc` (no I/O, unit-tested) and `live::LiveDoc` (a socket thread;
  local edits are found by a keyed `observe_update_v1`; remote ones carry the origin
  `REMOTE_ORIGIN`). `nv-core` holds the uniffi types: `lib.rs` (page reading), `content.rs`
  (box content) and `client.rs` (`Core`, `LivePage`, `PageListener`).
- **Docs.** Create them with `nv_model::new_doc()` (UTF-16 offsets, like Yjs in JS). yrs has
  the `sync` feature on (nv-sync turns it on), so docs and observers are Send + Sync.
- **Tests against the real server.** Start it with
  `PORT=4417 DATA_DIR=<scratch> JWT_SECRET=<32+ chars> GIT_SHA=core-test SIGNUP_MODE=open npx tsx server/index.ts`,
  then `NV_TEST_SERVER=http://127.0.0.1:4417 cargo test -p nv-core --test server`. Stop it
  afterwards (on Windows: find the PID listening on 4417 with `netstat -ano`, then `taskkill /F /T`).
- **nv-store (done).** `Store` (one account; `Mutex<Connection>`, shared as `Arc<Store>` by the
  `Core` and its `LivePage`s). Store write errors are ignored by the Core (fail soft, like
  `offlineCache.ts`) but kept in `Store::last_error` and printed to stderr. A schema change: bump
  `SCHEMA_VERSION` and append a step to `UPGRADES` (now at 2: the `outbox`). Page documents and
  queued edits are stored only for pages a stored tree shows unlocked.
  Not stored yet: trashed pages (nv-api's `Tree` has no `trashedPages`, so their docs are pruned),
  members, tags. A live page isn't seeded from the stored copy when it opens (merging an old copy
  could bring back content a version restore removed); `cachedPageDocument` is for showing a page
  read-only while offline.
- **nv-sync (done).** `live.rs`: one thread per page runs connect → `connection()` → back off,
  until `close()` (a `Condvar` wakes it; `close()` waits at most 1 s, then detaches a thread stuck
  connecting). Tokens come from a `Session` (the Core's: `access_token`, and
  `access_token_replacing(rejected)` after a 4401). Local edits: the doc observer pushes to
  `Inner::fresh`; the thread moves them into its queue and the `Outbox` (the Core's
  `StoreOutbox`), sends them after the first step 2 of each connection, then sends a step 1 as a
  receipt (at most every 500 ms) and confirms everything sent before it when its step 2 comes
  back (the server answers step 1s in order, after applying what came before). Restored edits are
  applied to the doc before the observer is registered. `protocol.rs` reports `doc_changed` only
  when an update changed something, so receipts don't trigger `on_change`. Statuses are in
  `nv_sync::Status`; the Core maps them to `LiveStatus` (new API) or `SyncStatus` (old). The
  stand-in server for tests is `crates/nv-sync/tests/support/mod.rs` (drop, kick with a code,
  offline, forbidden, token list).
- **TLS.** `rustls-platform-verifier` 0.7 for ureq (`rustls-no-provider` + `platform-verifier`,
  ring provider passed in `UreqTransport::default`) and the socket (`tls_config()` in live.rs).
  **Android:** the verifier needs initialising from the JVM before the first TLS connection
  (`rustls_platform_verifier::android::init_with_env(env, context)` called from JNI, plus the
  crate's Kotlin component on the classpath, its `rustls-platform-verifier-android` Maven
  artifact); without it the first connection fails. To do with the Kotlin step. A fallback if that
  ever blocks a platform: `webpki-roots` behind a cfg for that target only.
- **Kotlin and Android.** uniffi's Kotlin from the same library (`--language kotlin`), plus
  `cargo-ndk` for `aarch64-linux-android`, `armv7-linux-androideabi` and `x86_64-linux-android`
  in a Linux job.
- **Known gaps.** The static library is about 44 MB per slice before linking; nobody has
  measured the linked size against the 10 MB budget yet. The corpus records today's quirks
  (mentions and page links missing from Markdown; page links missing from the search text).
