# Editor stream status

Newest first. The overseeing session folds this into `docs/rewrite/STATUS.md`.

## 2026-11-21: TipTap suite flake on CI fixed (branch `rewrite/editor-input`)

- **Cause**: Rewrite run 44920734045 failed `tasks/Backspace in an empty task title makes a plain line` (tasks want `{}`, got `{"t1":{"title":"A"}}`). Not focus timing: the previous scenario's task create / title save (title "A") was still in flight on the slower runner, and its reply landed after the next scenario's `nv.load`, putting that task back in the store.
- **Fix** (`tests/editor/harness/main.tsx`, `tests/editor/run-tiptap.ts`): the harness counts in-flight fetches; `nv.settle()` waits until none are in flight for two frames. `nv.load` settles before seeding the store, and the runner settles before each scenario's end check (instead of a fixed 50 ms). No scenario or expectation changed. New stress flags: `NV_EDITOR_API_DELAY=150` (ms per stub API reply; reproduced the leak in 6 task scenarios before the fix) and `NV_EDITOR_THROTTLE=6` (CDP CPU throttling).
- **Result**: local full suite 144 passed, 0 failed, 3 skipped, ~19 s before and after (26 s with delay 150 + throttle 4, all passing); `npx tsc -b` clean, `cargo test -p nv-editor --test suite` green. CI Rewrite run 44921701420 green (editor suite (TipTap) passed).

## 2026-11-21: native text-input contract, step 2 (branch `rewrite/editor-input`)

Branched from `origin/rewrite/native`. How UIKit, AppKit, Android, Windows (and later the web) text input maps onto the engine, written down, tested on today's editor, and passing in nv-editor.

- **Contract**: `docs/rewrite/EDITOR.md` 10 "Native text input". The view exposes **one string per box** (a line per text block joined by `\n`; hard break `\n`; inline atoms and text-less blocks, task lines included, are U+FFFC), in UTF-16 offsets, which move 1:1 with engine positions inside a line. Per platform: which protocol call becomes `insert_text`, `replace_range`, `set_composition` / `commit_composition` / `finish_composition` / `cancel_composition`, `key()` or `set_selection`; keys vs text (chords go to `key()`, text through the protocol, keys go to the IME first while composing; newline, one-character delete-backward and tab through the protocol go to `key()`); the notifications a view sends when the engine changes text itself (`inputDelegate`, `updateSelection`, `NotifyTextChanged`, ...); Scribble, `UITextInteraction`, the keyboard's undo through an `UndoManager` that calls the engine.
- **Engine (`crates/nv-editor`)**:
  - `src/input.rs` (new): `ViewText` (`text`, `lines`, `to_pos`, `to_offset`, `slice`), `Editor::text_for_view()`, `view_offset_to_pos`, `pos_to_view_offset`; `Editor::replace_range(from, to, text) -> bool` (marks of the first replaced character, no input rules, its own undo step, selection mapped, refused outside text, offsets in the title when a task title has focus). 5 unit tests.
  - `compose.rs`: cancel, and commit with empty text, now delete the selection the composition replaced (what Chromium does; before, cancel put the selection back).
- **nv-core** (only `src/editor_session.rs`, plus a test in `tests/editor_session.rs`): `EditorSession::replace_range(from, to, text) -> bool`, `finish_composition()`, `text_for_view() -> String`, `view_offset_to_pos(u32) -> u32`, `pos_to_view_offset(u32) -> u32`; `cancel_composition` now runs `finish()`. lib.rs untouched.
- **Suite**: step types `compose` (with `selection`), `commitComposition`, `cancelComposition`, `replace { from, to, text }` (positions), documented in `tests/editor/README.md` ("Text input"). TipTap drives them through Chromium's CDP: `Input.imeSetComposition` for marked text, `Input.insertText` to commit, an empty `imeSetComposition` to cancel; a replacement selects the range, inserts with `Input.insertText` and maps the old selection back (harness `nv.beginReplace` / `nv.endReplace`). A synthetic `insertReplacementText` `beforeinput` does nothing in ProseMirror, so it isn't used. New file `tests/editor/scenarios/input.json`, 18 scenarios.
- **Counts**: TipTap **144 passed, 0 failed, 3 skipped** (147 scenarios; the new skip is below). nv-editor suite **147/147**, ratchet grown from 129 to 147 (`input` 18/18). `cargo test -p nv-editor -p nv-core` green (nv-editor 17 unit tests, nv-core `editor_session` 8), `cargo fmt --all`, `cargo clippy -p nv-editor -p nv-core --all-targets -- -D warnings` and `npx tsc -b` clean.

### Findings

- **Composition commits run input rules** in today's editor (TipTap's input rules also run on `compositionend`): `- ` committed through an IME makes a list. The engine does the same (commit types once with `insert_text`).
- **Replacements run input rules** in today's editor: ProseMirror reads the DOM change as typed text (`handleTextInput`), so an autocorrect or dictation correction can make a list. The contract says replacements don't; `input/replacement doesn't run input rules` is skipped on TipTap (README Findings).
- **Cancel over a selection deletes the selection** (Chromium deletes it when the composition starts); the engine now matches.
- Undo after a committed composition is one step on both. Undo after a replacement restores the text; TipTap's selection there is the replaced range (an artefact of how the runner selects it), so that scenario ignores the selection.

### What's next

- The views: implement 10.3 to 10.6 against `EditorSession` (Apple first). The session will want `can_undo` / `can_redo` (for `UndoManager.canUndo`) and probably a `ViewText` record with the line table, so a view maps offsets without a call per position.
- Composition in a task title (the title changes on commit only) and `replace_range` across a task line's notes are untested in the suite.
- Not yet covered: reconversion (`setMarkedText` with a replacement range), Android `setComposingRegion`, Windows `TextUpdating` with a range away from the caret: all map to existing calls, but no scenario runs them.

## 2026-11-21: editor session in the Core API, step 1 (branch `rewrite/editor-session`)

Branched from `origin/rewrite/native`. The native apps can now open a text box of a page and edit it through `nv-core`.

- **`crates/nv-core/src/editor_session.rs`** (new, editor-owned): `EditorSession`, a `uniffi::Object` over `Mutex<nv_editor::Editor>` bound to one field of its own yrs doc of the page.
  - `EditorSession::open(update: Vec<u8>, field: String, tasks: Arc<dyn TaskCallbacks>) -> Result<Arc<EditorSession>, EditorError>` (constructor; `field` is `box:<id>` or `default`).
  - Input: `insert_text(text)` (replaces the marked text while composing), `key(chord) -> bool`, `command(name, args_json) -> Result<bool, EditorError>`, `paste(html, text) -> bool`, `copy() -> ClipboardData`, `cut() -> ClipboardData`, `undo() -> bool`, `redo() -> bool`, `set_selection(anchor, head)`, `select_node(pos)`.
  - IME: `set_composition(text, sel_start, sel_end)`, `commit_composition(text)`, `cancel_composition()`.
  - Drawing: `state() -> EditorState { doc_json, selection: EditorSelection (Text{anchor,head} | Node{pos} | All), focus_task_id, suggestion: Option<EditorSuggestion { trigger, query, from, to, slash_items }>, composing: Option<TextRange>, remote_cursors }`.
  - Sync: `apply_update(update) -> Result<(), EditorError>`, `state_vector() -> Vec<u8>`, `encode_update_since(state_vector) -> Result<Vec<u8>, EditorError>` (empty bytes: everything).
  - Remote cursors: `set_remote_cursors(Vec<RemoteCursor { user_id, anchor, head }>)`, `remote_cursors()`; carried across remote changes.
  - `#[uniffi::export(with_foreign)] trait TaskCallbacks: Send + Sync` mirrors `TaskHost` (`new_id`, `create`, `delete`, `restore`, `title`, `set_title`); `EditorError` = `InvalidPage | NoSuchBox | UnknownCommand | InvalidArgs` (its own type, so `CoreError` in lib.rs is untouched).
  - Every edit commits an open composition first and runs `finish()` (one write to yrs).
- **Engine (`crates/nv-editor`)**:
  - `Editor::command(name, &Value) -> Result<bool, String>` (`src/command.rs`): the suite's command mapping moved out of `tests/suite.rs`, plus the views' `convertToTask`, `indent`, `outdent`, `moveBlockUp/Down`, `hardBreak`, `focusTitle {id}`, `pickSlash {title}`, `pickPage {pageId}`, `pickMention {id,label}`, `dismissSuggestion`.
  - IME composition (`src/compose.rs`): the marked text is shown in the tree but `finish()` writes nothing and syncs no tasks while composing; each update starts from the state before the composition; commit goes back to that state and calls `insert_text` once (input rules run, one undo step); cancel goes back.
  - Remote changes (`src/remote.rs`, `bind.rs`): `Editor::apply_update(&[u8])` applies the update with origin `nv-editor-remote` (not undoable), re-reads the tree, and maps the selection and remote cursors through **yrs sticky indexes** taken before the change (`Binding::stick` / `unstick`: walks the fragment beside the tree, text offsets in `XmlText`s, child indexes in elements). If they can't be tied, positions are clamped and snapped to a text block. Task lines that come or go remotely don't call the task store. An open composition is kept on top.
  - `Node::to_json()` (ProseMirror JSON), `bind::read_tree(doc, field)`, `Editor::open(doc, field, tasks, clock)`.
  - `TaskHost` is now `: Send` (so an `Editor` can sit in a uniffi Object); the suite's fake store uses `Arc<Mutex>`.
- **Tests**: `cargo test -p nv-editor -p nv-core` is green: nv-editor 12 unit tests (composition 4, remote 4, notation 2, to_json 1, others), the editor suite **129/129** (ratchet unchanged), nv-core `tests/editor_session.rs` 7 (type, then the state and the page doc both change, then undo/redo; keys, commands and clipboard; slash menu in the state; unknown box and bad bytes; composition then commit is one change; two sessions converge with the caret carried by sticky indexes, and remote cursors; tasks through a fake `TaskCallbacks`), plus `api.rs` 7 and `server.rs` 1. `cargo fmt --all` and `cargo clippy -p nv-core -p nv-editor --all-targets -- -D warnings` are clean. uniffi's library-mode Swift bindgen (as `build-xcframework.sh` runs it, `--locked`) generates the session on Windows; macOS steps not run.

### Lines added to `crates/nv-core/src/lib.rs` (core: accept or move them)

```rust
mod editor_session;          // after `mod content;`
pub use editor_session::*;   // after `pub use content::*;`
```

And in `crates/nv-core/Cargo.toml` `[dependencies]`: `nv-editor = { path = "../nv-editor" }` (Cargo.lock updated). Nothing else in core's files changed.

### Limits

- **Box fields** still read through `nv_model::Page::read` (no public fragment reader yet), so `open` only accepts `default` or a `box:<id>` that has geometry in `boxes` (`NoSuchBox` otherwise), and every read parses the whole page.
- **The session has its own doc**, not the `LivePage`'s: the app moves bytes between them (`live.apply_update(session.encode_update_since(sv))`, and `session.apply_update(...)` for others' changes). `PageListener::on_change` gives a `PageInfo`, not an update, so today the app would have to pass `live.document()` (the whole state; yrs ignores what it already has).
- Composition in a **task title** isn't shown (the title changes on commit). Undo/redo selections recorded before a remote change are clamped, not mapped. Sticky mapping falls back to clamping when the fragment holds something the tree drops (embeds inside text, unknown elements are handled).
- Undo grouping uses the wall clock (500 ms), so fast scripted input is one step.

### Requests

- **editor → core (nv-core):** share the live doc. Either a crate-visible accessor on `LivePage` (`pub(crate) fn doc(&self) -> &Doc`) so the session can add `EditorSession::open_live(page: Arc<LivePage>, field, tasks)` on the same doc (local edits then go out through LiveDoc's update observer with no byte shuffling), or an `on_update(update: Vec<u8>)` on `PageListener` for remote updates. The first is simpler; the session would then also need to hear remote changes (re-read on `on_doc_changed`).
- **editor → core (nv-model):** still the public fragment reader (`tree::read_fragment` or `Page::fragment(doc, name)`).

### Next

1. `open_live` on the live page's doc once core shares it, and re-reading on remote changes from nv-sync.
2. View-side queries the apps need: active marks and block type for the ribbon, list markers, word and line boundaries.
3. Page-wide undo across boxes; suite growth (two editors merging, images and files).

## 2026-11-21: M2 engine complete on the suite (branch `rewrite/editor-m2`)

- `crates/nv-editor` passes **all 129** editor-suite scenarios (`cargo test -p nv-editor`; ratchet in `crates/nv-editor/tests/passing.txt`, now listing all 129). On TipTap 127 pass and 2 are skipped; both pass on nv-editor:
  - `containers/Enter on an empty last toggle line leaves the toggle` (TipTap's harness can't open a toggle);
  - `undo/a new edit clears redo`: the engine does the expected thing (redo has nothing to do). Today's editor removes the new typing, which looks like a bug. That's a difference from today, not a decision for Devon unless he wants today's behaviour kept.
- Added this step: task lines (`src/tasks.rs`: convert with sub-points and checked items, Tab/Shift+Tab into and out of notes, Enter on an empty last note, title keys Enter/Backspace/Tab/Shift+Tab, a removed line deletes its task, a line brought back restores it, a cut keeps it); the yrs binding (`src/bind.rs`: the tree is written to the fragment by diff in y-prosemirror's mapping, read back through `nv_model::Page`); undo and redo with yrs's `UndoManager` (local origin only, 500 ms grouping on an injectable `Clock`, an input rule is its own undo step, undo restores the selection, and positions inside restored content collapse to its start as today); the clipboard (`src/clipboard.rs`: plain text out with tasks as `[ ] title` and indented notes, HTML out in today's shapes, HTML in for the common tags with links checked by `nv_model::urls::safe_link_url`, plain text in with the inline Markdown paste rules, a URL over a selection links it).
- The suite runner has a fake `TaskHost`, the suite's task names (`t<n>` in order of appearance), `focusTitle`, `paste`/`copy`/`cut` and a manual clock for `wait`.

## Requests

- **editor → core (nv-model):** make the fragment reader public (`tree::read_fragment`, or `Page::fragment(doc, name)`). `Page::read` only lists `box:<id>` fragments that have geometry in `boxes`, so the binding reads through `Page::read` and the suite binds to `default`. With a public reader the binding can bind any box directly, and it won't read the whole page on every change.
- **editor → core (nv-core):** the editor session for the Core API (next step below) needs one line in `crates/nv-core/src/lib.rs`: `mod editor_session;` (plus `nv-editor` in nv-core's dependencies). I'll write the module in its own file.

## Handover (for a fresh session)

- State: everything above is committed and pushed on `rewrite/editor-m2` (latest: the commit adding this file). `cargo fmt`, `clippy -D warnings` and `cargo test -p nv-editor` are clean.
- Code map (`crates/nv-editor/src`): `editor.rs` (state, typing, Enter/Backspace/Delete, marks, block types, lists, move, `finish()` = trailing paragraph + task sync + yrs write, undo/redo), `keymap.rs` (chords to commands; slash menu and task-title focus take keys first), `rules.rs` (input rules and autolink), `suggest.rs` (`/` `[[` `@`, slash items), `table.rs`, `insert.rs`, `tasks.rs` (`TaskHost`), `bind.rs` (yrs + undo), `clipboard.rs`, `notation.rs`/`schema.rs`/`node.rs`/`pos.rs`/`selection.rs`. Design: `docs/rewrite/EDITOR.md`.
- Next steps:
  1. **Editor session in the Core API**: `crates/nv-core/src/editor_session.rs`, a `uniffi::Object` `EditorSession` over `nv_editor::Editor` bound to a page doc's box field: `open(update, field)`, `insert_text`, `key(chord) -> bool`, `command(name, args_json)`, `paste(html, text)`, `copy() -> {html, text}`, `undo`/`redo`, `state()` (doc as notation or JSON, selection, focus, suggestion), and a `TaskHost` callback interface for the app. Ask core (above) for the `mod` line.
  2. Grow the suite where it's thin (README "Not covered yet": page-wide undo across boxes, images and files, comments, line picks, drag and drop, two editors merging), each green on TipTap first, then on the engine.
  3. Engine gaps the suite doesn't reach yet: remote changes (re-read the fragment on others' updates, carets through sticky indexes), page-wide undo across boxes (`pageUndo.ts`), word and line boundaries and list markers for the views, natural-language task titles.
- Known approximations: `join_backward` into a list merges text into its last item rather than ProseMirror's full `deleteBarrier`; `delete_range` across nested containers keeps the end side's remaining siblings where they were; HTML paste covers common tags only (no tables, task divs or images yet).
