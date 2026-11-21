# nv-editor: the editor engine

The design of `crates/nv-editor`, the text editing engine every native app drives (`docs/ARCHITECTURE.md` 3.2). What it must do is written down as data in `tests/editor/` (the editor suite, run against today's TipTap editor and against this crate). This file says how the engine is built.

## 1. What it is, and what it isn't

- **It is**: one text box's editing state (document, selection, focus, history), the commands that change it, input rules, the keymap, the clipboard, and the binding to that box's fragment in the page's yrs document. Plus the page-level undo that spans boxes.
- **It isn't**: layout, drawing, text input protocols, the canvas (box geometry, pan, zoom), ink, the network or the task store. The view (TextKit 2, Android `Layout`, DirectWrite, DOM) lays out and draws; the core owns sync and tasks. The engine reaches tasks through a small trait (5).

## 2. Document model

**Tree.** An owned, immutable-by-convention tree in the ProseMirror shape: `Node { kind, attrs, content: Vec<Node>, marks }`, where text is a leaf node with a string and marks. Node and mark names, attributes and defaults are today's schema (the one TipTap builds from `documentExtensions` in `src/editor/NoteEditor.tsx`), written out in `schema.rs`: `paragraph`, `heading{level}`, `bulletList`, `orderedList{start,type,paren,…}`, `listItem`, `taskList`, `taskItem{checked}`, `taskRef{taskId}`, `blockquote`, `codeBlock{language}`, `callout{…}`, `details`/`detailsSummary`/`detailsContent`, `table`/`tableRow`/`tableHeader`/`tableCell{colspan,rowspan,colwidth}`, `horizontalRule`, `hardBreak`, `image`, `fileAttachment`, `pageLink{pageId}`, `mention{id,label}`; marks `bold`, `italic`, `underline`, `strike`, `code`, `link{href,…}`, `textStyle{color}`, `highlight{color}`, `comment{…}`. Each node kind has a content rule (`block+`, `inline*`, `listItem+`, …) checked by `Schema::valid`.

**Why a tree and not editing yrs directly:** commands need whole-structure questions (what list is this item in, can these blocks join, where does Tab put this line) that are simple on a tree and painful on CRDT types; and positions must be stable integers within one state. yrs stays the source of truth between states (3).

**Positions** are ProseMirror's: 0 is before the first top-level block; entering or leaving a non-leaf node counts 1; each UTF-16 unit of text counts 1 (yrs is set to UTF-16 offsets, like `nv_model::new_doc`); a leaf node counts 1. The suite's notation is written in these positions, and they match the web's, which helps while the web still runs ProseMirror. `ResolvedPos` gives the path (depth, parent, index, offset) for a position.

**Selection**: `Text { anchor, head }`, `Node { pos }` (a selected task line, image, horizontal rule) or `All`. **Focus**: `Doc` or `TaskTitle(task id)`: a task line's title is edited in its own field (today a `<textarea>` in the task node view), so the engine keeps a title text and caret for it and handles its keys (5).

## 3. Binding to the page (yrs)

A box's content lives in the page doc's XML fragment `box:<id>` (`default` for document pages), in y-prosemirror's mapping, the format `nv-model` reads: an element per non-text node (tag = node name, attributes = node attributes), an `XmlText` per run of inline content with marks as formatting attributes (overlapping marks as `name--<hash>`), inline atoms as elements.

- **Reading**: `nv_model::tree` gives the fragment as owned `Node`s; `bind::from_fragment` converts that to the engine tree. Until `nv-model` grows anything more, this is the only coupling: a `trait FragmentSource` (read nodes, observe changes) keeps the engine testable without a doc.
- **Writing**: after each local transaction the engine diffs the new tree against the fragment, like y-prosemirror's `updateYFragment`: equal leading and trailing children are kept, changed elements are updated in place (attributes, then children recursively), text nodes are updated with a character diff (insert/delete/format) so concurrent typing in the same paragraph merges, and the rest is replaced. All in one yrs transaction with the engine's origin.
- **Remote changes**: on a fragment change from another origin, re-read the fragment into a new tree and re-map the selection through yrs sticky indexes (relative positions) taken before the change, so carets survive collaborators' edits. Remote cursors come the same way, from awareness (the core's job), as sticky indexes the engine resolves to positions.

## 4. Commands, input, keys

Everything that changes the doc is a **transaction**: a function from the current `State { doc, selection, stored_marks }` to a new state, built from a few primitive steps (replace a range with a slice, add or remove a mark over a range, set a node's attributes, set the selection). Steps map positions, so a command can compose several. After the transaction, the **appenders** run, as ProseMirror's `appendTransaction` plugins do today: the trailing paragraph (a box always ends with a paragraph), autolinking typed URLs, and task bookkeeping (5).

The **command API** the views call (also the suite's command vocabulary, `COMMANDS` in `tests/editor/run-tiptap.ts`):

- Text: `insert_text(s)` (typing, runs input rules), `delete_backward()`, `delete_forward()`, `split_block()` (Enter), `hard_break()` (Shift+Enter), word and line deletes from the view's boundaries.
- Marks: `toggle_mark(bold|italic|underline|strike|code)`, `set_link(href)`, `unset_link()`, `set_color(name)`, `set_highlight(name)`.
- Blocks: `set_paragraph()`, `set_heading(level)`, `toggle_heading(level)`, `toggle_quote()`, `toggle_code_block()`, `move_block_up/down()`.
- Lists: `toggle_bullet_list()`, `toggle_ordered_list()`, `toggle_checklist()`, `indent()` / `outdent()` (Tab / Shift+Tab: list nesting, into and out of a task's notes, table cells).
- Tasks: `insert_task(title)`, `convert_to_task()`, and the task title's keys (5).
- Tables: `insert_table(rows, cols, header)`, `add_row_after()`, `add_column_after()`, `delete_row()`, `delete_column()`, `delete_table()`, next / previous cell.
- Inline nodes: `insert_page_link(page_id)`, `insert_mention(id, label)`; suggestion menus (`/`, `[[`, `@`) report their query and range to the view, which shows the menu and calls `pick_suggestion(item)`.
- Selection: `set_selection(sel)`, `select_all()`, plus queries for the view: the node and marks at a position, active marks and block type (the ribbon's state), the list marker of a line (`nv_model::lists`).
- History: `undo()`, `redo()`.
- Clipboard: `copy() -> Clipboard { html, text }`, `cut()`, `paste(Clipboard)`.

**Input rules** (on `insert_text`, matching the text before the caret in a text block, as TipTap's do): `- ` / `* ` / `+ ` bullet, `1. ` and `3) ` numbered (with start), `a. ` / `i. ` lettered and roman, `# `–`### ` headings, `> ` quote, ` ``` ` code block, `---` rule, and the mark rules `**b**`, `*i*`, `` `c` ``, `~~s~~`. `[ ] ` is not a rule (checklists come from the ribbon; tasks from `/task`).

**Keymap.** `key(chord)` maps a chord to commands in priority order (task keys, then lists, then block exits, then the base keymap), the way today's extensions stack. Views that get keys as chords (hardware keyboards) call `key`; text input from IMEs, dictation and autocorrect arrives as `insert_text` / `replace_range`, never as chords. A command returns whether it handled the key, so the view can let unhandled ones through (Tab to the next box, for example).

## 5. Tasks

A `taskRef` block holds a task id and the task's notes (any blocks, including nested `taskRef`s: subtasks). The title, status and the rest live in the task store, outside the doc. The engine talks to it through:

```rust
trait TaskHost {
    fn create(&mut self, title: &str, done: bool) -> TaskId;   // convert, /task, Enter in a title
    fn delete(&mut self, id: &TaskId);                        // a task line deleted from the box
    fn restore(&mut self, id: &TaskId) -> bool;               // undo brought a deleted line back
    fn title(&self, id: &TaskId) -> String;                   // for copy, and for the title field
    fn set_title(&mut self, id: &TaskId, title: &str);
}
```

The rules are today's (`src/editor/taskChildren.ts`, `TaskRef.tsx`, `undoTasks.ts`): converting keeps a line's sub-points under its task; Tab on the line after a task moves it into the notes, Shift+Tab lifts it out; Enter on an empty last note line leaves the task; in a title, Enter makes the next task (or the first note line when there are notes), Enter or Backspace in an empty title turns it back into a plain line, Tab / Shift+Tab nest or un-nest the task. A task line removed by an edit (not by a cut or a move) deletes its task; undo restores it; undoing a convert deletes the task it made and redo makes it again. The appender compares task ids before and after each transaction to find these.

## 6. Undo

Today: one `Y.UndoManager` per box fragment, tracking only this client's origin, grouping changes made within 500 ms; page-wide undo (`src/editor/pageUndo.ts`) stamps each stack item with a page-wide sequence number and undoes whichever box (or box geometry) has the newest item.

The engine does the same with yrs's `UndoManager` on the box fragment (local origin only, 500 ms capture timeout, an injectable clock so tests are exact), storing the selection before and after each item so undo puts the caret back. A `PageHistory` in the core holds the box managers and the geometry manager and picks the newest, as `pageUndo.ts` does. Undoing via the CRDT (not by replaying tree inverses) is what keeps collaborators' edits in place.

Recorded difference: in today's editor, type, undo, type something else, then redo removes the new typing (suite: `undo/a new edit clears redo`, skipped on TipTap). The engine does what the scenario expects (nothing to redo) unless Devon says otherwise.

## 7. Clipboard

- **Copy**: HTML from the tree with today's `renderHTML` shapes (so pasting into the web app and other editors keeps structure, and pasting back keeps tasks: `div[data-type="task-ref"]`); plain text by today's rules (blocks separated by blank lines, a task as `[ ] title` with its notes indented two spaces, mentions as `@label`).
- **Paste**: HTML through an HTML parser (`html5ever`, or a small tag-soup parser if size matters for WASM) mapped by today's parse rules, then sanitised by `nv_model::sanitize` (script links dropped); plain text as paragraphs per line, with the inline Markdown paste rules applied (block Markdown stays text, as today); a URL pasted over a selection links it; files go to the view (uploads are the core's).
- Box-level copy and paste (whole boxes on the canvas, `boxClipboard.ts`) is the canvas's, built on these.

## 8. Testing

- `crates/nv-editor/tests/suite.rs` reads every `tests/editor/scenarios/*.json` file, builds the state from `doc` (the notation, parsed in `notation.rs`), plays the steps through the same API the views use (`type` → `insert_text` per character; `key` → `key(chord)`; `command` → the command; `paste`/`copy`), with a fake `TaskHost` and a manual clock, and compares the serialised result. Scenarios skipped for `rust` are listed with their reasons; the test prints a pass count per file and fails on any regression.
- Unit tests next to each module for positions, steps and the yrs diff (round trips: tree → fragment → tree).
- Later: two engines on one yrs doc (concurrent edits merge, carets survive), and the same scenarios run on the web through WASM.

## 9. Order of work

1. Tree, schema, positions, notation, the suite runner (no yrs): typing, splitting and joining, marks, headings, quotes, code, rules.
2. Lists, smart lists, checklists, Tab / Shift+Tab.
3. yrs binding and undo/redo.
4. Tasks (with `TaskHost`), input rules and suggestion menus.
5. Tables, callouts, toggles, page links, mentions.
6. Clipboard.
7. Page-wide undo across boxes; Core API (`nv-core`) editor sessions for the apps.
