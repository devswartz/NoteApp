# core stream: status and handover

The **core** stream owns `crates/` (except `crates/nv-editor`), `tests/corpus/`, `scripts/corpus/`
and the Rust parts of CI. The overseeing session folds this file into `docs/rewrite/STATUS.md`.

## Now

- **M4 step 1 done** on branch `rewrite/core-m4`, ready to merge: box content in the Core API, and
  x86_64 slices in the XCFramework.
- **Next, in order** (for a fresh session; see the handover below): `nv-store`, then `nv-sync`
  robustness, then Kotlin bindings with an Android build in CI.

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

- 2026-11-21, M4 step 1 (`rewrite/core-m4`): `crates/nv-core/src/content.rs`, tests in
  `crates/nv-core/tests/api.rs` and the Swift `testBoxContent`; `build-xcframework.sh` uses
  `lipo` for the simulator and macOS slices; rust.yml installs the two x86_64 targets.
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
- **nv-store (next).** Add rusqlite with the `bundled` feature. Cache workspaces, tree, tasks and
  page docs. The `Core` reads cached-first, then refreshes from the server; `Core::new` will need a
  database path. Never store locked pages (`PageMeta.locked`, and `Task.locked` tasks as they come;
  today's rule is in `src/lib/pageCache.ts`). Check that rusqlite builds for iOS in the apple
  job.
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
