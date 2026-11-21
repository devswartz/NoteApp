# core stream: status and handover

The **core** stream owns `crates/` (except `crates/nv-editor`), `tests/corpus/`, `scripts/corpus/`
and the Rust parts of CI. The overseeing session folds this file into `docs/rewrite/STATUS.md`.

## Now

- **nv-store done** on branch `rewrite/core-store`, ready to merge: the on-device SQLite store and
  a cached-first Core API (notes for apple below).
- **Next, in order** (for a fresh session; see the handover below): `nv-sync` robustness (its
  offline queue can live in nv-store now), then Kotlin bindings with an Android build in CI.

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
  `offlineCache.ts`). A schema change: bump `SCHEMA_VERSION` and append a step to `UPGRADES`.
  Not stored yet: trashed pages (nv-api's `Tree` has no `trashedPages`, so their docs are pruned),
  members, tags. A live page isn't seeded from the stored copy when it opens (merging an old copy
  could bring back content a version restore removed); `cachedPageDocument` is for showing a page
  read-only while offline.
- **nv-sync robustness.** Reconnect with exponential backoff (as `backoffMs` in src/api.ts: about
  1 s doubling to 30 s, with jitter); on 4401, refresh the token through the `Core` and reconnect;
  on 4403, stop. Queue local updates while offline (in nv-store once it exists) and send them after
  the sync handshake. Switch TLS to the system trust store (`rustls-platform-verifier`) for
  both ureq (its `platform-verifier` feature) and the socket.
- **Kotlin and Android.** uniffi's Kotlin from the same library (`--language kotlin`), plus
  `cargo-ndk` for `aarch64-linux-android`, `armv7-linux-androideabi` and `x86_64-linux-android`
  in a Linux job.
- **Known gaps.** The static library is about 44 MB per slice before linking; nobody has
  measured the linked size against the 10 MB budget yet. The corpus records today's quirks
  (mentions and page links missing from Markdown; page links missing from the search text).
