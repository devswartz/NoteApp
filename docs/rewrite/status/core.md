# core stream: status and handover

The **core** stream owns `crates/` (except `crates/nv-editor`), `tests/corpus/`, `scripts/corpus/`
and the Rust parts of CI. The overseeing session folds this file into `docs/rewrite/STATUS.md`.

## Now

- **The whole `rewrite/core-tasks-full` step is done** (cut from `rewrite/native` a625e3c, not
  merged): the full task model (task details, update, tags, teams, members, reminders, quick add;
  "For apple: task details"), **full-text search** ("For apple: search") and **comment threads**
  ("For apple: comments"). That answers all of apple's open requests to core. **Core pauses
  after this step.**
- Before that: box calls on `LivePage` (branch `rewrite/core-boxes`, "For apple: boxes", "For
  editor: boxes"), then task calls, live doc plumbing and the fragment reader (branch
  `rewrite/core-tasks`: "For apple: task calls", "For editor: the live doc").
- **Next, in order** (for a fresh session; see the handover below): Kotlin bindings with an
  Android library build in CI (`cargo-ndk`, including the platform verifier's Android init,
  below), then the CHANGELOG-SYNC.md design.
- **For the editor stream:** the engine has no command that adds or removes a `comment` mark yet;
  apple's Comment button needs one (`set_comment(thread_id)` / `unset_comment(thread_id)`, see "For
  apple: comments").

## For apple: search (2026-11-22, `rewrite/core-tasks-full`)

Answers apple's request "search(workspace_id, q) so the palette finds text inside pages". All
additions. The truth is the server's `GET /workspaces/:id/search?q=&limit=`
(`server/routes/search.ts`); the web's use is `PaletteInner` in `src/components/CommandPalette.tsx`
(asks 150 ms after the last keystroke, no limit given, shows the page snippet with `<mark>`).

```swift
core.search(workspaceId:, query:, limit: UInt32? = nil) throws -> SearchResults
parseSnippet(snippet:) -> [SnippetRun]          // pure; search() already applies it
```

- `SearchResults { pages: [PageSearchHit], tasks: [TaskSearchHit] }`, best match first in each
  list.
- `PageSearchHit { pageId, title, icon: String?, snippet: [SnippetRun], notebookName, sectionName,
  path }`. `path` is the server's "Notebook › Section › Subsection" string, ready to show (the
  web's crumb).
- `SnippetRun { text, matched: Bool }`. The server wraps matched terms in « and » (about 14 words
  of context, `…` at cut ends); `parseSnippet` splits on `«…»` exactly as the web's
  `highlightSnippet` does (markers dropped, empty runs left out, an unclosed « stays text). An
  **empty `snippet` array** means a title-only match (nothing to show under the title).
- `TaskSearchHit { task: TaskDetail, snippet: [SnippetRun]? }`: the snippet is present only when
  the task's **description** matched (the title is shown anyway).
- Matching (server): every word is prefix-matched ("plan" finds "planning") and stemmed, all
  words must match, at most 12 words, the query is cut to 200 characters. Title hits weigh 10x
  text hits; ties go to the recently edited. Open tasks sort before done ones. `limit` is 1 to 50
  per list (server default 20). Sub-task occurrences of repeating tasks are not searched.
- A blank (whitespace) query returns empty results **without a request**.
- **Locked pages:** the owner finds a locked page by its **title only** (its text is never
  indexed, so `snippet` is empty); tasks on locked pages are left out. Pages in notebooks the
  caller cannot see are never returned.
- **Online only.** Nothing is cached or queued; without a connection `search` throws
  `CoreError.Network` unchanged, and a rejected sign-in gives `CoreError.SignedOut`. The
  device's own title search (the tree) is still the offline fallback, apple's to keep.
- The server has no "recent pages" or quick-switcher endpoint (the web's palette lists recent
  pages from the tree it already holds), so there is nothing to add for that.
- Swift names: `SearchResults`, `PageSearchHit`, `TaskSearchHit`, `SnippetRun` do not clash with
  `apps/apple` (its own `SearchHit` and `SearchLogic` are untouched).

## For apple: comments (2026-11-22, `rewrite/core-tasks-full`)

Answers apple's request for comment threads (list for a page, create on a range, reply, resolve).
The truth is `server/routes/comments.ts`; the web's use is `src/editor/collabComments.ts`
(`beginComment`, the store) and `src/editor/collabCommentsPanel.tsx`. All calls **need the
network**: nothing is cached or queued, and `CoreError.Network` is returned unchanged.

```swift
core.pageComments(pageId:) throws -> [CommentThread]                         // oldest thread first
core.addCommentThread(pageId:, threadId:, quote:, body:) throws -> CommentThread
core.replyToCommentThread(threadId:, body:) throws -> CommentThread
core.resolveCommentThread(threadId:) throws -> CommentThread
core.reopenCommentThread(threadId:) throws -> CommentThread
core.editComment(commentId:, body:) throws -> CommentThread                  // your own only
core.deleteComment(commentId:) throws -> Bool                                // true: that was the thread's last comment, the thread is gone
core.deleteCommentThread(threadId:) throws
newCommentThreadId() -> String                                               // a random UUID
```

- `CommentThread { id, pageId, workspaceId, quote, createdBy, createdAt, resolved: Bool,
  resolvedAt: String?, resolvedBy: String?, comments: [ThreadComment] }`; `ThreadComment { id,
  threadId, authorId, body, createdAt, editedAt: String? }`. Comments are oldest first; the first
  started the thread. Times are ISO instants (UTC). Authors are user ids: `Core.members(...)` has
  names and colours (an author may be `deleted-user`). Bodies are plain text, 1 to 10 000
  characters (the server answers 400 for blank or longer). `quote` is the selected text, cut to 500
  characters. There is no mention parsing in the API (the server's notification hooks read `@name`
  from the body; the client sends plain text).
- **Who may do what** (server): anyone who can open the page can read threads (viewers too).
  Members and up can start a thread, reply, resolve and reopen (any of them, not only the
  starter); a viewer gets `CoreError.Server(status: 403, ...)`. Editing a comment: its author
  only. Deleting a comment: its author or a workspace admin; deleting the last one removes the
  thread. Deleting a whole thread: its starter or an admin. A reply to a resolved thread reopens it.
  Locked pages answer 403 until unlocked.
- **The anchor.** A thread is tied to the page text by a `comment` mark whose attribute
  `threadId` equals the thread's id (`Mark::Comment { thread_id }` in `content.rs`, so reading
  existing anchors already works). The server never touches the document: the mark is the client's
  job, and the server accepts any UUID as the thread id. **The call order the web uses**
  (`beginComment`, `submitComment`, `cancelComment` in `collabComments.ts`), which apple should
  follow:
  1. On Comment with a non-empty selection: `let id = newCommentThreadId()`; keep the selected
     text (at most 500 characters) as `quote`.
  2. **Mark the selection with `id` through the editor engine** (the web's `setComment(id)`), so
     the highlight shows while the composer is open and follows concurrent edits.
  3. The user types the comment; **then** `core.addCommentThread(pageId:, threadId: id, quote:,
     body:)`. Retrying with the same id returns the same thread (safe after a timeout); another
     user's id gives 409.
  4. If the user cancels, or step 3 fails for good: remove the mark of `id` (`unsetComment(id)`).
  5. When a thread is deleted (`deleteCommentThread`, or `deleteComment` returned `true`): remove
     its mark the same way. Resolved threads keep their mark; the web just stops highlighting them
     (it draws marks only for open threads that `pageComments` returned).
  **The engine has no such commands today** (`crates/nv-editor` and `EditorSession` have none and
  nothing in `nv-core` writes the mark), so the editor stream needs to add `set_comment(thread_id)`
  (mark the current selection) and `unset_comment(thread_id)` (remove every mark of that thread).
  Until it does, apple can list, create (step 3 alone), reply, resolve and delete threads and show
  `quote`, but a new thread has no highlight in the page. (The server's header comment in
  `comments.ts` says "create the thread, then add the mark"; the web does it the other way round,
  as above.)
- Live updates: the server publishes an event `{type: 'comments', workspaceId, pageId}` on its
  event stream when a thread changes; the core has no event stream yet, so refetch with
  `pageComments` after your own calls and when the page is opened.
- Swift names: `CommentThread`, `ThreadComment` do not clash with `apps/apple` (no `Comment*` or
  `Thread*` types there).

## For apple: task details (2026-11-22, `rewrite/core-tasks-full`)

All additions; nothing was renamed or removed, and `apps/apple` constructs `CoreTask(...)`
(`LookData.swift`), so **`Task` is unchanged** and the full task is a new record, `TaskDetail`.
Apple's open request ("task fields to write ... to read: `team_id`, `recurrence`, `reminders`,
`created_by`, `completed_by`, `assigned_by` ... tag, team and member lists with names") is
answered below. The truth for every field is the server: `server/tasks.ts` (`rowToTask`,
`validate`, `updateTask`), `shared/types.ts` (`Task`, `TaskPatch`, `Recurrence`, `Reminder`),
`server/routes/{tasks,reminders,teams,workspaces}.ts`; the web's use is
`src/components/TaskDetail.tsx` and `src/store/tasks.ts`.

**Reading.**

```swift
core.cachedTaskDetail(taskId:) -> TaskDetail?                // the stored task, instant
core.cachedTaskDetails(workspaceId:) -> [TaskDetail]?        // like cachedTasks
core.taskDetails(workspaceId:) throws -> [TaskDetail]        // like tasks(): sends queued changes first
```

There is no "get one task" on the server (only the workspace list, PATCH answers and the
`task` event), so a task's detail is the list's entry. `TaskDetail` = `Task`'s fields plus:

| Field | Type | Meaning |
|---|---|---|
| `title`, `description` | String | description is plain text, up to 50 000 characters |
| `done` | Bool | status `open`/`done` |
| `priority` | UInt8 | 1 urgent, 2, 3, 4 none (the default) |
| `dueDate` | String? | **local calendar date `YYYY-MM-DD`, no time zone** ("the 5th" is the 5th wherever you are) |
| `dueTime` | String? | **local `HH:mm`** (24 h), shown with the date; no zone either |
| `recurrence` | TaskRecurrence? | the repeat rule, below |
| `reminderAt` | String? | the original single reminder: an **ISO instant in UTC** (`2026-12-01T08:00:00.000Z`) |
| `assigneeId`, `assignedBy` | String? | user ids; `assignedBy` is who last set the assignee (server-set; none while unassigned) |
| `createdBy`, `completedBy` | String / String? | user ids (`createdBy` may be `deleted-user`) |
| `pageId`, `parentId` | String? | the note it is written on; its parent task (one level deep) |
| `teamId` | String? | one team |
| `tagIds` | [String] | no order |
| `checklistDone`, `checklistTotal` | UInt32? | counts of the plain checklists under the task in its note (server counts them when the page is saved) |
| `completedAt`, `createdAt`, `updatedAt` | String(?) | ISO instants, UTC |
| `locked` | Bool | on a locked page not unlocked: title and text withheld |

`TaskRecurrence { freq, interval?, byWeekday?, byMonthDay?, byNthWeekday?, until?, count?,
basis? }`: `freq` is `day`, `week`, `month`, `year` or `weekday` (Mon to Fri, no interval);
`interval` 1 to 365; `byWeekday` days 0 Sunday to 6 Saturday (weeks start Monday for "every 2
weeks on ..."); `byMonthDay` 1 to 31 or -1 (last day); `byNthWeekday { n: 1...5 or -1, weekday }`
("the 2nd Tuesday"); `until` is a `YYYY-MM-DD` (inclusive); `count` is the series length;
`basis` is `due` (default) or `completion`. A rule a newer server writes that this core can't
read comes back as no rule (the task still reads).

Not stored on the task, so not in `TaskDetail`: **subtask order** (the server has no position
field; the web lists subtasks by `createdAt`, the order in the task list; their order inside the
note is the note's) and **checklist items** (they are text in the page, only the counts are
fields; `taskNotes` returns them as Markdown).

**Writing: `core.updateTask(taskId:changes:) throws -> TaskDetail`.** One PATCH with only the
fields you set (a `TaskChanges` record; every field defaults to "leave it"). The call returns
the task as the server has it now.

```swift
TaskChanges(title:, description:, done:, priority:, dueDate:, clearDueDate:, dueTime:, clearDueTime:,
            recurrence:, clearRecurrence:, reminderAt:, clearReminderAt:, assigneeId:, clearAssignee:,
            teamId:, clearTeam:, tagIds:, pageId:, clearPage:, parentId:, clearParent:)
```

- **Set** a field by giving it a value; **clear** one by its `clear…` flag (`dueDate`, `dueTime`,
  `recurrence`, `reminderAt`, `assigneeId`, `teamId`, `pageId`, `parentId`): the call then sends
  `null`, exactly what the web sends (`updateTask(id, { dueDate: null })`). A value given with its
  flag wins. Absent means untouched. `title`, `description` ("" empties it), `priority`, `done`
  and `tagIds` (the whole list; `[]` clears) can't be null.
- **Server rules you will meet** (`server/tasks.ts`): only workspace members or editors of the
  note may edit; a viewer, or a note shared view-only, gets `.Server(status: 403 ...)` (the
  assignee may still tick or reopen). Teams and tags are for members. The assignee must be a
  member of the workspace (or someone the page is shared with). A subtask has no subtasks of its
  own and can't change page without its parent; `parentId` of a task that has subtasks is refused
  (400). `pageId`/`parentId` set `null` take a task off its note / make it its own task.
- **Ticking** (`done: true`): a recurring task is not completed: the server leaves a done copy
  in the history, moves the task's `dueDate` to the next date (and its single reminder by the
  same offset) and keeps it open. The returned `TaskDetail` is that open task. Offline the
  stored copy is shown done (the server's roll-forward arrives when the change is sent).
- **Checked first.** What the server would refuse (`validate`) is refused before anything is
  sent or queued, as `.Server(status: 400, message: ...)` with the server's own words (`Invalid
  priority`, `Invalid due date`, `Invalid due time`, `Invalid title` > 1000 characters, `Invalid
  description` > 50 000, `Invalid tags` > 50, `Invalid recurrence frequency/interval/weekdays/day
  of month/nth weekday/end date/occurrence count/basis`). Dates must be real dates (the server only
  checks the shape).
- **The web's two conveniences are the app's to do** (the core doesn't know your "today"): when
  it sets a **time** on a task with no due date it also sets `dueDate` to today; when it sets a
  **rule** on a task with no due date it sets `dueDate` to `firstOccurrence(rule:, from: today)`.
  Do both in the same `updateTask`.

**Offline.** The same queue as `setTaskTitle`: with a store, a change the server can't be reached
for is kept in `task_ops` (the stored PATCH body, so no schema change), applied to the stored
task at once and the call returns the task as it will be (`assignedBy` is you, `completedAt` and
`completedBy` set when ticking), `unsentTaskChanges()` counts it, `sendTaskChanges()` sends it, and
`taskDetails`/`tasks` lay waiting changes over the list. Several changes to one task are sent as
separate PATCHes in order. A refused queued change is dropped and noted in `taskError()`. Not
queued (the call throws `Network`): no store, a locked page, a task the store doesn't know. Tags,
teams, members, reminders and notes (below) are **online only**: they throw `Network` offline
(they are not cached).

**Creating with fields.** `NewTaskInput` has new fields after `done`, all defaulted, so existing
calls compile: `description`, `priority`, `dueDate`, `dueTime`, `recurrence`, `reminderAt`,
`assigneeId`, `teamId`, `tagIds`. They are validated like `updateTask`'s.

**The lists a task points into** (all `throws`, online only):

```swift
core.tags(workspaceId:) -> [TaskTag]                          // id, name, color "#rrggbb"
core.createTag(workspaceId:, name:, color:) -> TaskTag        // by name; an existing name (any case) returns it; "#" dropped; members and up
core.teams(workspaceId:) -> [TaskTeam]                        // id, name, color, parentId, memberIds
core.members(workspaceId:) -> [WorkspaceMember]               // id, name, email, color, role
core.taskNotes(taskId:) -> String                             // the notes under the task in its page, Markdown ("- [ ] x", "- [x] y"), "" if none
core.taskReminders(taskId:) -> [TaskReminder]                 // yours only
core.addReminder(taskId:, spec:) / updateReminder(reminderId:, spec:) / deleteReminder(reminderId:)
```

`ReminderSpec` is `.at(at: ISO UTC)` or `.before(minutes: 0...86400)` (before the task's due time,
or the user's default reminder time on a date-only task; it follows the due date when that
moves). At most 10 per task. `TaskReminder.nextFireAt` is when it fires next (none once fired, no
due date, or the task is done). Team creation and tag editing/deletion are admin screens and
aren't in the Core API.

**Quick add.** It is parsed on the client today (`shared/quickadd.ts`, used by
`src/components/QuickAdd.tsx` and the subtask field), so it is ported:

```swift
parseQuickAdd(text:, today:) -> QuickAddResult
// today: the user's LOCAL date "YYYY-MM-DD" ("tomorrow", "friday", "in 2 weeks" count from it;
// a malformed one means today in UTC). No time zone argument: dates have none.
QuickAddResult { title, dueDate?, dueTime?, priority?, recurrence?, assignee?, tags: [String], team?, tokens }
QuickAddToken { start, end, kind }   // UTF-16 offsets (String.utf16, NSRange); kind: .date .time .priority .recurrence .assignee .tag .team
```

Same words as the web: `today tod tonight tomorrow tmr tmrw`, `next week` (Monday), `next month`
(the 1st), `in N days|weeks|months`, weekdays (`fri`, `on friday`, `next friday`: the next one
strictly after today), `Nov 30`, `30 Nov`, `Dec 25th`, `2026-12-01`, times (`3pm`, `at 3:30pm`,
`at 15:30`, `noon`, `midnight`), `p1`..`p4` or `!p1`, `@name`, `#tag` (several; a letter first),
`+team`, and repeats (`daily`, `every 2 weeks on mon,thu`, `every month on the 15th`, `every 2nd
tuesday`, `every weekday`, ... with `until 2026-12-31`, `for 10 times`/`x10`, `after
completion`); "by", "due", "on", "at" before a date or time go with it. A repeat with no date
starts on its first matching day; a monthly or yearly rule is pinned to the date's day. It does
**not** resolve names or create anything: the web then does, and the app does the same:

```swift
let q = parseQuickAdd(text: line, today: todayLocal)
let me = core.user()!.id
let assignee = q.assignee.flatMap { resolveMember(mention: $0, members: members, me: me) } ?? me   // the web defaults to you
let team = q.team.flatMap { resolveTeam(text: $0, teams: teams) }   // unresolved: the web keeps " +text" in the title
let tagIds = try q.tags.map { try core.createTag(workspaceId: ws, name: $0, color: nil).id }       // makes missing tags
try core.createTaskWith(workspaceId: ws, task: NewTaskInput(title: q.title, pageId: page, done: false,
    priority: q.priority ?? 4, dueDate: q.dueDate, dueTime: q.dueTime, recurrence: q.recurrence,
    assigneeId: assignee, teamId: team, tagIds: tagIds))
```

(An `@name` that resolves to nobody stays in the title as `@name`, as the web does.) Also exported,
for the Repeat row: `describeRecurrence(rule:, dueDate:) -> String` ("Every 2 weeks on Mon,
Thu", "Every month on the last day", "Every year on Feb 14"; the web's task detail text) and
`firstOccurrence(rule:, from:) -> String`.

**How it was checked.** `scripts/corpus/quickadd.ts` runs the web's own `parseQuickAdd` over 134
lines for 4 "today"s (Thu 5 Nov 2026, leap day 2028, year end, month end: 536 results, tokens
included) and `describeRecurrence`/`firstOccurrence` over 21 rules, committed in
`tests/corpus/quickadd.json`; `crates/nv-core/tests/quickadd.rs` reproduces every one.
`crates/nv-core/tests/task_detail.rs` (scripted server: every field, bodies, clears, validation,
offline queue, lists, reminders) and `crates/nv-api/tests/client.rs` cover the calls; the
real-server test (`task_details_against_a_running_server`) sets and reads back every field,
clears them, ticks (plain and recurring), makes and unmakes a subtask, and runs reminders, tags
and members against `server/index.ts`. **Not run against a real server:** teams (the Core API
can't create one; `teams()` and `teamId` are tested with the scripted server only), a
non-member assignee, an edit refused as view-only (403), and the offline queue replaying a task
change against a server.

## For apple: boxes (2026-11-22, `rewrite/core-boxes`)

All additions (a new `BoxError` and new `LivePage` methods; nothing renamed), so today's Swift
compiles unchanged. Each call is **one local edit** on the live page, written in the web app's
own format (below), so it goes out like typing does: sent at once, kept in the store and resent
after a restart if offline. Units are the page's own: points from the page origin (what
`BoxGeometryStore` calls "from the surface origin").

```swift
LivePage.createBox(x: Double, y: Double, w: Double, z: Double) throws -> String   // the new id
LivePage.createBoxWithId(id: String, x:, y:, w:, z:) throws                       // your id; exists on a repeat
LivePage.moveBox(id: String, x: Double, y: Double) throws
LivePage.resizeBox(id: String, w: Double) throws                                  // also clears `wide`
LivePage.bringToFront(id: String) throws -> Double                                // the box's z afterwards
LivePage.deleteBox(id: String) throws                                             // empty boxes only
LivePage.deleteBoxWithContent(id: String) throws                                  // whatever it holds
newBoxId() -> String                                                              // free function
// enum BoxError (cases capitalised in Swift, as CoreError's): .NoSuchBox(id), .Exists(id), .NotEmpty(id), .Invalid(message), .Closed
```

- **Values.** x and y are rounded to whole points and clamped to 0...20000; `w` to 120...2400
  (the web's `clampPos`/`clampWidth`), so `moveBox` to a negative point puts the box at 0. `z` is
  stored as given. NaN or infinity is `invalid`. The web also snaps to the grid on ruled pages
  and starts a box 12 pt above a click: both stay the app's job (apple already does the 12 pt).
- **z.** "Front" is one above the highest z on the page; a box already alone on top stays where
  it is (nothing is written, the call returns its z); a tie at the top counts as not in front.
  For `createBox`, pass `z` = (highest z on the page) + 1 (0 if none), as the web does:
  `(page.info().boxes.map(\.z).max() ?? 0) + 1`.
- **A new box is empty**: an entry in `boxes` and an empty `box:<id>` fragment, like the web's
  `createBox`; the editor adds the first paragraph when it opens the box. It exists in the live
  document at once, so `EditorSession.openLive(page:, field: "box:" + id, ...)` works right after
  `createBox`, and so does `EditorSession.open` on `page.document()`; typing goes out through the
  session. Checked in `crates/nv-core/tests/boxes.rs` (typing reaches the stand-in server).
- **Deleting.** The web removes a box the user left empty without asking, and deletes a box with
  content only when the user selects it and presses Delete (with an undo toast; the core has no
  undo). So `deleteBox` refuses a box with content with `.NotEmpty` and changes nothing (empty
  paragraphs count as empty, as the web's `fragmentIsEmpty` does); for a user-chosen delete use
  `deleteBoxWithContent`. Neither deletes tasks on the box's task lines (the web does, through
  the task calls): read `readPage(document:).taskIds` first and `deleteTask` them.
- **Errors.** An id not on the page is `.NoSuchBox` (someone may have deleted it: drop it
  locally). After `close()` every call is `.Closed` and writes nothing. Locked pages: ordinary
  local edits, so they follow the existing rule (a locked page's edits stay in memory, nothing
  is queued in the store).
- **Implementing `BoxGeometryStore`**: `savesToServer = true`; `createBox(x:y:width:front:)` →
  `try page.createBox(x: x, y: y, w: width, z: front)`, return the id (no more `local-` ids);
  `moveBox` → `moveBox`; `resizeBox(_, width:)` → `resizeBox(id:w:)`; `bringToFront(_, z:)` →
  `bringToFront(id:)` (core computes z; the `z` argument isn't needed, or use the returned
  value); `deleteBox` → `deleteBox` (`deleteBoxWithContent` when the user chose to delete a box
  with text). Others' box changes arrive through `LivePageListener.onChange` (`PageInfo.boxes`)
  as before; a local call does not fire `onChange` for itself (like local typing), so redraw
  after the call.
- **The format, as the web writes it** (listed with sources in the header of
  `crates/nv-model/src/boxes.rs`): a box is a nested Y.Map in `boxes` with `x`, `y`, `w`, `z`
  numbers and `wide: true` only when set; moves and resizes set those keys on that map, and a
  resize deletes `wide`; ids are 16 base-36 characters (8 random bytes, two characters each,
  `newBoxId` in `src/editor/canvasGeom.ts`). A legacy plain-object entry is converted to a map
  the first time it is edited (the web ignores such entries).
- **How it was checked.** `scripts/corpus/box-ops.ts` runs today's web code (`newBoxMap`,
  `boxAtClick`, `frontZ`, `clampPos`/`clampWidth`, `boxGeoms`; `setGeom` and `removeBox` are
  copied from `CanvasEditor.tsx` because that file is React) on the `canvas-boxes` page and
  commits the result in `tests/corpus/box-ops/`; `crates/nv-model/tests/box_ops.rs` makes the
  same five edits through the Rust calls and compares the raw `boxes` map (after an
  encode/decode) and `Page::read` field by field. **Not run:** the web app reading bytes
  written by Rust (the structure is the same as the web's own, so it should); worth a look on a
  real page.

## For editor: boxes (2026-11-22)

Nothing to change. `EditorSession::open` / `open_live` read boxes through `Page::read` (their
`check_field`), which sees a box made by `LivePage::create_box` at once (its entry exists and its
fragment is empty), and opening an empty fragment adds the trailing paragraph as for any box.
`crates/nv-core/tests/boxes.rs` opens a new box by both routes and types in it. For later:
`nv_model::boxes::{create_box, move_box, resize_box, bring_to_front, delete_box}` take a
`yrs::Doc`, so a web-style box edit can be made on any doc, not only a `LivePage`'s.

## For apple: task calls (2026-11-21, `rewrite/core-tasks`)

All additions; nothing was renamed or removed, so today's Swift compiles unchanged (checked by
generating the Swift bindings on Windows; the Apple CI run is the real check).

- **The easy way: `core.pageTasks(workspaceId:pageId:) -> TaskCallbacks`.** Pass it as `tasks`
  to `EditorSession.open` (and later `openLive`) instead of `LocalTaskCallbacks`. Its calls
  return at once, so they are safe where the session calls them (with its lock held, on the
  main thread): titles come from this page's own changes, then the stored tasks; creates,
  renames, deletes and restores go to the server on its own thread (`nv-core-tasks`, one per
  `pageTasks` object, ended when it is released), in order, and are queued offline (below).
  Tasks are made in `workspaceId`, on `pageId`. Keep one per open page. A refused write shows
  in `core.taskError()`. There is no change notification yet: refresh the task list from
  `cachedTasks` (or `tasks`) when you next show it.
- **The calls themselves**, if apple keeps its own `TaskCallbacks` (all block on the network,
  so call them off the main thread, in order, e.g. on the serial queue):
  - `newTaskId() -> String` (free function): a random v4 UUID, lower case, as the web app's
    `crypto.randomUUID()`.
  - `createTaskWith(workspaceId:task: NewTaskInput) throws -> Task`; `NewTaskInput { id: String?,
    title: String, pageId: String?, parentId: String?, done: Bool }` (all but `title` have
    defaults). The server accepts the client's id (a UUID; `server/tasks.ts` `createTask`) and
    a retry with the same id returns the task it already made (409 if another user or workspace
    used it). An empty title is allowed. `done: true` is a create then a PATCH, as the web
    app's restore does.
  - `setTaskTitle(taskId:title:) throws -> Task` (PATCH `{ title }`; the server trims it).
  - `deleteTask(taskId:) throws` (DELETE `/tasks/:id`; subtasks go too, on the server and in
    the store; a task already gone, 404, counts as deleted; a refusal such as 403 puts the
    stored copy back).
  - `canRestoreTask(taskId:) -> Bool` (instant) and `restoreTask(taskId:) throws -> Bool`:
    bring back a task this Core deleted, with its subtasks, same ids and fields (description,
    due, priority, assignee, tags, recurrence…), done ones done again: what the web app's undo
    does (`restoreTasks` in `src/store/tasks.ts`; the server has no undelete, the task is made
    again with its old id). Needs a store (the fields come from the stored copy).
  - `cachedTask(taskId:) -> Task?` (instant, from the store, queued changes included).
  - `sendTaskChanges() throws -> UInt32` (send what was queued offline; returns how many still
    wait), `unsentTaskChanges() -> UInt32`, `taskError() -> String?`.
- **`TaskCallbacks` → Core** (what `pageTasks` does; for an own implementation):

  | `TaskCallbacks` | Core |
  |---|---|
  | `newId()` | `newTaskId()` |
  | `create(id, title, done)` | `createTaskWith(ws, NewTaskInput(id, title, pageId, nil, done))` |
  | `delete(id)` | `deleteTask(id)` (keep the title locally until it's done) |
  | `restore(id) -> Bool` | answer at once: "did this page delete it?"; then `restoreTask(id)` behind (falls back to `createTaskWith` with the old title when it returns false, e.g. no store) |
  | `title(id) -> String?` | this page's pending change, else `cachedTask(id)?.title` (never a network call: it is called while drawing) |
  | `setTitle(id, title)` | `setTaskTitle(id, title)` |

  The engine calls these with the session's lock held, so nothing in them may block on the
  network or call back into the session: do the Core call on another queue (in order), and
  answer `title`/`restore` from local state.
- **Offline.** With a store, a task write the server can't be reached for is kept in the store
  (new table `task_ops`, schema 3, upgraded in place), applied to the stored tasks at once, and
  the call returns as if it worked (the task as it will be). Writes are sent in order, one at a
  time: by `sendTaskChanges()`, before `tasks()` reads the list, and before every task write
  (a write made while earlier ones still wait queues behind them). `tasks()` lays writes still
  waiting over the server's list. A queued write the server then refuses (4xx) is dropped,
  noted in `taskError()`, and a refused create is removed from the stored tasks; 5xx and
  network errors keep it for later. Not queued (the call throws `Network` as before): without
  a store, for a task on a page the stored tree doesn't show unlocked (its title is the user's
  text), and for an edit of a task the store doesn't know. Apple could call
  `sendTaskChanges()` when a live page reaches `.synced`.
- **Behaviour changes** (no API change): `createTask(workspaceId:title:pageId:)` now sends an
  id the core makes; it, `setTaskDone` and the new calls queue offline instead of throwing
  `Network` (when the rules above allow), and `tasks()` sends queued writes first. Locked
  pages: unchanged (tasks are stored as the server sends them, redacted).

## For editor: the live doc (2026-11-21, `rewrite/core-tasks`)

Core's half of `EditorSession::open_live`; editor writes `open_live` in `editor_session.rs`.

- **What core provides** (`crates/nv-core/src/client.rs`, crate-visible, on `LivePage`):

  ```rust
  impl LivePage {
      /// The page's live document (a handle: clone it into the editor's binding).
      pub(crate) fn doc(&self) -> &nv_model::yrs::Doc;
      /// Run `hook` around every remote update; returns its id.
      pub(crate) fn add_remote_hook(&self, hook: Arc<dyn nv_sync::RemoteHook>) -> u64;
      pub(crate) fn remove_remote_hook(&self, id: u64);
      /// `close()` was called: edits on `doc()` are no longer sent.
      pub(crate) fn is_closed(&self) -> bool;
  }
  // nv-sync (crates/nv-sync/src/protocol.rs), re-exported as nv_sync::RemoteHook:
  pub trait RemoteHook: Send + Sync {
      /// Call `apply` once (it is called after you if you don't): it applies the update with
      /// REMOTE_ORIGIN and returns whether the document changed.
      fn around_remote(&self, apply: &mut dyn FnMut() -> bool);
  }
  ```

  And in nv-model: `nv_model::Page::fragment(doc: &Doc, name: &str) -> Fragment` and
  `nv_model::tree::read_fragment(txn, name) -> Vec<Node>` (now public): one fragment, `default`
  or any `box:<id>` with or without geometry, without reading the rest of the page (an absent
  fragment reads as empty).
- **Why a hook around the update, not a callback after it.** The engine's remote path takes
  sticky positions on the old tree *before* the update and maps them after
  (`remote.rs`: `stick` → `apply_remote` → `read` → `unstick`), and its `finish()` writes the
  whole tree as a diff against the fragment, so an edit landing between a remote update and
  the session's re-read would undo the remote change. `around_remote` lets the session hold its
  own mutex across stick, apply and re-read, so the session's tree and the fragment always match
  whenever the lock is free.
- **Local edits.** Any transaction on `doc()` whose origin isn't `nv_sync::REMOTE_ORIGIN` is a
  local edit: LiveDoc's update observer takes it when it commits (on the editing thread), keeps
  it in the outbox (the store) and sends it, exactly as `LivePage::apply_update` does. So the
  binding's `LOCAL` and `LOAD` writes (the trailing paragraph at open too) and the undo
  manager's writes all go out; nothing else to call. They are not reported back: `on_change`
  and the hooks fire only for updates from the server, and the server's echo of a local edit
  changes nothing (hooks see `apply() == false`). Tested in
  `crates/nv-core/src/live_doc_tests.rs` (edit on the doc with an own origin, online and
  offline: server, outbox, receipt; a remote update runs the hook with before/after; a hook
  holding its lock while another thread edits under the same lock).
- **Threads and locks.**
  - `around_remote` runs on the page's connection thread (`nv-sync`), for every remote update
    (sync step 2 after each connect, and updates), with no core or nv-sync lock held and no
    yrs transaction open. `apply()` opens a write transaction on the doc and commits it before
    it returns.
  - So the session's hook takes the session's `Mutex<Editor>`, then calls `apply()`. Local
    calls take the same mutex, then write the doc: one lock order (session mutex → yrs
    transaction), no deadlock. Inside the hook, hold no yrs transaction on the doc while calling
    `apply()` (the engine's `stick` drops its read transaction before returning: fine).
  - Several sessions on one page each add a hook; they nest (first added outermost), so during
    a remote update the connection thread holds every session's mutex at once, in the order they
    were added. Rule: never call into one session while holding another's lock (and
    `TaskCallbacks` must not call sessions). Don't call `LivePage::close()`, `apply_update`,
    `presence` or `unsent_updates` with the session locked (they take the page's lock, which
    `close()` holds while it waits up to 1 s for the connection thread).
  - The hook should hold the session through a `Weak` (the session holds `Arc<LivePage>`, which
    holds the hooks: a cycle otherwise); remove it in the session's `Drop`.
  - `LivePageListener::on_change` fires after the hooks, on the same thread: when apple hears
    it, the sessions already hold the new tree, so it just re-reads `state()` / `view_state()`.
  - Edits queued offline from an earlier run are applied to `doc()` before `open_live_page`
    returns, without hooks (no session exists yet).
- **What editor would change** (nv-editor, editor-owned):
  1. In `remote.rs`, a variant of `Editor::apply_update` that takes the apply step instead of
     bytes, e.g. `pub fn around_remote(&mut self, apply: &mut dyn FnMut() -> bool)`: the same
     `suspend_composition` / stick / *apply()* / read / unstick / `resume_composition` as today,
     with `b.apply_remote(update)?` replaced by `apply()` (skip the re-read when it returns
     false, if you like). `Binding::apply_remote` must not be used on the live doc: its origin
     (`nv-editor-remote`) isn't `REMOTE_ORIGIN`, so the update would be sent back out as a local
     edit (harmless, Yjs is idempotent, but wasteful).
  2. `Editor::open` already takes a `Doc` by value; `Doc` is a handle, so
     `Editor::open(page.doc().clone(), &field, …)` binds to the live doc itself. Nothing else in
     the engine owns a separate doc.
- **Suggested signature** (editor writes it in `editor_session.rs`):

  ```rust
  #[uniffi::export]
  impl EditorSession {
      /// `field` of a page open live: edits go out through the page, others' come in through it.
      #[uniffi::constructor]
      pub fn open_live(
          page: Arc<LivePage>,
          field: String,
          tasks: Arc<dyn TaskCallbacks>,
      ) -> Result<Arc<EditorSession>, EditorError>;
  }
  ```

  Sketch: refuse when `page.is_closed()`; check the field with `Page::fragment` or the box
  geometry (open after `LiveStatus::Synced`, or the doc may not have the box yet and the
  trailing paragraph written at open would merge in beside the server's content);
  `Editor::open(page.doc().clone(), …)`; keep `page` and the hook id in the session; the hook is
  `struct LiveHook(Weak<EditorSession>)` whose `around_remote` upgrades, locks the editor and
  calls `ed.around_remote(apply)` (or just `apply()` when the session is gone). In live mode
  `apply_update` / `encode_update_since` aren't needed (keep them for corpus pages). With
  `core.pageTasks(...)` as `tasks`, the session's task lines are backed by the server.

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

- 2026-11-22, search and comment threads (`rewrite/core-tasks-full`): nv-api `search`,
  `page_comments`, `add_comment_thread`, `reply_to_thread`, `set_thread_resolved`,
  `delete_comment_thread`, `edit_comment`, `delete_comment` with `SearchResult`/`CommentThread`
  types; nv-core `search.rs` (`Core.search`, `parseSnippet`/`SnippetRun`, `pageComments`,
  `addCommentThread`, `replyToCommentThread`, `resolveCommentThread`, `reopenCommentThread`,
  `editComment`, `deleteComment`, `deleteCommentThread`, `newCommentThreadId`). Tests:
  `crates/nv-api/tests/search_comments.rs`, `crates/nv-core/tests/search.rs` (scripted transport),
  the real-server test `search_and_comments_against_a_running_server` (page text written through
  a live page, found after the server's debounced save; a full thread round trip; passed locally
  on port 4457), Swift `testSnippetRunsAndThreadIds`. No server changes.

- 2026-11-22, the full task model (`rewrite/core-tasks-full`): nv-api `Task` with every server field
  (`assigned_by`, `completed_by`; missing and unknown fields tolerated), typed `Recurrence`,
  `TaskPatch` (`Option<Option<_>>`, `null` to clear), `Client::patch_task`, `completed_tasks`,
  `task_notes`, `tags`/`create_tag`, `teams`, `members`, `reminders`/`add_reminder`/
  `update_reminder`/`delete_reminder`; nv-core `task_detail.rs` (`TaskDetail`, `TaskChanges`,
  `updateTask`, `cachedTaskDetail(s)`, `taskDetails`, lists, reminders, `resolveMember`,
  `resolveTeam`, `describeRecurrence`, `firstOccurrence`, validation as `server/tasks.ts`),
  `NewTaskInput` with the quick-add fields, `quickadd.rs` + `recurrence.rs` (the web's quick add
  and repeat-rule text ported; new dependency `regex`), the offline queue carrying every field
  (no schema bump; optimistic copy sets `assignedBy`/`completedBy`). Tests: nv-api client tests
  (all fields, patch bodies, endpoints); `tests/corpus/quickadd.json` from
  `scripts/corpus/quickadd.ts` (the web's parser, 536 results, plus 21 rules) checked by
  `crates/nv-core/tests/quickadd.rs`; `crates/nv-core/tests/task_detail.rs`; the real-server test
  `task_details_against_a_running_server` (passed locally against `server/index.ts` on port
  4447); Swift `testQuickAddAndTaskFields`.

- 2026-11-22, box calls (`rewrite/core-boxes`): `nv_model::boxes` (create, move, resize, front,
  delete in the web's own format; `box_id_from`; `BoxError`), `crates/nv-core/src/boxes.rs`
  (`LivePage.createBox`/`createBoxWithId`/`moveBox`/`resizeBox`/`bringToFront`/`deleteBox`/
  `deleteBoxWithContent`, `newBoxId`, `BoxError`). Tests: nv-model unit tests (each call
  round-trips through `Page::read`, one update per call, clamping, plain-object entries),
  `crates/nv-model/tests/box_ops.rs` against `tests/corpus/box-ops/` (made by
  `scripts/corpus/box-ops.ts` with the web's code), `crates/nv-core/tests/boxes.rs` (create,
  `EditorSession` opens it and types, everything reaches the stand-in server), the real-server
  test extended (a box made on one sign-in, typed in, moved and widened; seen by the other and in
  the server's saved copy; passed locally on port 4437), Swift `testBoxCallsOnALivePage`.
- 2026-11-21, task calls and live-doc plumbing (`rewrite/core-tasks`): nv-api `delete_task`,
  `set_task_title`, `NewTask` with every TaskPatch field (and `Deserialize`); nv-store schema 3
  (`task_ops` queue with the locked-page rule, `task(id)` with an index, `remove_task` with
  subtasks); `crates/nv-core/src/tasks.rs` (`newTaskId`, `createTaskWith`/`NewTaskInput`,
  `setTaskTitle`, `deleteTask`, `canRestoreTask`/`restoreTask`, `cachedTask`,
  `sendTaskChanges`, `unsentTaskChanges`, `taskError`, `pageTasks` → `TaskCallbacks`; writes
  serialised, queued offline); `createTask`/`setTaskDone`/`tasks` routed through it; nv-sync
  `RemoteHook`/`RemoteHooks` around remote updates (`SyncDoc::remote_hooks`,
  `LiveDoc::remote_hooks`); `LivePage::doc`/`add_remote_hook`/`remove_remote_hook`/`is_closed`
  (crate-visible); nv-model `Page::fragment` and public `tree::read_fragment`. Tests: nv-api
  `task_writes_create_with_a_client_id_rename_and_delete`; nv-store task-op queue, removal
  with subtasks, upgrade from version 2; nv-sync `remote_hooks_run_around_each_remote_update_once`;
  nv-core `tests/tasks.rs` (online writes and restore, offline queue across a restart, refusals
  and overlay, locked pages and unknown tasks, `pageTasks`) and `src/live_doc_tests.rs` (above);
  nv-model `a_fragment_reads_on_its_own_with_or_without_geometry`; the real-server test now also
  creates a task with a client id, retries it, renames it, deletes it with a subtask, and
  restores it through a stored Core (passed locally against `server/index.ts`, on port 4427
  because 4417 was taken by another process).
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

Start each step in a fresh session (earlier contexts are large). What it needs to know:

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
  afterwards (on Windows: find the PID listening on 4417 with `netstat -ano`, then `taskkill /F /T`). If 4417 is already taken (another session's server), use another port, e.g. 4427; don't stop a server you didn't start.
- **nv-store (done).** `Store` (one account; `Mutex<Connection>`, shared as `Arc<Store>` by the
  `Core` and its `LivePage`s). Store write errors are ignored by the Core (fail soft, like
  `offlineCache.ts`) but kept in `Store::last_error` and printed to stderr. A schema change: bump
  `SCHEMA_VERSION` and append a step to `UPGRADES` (now at 3: the `outbox`, then `task_ops`). Page documents and
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
- **Tasks (done).** `tasks.rs`: every task write takes `TaskState::order` (one at a time, in
  order, across threads), sends the store's queue first, and queues itself on `Network` when the
  store allows (`nv_store::TaskOp`: create, PATCH, delete). `apply_locally` applies a queued
  write to the stored tasks (also re-applied over the server's list in `tasks()`). Deleted
  tasks are kept in memory (`TaskState::deleted`, cleared on sign-out) for `restore_task`.
  `PageTasks` is the Rust `TaskCallbacks` over the Core: a channel to one worker thread, a
  local title overlay cleared when each job settles (kept for good without a store). Not done:
  a change notification for task lists; queued edits of tasks the store doesn't know; the
  queue can't merge a create and a delete of the same task (both are sent).
- **Live doc for the editor (done, core's half).** `RemoteHooks` live in `SyncDoc` (shared by
  its clones); `SyncDoc::apply_remote` runs them nested around the transaction. Editor writes
  `open_live` (see "For editor: the live doc"); until then the `LivePage` accessors are
  `#[cfg_attr(not(test), allow(dead_code))]`.
- **Kotlin and Android.** uniffi's Kotlin from the same library (`--language kotlin`), plus
  `cargo-ndk` for `aarch64-linux-android`, `armv7-linux-androideabi` and `x86_64-linux-android`
  in a Linux job.
- **Known gaps.** The static library is about 44 MB per slice before linking; nobody has
  measured the linked size against the 10 MB budget yet. The corpus records today's quirks
  (mentions and page links missing from Markdown; page links missing from the search text).
