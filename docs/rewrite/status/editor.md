# Editor stream status

Newest first. The overseeing session folds this into `docs/rewrite/STATUS.md`.

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
