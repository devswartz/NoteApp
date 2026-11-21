# nv-editor: the editor engine

The design of `crates/nv-editor`, the text editing engine every native app drives (`docs/ARCHITECTURE.md` 3.2). What it must do is written down as data in `tests/editor/` (the editor suite, run against today's TipTap editor and against this crate). This file says how the engine is built.

## 1. What it is, and what it isn't

- **It is**: one text box's editing state (document, selection, focus, history), the commands that change it, input rules, the keymap, the clipboard, and the binding to that box's fragment in the page's yrs document. Plus the page-level undo that spans boxes.
- **It isn't**: layout, drawing, text input protocols (how they map onto the engine: 10), the canvas (box geometry, pan, zoom), ink, the network or the task store. The view (TextKit 2, Android `Layout`, DirectWrite, DOM) lays out and draws; the core owns sync and tasks. The engine reaches tasks through a small trait (5).

## 2. Document model

**Tree.** An owned, immutable-by-convention tree in the ProseMirror shape: `Node { kind, attrs, content: Vec<Node>, marks }`, where text is a leaf node with a string and marks. Node and mark names, attributes and defaults are today's schema (the one TipTap builds from `documentExtensions` in `src/editor/NoteEditor.tsx`), loaded by `schema.rs` from `tests/editor/schema.json`, which is exported from the live TipTap schema (`node --import tsx tests/editor/run-tiptap.ts --schema`), so the two can't drift: `paragraph`, `heading{level}`, `bulletList`, `orderedList{start,type,paren,…}`, `listItem`, `taskList`, `taskItem{checked}`, `taskRef{taskId}`, `blockquote`, `codeBlock{language}`, `callout{…}`, `details`/`detailsSummary`/`detailsContent`, `table`/`tableRow`/`tableHeader`/`tableCell{colspan,rowspan,colwidth}`, `horizontalRule`, `hardBreak`, `image`, `fileAttachment`, `pageLink{pageId}`, `mention{id,label}`; marks `bold`, `italic`, `underline`, `strike`, `code`, `link{href,…}`, `textStyle{color}`, `highlight{color}`, `comment{…}`. Each node kind has a content rule (`block+`, `inline*`, `listItem+`, …) checked by `Schema::valid`.

**Why a tree and not editing yrs directly:** commands need whole-structure questions (what list is this item in, can these blocks join, where does Tab put this line) that are simple on a tree and painful on CRDT types; and positions must be stable integers within one state. yrs stays the source of truth between states (3).

**Positions** are ProseMirror's: 0 is before the first top-level block; entering or leaving a non-leaf node counts 1; each UTF-16 unit of text counts 1 (yrs is set to UTF-16 offsets, like `nv_model::new_doc`); a leaf node counts 1. The suite's notation is written in these positions, and they match the web's, which helps while the web still runs ProseMirror. `ResolvedPos` gives the path (depth, parent, index, offset) for a position.

**Selection**: `Text { anchor, head }`, `Node { pos }` (a selected task line, image, horizontal rule) or `All`. **Focus**: `Doc` or `TaskTitle(task id)`: a task line's title is edited in its own field (today a `<textarea>` in the task node view), so the engine keeps a title text and caret for it and handles its keys (5).

## 3. Binding to the page (yrs)

A box's content lives in the page doc's XML fragment `box:<id>` (`default` for document pages), in y-prosemirror's mapping, the format `nv-model` reads: an element per non-text node (tag = node name, attributes = node attributes), an `XmlText` per run of inline content with marks as formatting attributes (overlapping marks as `name--<hash>`), inline atoms as elements.

- **Reading**: `nv_model::tree` gives the fragment as owned `Node`s; `bind::from_fragment` converts that to the engine tree. Until `nv-model` grows anything more, this is the only coupling: a `trait FragmentSource` (read nodes, observe changes) keeps the engine testable without a doc.
- **Writing**: after each local transaction the engine diffs the new tree against the fragment, like y-prosemirror's `updateYFragment`: equal leading and trailing children are kept, changed elements are updated in place (attributes, then children recursively), text nodes are updated with a character diff (insert/delete/format) so concurrent typing in the same paragraph merges, and the rest is replaced. All in one yrs transaction with the engine's origin.
- **Remote changes**: on a fragment change from another origin, re-read the fragment into a new tree and re-map the selection through yrs sticky indexes (relative positions) taken before the change, so carets survive collaborators' edits. Remote cursors come the same way, from awareness (the core's job), as sticky indexes the engine resolves to positions.

## 4. Commands, input, keys

Every command edits the tree directly and sets the new selection itself (no step log: the yrs binding diffs the new tree against the fragment, 3, and remote edits re-map the selection through sticky indexes). After each command, the **appenders** run, as ProseMirror's `appendTransaction` plugins do today: the trailing paragraph (a box always ends with a paragraph), autolinking typed URLs, and task bookkeeping (5).

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

- `crates/nv-editor/tests/suite.rs` reads every `tests/editor/scenarios/*.json` file, builds the state from `doc` (the notation, parsed in `notation.rs`), plays the steps through the same API the views use (`type` → `insert_text` per character; `key` → `key(chord)`; `command` → the command; `paste`/`copy`; `compose` / `commitComposition` / `cancelComposition` → the composition calls; `replace` → `replace_range`), with a fake `TaskHost` and a manual clock, and compares the serialised result. Scenarios skipped for `rust` are listed with their reasons; the test prints a pass count per file and fails on any regression.
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

## 10. Native text input

How each platform's text input protocol maps onto engine calls. The view owns the protocol object (it has to: the OS calls it, and geometry questions need the view's layout); the engine owns the text, the selection and the composition. Code: `crates/nv-editor/src/input.rs` (the view's text, `replace_range`), `compose.rs` (marked text); in the Core API, `EditorSession` (`crates/nv-core/src/editor_session.rs`). Suite: `tests/editor/scenarios/input.json`.

### 10.1 The view's text

**One string for the whole box**, from `Editor::text_for_view() -> ViewText`: each text block is a line, lines joined by `\n`; inside a line a hard break is `\n` and any other inline atom (mention, page link, inline image) is U+FFFC; a block with no text of its own (rule, image, file, a task line, whose title has its own field) is a line holding one U+FFFC; a task's notes follow its line as lines of their own.

Why one string and not one per block: every protocol here models one editable text (UITextInput's document, `NSTextInputClient`'s character indexes, Android's `Editable`, `CoreTextEditContext`'s text); selections can span blocks (select all, then type or dictate over it); IMEs and autocorrect read context across line breaks (capitalisation after a new paragraph); and a per-block model would make the view re-target the input client whenever the caret crosses a block. The cost is building the string for large boxes: the view caches it per state, and Android can be given a window of it (`getExtractedText` takes a start offset).

**Offsets are UTF-16 code units**, the unit of `NSString`, Java `String`, WinRT `HSTRING`, DOM strings and engine positions. Inside a line an offset moves exactly as a position does (text 1:1, an atom 1 unit as U+FFFC or `\n`), so mapping is a lookup of the line, then addition:

- `ViewText::to_pos(offset)` / `Editor::view_offset_to_pos`: the end of a line is the end of its block's content, the start of the next line the start of the next block's; on an object line, offset 0 is the position before the node and 1 the position after it.
- `ViewText::to_offset(pos)` / `Editor::pos_to_view_offset`: a position between blocks (entering a list, an item) goes to the start of the next line.
- `ViewText::slice(from, to)` for `textInRange`, `getTextBeforeCursor` and the like.
- The selection the view reports: a text selection maps its anchor and head; a node selection is its U+FFFC (`offset..offset+1`); select-all is `0..len`. A selection the platform sets that covers exactly one object line's U+FFFC becomes `select_node`.
- The composition the view reports (`markedTextRange`, the composing span) is `EditorState.composing` mapped the same way.

In the Core API: `EditorSession::text_for_view()`, `view_offset_to_pos(u32)`, `pos_to_view_offset(u32)`; and in view offsets throughout, `view_state() -> ViewState` (the string, its length, the **line table** `lines: [ViewLine]` with each line's offset, length, position, `is_text`, block `kind`, heading `level`, `containers` from the box down, list `marker` (`•`, `1.`, `b)`), checklist `checked` and a task line's `task_id`; the `selection` as anchor/head; the `marked` range and the selection inside it), `view_selection()`, `set_view_selection(anchor, head)` (the select-node and select-all rules above; a caret on an object line goes to the nearest text), `replace_view_range(from, to, text)`. Rects are the view's layout of the lines; the core only gives offsets. The open menu's `EditorSuggestion` has `view_from` / `view_to` to anchor the popup.

### 10.2 Engine calls

| Engine call | What it does | Comes from |
|---|---|---|
| `insert_text(s)` | Typed text over the selection; input rules run. While composing (session), it commits the composition with `s`. | Keyboard text, an IME commit with no range |
| `replace_range(from, to, s)` | Replaces positions `from..to` without moving the selection there first. The new text takes the marks of the first character it replaces (the caret's marks at `from` for an empty range); **no input rules** (autocorrect shouldn't turn `- ` into a list); its own undo step; the selection is mapped (before the range it stays, after it it shifts, inside it it goes after the new text). A range whose ends aren't in text is refused (false); one spanning blocks joins them, and task lines it removes are deleted as with any edit. In a task title, `from..to` are offsets in the title. | Autocorrect, spell-check, the predictive bar, dictation results, reconversion, accent menus, handwriting gestures |
| `set_composition(s, sel)` | Shows marked text in place of the selection the composition began on; `sel` is the selection inside it. Nothing is written to the page and no rules run until it ends. | `setMarkedText`, `setComposingText`, `TextUpdating` while composing |
| `commit_composition(s)` | Ends it with `s`: back to the state before it, then `insert_text(s)` once (rules run, one change, one undo step). Empty `s` deletes the selection it replaced. | `insertText` while marked, `commitText` while composing |
| `finish_composition()` (engine: `end_composition`) | Commits the marked text as it stands. | `unmarkText`, `finishComposingText`, `CompositionCompleted`, focus loss |
| `cancel_composition()` | The marked text goes, and so does the selection it replaced (as in Chromium and Android). | Escape in an IME, an emptied composition |
| `key(chord)` | Keys: `Enter`, `Shift+Enter`, `Backspace`, `Delete`, `Tab`, `Mod+b`, ... | Key events, and protocol calls that are keys in disguise (below) |
| `set_selection(anchor, head)` / `select_node(pos)` | The platform moves the caret or selection. | Taps, handles, IME cursor moves |
| `undo()` / `redo()` | | The platform's undo (`UndoManager`, `historyUndo`) |

**Keys and text take separate paths.** A view sends chords (anything with Mod, Ctrl or Alt; Enter, Tab, Backspace, Delete, Escape; the arrows the engine handles, such as Alt+Shift+ArrowUp) to `key()`, and lets text arrive through the input protocol, never as chords, so dead keys, IMEs, dictation and software keyboards all take one road. While a composition is open, keys go to the input method first (AppKit `inputContext.handleEvent`; the IME's own handling on the others), not to `key()`. Three protocol calls are keys in disguise and go to `key()`, so list, task and table rules apply:

- a newline inserted as text (`insertText("\n")` from the iOS Return key, `commitText("\n")`, `TextUpdating` with `\r`) is `key("Enter")`;
- deleting exactly the one character before an empty selection (`deleteBackward`, `deleteSurroundingText(1, 0)`, a one-character `TextUpdating` deletion) is `key("Backspace")`;
- a tab inserted as text is `key("Tab")`.

**After the engine changes text or selection** for any reason other than the protocol call being handled (a remote edit, a ribbon command, undo, a hardware key the engine took), the view tells the platform, so the keyboard drops stale autocorrect state and recomputes capitalisation: UIKit `inputDelegate.selectionWillChange` / `textWillChange` before and `textDidChange` / `selectionDidChange` after; AppKit `inputContext.invalidateCharacterCoordinates` (and `discardMarkedText` if a composition was dropped); Android `InputMethodManager.updateSelection` (and `restartInput` if text under an open composition changed); Windows `NotifyTextChanged(range, newLength, selection)` / `NotifySelectionChanged`. They are not sent from inside the protocol's own calls (UIKit and Android IMEs misbehave when told about their own edits), except Android's `updateSelection`, which follows every change.

### 10.3 UIKit (UITextInput, TextKit 2)

The box view adopts `UITextInput`, with `UITextPosition` / `UITextRange` subclasses holding view offsets (10.1) and `UITextInputStringTokenizer` as the tokenizer.

- `insertText(_:)` → `insert_text` (commits while marked); `"\n"` → `key("Enter")`.
- `deleteBackward()` → `key("Backspace")`.
- `setMarkedText(_:selectedRange:)` → `set_composition(text, sel.location, sel.location + sel.length)`; nil text is an empty composition. `unmarkText()` → `finish_composition()`. `markedTextRange` from `view_state().marked`; `markedTextStyle` is ignored (the view draws the underline).
- `replace(_:withText:)` → `replace_view_range(start, end, text)` (= `replace_range(to_pos(start), to_pos(end), text)`): autocorrect, the predictive bar, spell-check suggestions and dictation results arrive here.
- `selectedTextRange`: get → `view_selection()`; set → `set_view_selection` (which selects the node for one object line's U+FFFC).
- `text(in:)` → `ViewText::slice`; `position(from:offset:)` and `offset(from:to:)` are offset arithmetic clamped to `0...len`; `position(from:in:offset:)` is offset arithmetic left and right and asks the layout up and down; `beginningOfDocument` is 0, `endOfDocument` is `len`.
- `firstRect(for:)`, `caretRect(for:)`, `selectionRects(for:)`, `closestPosition(to:)`, `characterRange(at:)`: TextKit 2 layout, never the engine.
- `baseWritingDirection(for:in:)` → `.natural`; `setBaseWritingDirection(_:for:)` does nothing (the schema has no direction attribute yet).
- `UITextInteraction(for: .editable)` on the view gives the caret, handles, loupe and tap gestures; they reach the engine through `selectedTextRange`.
- **Scribble**: a `UITextInput` view gets Scribble on iPad through the plain text-input path (writing arrives as `insertText` / `replace`, scratch-out as `replace` with `""`). `UIIndirectScribbleInteraction` on the canvas lets people write where there is no box yet (`focusElementIfNeeded` makes a box and returns its view). Scribble is off while an ink tool is chosen (`UIScribbleInteractionDelegate` `shouldBeginAt` → false).
- **Undo**: the view's `undoManager` is a small `UndoManager` subclass whose `undo()` / `redo()` call the engine and whose `canUndo` / `canRedo` ask it (`can_undo()` / `can_redo()`, also in `state()`; typing groups in 500 ms windows on a monotonic clock), so shake, the three-finger swipe and the iPad shortcut bar undo engine steps. Hardware Cmd+Z goes to `key("Mod+z")` and must not also reach the `UndoManager`.
- `inputDelegate` notifications as in 10.2.
- **Slash menu**: `state().suggestion` gives the rows (`items`: id, label, description, Lucide `icon` name) and the `highlighted` row; while it is open, ArrowUp / ArrowDown / Enter / Tab / Escape sent to `key()` move the highlight, pick it and close the menu (or `move_suggestion_highlight`, `pick_suggestion`, `dismiss_suggestion` from taps). For `[[` and `@` the view lists pages or people itself and picks with `pickPage` / `pickMention`.

### 10.4 AppKit (NSTextInputClient)

- `insertText(_:replacementRange:)`: `replacementRange.location == NSNotFound` → `insert_text` (commits while marked); a range (press-and-hold accents, the character viewer, reconversion) → `replace_range`.
- `setMarkedText(_:selectedRange:replacementRange:)`: with a replacement range and no composition open, `set_selection` to it first; then `set_composition(text, sel)`. `unmarkText()` → `finish_composition()`. `hasMarkedText`, `markedRange` and `selectedRange` from the state, mapped.
- `attributedSubstring(forProposedRange:actualRange:)` → `ViewText::slice` (with the font, for the candidate window); `validAttributesForMarkedText` → `[]`.
- `firstRect(forCharacterRange:actualRange:)` and `characterIndex(for:)`: the view's TextKit 2 layout, in screen coordinates.
- Keys: in `keyDown`, an open composition sends the event to `inputContext.handleEvent` first; otherwise chords go to `key()`, and what it doesn't take to `interpretKeyEvents`, whose `doCommand(by:)` selectors map to keys (`insertNewline:` → Enter, `insertLineBreak:` → Shift+Enter, `deleteBackward:` → Backspace, `deleteForward:` → Delete, `insertTab:` / `insertBacktab:` → Tab / Shift+Tab) or to the view's caret movement (`moveLeft:`, `moveWordRight:`, ...: layout, then `set_selection`).

### 10.5 Android (InputConnection)

The view returns its own `InputConnection` (no `Editable` mirror) from `onCreateInputConnection`, with `EditorInfo.initialSelStart` / `initialSelEnd` set.

- `commitText(text, newCursorPosition)`: while composing → `commit_composition(text)`; over a composing region the view holds (below) → `replace_range(region, text)`; else `insert_text`. `"\n"` → `key("Enter")`. A `newCursorPosition` other than 1 is applied with `set_selection` afterwards.
- `setComposingText(text, newCursorPosition)` → `set_composition` (caret at the end, or where `newCursorPosition` puts it); over a region the view holds, `set_selection(region)` first.
- `setComposingRegion(start, end)` (Gboard going back into a word): the view remembers the region and tells the engine nothing; the next `setComposingText` or `commitText` uses it; `finishComposingText` forgets it.
- `finishComposingText()` → `finish_composition()`.
- `deleteSurroundingText(before, after)`: `(1, 0)` with an empty selection → `key("Backspace")`; otherwise `replace_range(…, "")` after the selection first, then before it (so offsets hold); `deleteSurroundingTextInCodePoints` the same, counted in code points.
- `sendKeyEvent` → `key()` (DEL, ENTER, hardware keys); printable characters from hardware keys come through `commitText`.
- `getTextBeforeCursor(n)`, `getTextAfterCursor(n)`, `getSelectedText` → `ViewText::slice`; `getCursorCapsMode` from the text before the caret.
- `setSelection(start, end)` → `set_selection`.
- `getExtractedText(request, flags)` → the string (or a window of it, with `startOffset`), the selection and `partialStartOffset = -1`; with `GET_EXTRACTED_TEXT_MONITOR` the view sends `updateExtractedText` after changes.
- `beginBatchEdit` / `endBatchEdit`: the engine applies each call at once; the view holds its `updateSelection` until the batch ends.
- After every change, the IME's included: `InputMethodManager.updateSelection(view, selStart, selEnd, composingStart, composingEnd)` (-1 when not composing). `requestCursorUpdates` → `CursorAnchorInfo` from the layout. `performContextMenuAction` (select all, cut, copy, paste) → the engine's. Stylus handwriting gestures (`performHandwritingGesture`, Android 14) → `set_selection` / `replace_range`.

### 10.6 Windows (CoreTextEditContext)

- `TextRequested` → `Request.Text = slice(Request.Range)`; `SelectionRequested` → the selection, mapped.
- `TextUpdating(Range, Text, NewSelection)`: between `CompositionStarted` and `CompositionCompleted` it edits the marked text: the view applies `Range` / `Text` to the composition string it holds and calls `set_composition(that string, NewSelection relative to the composition's start)`. When not composing, a `Range` equal to the selection → `insert_text(Text)` (with the key cases of 10.2 going to `key()`); any other `Range` → `replace_range`. Then `set_selection(NewSelection)` if the engine left the caret elsewhere. `Result = Succeeded`.
- `SelectionUpdating` → `set_selection`.
- `FormatUpdating` (the IME's segment underlines and colours) → the view's drawing of the marked text only.
- `CompositionStarted` → nothing (the engine's composition starts with the first `TextUpdating`); `CompositionCompleted` and `FocusRemoved` → `finish_composition()`.
- `LayoutRequested` → text and control bounds from the view's DirectWrite layout.
- Keys: `KeyDown` chords and editing keys → `key()`; characters come through `TextUpdating`, so `CharacterReceived` isn't used for text.
- After engine changes: `NotifyTextChanged(modifiedRange, newLength, newSelection)`, `NotifySelectionChanged`, `NotifyLayoutChanged`; `NotifyFocusEnter` / `NotifyFocusLeave` with the box's focus.

### 10.7 Web (later, when the web runs the engine through WASM)

`beforeinput` carries the same intents: `insertText` → `insert_text`; `insertReplacementText` (with `getTargetRanges()`) → `replace_range`; `insertCompositionText` with `compositionstart` / `compositionupdate` / `compositionend` → `set_composition` / `commit_composition`; `deleteContentBackward` → `key("Backspace")`; `insertParagraph` → `key("Enter")`; `insertLineBreak` → `key("Shift+Enter")`; `historyUndo` / `historyRedo` → `undo` / `redo`; `insertFromPaste` → `paste`. Chromium's `EditContext` is modelled on `CoreTextEditContext` and maps as 10.6 does.

### 10.8 Recorded behaviour (today's editor, `input.json`)

- Composition commits run input rules: `- ` committed through an IME makes a list, in one composition or two.
- Cancelling a composition that replaced a selection leaves the selection deleted (Chromium deletes it when the composition starts); committing empty text does the same.
- Undo after a committed composition takes the whole commit away in one step.
- A replacement keeps the marks of the first replaced character (`I saw *teh*` → `*the*`; replacing `b**c**` gives plain text).
- Difference, on purpose: today's editor reads a replacement as typed text (ProseMirror's `handleTextInput`), so input rules run on autocorrect and dictation corrections; the engine's `replace_range` doesn't (`input/replacement doesn't run input rules`, skipped on TipTap).
