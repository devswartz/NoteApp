# Editor test suite

What the page editor does, written as data, so today's TipTap editor and the native engine (`crates/nv-editor`) are checked against the same files. Part of the native rewrite (`docs/rewrite/PLAN.md`, M2; design in `docs/rewrite/EDITOR.md`).

```
tests/editor/
  scenarios/*.json   the suite: one file per area
  notation.ts        the document notation (parse / serialise); the Rust runner implements the same
  harness/           a page with today's text-box editor (the extensions canvas boxes use) on a Yjs doc
  run-tiptap.ts      runs the suite against it, headless in Chromium (Playwright)
```

Run it against today's editor (builds the harness with Vite, about a minute):

```
node --import tsx tests/editor/run-tiptap.ts [filter] [--print] [--headed]
```

`filter` keeps scenarios whose `file/name` contains it; `--print` shows each scenario's actual state (handy when writing one).

## A scenario

```json
{
  "name": "Enter splits a paragraph",
  "doc": "<paragraph>Hel|lo</paragraph>",
  "tasks": { "t1": { "title": "Call Sam", "status": "open" } },
  "steps": [{ "key": "Enter" }],
  "expect": { "doc": "<paragraph>Hel</paragraph><paragraph>|lo</paragraph>" },
  "skip": { "tiptap": "reason", "rust": "reason" }
}
```

- `doc`: one text box's content, with the selection, in the notation below. `tasks` (optional): the tasks that exist, by id.
- `steps`, in order:
  - `{ "type": "text" }` types the characters one by one (input rules apply, as with a keyboard).
  - `{ "key": "Enter", "times": 2 }` presses a key or chord: `Mod` is Ctrl (Cmd on Apple); `Shift+Tab`, `Mod+Alt+2`, `Alt+Shift+ArrowUp`.
  - `{ "command": "toggleMark", "args": { "mark": "bold" } }` runs an editor command (the ribbon and menus): see the list in `run-tiptap.ts` (`COMMANDS`), which is also the engine's command vocabulary.
  - `{ "paste": { "text/html": "…", "text/plain": "…" } }` pastes clipboard data.
  - `{ "copy": { "text": "…", "html": "…" }, "cut": false }` copies (or cuts) the selection and checks what went to the clipboard.
  - `{ "focusTitle": "t1" }` puts the caret at the end of a task line's title.
  - `{ "wait": 700 }` lets time pass (undo groups typing within 500 ms).
  - `{ "expect": { … } }` checks the state mid-way.
- `expect`: `doc` (the box afterwards, selection included), `tasks` (every task that exists: title and status), `focus` (`editor`, or `title:t1` when the caret is in a task's title, where the doc shows no selection), `ignoreSelection: true` (compare without the selection; see Quirks).
- `skip`: not run against that engine, with the reason.

Task ids: the ids in `doc` and `tasks` are names. Tasks the editor creates get the next free `t<n>` in order of appearance (doc first, then the task list), so expectations don't depend on random ids.

## The notation

`<paragraph>Hel|lo <bold>world</bold></paragraph>`

- Elements are ProseMirror node names, which are also the element names in the page's Yjs XML (`paragraph`, `heading`, `bulletList`, `orderedList`, `listItem`, `taskList`, `taskItem`, `taskRef`, `blockquote`, `codeBlock`, `callout`, `details`/`detailsSummary`/`detailsContent`, `table`/`tableRow`/`tableHeader`/`tableCell`, `horizontalRule`, `hardBreak`, `image`, `fileAttachment`, `pageLink`, `mention`).
- An element named after a mark wraps text in it: `bold`, `italic`, `underline`, `strike`, `code`, `link`, `textStyle` (colour), `highlight`, `comment`.
- Attributes are `key=value` with JSON values: `level=2`, `checked=true`, `href="https://x"`. Attributes at their default are left out of results; `<name/>` is an empty or leaf node.
- Selection: `|` is a caret; `[` the anchor and `]` the head of a range (`]ab[` is a backwards selection); `^` right before a node selects that node; `[` at the very start and `]` at the very end is select-all. `\` escapes `< > | [ ] ^ \` in text.
- Whitespace-only text containing a line break is ignored, so long expectations can be indented over several lines. Results put each top-level block on its own line.

## Fixtures

The harness seeds the app store: user `u1` (Tess Tester) in workspace `w1`; members `u1` and `u2` (Sam Lee) for `@` mentions; pages `page-1` ("This page", the page being edited) and `p2` ("Project plan") for `[[` links. The task API is faked in the runner (create / update / delete succeed and echo the task).

## Quirks of today's editor (kept, so the engine matches)

- **Trailing paragraph**: after any change, a box whose last block isn't a paragraph gets an empty one appended (StarterKit's TrailingNode).
- **Plain-text paste** applies inline Markdown (`**b**`, `*i*`, `` `c` ``, `~~s~~`, via paste rules) but keeps block Markdown (`- a`, `# T`) as text.
- **Typed links**: only URLs with a scheme autolink (`https://…`); a bare `example.com` doesn't. Typing at the end of a link extends it.
- **Page links and mentions** picked from their menus are followed by a space.
- **Selection after converting to a task** (Mod+Enter / Mod+1) and after undoing one is select-all, which looks incidental: those scenarios use `ignoreSelection`, and the engine may leave a better selection.
- **Toggles** open and close as view state, not in the doc (`persist: false`), and a loaded toggle is closed: Enter in its summary makes a line after it.

## Findings (possible bugs in today's editor)

- Type, undo, type something else, then redo: the redo removes the new typing (expected: nothing to redo). Scenario `undo/a new edit clears redo`, skipped on TipTap.
- After Tab in a task's title (making it a subtask), the title loses focus in the harness; Shift+Tab keeps it. Not yet checked in the app.

## Not covered yet

Page-wide undo across several boxes (`src/editor/pageUndo.ts`), box-level clipboard (`boxClipboard.ts`), images and files, comments, line picks, block drag and drop, task title natural-language parsing, collaborative merges (two editors on one doc).
