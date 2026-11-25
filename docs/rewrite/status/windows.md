# Windows stream status

Newest first. The overseeing session folds this into `docs/rewrite/STATUS.md`.

## Parity left (Windows, 2026-11-24)

Audit of `docs/rewrite/PARITY.md` (Windows column) against `apps/windows` at 8247569 (branch `rewrite/windows-audit`, docs only; no code touched). Of the 144 rows with a Windows ● or ◐, **69 are ticked ✓** (built and reachable in the app: checked by reading the code, with the UI tests in `Notivelo.Windows.UiTests` as evidence where one exists) and **75 are left**: 31 partly built, 44 missing. Class: **no-server** = doable now in the Windows app with core calls that exist (including Apple's new notification, share-link, delete-account and presence calls) or with none; **Devon** = needs Devon (store, signing, decision); **M7** = needs a new core call (the server route exists) or the M7 local-first work. Counts: no-server 46, Devon 3, M7 26 (25 need a new core call, 1 is offline page editing). Apple counted "new core call on an existing route" as no-server; under that rule the 25 move over. A ✓ means built and compiled; nothing ran against a real server and nothing was driven on a PC (every core-backed path is untested, as in the rounds below). Not listed: rows that are `—`/`○` for Windows (ink, local notifications, Face ID rows, app lock, share target, widget, universal links).

**Most used no-server rows, in order** (core everyday flows first):

1. ~~Task filters, sort, group, Team view, status filter (159, 156)~~ built (see above).
2. Ribbon buttons that do nothing (53): ~~Clear formatting, Link to page, Divider, text colour~~ built; Page colour and Rule lines wait for a core call; Print, Outline, Table group, highlight colour left.
3. ~~Notification inbox and taskbar badge (179, 178)~~ built.
4. Table tools, callout/toggle/code block (105, 106): partly built (left2: Table group, block menu; merge/split and toggle/code extras wait for apple-left3): engine commands (row and column add/delete, header toggle); toggle open/close, code copy.
5. ~~Boxes: select, cut/copy/paste/duplicate/delete, context menu (93)~~ built (see the left batch below).
6. Cursors and presence, follow a collaborator (94, 95): presence avatars and the "On this page now" list built (left2); carets and follow wait for apple-left3: `AnnouncePresence`, `Presence`, `RemoteCursors`, `SetRemoteCursors`.
7. ~~Save state indicator (96)~~ built (Saving, Saved, Offline, Offline — changes kept; "Connecting" shows as Offline).
8. Task keyboard, bulk bar, inline rename, Undo on toasts (162, 163, 164, 60): `UpdateTask`, `SendTaskChanges`; client code.
9. Opens offline from a cold start (222): open the shell from `CachedWorkspaces` / `CachedTree` / `CachedTasks` when `RestoreSession` fails with Network (today: signed-out screen with "Try again").
10. ~~Share link (126), Delete account (34)~~ built.

After those: tray, close-to-tray and Ctrl+Alt+N quick capture (250-252), Print and PDF (122, 123, 85, 166), Settings > Security > Locked notes (215), command palette commands (56), calendar drag to re-date (157), deep links (63).

**Built since (2026-11-24, `rewrite/windows-audit`, code in `apps/windows`): 7 rows moved to ✓** (compiled, unit tests green, UI tests written but not run; nothing drove a real server or a PC): task filters, sort, group, Team view and the Completed status (159, 156: `TaskViews.cs`, `TasksView.Filters.cs`; the choices are kept per view on the device); the notification inbox and the bell's badge (179: `Inbox.cs`, the rail bell); the taskbar badge (178: `TaskbarBadge.cs`, a numeric `BadgeUpdateManager` badge, which needs package identity, so a build run unpackaged shows none); the save state (96: Saving…, Saved, Offline, Offline — changes kept, polled every 2 s from `UnsentUpdates` / `UnsentPages`); the public share link (126: `ShareLinkBlock.cs` in the Share dialog); Delete account (34: `DeleteAccountDialog.cs`, Settings > Profile). **Row 53 and 99 are partly done:** Clear formatting, Link to page, Divider and the text colour menu work through the engine (`BoxTextView.Ribbon.cs`, `RibbonView.cs`); **Page colour and Rule lines have their menus but no core call to write a page's settings exists** (`PageSettings` is read-only in `nv-core`), so they only change the offline sample and say so on a live page; Print, Outline, the Table group and a highlight colour menu are left. Unverified: the live paths of every call above (`notifications`, `unread_notification_count`, `page_share_link`, `account_deletion_preview`, `delete_account`, `unsent_updates`), the Team cards' numbers against real tasks (a task's team comes from `TaskDetails`, loaded when a view needs it), the page picker opening after Link to page, and the divider picking when the caret is mid-word.

### no-server

| Row (PARITY line) | Windows today | What it needs |
|---|---|---|
| OneNote-style ribbon (53) | partly: as before, plus Clear formatting, Link to page, Divider and the Tasks ribbon's Group, Sort, Status, Assignee, Tags, Team, Priority, More filters and Clear filters | Page colour and Rule lines need a core call to write the page's settings (menus are built, live pages refuse); Print, Outline, Table group |
| Marks (99) | partly: text colour menu works (`setColor`, `unsetColor`); highlight stays a yellow toggle | a highlight colour menu (`setHighlight` with a name) |
| Tables (105); callout, toggle, code (106) | partly (left2): ribbon Table group (Add row, Add column, Table tools menu: row and column insert and delete, header row, delete table) and callout and toggle in the Text style menu; merge/split cells, column width, toggle open/close and code copy wait for apple-left3 | row/column commands, header toggle, merge/split; toggle opens; code highlighting |
| ~~Boxes: select, cut/copy/paste/duplicate/delete, context menu (93)~~ | built in the left batch (one box at a time; copies keep the same tasks) | multi-box selection waits for the multi-range selection (115) |
| Cursors and presence (94); follow (95) | partly (left2): who is on the page (avatars, list; polled every 3 s). Other people's carets in boxes and follow wait for apple-left3 (presence states carry the user only) | `AnnouncePresence`, `Presence`, `RemoteCursors`, `SetRemoteCursors` |
| Task keyboard, bulk, inline rename (162, 163, 164); Toasts with Undo (60) | missing | client code; `UpdateTask`, `SendTaskChanges`; Undo action on `OverlayHost` toasts |
| Opens offline from a cold start (222) | partly: tree and tasks load from the store once signed in; a cold start without network shows "Try again" | `CachedWorkspaces`/`CachedTree`/`CachedTasks` when `RestoreSession` fails with Network |
| Tray icon, close to tray, global quick capture, app shortcuts (250, 251, 252, 253) | missing; only Q, Ctrl+K, Ctrl+Shift+F, Ctrl+Z/Y, Ctrl+/ | NotifyIcon + `GetTaskCounts`; RegisterHotKey + `QuickAddDialog`; Ctrl+N, Ctrl+Shift+T, Ctrl+1-8, Ctrl+, |
| Print page/selection/PDF, Export PDF, print section/notebook, print task view (122, 123 PDF part, 85, 166) | missing (Markdown export is built) | Windows print APIs / PDF save |
| Settings > Security > Locked notes (215) | missing (lock, unlock, keepalive are built from the page menu) | `SetLockedNotesPassword` (create/change); Windows Hello needs Devon, reset by code needs a core call |
| Task detail: From the note, assigned-by (154) | partly: all other fields built | `TaskNotes`, `TaskDetails` |
| Calendar: drag to re-date, double-click to add, Tags and Team filters (157) | partly: month/week, Mine/Everyone, Status | `UpdateTask` on drop; client |
| Assignee menus grouped by team (160); recurrence Custom (165) | partly | `Teams`, `WorkspacePeople`; custom repeat editor, `DescribeRecurrence` |
| Favourites (50) | partly: Recent only | device-local list, no server |
| Trashed page opens read-only with Restore (84) | missing | `CachedTrashedPages`, `RestoreFromTrash`, `CanRestoreTask`, `RestoreTask`; read-only banner |
| Page links: create page from link (112); outline (117) | partly: the `[[` menu works; the outline is static bars | `CreatePage`; headings from the page content |
| Drag handle (114); multi-selection (115) | missing | handle view and line picks (engine `moveBlockUp/Down`); multi-range selection in the editor session |
| Spellcheck (121) | missing: custom text view | Windows spell-check API; needs a check on a real PC |
| Command palette commands (56); F6 regions (58); deep links (63); notebook templates picker (74); Privacy/Terms/Support in Settings > About (36); native window theme (255); import from OneNote link-out (232) | partly or missing | small UI work; protocol activation in `Package.appxmanifest` routing to `PageOpened`; title bar colours follow the theme; open the web importer in the browser |

### Devon

| Row | What it needs |
|---|---|
| Push reminders with snooze (176) | WNS registration in Partner Center and a core call for the device token |
| "New version available" (62) | decision: MSIX / Store update path (sideload has none; `.appinstaller` or the Store would do it) |
| Self-updater (254) | same decision |

### M7 (a new core call on an existing server route, or the local-first work)

| Rows | Missing |
|---|---|
| Resend verification email (28); export my data (35); send feedback (67); error reporting (68) | resend-verification, `GET /me/export`, `POST /feedback`, `POST /client-errors` |
| Create workspace (47); rename/delete workspace (196); workspace settings General, Teams, Tags, Activity (195); activity feed (181) | `/workspaces` create, `PATCH/DELETE /workspaces/:id`, activity |
| ~~Templates (134-140)~~ | built in left2 (see the dated section). Was: core calls now exist (Apple, apple-left2-core.md). Built in the left batch: New page from template (section menu), Save as template, `{date}` and `{time}`. Left: the empty-page picker, the ribbon entry, per-section scope, rename and delete, the default per section | UI only |
| Backlinks (113); full width, page colour, rule lines write (118, 119, 120) | `GET /pages/:id/backlinks`; a page-settings write on the live doc (colour and lines are shown, not changeable) |
| Saved views (161); tags rename/colour/delete (167); teams management (168) | `/workspaces/:id/task-views`, `/tags/:id`, `/teams/:id(/members)` |
| Notification settings extras (180) | quiet hours, calendar feed link, test notification |
| Export workspace, import from export (230, 231) | `GET /workspaces/:id/export`, import route |
| Opened pages editable offline, sync on reconnect (223) | store-backed screens and the offline queue (M7) |

## 2026-11-24: left2: templates finished, table tools, who is on the page, notebook drag (branch `rewrite/windows-left2`, from `rewrite/native` f30d23b)

Not merged; pushed. Built and 319 unit tests green on this PC (`dotnet build` of the sln, the UI test project and `dotnet test`); nothing was driven with input and nothing ran against a server (the UI tests in `Left2Tests.cs` and the shots in `LookShots.cs` are written for CI only).

- **CI** (branch `rewrite/windows-left2`):
  - 45497160372 on 16a43bc: 2 failures.
    - A ribbon flyout menu takes the keyboard, so Table tools and the Text style menu acted on no box. Fixed in 40b65f3: they now act on the box that last had focus (`BoxTextView.Target`).
  - 45501494077 on 40b65f3: 3 failures.
    - A typed "/" opens the slash menu only at a line start or after a space, so Callout and Toggle did nothing after other text. Fixed in aabee32: a space goes in first and is taken back after the pick.
    - After the first row of a table is deleted, the engine puts the caret on the line above the table (core quirk, for apple-left3). The test now steps back in with Down.
    - `Search_finds_tasks_and_the_sheet_edits_them` failed again. It is the second flaky run of this test, and nothing in this batch touches it.
  - 45505179122 on aabee32: green. Build x64 + arm64, 319 unit tests, 93 UI tests, look shots.
- **Waits for apple-left3** (core calls; nothing added to `crates/` here):
  - tables: merge and split cells, column width, header column, cell colours, and the caret after deleting a first row;
  - blocks: toggle open/close, code-block copy and highlighting;
  - other people's carets in boxes, and follow mode;
  - workspace, team and tag management.

- **Templates (134-140: all ✓ in PARITY).** An empty new page shows a strip with the three built-ins, "More…" and "Start blank" (dismiss); a template put on a page shows "Started from X" with **Start blank**, which undoes the insert (`LivePage.Undo`), deletes the template's tasks and clears a title or icon the template set (`PageView.Left2.cs`, `CoreNotesSource.Templates.cs` `ApplyTemplate`). Ribbon Page group > **Templates** and the page menu **Use a template…** open the picker for the open page (built-ins by `InsertTemplateContent`, saved ones by `UseTemplate`). Section menu: **Default template…** (inherit, None, or a saved template: `SetSectionDefaultTemplate`, read back with `SectionDefaultTemplates`, the effective one worked out up the section chain) and **Manage templates…** (rename, delete, and a button that cycles where a template is offered: everywhere, this section, not this section: `UpdateTemplate`). The New page button now asks the core for the section's default (`CreatePageFromTemplate` with "default", then the pending claim). Not possible with the core: a built-in template can't be a section default or be renamed (only saved ones are stored); the subsections flag is always on when a section is added to a scope; a saved template made private can't be a default (the core refuses). The template's tasks appear in the task list at once (`RefreshTasksNow`).
- **Tables and blocks (105, 106: partly).** Ribbon **Table** group: Add row, Add column and **Table tools** (insert row above and below, column left and right, header row, delete row, column, table), all engine commands (`addRowAfter`, `addRowBefore`, `addColumnAfter`, `addColumnBefore`, `toggleHeaderRow`, `deleteRow`, `deleteColumn`, `deleteTable`). The Text style menu gained Callout and Toggle (`pickSlash`); the slash menu already had them. **Waits for apple-left3:** merge and split cells, column width, a header column, cell colours (no engine command), toggle open/close from the keyboard, code copy and highlighting.
- **Presence (94: partly; 95: not).** The page bar shows an avatar stack (up to 4 circles, "+N") and its list **On this page now** (editing or viewing, devices); `LivePage.AnnouncePresence` plus `Presence` every 3 s (`CoreNotesSource.Presence.cs`, `PresenceRules.From` merges one person's devices). The sample shows one viewer, "Sample Viewer". **Waits for apple-left3:** other people's carets and selections in boxes (the presence states carry `{user}` only; `RemoteCursors`/`SetRemoteCursors` take offsets in a box with no way to learn them), and so follow mode.
- **Notebook drag.** In the notebook picker a notebook row drags before or after another (`MenuEntry.DragId/DropOn`, `TreeActions.DropNotebook`); **Move up / Move down** in the notebook menu is the keyboard path and is what the test drives.
- **Checked, one gap fixed (179, 126, 34).** Inbox, share link and account deletion read right against the core (`Notifications`, `PageShareLink`, `DeleteAccount` signs out in the core and the app clears the stored token). Gap fixed: a notification from another workspace now switches to that workspace before opening its page or task. Push registration stays out: the core takes only ios and android and WNS needs Devon.
- **UI readouts added** for the tests: a box's ItemStatus has `tables=RxC,…` and `in=<containers>`; ids `ribbon-add-row`, `ribbon-add-column`, `ribbon-table-tools`, `table-*`, `ribbon-block-type`, `block-*`, `ribbon-templates`, `empty-template-*`, `template-strip-blank`, `page-start-blank`, `page-presence`, `menu-presence`, `menu-default-template`, `menu-manage-templates`.
- **Unverified.** Everything on a real PC and server: the strip's layout, the live `Start blank` (undo of a template insert with several boxes), the default-template claim on a new page, the avatar stack colours, the notebook drag path with a pointer, and that the Table tools menu keeps the box's caret.

## 2026-11-24: the left batch: box clipboard, templates, reminder toasts, print (branch `rewrite/windows-left`, from `rewrite/native` cf41927)

Not merged; pushed. Nothing was driven with input on this PC; nothing ran against a server (the UI tests use the in-memory sample source). CI: 45466129166 on e3e64c1 had 1 failure: the box context-menu test right-clicked a guessed spot. Shift+F10 and the menu key now open a selected box's menu (d11858a), and the test uses them. 45470091475 on d11858a is green: build x64 + arm64, 311 unit tests, 83 UI tests, and the look shots (`template-picker`, `box-selected`, `box-menu`). The core's bindings were regenerated first (`build-windows.sh`).

- **Boxes (PARITY row 97, now ✓).** A box is selected as a whole by pressing its move bar or by Escape inside it (OneNote); an accent frame, the bar and the width handle show, and the page takes the keyboard. Then Ctrl+C, Ctrl+X, Ctrl+D (duplicate, nudged 24 pt down and right), Delete (with its text, one undo step), Ctrl+V (also with nothing selected), Escape lets go. Right-click on the bar or handle opens Cut, Copy, Paste, Duplicate, Delete; right-click on empty canvas offers Paste at the pointer. The clip is the core's `BoxesJson` string, put on the Windows clipboard under the format `NotiveloBoxes` next to its plain text and kept in the app too (`BoxClipboard.cs`, `BoxClipboardRules.cs`, `PageView.Boxes.cs`, `CoreNotesSource.Left.cs`). Copies keep the same tasks (taskMap empty, as Cut does) rather than making task copies; one box at a time. Test readout: `boxsel=1` in the box's ItemStatus.
- **Templates (134-140: partly).** Section menu > "New page from template…" lists the built-in three (ported from Apple's `Templates.swift`, `TemplateRules.cs`) and the workspace's saved ones offered in that section; a page menu "Save as template…" saves the open page (`CanvasTemplateJson` then `SavePageAsTemplate`, offered everywhere). A built-in template creates the page and inserts its content once the page is live (`InsertTemplateContent`, one undo step) and sets the title and icon if empty; a saved one uses `CreatePageFromTemplate` and `ClaimPendingTemplate`. `{date}`/`{time}` are filled by the core (row 142 ✓). Left: the picker on an empty page, the ribbon entry, "Start blank" undo toast, per-section scope, default per section, rename/delete, the template's tasks showing in the task list without a reload.
- **Reminder toasts (180: partly).** `ReminderToasts.cs` plans the next 50 reminders of the user's open tasks (`TaskReminders` per task, every 5 minutes and when tasks change) as `ScheduledToastNotification`s with a Snooze choice (10 minutes, 1 hour, tomorrow morning) and Open task; a tap opens the task (`AppNotificationManager`). Needs package identity: an unpackaged run keeps the plan and schedules nothing. Settings > Notifications shows "n reminders scheduled on this PC" (the UI-test readout). A local toast has no snooze token, so Snooze reschedules the toast on this PC only; `SnoozeReminder` (core) is wired for a push's token and used when a toast carries one. **Push (WNS) registration is not done**: it needs the app registered in Partner Center (Devon); the core has no Windows platform for `RegisterPushDevice` either (it takes "ios" or "android").
- **Print (126: partly; ribbon Print, Ctrl+P, page menu "Print…").** `PagePrint.cs` draws the page as laid out to a bitmap, scales it to the paper's width, cuts it into sheets and gives it to Windows' print dialog (`PrintManagerInterop`), which also offers Microsoft Print to PDF (so Save as PDF). A dark page prints on a dark sheet. Not done: print selection, print section/notebook, print task view.
- **Not done.** Notebook drag reorder (notebooks only show in a picker menu; Move up/down exist). Table tools and callout/toggle/code (105, 106).
- **Unverified.** Everything above on a real PC and server: box selection by the bar and Esc, the clipboard format round trip, whether `RenderTargetBitmap` captures the Win2D box text (the print bitmap may come out blank behind the text), the print dialog, toast scheduling and activation when packaged, the pending template claim on a real page.

## 2026-11-24: PARITY audit and the most-used rows left (branch `rewrite/windows-audit`, from `origin/rewrite/native` 8247569)

Not merged. Nothing was driven with input on this PC, and nothing ran against a server: the UI tests use the in-memory sample source.

- **Audit** (a12859a, docs only, by reading the code and UI tests):
  - Every Windows row marked ● or ◐ was checked; built rows now have ✓ in `PARITY.md`, and a "Windows ✓" line explains what the mark means.
  - Of 144 unticked rows, 69 were ticked; 75 are left (31 partly built, 44 missing). They are classed in "Parity left" above: no-server 46, Devon 3, M7 26.
  - **Not the same as Apple's classing:** 25 of the M7 rows only need a new core call on a server route that already exists (templates, workspace create, export and import, backlinks, page settings, saved views, tag and team management, feedback, resend verification). Apple's audit counts those as no-server.
  - Judgement calls:
    - Forgot password (opens the web flow, as Apple's does), the pasted invite link and tree drag are ticked. Tree drag has not been tried with a real mouse.
    - The email confirmation screen is not ticked, because it has no Resend.
- **Built** (a95d6a3, fixes 492b9af), the most-used rows that needed no server work. Seven rows are ticked:
  - **Task filters, sort and group (156, 159):**
    - The Tasks ribbon's Group, Sort, Status, Assignee, Tags, Team, Priority, More filters (due, source) and Clear filters now work. Show (Today, Upcoming, My Tasks, All) works too.
    - There is a search box with a count and summary, and Mine / Everyone on Upcoming.
    - The Team view shows a card per person, or groups by team.
    - Choices are kept per view on this device.
  - **Notifications (179):** a bell on the rail with an unread count and a popover. Opening an item marks it read; there is also Mark all read and Load more. It refreshes on sign-in, when the window is activated, and every 60 s.
  - **Taskbar badge (178):** shows my open tasks due today or overdue. It needs the packaged app, and an unpackaged run shows none.
  - **Save state (96):** the page bar shows Saving…, Saved, Offline, or Offline — changes kept. "Connecting" shows as Offline.
  - **Public share link (126):** create, copy, open, and turn off with a confirm, in the Share dialog.
  - **Delete account (34):** Settings > Profile. It shows the server's preview, asks for the password, shows a wrong-password message, then goes back to sign-in. The sample deletes nothing.
  - **Partly done, not ticked:**
    - Ribbon (53, 99): Clear formatting, Link to page, Divider and text colour work; Highlight is still a yellow toggle.
    - Page colour and Rule lines change only the sample page, since core has no call to write page settings (request below).
    - Print, Outline, the Table group and table tools are not done.
  - **Fixed after CI:**
    - The wrong-password message vanished as soon as the field was cleared.
    - A test used the wrong id for the Done status.
- **Next no-server rows by use:** table tools and callout/toggle/code; box select, copy and delete; cursors and presence; task keyboard, bulk bar, inline rename and Undo on toasts; opening offline from a cold start.
- **Needs a manual check, or a server:** every new path through the core; the badge in the installed MSIX; whether Link to page opens the page picker; the Team view with real tasks.
- **Requests to core:** a call to write page settings (page colour, rule lines); plus the M7 list in "Parity left".
- **CI runs** (branch `rewrite/windows-audit`):
  - 45400489250 on a95d6a3: 2 failures, both fixed.
  - 45403518954 on 492b9af: green. Build x64 + arm64, 280 unit tests, 73 UI tests, look shots.

## 2026-11-24: images and attachments, page tools, people and sign-up, tree and shell polish (branch `rewrite/windows-parity3`, from `origin/rewrite/native` e5ea45a)

Not merged. Nothing was driven with input on this PC: local checks were builds and unit tests; UI tests and screenshots ran on the GitHub runner. Nothing ran against a real server, so every `CoreNotesSource` path added this round is untested; the UI tests use the in-memory sample source.

- **Images and attachments** (`Controls/BoxTextView.Media.cs`, `MediaCache.cs`, `MediaPicker.cs`, `Data/Media.cs`, `SampleNotesSource.Media.cs`, `Text/MediaRules.cs`; core `uploadFile` / `fileUrl` / `downloadFile`, editor `insertImage` / `insertFile` / `setImageWidth`):
  - **Insert:** ribbon Picture and File (`ribbon-picture`, `ribbon-file`), `/image` and `/file` (open the picker), paste files or a bare bitmap, drop files on a box.
  - **Upload:** off the UI thread, "Uploading…" pill, errors as toasts (25 MB, empty, view-only, not found, offline). `image/*` except HEIC and SVG becomes a picture, anything else a file card; only the stored `/uploads/` path goes in the document.
  - **Display, resize, open:** pictures load through a signed link into a Win2D bitmap cached for the page (placeholder, retry after 20 s); file cards with type icon, name and size. Click selects a picture and shows 4 handles; dragging resizes, keeping the aspect ratio, with a minimum width of 80. Double-click or Enter opens a temp copy; Save as… from the right-click menu or the card's download icon.
  - **Left out:** a drop on empty canvas doesn't make a box; no keyboard resize. Real file dialogs, clipboard and drag-drop are only stubbed in tests (`NOTIVELO_TEST_PICK`, offline only).
- **Batch 2, page tools** (`Views/CommentsPanel.cs`, `Views/PageDialogs.cs`, `Data/PageTools.cs`, `CoreNotesSource.PageTools.cs`, `SampleNotesSource.PageTools.cs`):
  - Comments tab: threads, reply, resolve/reopen, edit, delete, @mentions; a Comment button on the floating bar marks text (`setComment` / `unsetComment`); badge on the top bar.
  - Version history: list, Markdown preview, restore.
  - Page sharing: people search, Can view / Can edit, remove, pending invites with revoke.
  - Locked pages: Lock page (sets the password first if needed), Remove lock, Lock pages now, an unlock screen, and relocking on 403 with a once-a-minute keepalive. Windows Hello is not done, and the Settings → Security entry point is missing.
  - Export as Markdown (FileSavePicker), Shared with me in the sidebar, page icon (emoji picker; shown in the tree, Recent and the title).
- **Batch 3, people and sign-up** (`Views/PeopleDialogs.cs`, `CheckEmailView.cs`, `AuthParts.cs`, `Data/People.cs`):
  - Create account on the sign-in card (`register`); the check-email screen re-checks via `restore_session`.
  - Workspace menu → Members: role menu, remove, invite by email with role, pending invites with Resend and Revoke, copyable invite link, Leave workspace.
  - Workspace menu → Join with invite link (pasted link or token).
  - `NOTIVELO_SOURCE=signup` previews the signed-out screens.
  - **Left out:** Resend on the check-email screen; no core call.
  - **Left out:** a standalone invite link with no email; no core call.
  - **Left out:** opening invite links by protocol activation.
- **Batch 4, tree and shell polish** (`Data/ShellPolish.cs`, `Views/NotebookShareDialog.cs`):
  - Colours: the section and notebook menus have Apple's 8 colours.
  - Notebook sharing: share with people, Make private, Share with workspace.
  - Tree: drag pages and sections (before, after, into), and Move up / Move down for pages, sections and notebooks.
  - Settings → Appearance: accent colours, and a System theme that follows Windows live. The theme choice is now kept.
  - Offline pill: in the top bar, plus a bottom pill after 30 s (`NOTIVELO_FORCE_OFFLINE=1`).
  - Shortcut sheet: from the account menu, Ctrl+/ or ?.
  - Page title: click it to rename.
  - **Left out:**
    - Notebook drag; the shortcut list is partly assumed.
    - The offline signal comes from network errors, not pending sync.
    - Print, templates and Get the apps need core calls.
- **Look** (CI shots compared with `look/reference`; 13 before-fix shots as `windows/p3-*.png`):
  - Fixed: the sign-up terms line was clipped; the notebook and section menus now open at the button's left edge (they covered the rail); the page panel now fills its height in Hybrid.
  - Most of the new screens (media, comments, versions, share, lock, members, join, shortcut sheet, sign-up, check-email, accent) have no reference: they were judged against the matched screens only.
  - The page and account menus carry fewer items than the reference.
- **Needs a manual check:**
  - picture resize and tree drag with a real mouse;
  - paste, and drop from Explorer;
  - the real file dialogs;
  - every core-backed path against a server: upload, signed links, comments, versions, sharing, lock, register, members.
- **Requests to core:** resend verification email; standalone workspace invite link create/revoke; a lock-state read without a 403; comment-anchor ranges for highlighting; a connection/pending-sync signal; plus the earlier list (templates, favourites, saved views, bell and activity, workspace create/rename/delete, export/import, backlinks, public links).
- **CI runs** (branch `rewrite/windows-parity3`):
  - 45323584416 on 4c4acc6: 1 failure (resize test hit the wrong corner; fixed by reading the corner from the box).
  - 45325725142 on fb52402: 2 failures (tree rows have no Invoke pattern; tests now click).
  - 45328154688 on 1585d70: green. Build x64 + arm64, 253 unit tests, 67 UI tests, 83 look shots.
  - 45330277630 on 3256c45 (look fixes and this status): one failure in `Search_finds_tasks_and_the_sheet_edits_them` (the Tasks row not found in time; nothing this round touched it), green on a re-run of the UI job: 67 UI tests, look shots. That test looks flaky.

## 2026-11-24: ink editing and task detail (branch `rewrite/windows-ink`, from `origin/rewrite/native` 5b7f5f4)

Not merged. Nothing was driven with input on this PC: local checks were builds and unit tests; UI tests and screenshots run on the GitHub runner. Of the PARITY batches below, only batch 1 (task detail) was done this round; batches 2-4 are next.

- **Ink editing** (`Views/InkBar.cs`, `Views/InkOverlay.cs`, `SampleNotesSource.Ink.cs`; Apple's InkSession / InkTool / InkBar / MacInk):
  - **Pen row:** opened by ribbon Draw (`ribbon-draw`) and shown under the ribbon. It has select/type, pen, highlighter, stroke eraser, partial eraser and lasso; Apple's colours and 3 widths (remembered); Delete for a selection; and close. A lasso icon was added to the generated set.
  - **Input:** an overlay on top of the canvas takes the pointer only while a tool is active.
    - Pen pressure and intermediate points feed the core stroke builder, with a live preview; the stroke is committed on release.
    - The pen's eraser end erases. Mouse and touch draw with pressure 0.5.
  - **Lasso:** select by loop or tap, drag to move, Del/Backspace to delete, Esc to clear.
  - **Undo:** ink steps are in page undo (`LivePage.Undo`); the sample source has its own in-memory ink and undo.
  - **Core calls:** `InkStrokeBuilder` (`PushMany`, `Preview`), `LivePage.AddInkStroke`, `EraseInk`, `InkHitLasso`, `InkHitPoint`, `MoveInkStrokes`, `DeleteInkStrokes`, `InkStrokes`.
  - **Left out:** eraser dimming of the strokes it would take, tilt, Windows Ink `InkCanvas`, the finger-draw toggle; the sample's partial eraser removes whole strokes.
  - **Bugs found by CI and fixed:**
    - `Canvas.SetZIndex` on the overlay threw and killed the app; the overlay now sits in a host Grid.
    - Releasing pointer capture before ending the stroke cancelled every stroke.
  - **Needs a manual check with a real mouse or pen:**
    - On the runner, synthetic mouse moves between press and release arrive as a few jumps: the test wave is drawn nearly flat, and a drawn lasso loop collapses into a tap. So the lasso UI test selects by tapping the stroke.
    - Whether real pointer moves come through densely (they should), the lasso loop, and Ctrl+Z while the overlay has focus.
  - **Look:** `windows/ink-ink-toolbar-light.png`; there is no reference for the pen row. The grid on "Settings and ink" stops around the content, while `page-settings-and-ink.png` fills the whole page (gap).
- **Batch 1, task detail** (Apple's TaskDetail, TaskPickers, PageTasks, CalendarScreen):
  - **Task sheet:** Team, Tags (pick or create), Time, Repeat (presets, clear), Reminders (add, remove), the due date in words, and Subtasks (add, tick, progress).
  - **Quick add:** the team, tags and assignee chips are pickers.
  - **Tasks-on-this-page panel:** docked right, opened from the top bar's tasks button.
  - **Calendar:** week view, Mine / Everyone, and the Status filter (kept on the device).
  - **Sample source:** all of it in memory.
  - **Bug fixed:** re-parenting the focused subtask input during a refresh crashed the app (COMException 0x800F1000); the input now lives in a fixed row.
  - **Left out:**
    - task sheet: Repeat "Custom…", subtask priority; Time uses the stock WinUI TimePicker;
    - calendar: drag to re-date, double-click to add, Tags and Team filters;
    - the page panel's Comments tab is a stub;
    - assignee menus aren't grouped by team.
  - **Open question:** in the quick-add pickers test, a real mouse click on a Tasks row did not open the sheet, so the test opens it through search. Check by hand whether clicking a row works.
  - **Screenshots:** `windows/ink-task-sheet-full-light.png` (the tag picker was left open in that shot), `ink-page-tasks-panel-light.png`, `ink-calendar-light.png`.
- **PARITY rows done on Windows by this round** (not marked ✓ in PARITY.md; marking is left to the overseer to avoid conflicts there):
  - from earlier rounds, per the audit: 43 rows such as sign in, profile, change password, sign out, tree actions, Trash, search, quick add;
  - this round: "Task detail (all fields)", "Quick add (Q)" pickers, "Tasks on this page panel", "Reminders: fixed time or N minutes before", "Recurrence" (presets), "Subtasks (one level, progress 2/5)", "Calendar: month / week, Mine / Everyone", and ink drawing.
  - The full row-by-row audit (DONE 43, PARTLY 37, TODO with core calls 37, TODO needing core 25, images 2) is in the shared session notes folder as `windows-parity-audit.md` (before batch 1).
- **Next batches** (core calls exist):
  - 2, page tools: comments, version history, page sharing, locked pages, Markdown export, Shared with me, page icon.
  - 3, people and sign-up: native sign-up, the check-email screen, invite links, members, roles and invites.
  - 4, tree and shell polish: section and notebook colours, notebook sharing, drag to reorder, accent colours, System theme, offline pill, the shortcut sheet, editable page title.
- **Requests to core** (no calls yet): templates, favourites, saved views, the notification bell and activity feed, workspace create / rename / delete, export and import, backlinks, public share links.
- **CI runs** (branch `rewrite/windows-ink`): 6.
  - 45301548389 and 45303817389 on 491aad9 / 42722df: the app crashed (SetZIndex).
  - 45305927506 on 0940fc4: 7 failures (cancelled strokes, the subtask crash).
  - 45307980432 on 05f8b3f: 3 failures.
  - 45309864659 on 2d92053: 1 failure (lasso loop).
  - 45311303561 on 3c7f6bf: green. Build x64 + arm64, 132 unit tests, 37 UI tests, 46 look screenshots.

## 2026-11-24: look pass with CI screenshots, Settings on the account calls, sideload MSIX (branch `rewrite/windows-look`, from `origin/rewrite/native` 9ed16e7)

Not merged. Nothing was driven with input on this PC: local checks were builds and 106 unit tests; every screenshot below comes from the GitHub runner.

- **CI screenshots** (`UiTests/LookShots.cs`, workflow step "Look screenshots", `continue-on-error`; artifact `windows-look-screenshots`, 7 days): offline mode, client area 1180x820 (the workflow raises the runner's display to 1920x1080 first; before that the window was clipped at 1024x768), DWM frame capture, in **light** and **hybrid**: canvas page (unfocused, focused), page-canvas, page-ink, workspace menu, notebook picker, account menu, section menu, quick add, search palette, task sheet, Trash dialog, name dialog, Tasks, Calendar, Settings (Profile, Password, Notifications, Connected apps, Appearance). 40 files; a screen that can't open is logged and skipped. Kept in the repo: `windows/look-settings-light.png`, `look-quick-add-light.png`, `look-calendar-light.png`, `look-account-menu-light.png`, `look-task-sheet-hybrid.png`, `look-page-ink-hybrid.png`.
- **Compared with `look/reference/ipad-landscape` and fixed** (two passes, by reading each shot next to its reference):
  - Text: mojibake ("Â·", "â€"") in sample strings came from one invalid UTF-8 byte that made csc read `SampleNotesSource.cs` as ANSI; fixed, and the project pins code page 65001.
  - Menus: widths as the references (workspace 252, notebook picker 272, account 260, section 252); account order name, Theme, Settings, Sign out.
  - Overlays: the scrim uses the `BgOverlay` token (.32; it was a hard-coded .18), so every overlay dims as the references. Primary buttons have a disabled state with white text on the pale accent.
  - Quick add: chips 42 high with bold labels, buttons 44, card position. Now matches `quick-add.png` closely.
  - Settings: one scrolling page with Profile and then Password, as `settings.png`; content to a 32 right margin; the reference's 8 avatar swatches in its order; heading and nav sizes. Now matches closely.
  - Calendar: the duplicate Today / previous / next removed (they're in the ribbon), "No date" tray 220 wide, 110 high rows, day numbers left-aligned. Sidebar gained a RECENT row and the Calendar panel's mini month (its own previous / next don't move the main grid).
  - Task sheet: 18 tick, 120 label column, 46 row pitch, title size.
  - Search: borderless input. TextBoxes everywhere get a flat 1 pt border.
  - Sample data uses the seed's "Demo User" / demo@example.com.
  - Left, because they're missing features rather than layout: account menu System theme, Keyboard shortcuts, Get the apps (also in the Settings nav); workspace menu New workspace, Workspace settings, Activity; section menu templates, Print, colour row; task sheet Team, Tags, Time, Repeat, Reminders, Subtasks (and the due date is a picker where the reference shows text); Calendar Status filter; search "Create task" row; Tasks stats card ~3 px short. Not checked against a reference: Trash dialog, name dialog, Settings sub-sections other than Profile/Password.
- **Settings on the core's account calls** (`SettingsView.Account.cs`; `INotesSource` account methods, `AccountResult`): Profile (`profile`, `update_profile` name and colour), Password (`change_password`; the returned refresh token is stored in the Credential Locker straight away, since the old one is dead; `wrong_password` shows under the field), Notifications (`notification_settings` / `update_notification_settings`: email, default reminder time, digest and time, time zone from a list of 39 IANA zones), Connected apps (`connected_apps`, `disconnect_app` after a confirm). Offline (`CoreError.Network`) shows "Offline" and changes nothing. The sample source serves all of it in memory. 14 new unit tests (`AccountRulesTests`, input rules). The avatar colour isn't shown elsewhere yet (the workspace member record has no colour). Not run against a server.
- **Sideload MSIX**: CI patches the Publisher to `CN=Notivelo Dev, OID.2.25.311729368913984317654407730594956997722=1` in its checkout only (the committed manifest is unchanged) and uploads `notivelo-windows-x64-msix-unsigned` and `notivelo-windows-arm64-msix-unsigned` (14 days). `apps/windows/SIDELOAD.md`: `Add-AppxPackage -AllowUnsigned` from an administrator PowerShell on Windows 11, update, remove, caveats. The OID and `-AllowUnsigned` match Microsoft's unsigned-package docs; not yet installed on a PC.
- **CI runs** (branch `rewrite/windows-look`): 3, all green. 45274791023 on 85d6619 (first shots, clipped, quick add missing); 45278325314 on 11729bf (full-size shots); 45280380384 on 163be12: build x64 + arm64, 106 unit tests, 28 UI tests, both look runs, both MSIX artifacts.

## 2026-11-24: parity round 2: page undo, overlay menus, floating bar, quick add, Calendar, Settings (branch `rewrite/windows-parity2`, from `origin/rewrite/native` af067b5)

Not merged. Links, the `[[` / `@` menus, box create/move/resize and read-only ink were already in from parity A (merged), so this round did the rest. Nothing was driven with input on this PC: local checks were Release x64 builds and the 92 unit tests; the input paths are checked by UI tests on the runner. Not looked at against the references by eye this round (no screenshots taken): the menus, quick add, Calendar and Settings were built from the Apple sources and the reference PNGs, layout unchecked.

- **Page undo** (core's `LivePage.Undo()` / `Redo()` / `CanUndo()` / `CanRedo()`, `PageUndoException` caught): `INotesSource.PageUndo` / `CanPageUndo` (null = page not live). Ribbon Undo/Redo, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z in a box and at page level (`ShellView.OnShellKey`) go through `PageView.Undo`; afterwards `live.Info()` is re-read, every open box session re-renders and ink is drawn again. Ribbon enabled states follow the page. Offline/sample pages keep `EditorSession` undo. Box sessions live as long as the page, so text steps stay; a box brought back by undoing a delete gets a fresh session (its earlier text steps are gone). No UI test (offline mode has no `LivePage`).
- **Notebook picker and account menu on the overlay popover** (`PopupMenu` gained tile, check, lock, section label and custom rows): picker = "My notebooks", a colour tile per notebook, a check on the open one, a lock on private ones, New notebook (as `menu-notebook-picker.png`). Account = name and email, Light / Dark / Hybrid switch, Settings, Sign out (signed in only). Left out: Keyboard shortcuts and Get the apps (nothing behind them), "System" theme.
- **Floating format bar** (`Controls/BoxTextView.FloatingBar.cs`; Apple's iOS `FloatingToolbar`): over a non-empty selection in a box: H1-3, Quote, Bold, Italic, Underline, Strike, Code, Link, Task through `RunCommand`, pressed states from `Active`. A `Popup` like the link editor (overlay layers would block the canvas). Missing: text colour, highlight, comment; it does not follow page scrolling.
- **Quick add** (`Views/QuickAddDialog.cs`; QuickAdd.swift, `quick-add.png`): 560 wide card; `NvCore.ParseQuickAdd` on each key, chips for due, priority, assignee (Me / @name), team, tags, repeat and page; due and priority chips open menus that override the line. Enter adds and closes, Ctrl+Enter adds and stays. Opens with Q (no box focused), sidebar and Tasks "Add task", ribbon New task (Tasks, Calendar), a Calendar day's "+". `INotesSource.AddTask(NewTask)`: the core source resolves @member and +team, finds or creates tags, then `CreateTaskWith`; the sample source adds in memory. The team, tags and assignee chips only show what the line says (no pickers); no custom date picker on the due chip.
- **Calendar** (`Views/CalendarMonthView.cs`; CalendarScreen.swift, `tasks-calendar.png`): Monday-first month grid of open tasks by due date, today marked, "No date" tray, Today / previous / next in the header and the Calendar ribbon; a task opens the task sheet. Missing: week view, the Status filter, Mine / Everyone, the sidebar mini calendar, drag to re-date.
- **Settings** (`Views/SettingsView.cs`; SettingsScreen.swift, `settings.png`): a route from the account menu: Profile (name and email read-only, Sign out), Appearance (Light / Dark / Hybrid), About (server host, app and core version); ribbon Back. Left out (nothing behind them on Windows yet): avatar colour, password, security, notifications, connected apps, get the apps, keyboard shortcuts.
- **UI tests** (`ParityTests.cs`, 6 new, offline mode): notebook picker lists the notebooks; account menu theme switch; floating bar shows on select-all and goes on collapse; quick add makes a task that shows in the list; Calendar grid and navigation; Settings from the account menu. UIA ids on the cards moved from `Border` (no automation peer, so invisible to UIA) to the panel inside, with a `Name`.
- **Windows vs Apple parity**, still missing after this round: the list in parity B below minus quick add, Calendar view, notebook picker / account menu and settings; plus the gaps named above (Calendar week view and filters, quick-add pickers, floating bar colour / highlight / comment, most Settings sections).
- **Requests to core**: (1) `undo()` saying what it undid (box id / kind) so the app can scroll to it; (2) keep a box's text steps when its session is replaced after an undone delete (or say the app should keep the old session); the parity B requests (page title on task hits, `created_by`, tag/team/checklist reads, restore place, workspace create) still stand; `parse_quick_add` is exposed to C# (done).
- **CI runs** (branch `rewrite/windows-parity2`): 2. 45245292930 on bfc76fe: build and 92 unit tests green, 5 of the 6 new UI tests failed (ids on `Border`s); 45247894947 on 36df223: green, build x64 + arm64, 92 unit tests, 28 UI tests.

## 2026-11-24: parity B: tree actions, Trash, search, task sheet, page colour (branch `rewrite/windows-parity`, on parity A)

Not merged. Nothing was driven with input on this PC: local checks were builds (as CI: `-p:WindowsPackageType=None -o <dir>`), 92 unit tests and passive window screenshots (`NOTIVELO_SOURCE=sample`). The input paths are checked by the new UI tests on the runner.

- **Overlay layer** (`Controls/Overlay.cs`, `PopupMenu.cs`, `Views/Dialogs.cs`): menus, dialogs, the search palette and the task sheet are drawn inside the window on one `OverlayHost` (scrim, Esc closes, toasts) instead of `MenuFlyout` / `ContentDialog`, so they follow the LOOK 4.9 popover (elevated, 1 pt border, radius 12, 32 high items, icon column, danger red, hints) and the UI tests can see them in the UIA tree. The workspace menu is this popover too (workspaces with the role as hint, a check on the open one, Trash); the notebook picker and account menu are still `MenuFlyout`.
- **Tree actions** (`Views/ShellHost.cs` `TreeActions`; the core calls Apple's `changeTree` makes, and the tree is read again after each): notebook "..." (New section, Rename, Delete notebook), section row hover "+" and "..." or right-click (New page, New subsection, Rename, Duplicate = `copy_section`, Move to..., Delete section), page row "..." or right-click and the top bar "..." (Rename, Duplicate = `copy_page`, Move to..., Delete page), "New notebook" in the picker, "+" next to SECTIONS, "New page" on an empty section. Calls: `create_notebook`, `create_section`, `create_page` (and opens it), `rename_*`, `move_page`, `move_section`, `delete_*` (to the Trash, after a confirm). Rename and create use a name dialog; Move to... a destination list (notebook headings, nested sections; a section cannot go into itself). A page that was deleted closes.
- **Trash** (`Views/TrashDialog.cs`, from the workspace menu): `trash` list with path, who deleted it and days left; Restore (`restore_from_trash`, toast "Restored to ..."); the trash button turns into a red "Delete forever" (`delete_forever`) and "Empty Trash" does the same (`empty_trash`): two clicks each, as Apple.
- **Search** (`Views/SearchPalette.cs`; Apple's Search.swift): rail search button, Ctrl+K or Ctrl+Shift+F when the keyboard is not in a box. A focused box handles Ctrl+K itself (the link editor; `BoxTextView.HandleKey` returns handled before the event can bubble to the shell), so the two do not clash. Title matches from the tree show at once, then `search(workspace, query)` 150 ms after the last key replaces them: pages with the matched snippet (accent bold runs) and path, tasks with the due label. An empty query lists the 5 recent pages. Up/Down, Enter opens a page or the task sheet, Esc closes; "No results" when empty.
- **Task sheet** (`Views/TaskSheet.cs`, LOOK 4.10): 480 wide from the right over a dim scrim; opens from a Tasks-view row, a page task line's open icon or title, or a search hit. Title (Enter or leaving the box), tick circle, assignee menu (workspace members), due date (calendar picker plus clear), priority menu (1-3, none), description (on leaving the box), delete task (confirm, `delete_task`). All through `update_task` (`TaskChanges`): the local task list changes first and is merged with the core's answer (a refusal reloads the list). Ticking the circle in Tasks rows and on page task lines does the same; page task lines are drawn again when the task list changes (`TasksVersion`).
- **Page colour and rule lines** (`PageView`): the tint (LOOK 1.3 light/dark table) fills the page including the top bar; Lines draws a 1 pt `--page-rule` line at the bottom of each 28 pt band from 7 pt below the surface top, Grid adds vertical lines, under the boxes. Box text is not snapped to the lines yet.
- **Offline/sample source** (`SampleNotesSource.Parity.cs`): the tree (create, rename, duplicate, move, delete, Trash), search and task edits work in memory, so the UI tests need no server. The sample "Settings and ink" page is blue with a grid.
- **UI tests** (`ParityTests.cs`, 6, offline mode; UIA Invoke/Value on named elements plus a few real keys): rename a page through its "..." menu and the name dialog; delete a page, then restore it from the Trash; new section from the notebook menu; search "sandb" and open the page with Enter; search a task, open the sheet, set priority 3 and a new title, see the title in the Tasks view; tick a task in the Tasks view. Dev hook `NOTIVELO_SHOW=search:text|trash|task:id|menu-section:id|menu-page:id|menu-notebook` opens an overlay for screenshots (loopback `NOTIVELO_SERVER` only).
- **Screenshots** (passive, 1180x820 at 150 %): `windows/parity-search.png` (palette over the canvas page, snippets matched in accent) against `ipad-landscape/search.png`: same structure (input row, groups, rows with right-aligned sub, footer hint); the reference is light, ours Hybrid dark; no "Create task" row yet. `windows/parity-colour-grid.png` (sample "Settings and ink": blue tint, grid, ink) against `page-settings-and-ink.png`: tint and grid match. Also seen, not committed: the section menu (as `menu-section.png` minus New page from template, Default template, Print and the colour row), the task sheet (as `task-detail.png` minus Team, Tags, Time, Repeat, Reminders, Subtasks) and the Trash dialog. Not seen with a pointer: row hover buttons, right-click menus, the calendar picker.
- **Requests to core**: (1) task search hits and the task list need the page title or crumb so a row can say "on <page>" (today the app joins on the tree); (2) `Task` (list item) lacks `created_by`, so the sheet says "Created 6m ago" only: a cheap synchronous `cached_task_detail` read (as `cached_tree`) would give "Created by X"; (3) tag names and colours, teams, and checklist reads for the sheet's Tags, Team and Subtasks rows; (4) `restore_from_trash` returning the place as ids (notebook, section) so the app can open the restored page; (5) `parse_quick_add` for the palette's "Create task" row and the Tasks "Add task" (not built here yet; say if it is exposed to C#); (6) a workspace create call for the menu's "New workspace".
- **Windows vs Apple parity** (still missing on Windows):
  - Tree: Favourites and Recent groups, drag to reorder or move, notebook and section colour row, sort pages, share with people, make private or shared, lock page, templates (New page from template, Default template, Save as template), Print, Export, Import, page icon, an Undo toast after delete, "Shared with me".
  - Page: top bar Share, Comments panel, Tasks-on-this-page panel, version history, backlinks ("Linked from"), a live outline rail (it is static), text snapped to rule lines, box right-click menu and empty-canvas menu, ink drawing and erasing.
  - Tasks: "Add task" and quick add (Q), saved Views, the filter and grouping toolbar, Calendar view, Team view content, the sheet's Team, Tags, Time, Repeat, Reminders and Subtasks, checklists, "Create task" in search.
  - Shell: ribbon buttons are placeholders (formatting, Page colour and Rule lines menus, Task button), notifications bell, settings, theme choices beyond cycling, accent colours, phone layout, shortcut sheet, offline banner, sign-up and password reset.
- **CI runs** (branch `rewrite/windows-parity`): 1 run, 45219521035, green first time: build x64 + arm64, 92 unit tests, 22 UI tests (the 16 earlier and the 6 new).

## 2026-11-24: parity A: canvas boxes, ink, links, menus (branch `rewrite/windows-parity`, from `origin/rewrite/native` e175c64)

Not merged. Nothing was driven with input on this PC (computer use declined): builds, unit tests (92, 3 new) and passive window screenshots only (`NOTIVELO_SOURCE=sample|offline`, `NOTIVELO_SHOT`, no input). The input paths below are checked by the new UI tests on the runner.

- **Canvas boxes** (`Views/PageView.cs`, Apple's `BoxGeometryStore` / `MacCanvas`): a click on empty canvas makes a box 360 wide, 12 pt above the click, in front, and opens it for typing; while a box is being edited, the click only stops that (as Apple). Move bar (12 high, from 9 above the box, `--bg-pressed`) drags the box; the width handle (3x24 bar, 9 wide hit strip) resizes it (120..2400); geometry is sent once on release (`MoveBox` / `ResizeBox`, then `BringToFront`), the box follows the pointer meanwhile. Chrome per LOOK 4.5.2: idle transparent, hover `--border`, editing opaque `--bg` + `--border-strong` with bar and handle (also while the link editor is open). A box left empty (Escape, a click on the page, another box taking the keyboard) is removed with `delete_box`, which the core refuses for a box with content (Apple's `removeIfEmpty`). Core calls: `new_box_id`, `create_box_with_id`, `move_box`, `resize_box`, `bring_to_front`, `delete_box`, then `LivePage.Info()` and the page redraws. Added, removed and moved boxes now update in place (the views keep their sessions and focus); a full rebuild only for page-level changes.
- **Ink, read-only**: `LivePage.InkStrokes()` (readable strokes with bounds) and `ink_outline_ops(data)` per stroke (cached by id), drawn with Win2D (`CanvasPathBuilder`, winding fill, circle ops as two arcs), highlighters under the boxes, pens over them, near-black drawn near-white in dark (as Apple's `InkGeometry.color`). Layers exist only on a page with ink. Sample page "Settings and ink" shows three strokes made with the core's stroke builder.
- **Links**: Ctrl+K opens the link editor under the selection (Text, Address; open and remove buttons when it is a link; Enter applies through `editLink`, remove through `unsetLink`, Escape cancels). Caret inside a link selects the whole link first. Ctrl+click opens a link (http, https, mailto; a bare `example.com` is taken as https), and so does a plain click in a box that was not being edited (Apple). A page link atom opens its page in the app on click (the shell's `PageOpened`).
- **Menus**: `[[` lists real pages from the tree, ranked as Apple's `pageMatches` (prefix, word prefix, contains; newest first), each with its notebook / section path, header "LINK TO PAGE", empty text "Type a page title…". `@` lists the real workspace members (`LivePage`-less core call `members(workspace)`, loaded after the tree; yourself until it arrives) with the member colour dot and email. Styled per LOOK 4.7 (290 wide, radius 12, rows 6 8, active `--bg-hover`).
- **UI tests** (`BoxTests.cs`, offline page, 5 tests): click on empty canvas makes a box that has the keyboard; an empty box is removed on Escape; a box with text stays; Ctrl+K links the selection (`link=` in the readout); `[[` opens the page menu. Offline source implements the box calls on its own page record. Unit tests: `editLink` / `unsetLink` on a session, the ink builder's outline ops.
- **Screenshots** (passive, 1180x820 at 150 %): `windows/parity-ink.png` (sample "Settings and ink": highlighter under, pen over, heading box) and `windows/parity-link-editor.png` (focused box with editing chrome, link editor under the selection). Against `ipad-landscape/page-settings-and-ink.png`: the ink and boxes are there; the reference also has a blue page colour and grid rules, which the Windows page does not draw yet (gap). Against `edit-caret.png`: the editing box (opaque, strong border, grey move bar) matches. The `[[` and `@` menus were seen in passive shots too (not committed).
- **Gaps**: page colour and rule lines/grid on the canvas; hover chrome and drag were not seen (no pointer on this PC); box right-click menu (Cut/Copy/Duplicate/Delete) and the empty-canvas menu (Paste / New text box here); box z-order on focus (only on drag); Delete key on a selected box; wide boxes drawn at 819 fixed instead of the visible note area; the ribbon Link button is still inert (Ctrl+K only); mention colour for others in the text; no Ctrl-click "picked" state; no ink drawing or erasing (read-only by design); `[[` / `@` menus do not scroll the highlight with the mouse wheel.
- **Local note**: a plain `dotnet build` (packaged layout) crashes at startup here with heap corruption (0xC0000374, about half the runs, also on the canvas page before this work); builds made like CI (`-p:WindowsPackageType=None -o <dir>`) are stable. Looks like an unpackaged-run-of-a-packaged-build issue, not this branch (the older `out-ui` build of the same layout as CI never crashed).
- **Requests to core**: (1) an all-strokes outline call (`ink_outlines(document)` or `LivePage.ink_outlines()` returning id, colour, tool and ops per stroke) to save one native call per stroke on a busy page; (2) `members` without the network (a cached read, like `cached_tree`), so `@` works at once and offline; (3) `LivePage.page_box_ids_empty()` or a `box_is_empty(id)` so the app need not infer emptiness from the view text; (4) the page's open-link target classification (`link_target(href)`: external, page, mailto) shared with Apple instead of each app's own rule.
- **CI runs** (branch `rewrite/windows-parity`): 1 run, 45214389317, green first time: build x64 + arm64, 92 unit tests, 16 UI tests (the 11 earlier and the 5 new).

## 2026-11-24: input checks automated in CI (branch `rewrite/windows-uitest`, from `origin/rewrite/native` 640a124)

The manual input list of the part 2 section below now runs on the GitHub `windows-latest` runner: FlaUI (UIA3) drives the real app with real keys and mouse. Nothing was run on this PC (no UI automation here, as decided); the unit tests and builds were. Not merged.

- **Offline mode**: `NOTIVELO_SOURCE=offline` (next to `sample`; normal startup untouched). `SampleNotesSource(offline: true)` shows a fixed page "UI test" (`InitialPageId = "uitest"`) with two boxes: `box:a` (empty) and `box:b` ("Second box"). `PageView` asks the source for a box session when there is no live page (`INotesSource.OpenOfflineBox`, default null); the source opens `EditorSession.Open([0, 0], "default", tasks)` (the empty Yjs update; the `default` field needs no box record) with the app's normal `BoxTasks` callbacks, and keeps tasks made from lines (`CreateTask` / `DeleteTask`, logged to the file named by `NOTIVELO_OFFLINE_LOG`). Pinned by 5 new xunit tests (`OfflineSessionTests`: type, Enter, Backspace, replace a selection, undo/redo, slash menu pick, `Mod+Enter` task).
- **UIA** (`Controls/BoxTextView.Automation.cs`): `BoxTextViewPeer`, control type Edit, automation id `box-box-<id>` (set by `PageView`), name "Text box", Value pattern = the view text of the last render (read-only). Test-only readout in ItemStatus: `block=<line kind>[/marker];sel=A,H;focus;menu=<trigger>:<highlight>/<count>;undo;redo;marked`. Not a Text pattern yet (no ranges, no caret provider): that is the accessibility work still to do.
- **Tests** (`Notivelo.Windows.UiTests`, FlaUI 4.0.0, xunit, each test on a fresh app, failures leave a screenshot): typing; Enter and Backspace; Shift+Left x5 then typing over the range; Ctrl+arrows, Ctrl+Shift+Left and Ctrl+A then typing; slash menu: `/`, Down x2, Enter makes a heading; slash menu: `/bullet` filter, Enter makes a bulleted item; Shift+Home, Ctrl+C, paste within a box and into the other box; system clipboard: set CF_UNICODETEXT with Win32, Ctrl+V, change the clipboard, Shift+Home, Ctrl+C, read it back, Ctrl+X; a two-line system clipboard text pastes as two lines; Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z; Ctrl+Enter creates a task through the callbacks.
- **CI** (`windows.yml`, job `windows-uitest`): builds the core for x64, the app unpackaged (`-p:WindowsPackageType=None`, self-contained, to `out-ui`), prints the desktop (1024x768, ctfmon running), runs the tests, uploads `uitest-screenshots` (failure screenshots and `notivelo-text.log`, 3 days). The window is maximised, boxes are clicked with the mouse.
- **Found and fixed**:
  - **Typing did nothing on the runner.** The text services context is created, but `TextUpdating` never fires there (0 events in the trace); the characters arrive only in `CharacterReceived`, which the app ignored while a context existed. Fix (`BoxTextView.Input.cs`): with a context, characters are held 60 ms and typed by the app only when no `TextUpdating` came since the key went down (never while composing; held characters go in before the next key acts). On a machine where the text services work, nothing changes (the events are counted and the held characters dropped). **Not confirmed on a real PC**: whether `TextUpdating` fires there at all (the manual check was never done); the fallback makes typing work either way, and the trace (`NOTIVELO_TRACE`) says which path was taken.
  - Not bugs, test expectations: after a heading or list the box text ends in the trailing paragraph (`"Title\n"`), the bullet is `paragraph/•`.
- **Editor / core requests**: none from these tests.
- **Still unchecked**: IME (no way to drive a composition on the runner: no second input method installed, TSF delivers nothing there); emoji panel; touch, long-press and handles; drag selection with the mouse (clicks only); right-click flyout; a second live client and remote edits (offline mode has no server); `[[` and `@` menus; the ribbon buttons with the mouse; DPI other than 100%; ARM64 (the job is x64 only); real CF_HTML to and from another app (only plain text through the system clipboard here).
- **CI runs** (branch `rewrite/windows-uitest`): 6 runs. 45178926337 (app starts, UIA works, typing fails), 45180774688 (typing diagnostics), 45182078913 (typing fix: 9 of 11 pass), 45182988265 (my newline typo, did not compile), 45183928642 (2 wrong expectations), **45184873687 green: 11 of 11 UI tests, build and the 89 unit tests**.

## 2026-11-23: BoxTextView, part 2: input (branch `rewrite/windows-text`, on part 1)

Boxes of live pages are now editable in code: focus, pointer selection, `CoreTextEditContext`, keys, ribbon, menus, clipboard, live. Not merged. **Not checked by hand**: my request to drive the app (computer use) was denied, so typing, Enter/Backspace, IME, clipboard to and from Notepad, drag, undo/redo from the keyboard and a second live client were NOT exercised. What was checked is listed below; please run the manual list once.

- **Done** (`Controls/BoxTextView.Input.cs`, `Text/InputMap.cs`):
  - Focus and caret: a press focuses and hit-tests (`HitOffset`: nearest line rectangle, DirectWrite hit test, never inside a surrogate pair) into `set_view_selection`; shift-click extends; double click = word, triple = line, drag extends by character, word or line, autoscrolling the page near its edges; a press on an object line selects its node. Right click: Cut / Copy / Paste / Select all flyout. Caret blinks at `UISettings.CaretBlinkRate` (0: solid), solid while anything changes, stopped unfocused or with a range. Selection is `--accent-soft` (LOOK 4.4). Escape (when the engine doesn't take it) or a click on the page outside a box gives the focus to the page scroller.
  - Text services: `CoreTextServicesManager.GetForCurrentView().CreateEditContext()` works in WinUI 3 desktop (checked: the context is created on focus). TextRequested / SelectionRequested / SelectionUpdating / TextUpdating (Enter, Tab, Backspace, insert, replace-range, composition via `SetComposition`, composition ended on updates outside it) / FormatUpdating (underline drawn; single, dotted, thick) / CompositionStarted and Completed / LayoutRequested (screen pixels from the window handle) / FocusRemoved; `NotifyTextChanged`, `NotifySelectionChanged`, `NotifyLayoutChanged` after each render whose revision moved, never from inside a platform call; a dropped composition restarts the context. Input pane policy: `Automatic` (the design's `Manual` + `InputPane.TryShow` needs a CoreWindow; Automatic lets the system show the touch keyboard). Without a context, `CharacterReceived` types.
  - Keys: `InputMap.ChordOf` (Mod = Ctrl; AltGr is text) to `key()`; Ctrl+Z / Y / Shift+Z undo and redo; Ctrl+C / X / V (Ctrl+Shift+V plain) clipboard; arrows, Ctrl+arrows (words), Home / End (visual line), Ctrl+Home / End, PageUp / Down, all with Shift, done by the view from the layout with a sticky x, then `SetViewSelection`. Tab not handled by the engine moves focus on.
  - Ribbon: Bold, Italic, Underline, Strike, Highlight, lists, indent / outdent, Task (`convertToTask`), Table, Undo / Redo and the block-type menu (Normal, Heading 1-3, Quote, Code block) call `RunCommand`; enabled and pressed states follow the focused box's `Active` marks, `List`, block, `can_undo` / `can_redo`; the buttons never take focus.
  - Menus: slash (LOOK 4.7: 290 wide, header, 36 px icon tiles, `--bg-hover` highlight, 6 pt under the caret line or above when short of room), `[[` pages and `@` people (the app lists them; Up/Down/Enter/Tab picked by the app, Escape by the engine). Slash keys go through the session.
  - Clipboard: `DataPackage` with text and CF_HTML (`Text/InputMap.cs` `CfHtml`, own reader and writer, UTF-8 byte offsets), `Clipboard.Flush`.
  - Tasks: the session's `TaskCallbacks` create and delete tasks through `INotesSource.CreateTask` / `DeleteTask` (queued to the UI thread, never back into the session), so Ctrl+Enter and the slash Task item make real tasks.
  - Live: edits go through the live page already; remote edits re-render through `OnPageChanged` and the same `AfterRender`.
- **Editor fix**: opening a session no longer writes the trailing paragraph (see `editor.md`): `Binding::new_lazy`, test `opening_a_session_sends_no_update`. Commit 065384d.
- **Checked**: `cargo fmt`, `clippy -D warnings`, `cargo test --workspace` green, ratchet unchanged; 84 xunit tests in `Notivelo.Windows.Tests` (new: `InputMapTests`: diff of text updates, update classification, chord names, words, caret steps over surrogates and combining marks, hit-test rectangles, CF_HTML round trip); the app runs against the local server (127.0.0.1:4417, seeded demo account) with a focused box: the text-services context is created, the ribbon enables and shows "Heading 1 / 2" for the focused block, the selection draws, the slash menu opens at the caret. Screenshots (window pixels through a dev hook, no synthetic input): `docs/rewrite/status/windows/input-selection.png` (selection in the focused box, ribbon state; compare `ipad-landscape/edit-selection.png`), `input-slash-menu.png` (slash menu; compare `ipad-landscape/slash-menu.png`). No composition screenshot.
- **Dev hooks added**: `NOTIVELO_FOCUS=1` (focus the first box 6 s after the page shows), `NOTIVELO_SHOT=file.png;seconds` (+ `NOTIVELO_SHOT_EXIT`), seed op `start`; loopback servers only.
- **Gaps**:
  - Manual checks above, and the Japanese IME and emoji panel.
  - No remote cursors, no touch handles or long-press, no UIA text provider, no task title editing in task rows, no checkbox / toggle / code Copy clicks, I-beam over the whole box (also over task rows), `NotifyLayoutChanged` not sent on page scroll.
  - `@` lists only you (no member list in the core); no link, colour, image, file, link-to-page or clear-formatting buttons yet.
  - Menu checklist icon is missing (no Lucide name match).
- **Requests**: core: member list for `@`; the `Active` info for task state; R4 / R5 / R7 from part 1 still stand.

## 2026-11-23: BoxTextView, part 1: rendering (branch `rewrite/windows-text`, from `origin/rewrite/native` c4a599d)

Live pages now draw every canvas box with `BoxTextView` (Win2D / DirectWrite) from an `EditorSession` opened with `EditorSession.OpenLive(livePage, "box:<id>" | "default", tasks)`, instead of the read-only TextBlocks. Draw only: no input, no focus, no menus (part 2). Not merged.

- **How it works**:
  - `Controls/BoxTextView.cs`: one control per box. `ViewRender()` is read on creation, on every page change (the source's `Changed` already arrives on the UI thread through `DispatcherQueue`) and on theme change; `text_revision` or a width change relays out (a `CanvasTextLayout` per line-table line, decorations, XAML task rows), `revision` alone only invalidates. `PageView.Refresh()` skips the rebuild when only text changed and just calls `OnPageChanged()` on each view.
  - `Text/` is the XAML-free half, unit tested: `RunMap` (R1 runs to line-relative ranges, view offset to line/column, selection clipping), `Metrics` (LOOK 2.3 type scale and pitch, indents from containers, block gaps with CSS-style collapsing, new-list detection), `DocInfo` and `TableMap` (callout emoji, code language, toggle state and table shapes read from the box's `doc_json`, until R4/R5), `TextColors` (LOOK 1.5).
  - Line pitch: DirectWrite uniform spacing with the CSS baseline (27.2 / 36.4 / 29.16 / 21 for code); tracking per heading; atoms are one U+FFFC whose advance is widened to the chip (`SetCharacterSpacing` min advance) and the chip is drawn over it.
  - `INotesSource` gained `LivePageOf`, `FindTask`, `PageTitleOf`, `UserId`; `CanvasBox.Field` carries `box:<id>` / `default`. `NOTIVELO_TEXTVIEW=0` switches back to the TextBlock path (the sample source and boxes a session can't open use it anyway).
  - Dev hooks (env, loopback servers): `NOTIVELO_WORKSPACE`, `NOTIVELO_NOTEBOOK` (pick by name part), `NOTIVELO_SELECT=anchor,head` (draw caret/selection in the first box), `NOTIVELO_SEED=<script>` (drive the first box's session: `text`, `key`, `cmd`, `word`, `end`), `NOTIVELO_TRACE`; layout and draw errors go to `%TEMP%\notivelo-text.log`.
- **What renders** (checked on the corpus pages below): paragraphs; h1-h3 with margins; bold, italic, underline, strike, inline code (rounded `--bg-hover`), links, text colours, highlights (rounded, per theme), comment anchors; bullet (disc / circle / square by depth), numbered (the core's markers; a new list when the style or number jumps) and check lists (checkbox, muted strike when done); blockquote bar; callout (emoji, fill, border; adjacent callouts told apart by `doc_json`); code block (language label, Copy label, mono 13.5); rule; tables (equal columns, header shading, multi-line cells); toggles (closed: summary with triangle, content hidden); mentions (yellow for you), page links (title looked up in the tree, underline, "Missing page"), images as a placeholder box (alt text) at their stored size, file cards (icon tile, name, size, download icon); task rows as XAML (circle, title, due / priority / checklist chips, avatar, missing-task state with "Remove from page"), a task's notes with the guide line; caret and selection from the session's `ViewRender.View.Selection` (off unless the dev hook is set).
- **Tests**: `apps/windows/Notivelo.Windows.Tests` (xunit, net8.0, 31 tests; compiles `Text/*.cs` and the core's generated bindings, no WinUI): runs with an emoji before a bold word, clamping and gap filling, `LineAt` / `ToLine` at line feeds, selection clipping, type scale, indents, gap rules, numbering, doc_json shapes, table dealing. CI runs it before the app build (a `dotnet test` step in `windows.yml`).
- **Verified** (Windows 11, x64 Debug unpackaged, 150% DPI, 1180 DIP wide; local server on 127.0.0.1:4417 seeded with `docs/rewrite/look/seed.ts`, i.e. the reference corpus, with the demo account from that script's README; no production, nothing committed): Blocks, Lists, Canvas, Tasks, Document page, the demo Welcome page, in light / dark / hybrid. Screenshots in `docs/rewrite/status/windows/`: `text-blocks.png` (compare `ipad-landscape/page-blocks.png`), `text-tasks.png` (`page-tasks.png`, Hybrid), `text-marks.png` (Document page: every mark; the web has no reference of that page). Three passes: (1) the first block keeps its own margin (headings too: the box has padding) and the shell's title / sub-line / canvas offsets (+5 / +3 / +8 DIP); (2) lists (4.8 between a list and a paragraph, a new list when `5.` becomes `7)`, nested 4.8), callout grouping, toggle summary, table borders, file card; (3) task rows (hanging margin, guide line, checklist 3.2 gaps, strike). Lists, Canvas and Blocks then match the references within 1-3 DIP vertically and a pixel or two horizontally; both sides use Segoe UI, so glyphs agree.
- **Remaining differences**:
  - Images are placeholders (alt text); no fetch yet. No hover / selected states on callouts, tables and code; no per-language code colours (LOOK 1.6); toggles can't open (content hidden when `doc_json` says closed).
  - Task rows show only filled chips (the references show empty ones on touch / hover); no fold arrow left of a task with notes (the gutter is outside the control); notes of a missing task are still drawn (the web hides them); no hover or selected fills.
  - Table columns are always equal (no stored widths), cells hold text lines only. Page links get an icon only from `attrs.emoji`.
  - No "active thread" tint on comment anchors; no placeholder text ("Type '/' for commands").
  - Side effect: opening a session on a box adds the trailing empty paragraph if it is missing (the core's `open`) and sends it, so merely viewing a page can touch it ("Edited just now").
  - WinUI note: moving a `UserControl` that holds the canvas from one page tree to the next crashed the app natively (E_NOINTERFACE); views are rebuilt with each page build and reused only through `OnPageChanged`.
- **Requests**:
  - **core / editor, R4**: table coordinates on `ViewLine` (`row`, `col`, `rows`, `cols`, `header`); today the shape is read from `doc_json` and the lines are dealt out by counting.
  - **R5**: `open` on the toggle summary line, callout emoji and code language in the line table (an `attrs_json` on the first line of a container), and a stable id per container instance so adjacent callouts and lists aren't guessed.
  - **R7**: `ViewRender` returns the whole line table per call; return it only when `text_revision` moved. `state()` (for `doc_json`) is read on every relayout, which is heavy: R4/R5 would drop that call.
  - **R3 follow-up**: `src` / `width` / `height` of inline images in `ViewAtom.attrs_json` (block images already carry them) and a file card's `mime`, for real images and file icons.
  - **core**: an `open_live` option not to normalise the box (no trailing-paragraph write); for part 2, `TaskCallbacks.create` needs the app to call `create_task_with(id)`.
- **Next (part 2)**: focus, `CoreTextEditContext`, keys, pointer hit testing and drag selection, caret blink, clipboard, undo, slash / mention menus, the task title field, toggles opening.

## 2026-11-23: the app on the real core (branch `rewrite/windows-core`, from `origin/rewrite/native` 6f396b8)

The shell now runs on the Rust core through the uniffi C# bindings: sign-in, workspaces, tree, tasks and live read-only pages. `CoreNotesSource` (default) implements `INotesSource`; `SampleNotesSource` stays behind `NOTIVELO_SOURCE=sample` (offline screenshots, no sign-in). Not merged.

- **Wired** (`apps/windows/Notivelo.Windows/`):
  - Build: the csproj compiles the generated `nv_core.cs` into the app (no separate assembly) and copies `nv_core.dll` for the build's RID next to the exe and into the MSIX; a target fails with a clear message when `bash crates/nv-core/build-windows.sh` has not been run (`NV_TARGETS=x86_64-pc-windows-msvc` for x64 only). Core types are used as `N.*` (`using N = Notivelo.Native`) because the core's `Task` clashes with `System.Threading.Tasks.Task`.
  - `Data/AppSession`: phases restoring / signed out / signed in; one `Core.WithStore` per server (store file `%LOCALAPPDATA%\Notivelo\Store\notivelo-<host>.sqlite`); core calls run one at a time on the pool (`CallAsync`) and continue on the UI thread; the rotating refresh token is stored again after every call; a `SignedOut` error returns to the sign-in screen. `Data/CredentialStore`: refresh token in the Windows Credential Locker (`PasswordVault`), one entry per server; session restored on launch; Sign out (account menu) clears it and calls `core.SignOut()`.
  - Server: production `https://app.notiveloapp.com` by default; env `NOTIVELO_SERVER=<url>` overrides (dev/staging); press and hold the version line on the sign-in screen for 1.5 s to switch production/staging (persisted in `%LOCALAPPDATA%\Notivelo\settings.json`, ignored when the env var is set), as on Apple.
  - `Views/SignInView`: LOOK 4.13 (card 400, logo row, fields 40 high, accent button, links, version line with `core 0.1.0`, "Server: host" in orange off production, "Signing in..." while restoring, "Try again" when a kept sign-in could not be resumed offline, error line; a wrong password reads "Wrong email or password.").
  - Workspaces: the rail workspace button opens a menu to switch (choice remembered per server); the account button opens a menu (name, email, Change theme, Sign out). Tree: `CoreNotesSource.Rebuild` maps the core `Tree` to notebooks, nested sections and pages (with open-task counts); notebook picker in the sidebar head. Tasks: Today / My Tasks / Upcoming / All built from `core.Tasks` (top-level tasks assigned to the signed-in user for Today, My Tasks and Upcoming; all visible tasks for All; Overdue / Today / Later / No date / Done groups, counts, done-today, left, streak, week bars). Team is empty (the list model carries no team id).
  - Live pages: `OpenPage` on navigation, `Close` (off the UI thread) on leaving or switching; `PageListener` changes are coalesced and hop to the UI thread through `DispatcherQueue`; 4401 reopens, 4403 / 403 / 404 end with a message, other drops retry with a growing delay. Boxes sit at their `PageBox` x/y/w (a document page is one wide box); content comes from `PageInfo.Content` (`ContentMapper`, the same typed `ContentNode`s Apple's `PageText` reads) as read-only blocks with marks: headings, paragraphs, bold / italic / underline / strike / code / link / text colour / highlight, bullet / numbered / check lists, quotes, code blocks, rules, table rows as text, mentions and page links, and real task lines (title, due date, done) looked up in the task list. Scroll position is kept across live updates.
  - Empty and error states (LOOK 4.14): Notes overview with Recently edited cards, "No notebooks yet", "No sections yet", Today "You're all caught up", the other task views' lines, load errors with "Try again", a page status line (opening / offline, trying again / ended).
- **Run against dev or staging**: build the core once, then the app, and start it with the server env var:
  - `bash crates/nv-core/build-windows.sh` (x64 only: `NV_TARGETS=x86_64-pc-windows-msvc bash ...`).
  - `dotnet build apps/windows/Notivelo.Windows/Notivelo.Windows.csproj -c Debug -p:Platform=x64 -p:WindowsPackageType=None -o <dir>` (the MSIX-typed exe crashes unpackaged), then run `<dir>\Notivelo.exe`.
  - Local server: `PORT=4417 DATA_DIR=<scratch> JWT_SECRET=<32+ chars> GIT_SHA=win-test SIGNUP_MODE=open npx tsx server/index.ts`, then `NOTIVELO_SERVER=http://127.0.0.1:4417`. Staging: `NOTIVELO_SERVER=https://staging.notiveloapp.com` (or the long press).
  - Dev hooks (all env): `NOTIVELO_SOURCE=sample`, `NOTIVELO_THEME`, `NOTIVELO_ROUTE`, `NOTIVELO_PAGE=<part of a title>` (open that page once the tree loads), `NOTIVELO_DEV_EMAIL` + `NOTIVELO_DEV_PASSWORD` (fill the form and sign in once, only against a loopback server).
- **Verified** (Windows 11, x64 Debug, unpackaged, 150% DPI, against the web app's dev server on 127.0.0.1:4417 with a test user made through the open-signup register call; nothing real, no production):
  - Sign-in with correct and wrong credentials, session restore from the Credential Locker on a second launch (no credentials given), Sign out back to the sign-in screen.
  - Workspace, tree (notebook, section, page), the Welcome page open live with rich text, task lines and headings, the Tasks Today view with overdue / today groups, counts, stats.
  - Screenshots in `docs/rewrite/status/windows/` (1180 wide, hybrid): `core-sign-in.png` (compare `ipad-landscape/hybrid-sign-in.png`), `core-notes-live-page.png`, `core-tasks-today.png`.
  - Not verified: staging, production, the ARM64 build run on a device, a second client editing the page while it is open (the change callback is exercised only by the initial sync), the empty-state screens (written to the spec, not captured), offline start (cached copies).
- **Differences from the reference sign-in**: no accent glow behind the card and no card shadow (WinUI 3 has no radial gradient brush; a composition effect would do).
- **Gaps**:
  - No editing: boxes are read-only text (TextBlock with runs); the box text view (`WINDOWS-TEXT-VIEW.md`) is next. Ink is not drawn: `PageInfo.HasInk` and `LivePage.InkStrokes()` / `InkOutline` exist, but drawing needs a path renderer, so it waits for the box view work. Task ticks, add task, search, notifications, calendar, sharing, locked pages, comments, versions, the second pages panel and the ribbon / sidebar row menus are not wired. New pages, sections and notebooks (the core has the calls) are not in the UI.
  - Network reachability is not watched (Apple reloads when the connection returns); a failed load shows "Try again".
  - The MSIX is unsigned with the dev identity; the core DLL is inside it, untested as an installed package.
- **CI**: `windows.yml` now installs Rust 1.99.1 and `uniffi-bindgen-cs` (cached) and runs `build-windows.sh` for x64 and arm64 before building the app, so the app build uses the real `nv_core.dll`; it also triggers on `crates/**`. Builds only: no signing, no Store upload. Note: the repo-wide `.gitignore` entry `data` matched `apps/windows/.../Data/`, so new files there were silently untracked; `apps/windows/.gitignore` now has `!Data/`.
- **Requests to core**:
  - A cheap ink read for a page: outlines as ready-to-draw polylines for all strokes in one call, so a read-only ink layer needs no per-stroke round trips.
  - Team and member names on `Task` (or a lookup the list view can use without `taskDetails`) for the Team view and assignee avatars.
  - A `LivePage` change that says whether content, settings or only the task list changed, so the view can skip rebuilds.

## 2026-11-22: box text view design (branch `rewrite/windows-shell`)

`docs/rewrite/WINDOWS-TEXT-VIEW.md` is the design for step 3: one `BoxTextView` per canvas box drawing with Win2D/DirectWrite (`CanvasTextLayout` per line-table line) plus XAML chrome, input through `CoreTextEditContext` over the single view string, no hidden `RichEditBox`. It maps every event to `EditorSession` calls, and covers keys, menus, clipboard, undo, live sessions and threading, UIA, hit testing and testing. Requests to core and editor (R1-R12) are at its end; R1 (formatting runs in `ViewLine`), R2 (active marks) and R3 (atom payload) gate rendering. Nothing built; waits on `rewrite/core-windows` (C# bindings, `nv_core.dll`) being merged.

## 2026-11-22: shell in today's look (branch `rewrite/windows-shell`)

Wide layout (LOOK 3.1/3.3) built in WinUI 3 with sample data; no phone layout. Verified by running an unpackaged Debug build locally at 150% DPI (client 1180x820 DIP) and comparing with `reference/ipad-landscape/*` (hybrid and light).

- **What is built** (`apps/windows/Notivelo.Windows/`):
  - `Themes/Tokens.xaml`: LOOK 1.1 light/dark colour tokens (alpha colours precomputed), type scale, radii. Accent is Blue only (accent switching not built). `Themes/Styles.xaml`: restyled ghost / ribbon-toggle / nav-toggle button templates (hover, pressed, checked, disabled from the tokens, no Fluent fills).
  - `ShellView`: ribbon on top, rail 64, sidebar 216 (180-420, 6 pt grabber, hide/show from the rail), main. Theme modes Hybrid (default: dark chrome, light page inset 6 pt with 12 pt top corners), Light, Dark; clicking the rail account button cycles them. Window min 800x560 DIP (WM_GETMINMAXINFO); default client 1180x820.
  - `RailView` (4.2), `SidebarView` (4.3: notebook picker, SECTIONS tree with pages folded in, Tasks panel with counts and VIEWS, Calendar stub), `RibbonView` (4.1: Note, Tasks and Calendar ribbons; smallest <=1023, compact <=1279, full >=1280 with group names and words; collapse/"Show ribbon"; buttons are placeholders), `PageView` (4.4 top bar, 4.5 article: title, sub-line, canvas of static positioned boxes as TextBlocks, task line, outline rail), `TasksView` (4.10: header, Today stats card, groups, TaskRow rows) for Today / My Tasks / Upcoming / All.
  - Dev hooks: env `NOTIVELO_THEME=hybrid|light|dark`, `NOTIVELO_ROUTE=notes|tasks|calendar`; `App` writes unhandled exceptions to `%TEMP%\notivelo-crash.log`.
- **Screenshots** (`docs/rewrite/status/windows/`, 1180 wide): `notes-hybrid.png`, `notes-light.png`, `tasks-hybrid.png` (Hybrid Tasks is dark), `tasks-light.png`.
- **Fonts**: `--font` resolves to Segoe UI on Windows (SF Pro/Inter not installed; the reference PNGs were also rendered in Segoe UI), so the app uses the system Segoe UI; nothing bundled. Segoe UI has no Medium (500) or 650 weight, so those render as Regular/Semibold. Mono: Cascadia Mono, Consolas (unused yet).
- **Icons**: Lucide (same as the web app, ISC licence). `apps/windows/tools/gen-icons.mjs` converts `docs/rewrite/look/icons/*.svg` (164 icons) to path-data strings in `Icons/IconData.cs`; `Controls/Icon.cs` draws them in a 24x24 viewbox with a 2-unit round stroke, tinted from the host button's foreground. Re-run the script when icons change.
- **Data interface**: `Data/INotesSource.cs` (workspace, notebooks/sections/pages, `GetPage` returning `NotePage` with `CanvasBox`es and blocks, task counts, today stats, `GetTaskGroups(TaskViewKind)`, `Changed`), records in `Data/Models.cs`, fake `SampleNotesSource`. The core binding implements `INotesSource`; the views read nothing else. Box text view over `EditorSession` replaces the TextBlocks in `PageView.Box`.
- **Remaining differences from today's look**:
  - Hybrid page shadow is only a 1 pt dark ring (no 24 pt blur); page top bar is not translucent.
  - Not built: second pages panel at >=1200 wide (pages stay folded in the tree), page side panel, menus/popovers (buttons do nothing), tooltips use the default style, hover-only row actions, notebook picker menu, calendar view, task detail, search, accent colours other than Blue, Face ID etc.
  - Text metrics differ slightly (Segoe UI weights above); a few rows are 1-3 DIP off the reference (sidebar head spacing, Today stats card height).
- **Local run notes**: the MSIX-typed Debug exe crashes unpackaged. For a quick visual run build with `-p:WindowsPackageType=None` (same sources, output elsewhere) and launch the exe; screenshots via `PrintWindow` of the window.

## 2026-11-22: project and CI (branch `rewrite/windows-shell`)

Branched from `origin/rewrite/native` (contains cf8cee0, not merged).

- **What exists**: `apps/windows/Notivelo.Windows.sln` with one project, `Notivelo.Windows/` (WinUI 3, Windows App SDK 1.6, `net8.0-windows10.0.19041.0`, min 10.0.17763, single-project MSIX, self-contained, x64 + ARM64). `App`, a `MainWindow` that shows "Notivelo", `Package.appxmanifest` with a dev-only identity (`Notivelo.Windows.Dev`, `CN=Notivelo Dev`; no Partner Center or Store identity), and tile/logo PNGs in `Assets/` resized from `apps/desktop/src-tauri/icons/icon.png`. Signing is off (`AppxPackageSigningEnabled=false`), so the MSIX is unsigned; no keys or certs are committed.
- **Build locally** (needs a .NET 8+ SDK; no Visual Studio needed; from the repo root):
  - `dotnet build apps/windows/Notivelo.Windows/Notivelo.Windows.csproj -c Release -p:Platform=x64`
  - MSIX: `dotnet build apps/windows/Notivelo.Windows/Notivelo.Windows.csproj -c Release -p:Platform=x64 -p:GenerateAppxPackageOnBuild=true -p:AppxPackageDir=<absolute dir>/` (output `Notivelo.Windows_0.0.1.0_x64_Test/*.msix`). A harmless `mspdbcmf.exe` warning appears without VS.
  - To install it, sign it with a throwaway cert (`New-SelfSignedCertificate`, `signtool`) whose subject is `CN=Notivelo Dev`, trust the cert, then `Add-AppxPackage`.
  - Verified here with SDK 10.0.402 targeting net8.0: x64 build and unsigned MSIX both succeed. Not run on a device.
- **CI**: `.github/workflows/windows.yml` ("Windows native"), `windows-latest`, on push to `rewrite/**` and PRs touching `apps/windows/**` or the workflow, plus manual. Steps: setup-dotnet 8, restore, build x64 and ARM64 Release, package the unsigned x64 MSIX, upload it as an artifact (7 days).
- **Next**:
  1. The shell to today's look (notebook/section/page tree, ribbon, canvas frame, tasks), in WinUI 3.
  2. The box text view over `EditorSession` via `CoreTextEditContext`, once core's C# bindings and `nv_core.dll` land from `rewrite/core-windows` (the workflow will need to build or fetch the Rust DLL for x64 and arm64).
- **Open questions**:
  - Test-signed MSIX in CI (self-signed cert generated per run) so the artifact can be installed, or keep it unsigned?
  - Real package identity and publisher once a Store/Partner Center account exists; version scheme (1.99.x like TestFlight?).
  - Pin the SDK with a `global.json`? CI uses 8.0.x; a local newer SDK works but differs.
  - Self-contained Windows App SDK (as now) versus framework-dependent, which makes a smaller MSIX but needs the runtime installed.
