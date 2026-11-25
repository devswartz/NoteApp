# Feature parity: what the native apps must match

Every feature of today's app (v1.5.13, 2026-11-21), one row each, with what each platform has **today**. The native rewrite is at parity on a platform when every row that platform has today is done natively (or deliberately dropped, with Devon's OK, noted in the row).

Derived from `docs/USER_GUIDE.md`, `CHANGELOG.md`, `src/` (components, editor, pages, platform), `server/routes/`, `apps/mobile` (Capacitor + native iOS/Android code) and `apps/desktop` (Tauri). Where the guide and the code disagree, the code wins. Rows marked *(verify)* were inferred and need a check in the running app.

## How to read it

Today's apps: **iPad / iPhone** = Capacitor app (`apps/mobile`, iPad gets the wide layout with the ribbon, iPhone the phone layout); **Mac** = Tauri app (`apps/desktop`, direct download and Mac App Store); **Windows** = Tauri app; **Android** = Capacitor app; **Web** = the browser app (PWA).

| Mark | Today |
|---|---|
| ● | has it |
| ◐ | partly, or a different form (see note) |
| ○ | doesn't have it |
| — | doesn't apply to that platform |

Native progress: when a row is done in a native app, append **✓** to that platform's cell (e.g. `● ✓`). A row dropped on purpose gets `✗` and a note. **Mac ✓ (2026-11-22, rewrite/apple-mac) means it builds in the native Mac app (compiled only, never run on a Mac).** M5 is done when every ●/◐ in the iPad column has a ✓ or ✗.

**Windows ✓ (2026-11-24, rewrite/windows-audit): built in the native Windows app, compiled and covered by CI UI tests in offline sample mode where noted; not run against a server unless said.** Unticked Windows rows are listed, with what is missing, in `docs/rewrite/status/windows.md` ("Parity left").

**Android ✓ (2026-11-24, rewrite/android-media): built in the native Android app (`apps/android-native/`), compiled and covered by JVM tests, Paparazzi shots and, where noted, emulator UI tests in offline mode; never run on a device or against a server unless said.** Unticked Android rows are listed, with what is missing, in `docs/rewrite/status/android.md` ("Parity left").

Wide/phone layout: iPad, Mac, Windows and wide web windows use the **wide layout** (rail, panels, ribbon). iPhone, Android and narrow web (≤760 px) use the **phone layout** (bottom tab bar, full-screen editor, floating toolbar).

## 1. Account and sign-in

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Sign in (email + password) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `POST /auth/login`, refresh tokens (`/auth/refresh`) |
| Create account (open sign-up) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `/auth/register`; `/login?mode=register&email=…` prefill (web) |
| Email confirmation screen (Check your email, Resend, I've verified, Sign out) | ● | ● | ● | ● | ● | ● | `CheckEmail.tsx`, `VerifyEmail.tsx`; unconfirmed accounts deleted after 7 days |
| Forgot / reset password | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | email link opens web `ResetPassword` |
| Sign-in kept securely | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ◐ | mobile: secure storage plugin (Keychain/Keystore); desktop: system keychain (`secure.rs`); web: browser storage |
| Release builds locked to app.notiveloapp.com; internal builds have hidden "Change server…" | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | — | `src/platform/serverUrl.ts`, desktop `config.rs` |
| Profile: name, avatar colour | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | Settings → Profile |
| Change password | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `POST /me/password` |
| Delete account (preview of consequences, password) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `GET /auth/account/deletion-preview`, `DELETE /auth/account`; required by App Review |
| Export my data | ● | ● | ● | ● | ● | ● | `GET /me/export` |
| Privacy, Terms, Support links | ● ✓ | ● ✓ | ● ✓ | ● | ● | ● | sign-in screen and Settings → About |
| Sign out | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | |
| Invite link: open, accept, join workspace | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `/invites/:token`; universal links on iOS |

## 2. Navigation and shell

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Rail: Notes, Tasks, Calendar | ● ✓ | — | ● ✓ | ● ✓ | — | ● | `Rail.tsx`; phones use the tab bar |
| Bottom tab bar (Notes, Today, +, My Tasks, Search) | — | ● ✓ | — | — | ● | ◐ | `MobileChrome.tsx`; web on narrow screens |
| Workspace switcher (top of sidebar) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | |
| Create workspace | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `POST /workspaces` |
| Notes panel: notebook picker, section tree, pages list | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `NotesPanel.tsx`; separate sections/pages panels from 1200 pt wide |
| Section ribbons / colour tabs | ● ✓ | ◐ | ● ✓ | ● ✓ | ◐ | ● | `SectionRibbons.tsx` *(verify phone form)* |
| Favourites and Recent | ● ✓ | ● ✓ | ● ✓ | ● | ● | ● | |
| Resize sidebar, hide sidebar (⌘\) | ● | — | ● | ● ✓ | — | ● | |
| Notes home overview | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `NotesHome.tsx` |
| OneNote-style ribbon (Text, Lists, Insert, Page, View; Table group; changes per section: Tasks, Calendar) | ● | ○ | ● | ● | ○ | ● | collapse with chevron / Ctrl+F1; phones keep floating toolbar |
| Floating formatting toolbar (phones) | — | ● ✓ | — | — | ● | ◐ | |
| Undo/Redo buttons in note top bar (phones) | — | ● ✓ | — | — | ● ✓ | ◐ | v1.5.13, screens ≤760 px |
| Command palette ⌘K (search + commands) | ● | ● | ● ✓ | ● | ● | ● | `CommandPalette.tsx`, `shell/commands.tsx` |
| Keyboard shortcut overlay (?) | ● | ◐ | ● ✓ | ● ✓ | ◐ | ● | phones only with a keyboard |
| F6 region cycling | ● | — | ● | ● | — | ● | `useF6Regions.ts` |
| Swipe actions on rows | ● ✓ | ● ✓ | — | — | ● | ◐ | `SwipeRow.tsx` *(verify which rows)* |
| Toasts with Undo | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |
| Offline banner / pill (after 30 s) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |
| "New version available, reload" prompt | ◐ | ◐ | ◐ | ◐ | ◐ | ● | service worker; bundled apps update via store/updater |
| Deep links (`notivelo://`, universal links `/w/…`) | ● ✓ | ● ✓ | ● ✓ | ● | ● | — | `DeepLinks.tsx`, `platform/deepLinks.ts` |
| Themes: Light, Dark, Hybrid (default), System | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | native window theme on desktop (`theme.rs`) |
| Accent colour (8, per device) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | Settings → Appearance |
| Get the apps page | — | — | — | — | — | ● | Settings → Get the apps (browser only) |
| Send feedback (≤4000 chars, 5/hour) | ● | ● | ● | ● | ● | ● | `POST /feedback` |
| Error reporting | ● | ● | ● | ● | ● | ● | `POST /client-errors` |

## 3. Notebooks, sections, pages (tree)

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Create notebook (dialog, notebook templates) | ● ✓ | ● ✓ | ● ✓ | ● | ● | ● | `NewNotebookDialog.tsx`, `notebookTemplates.ts` |
| Create section; subsections up to 3 levels | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |
| Create page (N, + , ribbon) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `POST /sections/:id/pages` |
| Rename notebook / section / page | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |
| Page icon | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `IconPicker.tsx` |
| Drag to reorder / move in the tree | ● | ◐ | ● ✓ | ● ✓ | ◐ | ● | `treeDnd.ts`; phones *(verify)* |
| Move dialog; copy page / section | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `MoveDialog.tsx`, `/pages/:id/move`, `/copy` |
| Notebook shared vs private, share with people | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `PUT /notebooks/:id/shares` |
| Delete to Trash (60 days) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |
| Trash: list, restore, delete forever, empty | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `TrashView.tsx`, `/trash` routes |
| Tasks of a page in Trash stay usable; page opens read-only with Restore | ● | ● | ● | ● | ● | ● | v1.5.12 |
| Print section / notebook (All pages, Contents only) | ● | ● | ● | ● | ● | ● | native print dialog |

## 4. Page canvas and editor

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Canvas page: click anywhere for a text box; move box by top edge, resize by right edge | ● ✓ | ◐ | ● ✓ | ● ✓ | ◐ ✓ | ● | phones stack boxes one under another with "Add a text box" |
| See-through boxes (only active box opaque) | ● ✓ | — | ● ✓ | ● ✓ | — | ● | |
| Select boxes; cut/copy/paste/duplicate/delete boxes; context menu | ● ✓ | ◐ | ● ✓ | ● ✓ | ◐ | ● | `boxSelection.ts`, `boxClipboard.ts` |
| Live collaboration: edits, cursors, presence | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | Yjs over y-websocket, `collab*.ts` |
| Follow a collaborator | ● | ● | ● | ● | ● | ● | `collabFollow.ts` *(verify phone)* |
| Save state indicator (Saved / Saving / Connecting / Offline) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | phone hides ✓ when saved |
| Page title | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | title change refused unless current title known |
| Undo/redo across typing and box moves (⌘Z, ⌘⇧Z, Ctrl+Y) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `canvasUndo.ts`, `pageUndo.ts`, `undoTasks.ts` |
| Marks: bold, italic, underline, strikethrough, code, text colour, highlight | ● ✓ | ● ✓ | ● ✓ | ● | ● | ● | |
| Links: ⌘K, editor with Text + Address | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `LinkEditor.tsx` |
| Headings 1–3 | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `#`, Ctrl+Alt+1/2/3 |
| Bulleted lists (Ctrl+.) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | |
| Word-style numbered outlines (1 → a → i; `1.`, `a.`, `i.`, `1)`) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | Tab / Shift+Tab |
| Plain checklist | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | |
| Tables: insert/delete rows and columns, header row, merge/split | ● ✓ | ◐ ✓ | ● ✓ | ● ✓ | ◐ | ● | Table ribbon group on wide layout |
| Callout, toggle, quote, code block (highlighting), divider | ● | ● | ● | ● | ● | ● | `blocks.tsx`, `codeHighlight.ts` |
| Backspace/Enter leave a block (Word-outline style) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `blockExit.ts` |
| Images (insert, resize by corner) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `upload.ts`, `POST /uploads` |
| File attachments (≤25 MB, type rules, signed short-lived links) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `/files/:id`, `/files/key` |
| Slash menu (/) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `SlashMenu.tsx` |
| Markdown input rules (#, -, *, 1., >, ```) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | |
| Page links `[[`, create page from link | ● ✓ | ● ✓ | ● ✓ | ● | ● | ● | `PageLink.tsx` |
| Linked from (backlinks) panel | ● | ● | ● | ● ✓ | ● | ● | `GET /pages/:id/backlinks` |
| Drag handle: move a block with its nested lines, drop anywhere; keeps numbering | ● | ◐ | ● | ● | ◐ | ● | `blockMove.ts`, `listDrop.ts`, `handleReach.ts` |
| Word-style multi-selection (Ctrl/⌘ + click/drag/double-click lines) | ● | — | ● | ● | — | ● | `linePicks*.ts` |
| Copy keeps formatting; paste rich text and Markdown | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `clipboardOut.ts`, `markdownUtils.ts` |
| Outline / table of contents beside long pages | ● | ○ | ● | ● ✓ | ○ | ● | `Outline.tsx` *(verify phone)* |
| Full width option | ● | — | ● | ● | — | ● | |
| Page colour | ● | ● | ● | ● | ● | ● | syncs, in templates and versions |
| Rule lines / grid with snapping | ● | ● | ● | ● | ● | ● | `ruleGrid.ts` |
| Spellcheck | ● | ● | ● ✓ | ◐ | ● | ● | Mac app: native spelling (`spelling.rs`); else system/browser |
| Print page, print selection; Save as PDF | ● | ● | ● | ● | ● | ● | `print/`, `PrintSelectionMenu.tsx`; iOS via native `print` plugin method |
| Export page (Markdown / PDF) | ● ✓ | ● ✓ | ● ✓ | ● | ● | ● | `exportPage.ts`, `collabExport.ts` |
| Version history: list, preview, restore (undoable) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `VersionHistory.tsx`, `/pages/:id/versions` |
| Share a page with people (view / edit, outside the workspace) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `PageShareDialog.tsx`, `/pages/:id/shares` |
| Share link "Anyone with the link can view" (public read-only page) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `/pages/:id/link`, `server/publicPage.ts` |
| Shared with me | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `SharedWithMe.tsx`, `/shared-pages`, `/shared-tasks` |
| Handwriting / ink | ○ | ○ | ○ | ○ | ○ | ○ | behind the `ink` flag, off for everyone; native goal is ink on every page (beyond parity) |

## 5. Templates

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Start with a template on an empty page (built-in: meeting, project, journal) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `TemplatePicker.tsx`, `defaultTemplates.ts` |
| Save as template (workspace or private; per section) | ● | ● | ● | ● ✓ | ● | ● | `TemplateDialog.tsx`, `POST /pages/:id/templates` |
| Tasks in a template become new tasks; attachments copied | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `POST /templates/:id/use` |
| Rename / delete template (creator or admin) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |
| `{date}`, `{time}` placeholders | ● | ● | ● | ● ✓ | ● | ● | |
| Default template per section (inherited by subsections) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `PUT /sections/:id/default-template` |
| New page from template (ribbon, section menu) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |

## 6. Tasks

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Task in a note is the real task (one task everywhere) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `TaskRef.tsx`, `taskRefIds.ts` |
| Insert task: /task, ⌘↵, Ctrl+1, ribbon Task button | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |
| Task chips in notes (date, priority flag, assignee) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | phone shows icon-only checklist button |
| Deleting a task line deletes the task (undoable); cut keeps it; deleted page → standalone tasks | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `taskGate.ts`, v1.5.9 |
| Notes under a task (bullets, numbers, paragraphs, checklists, subtasks) | ● | ● | ● | ● ✓ | ● ✓ | ● | `taskChildren.ts`, v0.5.0 |
| Subtasks (one level, progress 2/5) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | |
| Checklist under a task (not tasks) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | |
| Tasks on this page panel | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `GET /pages/:id/tasks` |
| Task detail: title, description, due date/time, priority, assignee, tags, team, assigned-by, reminders, recurrence, From the note | ● | ● | ● | ● | ● | ● | `TaskDetail.tsx`, `GET /tasks/:id/notes`. Native: every field editable (apple-wire); "From the note" not yet |
| Quick add (Q) with natural language (dates, times, p1–p4, repeats, @assignee) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | `QuickAdd.tsx`; phone via + tab |
| Views: Today (progress strip, streak, 7 days), My Tasks, Upcoming, Team, All tasks (status Open/Completed/All) | ● | ◐ | ● | ● ✓ | ◐ | ● | phones: Today and My Tasks tabs, rest via Notes/Tasks menu *(verify)* |
| Calendar: month / week, drag to reschedule or onto No date, double-click to add, Mine / Everyone | ● ✓ | ◐ ✓ | ● ✓ | ● | ◐ | ● | `CalendarView.tsx`, `CalendarPanel.tsx`, `MiniCalendar.tsx` |
| Sidebar counts (Today, My Tasks, Upcoming) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | |
| Filters (tag, team, assignee, section, status…), sort, group; filter bar with Clear | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `FilterChips.tsx`, `ViewFilterBar.tsx` |
| Assignee menus grouped by team (subteams nested) | ● ✓ | ● ✓ | ● ✓ | ● | ● | ● | `assigneeGroups.ts` |
| Saved views (server, optionally shared) | ● | ● | ● | ● ✓ | ● | ● | `/workspaces/:id/task-views` |
| Keyboard: J/K, X/Space, D, A, 1–4, R/F2, ↵, S, ⌘A, Esc | ● | ◐ | ● | ● | ◐ | ● | with a hardware keyboard |
| Bulk select and bulk bar (complete, reschedule, assign, priority, delete; one Undo) | ● | ◐ | ● | ● ✓ | ◐ | ● | `BulkBar.tsx`, `selection.ts` |
| Inline rename, complete with Undo | ● | ● | ● | ● | ● | ● | |
| Recurrence (every N days/weeks on days, monthly by date or nth weekday, last, until, count, after completion) | ● ✓ | ● ✓ | ● ✓ | ● | ● | ● | `RecurrencePicker.tsx`; same task moves to next date |
| Print task view (⌘P) | ● | ● | ● | ● | ● | ● | |
| Tags: create, rename, colour, delete | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `Labels.tsx`, `/tags` |
| Teams and subteams, members | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `TeamsSettings.tsx`, `/teams` |
| Tasks offline: read-only | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | native target M7: editable offline |

## 7. Reminders and notifications

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Reminders: fixed time or N minutes before; default time for date-only tasks | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `ReminderPicker.tsx`, `/tasks/:id/reminders` |
| Push reminders with snooze actions (10 min, 1 h, tomorrow) | ● ✓ | ● ✓ | ◐ | ◐ | ● | ● | iOS APNs, Android FCM (`SnoozeReceiver`), web push; desktop *(verify: webview notifications)* |
| Local notifications | ● | ● | ○ | ○ | ● | — | `@capacitor/local-notifications` |
| App icon badge: due today | ● ✓ | ● ✓ | ● ✓ | ◐ ✓ | ● | ○ | Mac Dock badge; Windows tray count |
| Notification inbox (bell): mentions, replies, assignments; read / read all | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `NotificationBell.tsx`, `/notifications` |
| Settings → Notifications: time zone, default reminder time, email reminders, daily digest, quiet hours per workspace, calendar feed link, test notification | ● | ● | ● | ● | ● | ● | `NotificationSettingsPanel.tsx` |
| Activity feed (workspace) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `ActivityFeed.tsx`, `/workspaces/:id/activity` |

## 8. Comments and mentions

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Comment on selected text (thread anchored in the doc) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `collabComments.ts` |
| Comments panel: reply, edit, delete, resolve, reopen | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `collabCommentsPanel.tsx`, `/comment-threads` |
| @mentions in comments (and pages) with notifications | ● | ● | ● | ● ✓ | ● | ● | `collabMentions.ts` |

## 9. Workspace, members and roles

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Workspace settings: General, Members, Teams, Tags, Activity, Trash | ● | ● | ● | ● ✓ | ● | ● | separate from personal settings (v0.4.10) |
| Rename / delete workspace (owner) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |
| Invite by email; copy, resend, revoke pending invites; invite link shown | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `MembersPanel.tsx`, `InvitePage.tsx` |
| Roles: owner, admin, member, viewer; change role, remove member | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | |
| Access changes take effect immediately (open pages too) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | server-driven |
| Admin stats (server admins) | ○ | ○ | ○ | ○ | ○ | ● | `/admin/me`, `/admin/stats` *(verify where shown)* |

## 10. Search

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Search page titles, text, tasks (best first) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `GET /workspaces/:id/search`; phone Search tab |

## 11. Locked pages

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Lock / unlock a private page (locked, not encrypted) | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `LockedNotes.tsx`, `/pages/:id/lock` |
| One password unlocks all locked pages on the device; keepalive / auto-lock | ● ✓ | ● ✓ | ● | ● ✓ | ● | ● | `/locked-notes/unlock`, `/keepalive` |
| Face ID / Touch ID / fingerprint unlock (device registration) | ● ✓ | ● ✓ | ○ | ○ | ● | ○ | `/locked-notes/devices`; Face ID untested on device |
| Settings → Security → Locked notes: create / change password, biometrics on/off, reset with sign-in password + code | ● | ● | ● | ● | ● | ● | |
| App lock with Face ID / fingerprint | ● | ● | ○ | ○ | ● | ○ | `AppLockSettings.tsx`, ⌘K → Lock app |

## 12. Offline and caching

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Opens offline from a cold start | ● ✓ | ● ✓ | ● ✓ | ● | ● | ● | bundled web app; service worker on web |
| Opened pages editable offline, sync on reconnect | ● | ● | ● | ● | ● | ● | `pageCache.ts`, `offlineCache.ts` |
| Tree and tasks cached for offline reading | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `store/cache.ts` |

## 13. Import and export

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Export workspace (.zip: Markdown, tasks, attachments, templates, backup) | ● | ● | ● | ● | ● | ● | owners/admins, 6/hour |
| Import from export → new workspace | ● | ● | ● | ● | ● | ● | 100 MB, 3/hour |
| Import from OneNote (Microsoft sign-in, pick notebooks, progress, cancel) | ◐ | ◐ | ◐ | ◐ | ◐ | ● | "start it from the web app": sign-in finishes in the browser |

## 14. Connected apps (AI connector)

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| OAuth consent page for AI apps | — | — | — | — | — | ● | `OAuthConsent.tsx`, `server/oauth` |
| Settings → Connected apps: list, revoke | ● ✓ | ● ✓ | ● ✓ | ● ✓ | ● | ● | `ConnectedApps.tsx` |
| MCP connector at `/mcp` | — | — | — | — | — | — | server only; unchanged by the rewrite |

## 15. Platform integrations

| Feature | iPad | iPhone | Mac | Windows | Android | Web | Notes |
|---|---|---|---|---|---|---|---|
| Share sheet / share target: Add as task, Save as note (Inbox section) | ● ✓ | ● ✓ | ○ | ○ | ● | ○ | iOS ShareExtension + App Group `group.com.devswartz.notivelo`; Android SEND intent |
| Home-screen Today widget | ● ✓ | ● ✓ | ○ | ○ | ● | — | iOS TodayWidget (WidgetKit), Android `TodayWidgetProvider` |
| Haptics | ● | ● | — | — | ● | — | |
| Keyboard-aware layout | ● ✓ | ● ✓ | — | — | ● | ◐ | `keyboardInset.ts` |
| Menu bar / tray icon with due-today count and quick actions | — | — | ● | ● | — | — | `tray.rs` |
| Close window keeps app running in tray | — | — | ● | ● | — | — | |
| Global quick capture ⌥⌘N / Ctrl+Alt+N (task or note, Tab switches) | — | — | ● ✓ | ● | — | — | `quick.rs` |
| App menu shortcuts (⌘N, ⇧⌘T, ⌘1–8, ⌘,) | — | — | ● ✓ | ● | — | — | `menu.rs` |
| Self-updater (asks before restart) | — | — | ◐ | ● | — | — | direct-download Mac only; Mac App Store build updates via the store |
| Native window theme | — | — | ● ✓ | ● | — | — | `theme.rs` |
| Install as PWA | — | — | — | — | — | ● | |
| Universal links / app links for `/w/…` | ● ✓ | ● ✓ | ○ | ○ | ● | — | associated domains app.notiveloapp.com, staging |

## 16. Store and compliance (Apple)

| Item | Notes |
|---|---|
| Bundle ID `com.devswartz.notivelo` (iOS and Mac App Store) | same App Store Connect records; native builds go to TestFlight as **1.99.x** until Devon approves a release |
| Entitlements today (iOS) | push (`aps-environment`), associated domains, App Group `group.com.devswartz.notivelo` (app, ShareExtension, TodayWidget) |
| Extensions today (iOS) | `com.devswartz.notivelo.ShareExtension`, `com.devswartz.notivelo.TodayWidget` |
| Privacy manifest | `apps/mobile/ios/App/App/PrivacyInfo.xcprivacy`; App Store privacy answers in `docs/app-store-privacy.md` |
| Account deletion in app, sign-up/sign-in, export compliance (`ITSAppUsesNonExemptEncryption`) | must carry over |
