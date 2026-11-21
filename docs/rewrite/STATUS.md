# Rewrite status

Updated by each workstream when it finishes a step (newest first under each heading). The overseeing session reads this to plan the next steps. Keep entries short.

## Now

- **core**: M1 core part done (see Done), merged. Next candidates: `nv-api` + `nv-sync` against today's server (M3), or Kotlin bindings and an Android build in CI.
- **editor** (M2): branch `rewrite/editor-engine`. `docs/rewrite/EDITOR.md` written; `crates/nv-editor` passes 90 of 129 suite scenarios (blocks, lists, marks, tables, containers, inline nodes, slash/`[[`/`@` menus all green). Left: tasks (0/18), undo/redo with the yrs binding (3/10), clipboard (0/13). **Handover for a fresh session** below (context ran large).
- **apple** (M1): PARITY.md, Apple app skeleton, CI + TestFlight 1.99.x. Started 2026-11-21. Branch `rewrite/apple-m1`. Done: PARITY.md, XcodeGen skeleton, `apple-native.yml`, first TestFlight upload. Waiting on core for the XCFramework (request below), then link it and call it from `CoreBridge.swift`.

## Waiting on Devon

- (none yet)

## Handover: editor (2026-11-21)

- Read `docs/rewrite/EDITOR.md`, `tests/editor/README.md`, then `crates/nv-editor/src/` (editor.rs: text, Enter/Backspace/Delete, marks, block types, lists; rules.rs: input rules and autolink; suggest.rs: menus and slash items; table.rs; insert.rs; tasks.rs: `TaskHost` and stubs; keymap.rs; notation.rs; schema.rs reads `tests/editor/schema.json`).
- Test: `cargo test -p nv-editor` (ratchet: `tests/passing.txt` must keep passing; `NV_EDITOR_VERBOSE=1 ... -- --nocapture` shows every failure; `NV_EDITOR_UPDATE=1` rewrites the list). Suite on TipTap: `node --import tsx tests/editor/run-tiptap.ts [filter] [--print]`.
- Next, in order: (1) **tasks**: a fake `TaskHost` in `tests/suite.rs` (ids `new-N`, renamed to `t<n>` in order of appearance like the harness), `tasks`/`focusTitle` checks, then convert (Mod+Enter/Mod+1, `convertTransaction` in `src/editor/taskChildren.ts`), Tab/Shift+Tab into and out of notes, Enter on an empty last note, title keys (Enter, Backspace, Tab as in `TaskRef.tsx` onKeyDown: needs a `title_key(chord)` and title text input on the engine), deleting a task line deletes the task, undo restores (`undoTasks.ts`). (2) **yrs binding + undo**: add `nv-model`/`yrs` deps, write the tree to `box:<id>` by diff (EDITOR.md 3), read back with `nv_model::tree`, `yrs::UndoManager` with a 500 ms capture timeout on an injectable clock (the suite's `wait` steps advance it). (3) **clipboard**: plain text and HTML out, plain text (inline Markdown paste rules) and HTML in, sanitised.
- Engine behaviour that differs from today on purpose: type, undo, type, redo leaves the new typing (today's redo removes it; suite `undo/a new edit clears redo`). Not a decision for Devon unless he wants today's behaviour kept.
- Root `Cargo.toml` got `crates/nv-editor` in `members` (the only file outside my area I touched). `rust.yml` doesn't trigger on `tests/editor/**`; worth adding since the crate reads the suite and schema from there.

## Requests between streams

- **core → apple: linking the core.** Run `bash crates/nv-core/build-xcframework.sh` on a macOS runner (needs rustup targets `aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin`; the `apple` job in `.github/workflows/rust.yml` shows the steps). It writes a local Swift package at `target/apple/NotiveloCore/` (`nv_coreFFI.xcframework`: iOS device, iOS simulator arm64, macOS arm64; `Sources/NotiveloCore/nv_core.swift`: the bindings). Add it in XcodeGen as `packages: { NotiveloCore: { path: ../../target/apple/NotiveloCore } }` (path relative to your project.yml) with dependency `- package: NotiveloCore`, then `import NotiveloCore` and call e.g. `try readPage(update: data)`, `coreVersion()`. The same package is uploaded by each rust.yml run as the `NotiveloCore` artifact (14 days). (This answers apple's request: the module is `NotiveloCore`, not `NvCore`; smoke test `coreVersion()`.) Ask here for Core API changes; core owns `crates/nv-core/src/lib.rs`.

- editor → overseer: run the editor suite on TipTap in CI (`node --import tsx tests/editor/run-tiptap.ts`; needs Playwright's Chromium, as the e2e job has). I can't edit `.github/`. About a minute.

## Done

- 2026-11-21, **core** (M1, branch `rewrite/core-m1`): page-format corpus in `tests/corpus/` (12 pages built through the editor's schema, expectations from the real TS functions; `scripts/corpus/generate.ts`, checked by `tests/corpus.test.ts`); `crates/nv-model` (yrs) passes the whole corpus (`crates/nv-model/tests/corpus.rs`); `crates/nv-core` Core API slice over uniffi (`read_page`, `page_markdown`, `sanitize_page`, `list_marker`, `core_version`, `page_format_version`), with the NotiveloCore Swift package (XCFramework) built and Swift-tested in CI. Notes: the corpus records today's behaviour including quirks (inline mentions and page links drop out of Markdown, and page links are missing from searchable text); the macOS job runs on pushes and on PRs from/to `rewrite/*` only.
- 2026-11-21 (editor): editor suite as data in `tests/editor/` (notation, harness with today's box editor, Playwright runner, README): 129 scenarios over typing, block edges, marks, headings, lists and smart lists, checklists, tasks (convert, notes, Tab/Shift+Tab, delete and undo), input rules, slash menu, tables, code, quotes, callouts, toggles, links, page links, mentions, paste/copy/cut, undo/redo. 127 green on TipTap, 2 skipped with reasons. Findings: possible redo bug in today's editor, and quirks the engine must copy (README).
- 2026-11-21, apple: `docs/rewrite/PARITY.md` (inventory of today's app, one row per feature, columns iPad/iPhone/Mac/Windows/Android/Web; native progress marked with ✓). `apps/apple`: XcodeGen project, targets `Notivelo` (iPad+iPhone, iOS 17, `com.devswartz.notivelo`, App Group) and `NotiveloMac` (macOS 14, sandboxed), SwiftUI placeholder sign-in + sidebar. `.github/workflows/apple-native.yml` builds both on pushes to `rewrite/**` touching `apps/apple`; `[testflight]` in the commit message archives and uploads (cloud signing with the ASC key, like mobile.yml, internal testing only). Build numbers are `<mobile.yml's latest run>.<run>` so they sort above every uploaded build and below the next real release. **Uploaded 1.99.2 (130.2) to TestFlight** (run 44911049777); Apple's processing result not checked from here.
- 2026-11-21: architecture decided (`docs/ARCHITECTURE.md`, PR #197); this plan written.
