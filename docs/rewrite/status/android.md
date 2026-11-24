# android stream status

Progress, requests and handover for the **android** workstream (`apps/android-native/`, `.github/workflows/android-native.yml`). `apps/mobile/android` is today's Capacitor app and is not touched.

## Now

- Images, attachments, ink editing and the PARITY audit (branch `rewrite/android-media`, cut from `rewrite/native` 562c7da, not merged; **android pauses**): CI run 45422902949 green at b3d6c0c ("android app" and "emulator UI tests"; the later commits are docs only). Android column ticked in PARITY.md: 24 of 142 rows, 118 left (see Parity left). Nothing has run on a device.
- Steps A-C and the emulator UI tests are merged (b2780d2) and described under Done.

## Done

- **Project** `apps/android-native/`: Kotlin DSL, version catalog, wrapper (Gradle 8.10.2), app id `com.notivelo.app.native` (debug `.debug`), minSdk 26, target/compile 35, Compose (BOM 2024.12.01) with Material3 only as a base; every colour, size and type is custom (`look/Palette.kt`, `look/Theme.kt` = tokens from LOOK.md). AGP 8.7.3 / Kotlin 2.0.21 are pinned because the core module (`crates/nv-core/kotlin/NotiveloCore/build.gradle.kts`) pins them and a module in the same build must match; newer needs the core module bumped too.
- **Core**: `settings.gradle.kts` includes `target/android/NotiveloCore` (built by `crates/nv-core/build-android.sh`, never committed). `NotiveloCore.init(this)` in `NotiveloApp.onCreate`; calls run on `Dispatchers.IO` (`AppViewModel`), results go to a `StateFlow<AppState>`. ABIs: arm64-v8a and x86_64 only (`NV_ABIS` in CI, `abiFilters`).
- **Session**: sign-in (server defaults to `https://app.notiveloapp.com`; long-press the app name on the sign-in card shows a server field), refresh token in EncryptedSharedPreferences (`data/SessionStore.kt`), restored at launch (cached workspaces/tree first, then the server), rotated token stored again, sign out (core clears its store). Offline at launch keeps the token and shows an error on the sign-in screen.
- **Shell**: phone (<= 760 dp): top bar, tab bar, FAB, drawer with workspace switcher, notebook picker, sections tree, user row; Notes drill-down notebooks, notebook, section, page. Tablet (>= 761 dp): Notes ribbon, rail, sidebar (open from 900 dp), overview / empty section / page. Pages open a placeholder; Tasks, Calendar, Search, notifications, row menus and every write show "... is not in the native preview yet."
- **Look scenes**: `look/LookData.kt` (in-memory data of docs/rewrite/look/seed.ts), `LookRoot(state)`; a debug build opens one with `--es lookState <name>`. Paparazzi tests `app/src/test/kotlin/.../look/Shots.kt` (JVM, no emulator) render them at 390x844 @2x and 820x1180, 1180x820 @1x. CI: `recordPaparazziDebug -Pshots`, `scripts/collect-shots.py` names them like the references, `docs/rewrite/look/side-by-side.py` makes pairs. Artifacts: `notivelo-android-debug`, `android-shots`, `android-side-by-side`. No goldens committed.
- **Icons**: `scripts/lucide-to-vector.py` turns the Lucide SVGs in `docs/rewrite/look/icons/` into vector drawables (only the ones listed in the script).
- **Tests** (JVM): `TreeIndexTest` (ordering as web/Apple), `AppViewModelTest` (restore, rejected/offline token, sign-in errors, workspace switch and memory, navigation, sign out), `RelativeTimeTest`. Screenshot tests only run with `-Pshots`.

### Step B

- **Tasks** (`ui/tasks/`, `data/TaskModel.kt`): `TaskBuckets` is the Apple app's `TaskBuckets` (Today = mine, due today or earlier; Upcoming = due within 14 days, Mine or Everyone; My Tasks; All; groups Overdue / Today / Tomorrow / weekday / date / No date, sorted by date then priority; the sidebar's Upcoming count is tomorrow to 14 days). Rows, stats card, empty states, detail sheet (phone bottom sheet, tablet 480 dp side sheet). Tasks come from `Core.tasks`; the tick is `Core.setTaskDone`, shown at once and put back with a toast if the call fails (`AppViewModel.toggleTask`). Phone: Tasks tab, the drawer shows the Tasks panel on that tab. Tablet: rail, Tasks panel in the sidebar, Tasks ribbon.
- **Pages** (`ui/page/`): `AppViewModel` opens a page with `Core.openLivePage` while it is the chosen one (a core-thread listener posts to the main scope; `PageView` holds `PageInfo`, ink outlines and the status), shows `cachedPageDocument` first, closes it on leaving. `PageLayout` (pure, tested) places boxes at 40 + x, 167.95 + y (wide boxes: visible width minus 80; higher z in front), phones stack them in reading order. `Blocks.kt` draws the core's `ContentNode` tree with Compose: paragraphs, headings, bullet / numbered (the core's `markers`) / check lists, task lines (title, ticks, priority, due, checklist count, notes with a guide), callouts, toggles, quotes, code, tables, images, file cards, mentions, page links, marks (bold, italic, underline, strike, code, link, text colour, highlight, comment anchors), CSS margin collapsing. Ink: `inkStrokes` + `inkOutline` path commands to a Compose `Path` (highlighters under the boxes, pens over). Rule lines and grid, page colours. A remote change calls the listener and redraws.
- **Ribbons** (`ui/tablet/Ribbons.kt`): note ribbon (disabled editing controls, enabled page colour, rule lines, print, outline, history dimmed), Tasks ribbon, Notes ribbon.
- **Look data**: `LookPages.kt` is generated by `scripts/corpus-to-kotlin.py` from the corpus `expected.json` (the same typed tree `readPage` returns; the JVM screenshot job has no host build of the core), `LookDemoPages.kt` has Weekly sync and Q4 roadmap, `LookData.tasks` the demo tasks. Icons: `lucide-to-vector.py` now covers the ribbon and task icons and a filled flag.
- **Emoji page icons** rendered as "..." because the big icon `Text` ellipsized (`maxLines = 1`); the icon text now never wraps or ellipsizes (emoji themselves rendered all along in smaller sizes).
- **Drawer swipe** (phone): a drag from the left 24 dp edge opens, a drag left on the drawer or scrim closes. It does not follow the finger (opens and closes at once after 48 dp).
- **Tests** (JVM): `TaskBucketsTest` (buckets, groups, counts, due words, tones), `PageLayoutTest` (box places, wide boxes, z order, icon shift, phone stacking, document pages), `AppViewModelTest` (tick and refusal, page open/close, task navigation).

### Step C (editing)

- **Box text view** (`ui/page/` editor files): tapping a box on a live page opens an `EditorSession` for it (`PageHandle.openEditor` -> `EditorSession.openLive`, held by `AppViewModel.startEditing/stopEditing`); a tap on empty canvas or leaving the page ends it. A custom `View` in `AndroidView` with an `InputConnection`: commitText (newline = Enter, tab = Tab), setComposingText / setComposingRegion / finishComposingText to the core's composition calls, deleteSurroundingText (UTF-16 and code points), setSelection, batch edits, text before/after/selected, extracted text, cursor anchors, context-menu and editor actions; `updateSelection` after every change, `restartInput` when the engine drops a composition. Hardware keys: Ctrl chords to `key()`, Ctrl+C/X/V through the system clipboard (HTML + plain), arrows / Home / End by the layout. Lines are drawn with Blocks.kt's metrics; caret, selection, drag handles, double-tap / long-press word select, floating Cut / Copy / Paste / Select all. Relayout on `text_revision`, repaint on `revision`.
- **Menus**: `/`, `[[`, `@` open as a non-focusable popup at the caret (slash highlight from the engine, page and people highlight in the view; names from the tree and `Core.members`); tap, arrows, Enter, Tab, Escape.
- **Boxes** (tablet): a tap on empty canvas creates a 360-wide box 12 above the tap (snapped to rule lines) and edits it; while editing, the web's frame with a drag bar (move) and width pill (resize), live while dragging, one `LivePage.moveBox/resizeBox` at drag end, clamped as the web (0..20000, widths 120..2400). An empty box is deleted when editing ends (never the page's default box). The first tap while editing only ends editing (Apple's behaviour). Phone: boxes stay stacked (as the web); an "Add a text box" row under the stack.
- **Page undo**: phone top bar, tablet ribbon, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y and the text menu call `LivePage.undo/redo` (also while a box is edited), enabled from `canUndo/canRedo`.
- **Task writes**: title, details, assignee, team, tags, due date, time, priority, repeat presets, subtasks, delete (confirmed), quick add with the core parser (`parseQuickAdd`, `resolveMember`, `resolveTeam`, tags by name) from the FAB, Add task rows, the Tasks panel and ribbon. Team chip, tags and other people's avatars on rows; Team and Repeat rows in the detail (from `taskDetails`, `teams`, `tags`, `members`).
- **Tests** (JVM): `BoxInputTest` (22, IME mapping against a fake engine, emoji deletes), `SuggestionsTest`, `BoxGeomTest`, `TaskEditTest`, about 20 new `AppViewModelTest` cases. Shots: edit-caret, edit-selection, slash-menu, task-detail-edit (phone and tablet, light / dark / hybrid caret).
- **Not done**: floating formatting toolbar and the editor ribbon's formatting buttons; editing a task title inside a page (`focus_task_id`); tables edit as stacked cell lines; callout emoji always 💡 and the code header always "Plain text"; no collapsed-caret handle, stylus handwriting or scroll-above-keyboard; moving a box doesn't bring it to the front; reminders and new tags in the task detail; date / time / assignee pickers are dialogs with no shot.

### Emulator UI tests

- **Offline source** (`data/OfflineBackend.kt`): debug builds only (`FLAG_DEBUGGABLE`), `--es source offline` skips sign-in and opens a one-page workspace whose two boxes are real core `EditorSession`s over local documents (as Windows' `NOTIVELO_SOURCE=offline`). Core has no offline `LivePage`, so offline page undo is the last-edited box's undo. Test tags on boxes and the phone bar's undo/redo.
- **CI job** "emulator UI tests" in `android-native.yml`: `reactivecircus/android-emulator-runner` v2.35.0, API 34 x86_64 google_apis, pixel_6, KVM, AVD cache, hardware keyboard; builds the x86_64 core only; `scripts/run-ui-tests.sh` runs `connectedDebugAndroidTest`, hides ANR dialogs, pulls failure screenshots and logcat; artifact `android-ui-test-reports`. Took 12 runs to go green (emulator timing and Compose idling in the tests, not the app).
- **Tests** (`app/src/androidTest/.../BoxEditingTest`, 16, all passing): hardware keys (typing, Enter, Backspace, arrows, Ctrl+A/C/X/V, Ctrl+Z / Shift+Z / Y); the real view's `InputConnection` (commit, composition, composing region, delete-surrounding, sendKeyEvent, setSelection, context-menu cut/copy/paste); the `/` menu (tap Heading 1, filter + Enter, Down + Escape, the `- ` shortcut); long-press word select and tap caret placement; undo/redo from the bar buttons, including a structural undo; switching boxes. Assertions read the engine's view frame.
- **Fixed**: the hardware Space key never typed (`isPrintingKey` is false for Space).
- **Not covered**: soft keyboards (Gboard, Samsung), handle dragging, `[[` and `@`, box create / move / resize, task writes, tablet width, `LivePage` undo across text, ink and boxes (no offline LivePage). Diagnostic logging (`nvLog`, a `Log.i` in the `BoxEditor` factory) is still in `AppViewModel` / `BoxEditor`; remove it when next touching them.

### Images, attachments and ink

- **Images** (`media/`): fetched through the core's `downloadFile`, memory + disk cache, decoded off the main thread with EXIF rotation, sized as the web (own width, capped to the box), in both the static and the edited box view. A just-uploaded picture is cached at once.
- **Files**: file cards open through `downloadFile`, a FileProvider and `ACTION_VIEW`. Insert: system picker (`GetContent`) -> `uploadFile` -> `insertImage` / `insertFile` in the edited box, from the `/` menu, the tablet ribbon Insert and image paste.
- **Ink** (`ink/`): a Draw button (tablet ribbon, phone page bar) opens a pen bar: pen, highlighter, eraser, partial eraser, the web's colours and widths, "draw with finger". Stylus and mouse draw, the stylus eraser end erases whole strokes, a finger scrolls unless "draw with finger" is on. One `addInkStrokeFromSamples` / `eraseInk` per gesture with a live preview; the page re-reads after each write; page undo covers it.
- **Tests** (JVM): `MediaSizingTest`, `InkModelTest` (tool-type gating, samples), 4 `AppViewModelTest` cases (upload -> insert, file open, ink writes), `InkBarShots` (3 Paparazzi). The 16 emulator tests still pass. The leftover diagnostic logging from the UI-test round is removed.
- **Not done**: camera, full-size image view, image resize, ink settings kept between launches, pressure / smoothing in the live preview (the committed stroke has them), tilt. **Unverified on a device**: the picker, clipboard image paste, FileProvider open, stylus pressure and historical points.

## Look, per state (step B; CI run 45288154806, side-by-side artifact, two rounds of fixes)

| State | Status |
|---|---|
| iphone tasks-today, tasks-upcoming, tasks-my, tasks-all, empty-tasks-*, dark / hybrid tasks-today | Close: heading, stats card, group heads, rows (69 dp), meta chips, Add task, FAB, tab bar. Differs: no Staff team chip or tags, heading and stats a few dp off after round 1 (not re-checked on every list), font. Upcoming Mine/Everyone toggle and Add filter drawn as the Apple app does. |
| iphone task-detail | Close: sheet, head, title, property rows (46 dp pitch), details box, subtasks, footer. Differs: no Team and Repeat rows, no resize grip, text a little smaller. |
| iphone page-canvas-boxes, page-blocks, page-lists, page-tasks, page-meeting, page-roadmap, page-settings-and-ink (+ -2, dark, hybrid) | Close: header, box stacking, hairlines (after round 1: heading margins from the CSS, table margins not collapsed, task notes indent and guide). Differs: images are a placeholder, the toggle row and image rows a few dp off, page links underlined without the pill, comment anchors a little stronger, "Edited" times differ (look clock), `-2` scroll offsets are a guess (800 px) not matched to the references. |
| ipad-landscape / ipad-portrait page-* | Close: ribbon (Normal, B I U S ..., history), page bar with Saved, badge and Share, boxes at their places, overlap and z order, blank box off screen. Differs: sidebar shows RECENT and no highlighted section row while a page is open, outline bars at the top right missing, sidebar Team row missing. |
| ipad-* tasks-*, task-detail, empty-tasks-* | Close: Tasks ribbon, Tasks panel with counts (Upcoming 7 after round 1), content, side sheet 480 dp. Differs: Team row, team chip, 6 dp on the heading before round 1 (fixed, not re-checked). |
| dark / hybrid page and tasks states | Close; colours follow the palettes (Hybrid page is the light palette on #fcfcfa). |

## Differences from the references (known)

- Font: system sans (Roboto). LOOK.md's stack lists Roboto after SF Pro, Inter and Segoe UI, none of which ship on Android; the references are Segoe UI, so widths and glyph shapes differ a little.
- Step B: no "Add a text box" on tablet, "Add a task to this page" or "Linked from" under a page; images are a placeholder with the alt text (uploads need an authenticated fetch); the page outline bars at the top right are not drawn; ink strokes are not in the look shots (no host core to decode them) but are drawn from the core in the app; the page bar shows the page title over the workspace name when scrolled on the web, not here; a due time reads "09:30" where the web writes "9:30" and the recurrence icon is missing; the web's text is Segoe UI, ours the system sans.
- The phone drawer shows no open-task counts (the reference has none); the tablet tree does.
- Paparazzi caps snapshots at 1000 px high, so the iphone and ipad-portrait shots are scaled down (and the side-by-side scales them back up).
- Emoji page icons depend on the renderer's emoji font.
- Shadows (card, FAB, drawer) use Compose elevation shadows, not the CSS two-layer blur.
- Phone notebook screen and section page rows have no reference; they follow the section screen's style.
- No hover, drag-resize of the sidebar, ribbon collapse, Recent group contents, Favourites, row menus, search, notifications.

## Parity left (Android, 2026-11-24)

Audit of `docs/rewrite/PARITY.md` (Android column) against `apps/android-native` at b3d6c0c (branch `rewrite/android-media`, docs only; no code touched). Of the 142 rows with an Android ● or ◐, **24 are ticked ✓** (checked by reading the code, with the JVM tests, Paparazzi shots and the 16 emulator UI tests as evidence where one exists) and **118 are left**. Classes: **no-server** = can be built in the app now with core calls that exist (Windows and Apple already use them) or with none; **Devon** = needs Devon (accounts, store, signing, a decision); **M7** = needs a new core call on a server route that exists, or the M7 local-first work (the Windows rule; Apple counts a new core call as no-server). A ✓ means built and compiled; nothing ran on a device or against a server. Not listed: rows that are `—` for Android, and Handwriting / ink, which is `○` in PARITY (flag off everywhere) but is built natively (below).

**Ticked (24):** sign-in, sign-in kept securely, sign out, workspace switcher, notes panel, notes home overview, undo/redo in the phone bar, canvas page (phones stack boxes), page undo/redo, headings, bulleted lists, numbered outlines, plain checklist, Backspace/Enter leave a block, file attachments, slash menu, Markdown input rules, copy and paste (HTML + plain), task chips in notes, notes under a task, subtasks, checklist under a task, quick add, sidebar counts. Judgement calls: leaving a block, the list rules, and notes and checklists under a task are the engine's behaviour, drawn by `Blocks.kt` and typed through the view (the emulator tests cover typing, Enter, the `- ` rule, the slash menu and undo, not each list kind); file attachments are built on this branch (picker, `uploadFile`, `insertFile`, cards open through FileProvider) and have no emulator test.

**Images (row not ticked):** insert from the picker, the `/` menu, the tablet ribbon and paste, and display through `downloadFile` with a memory and disk cache all work; resizing by a corner (`setImageWidth`) and the full-size view do not. **Ink (row is `○`, not ticked):** Draw button (tablet ribbon, phone page bar), pen, highlighter, eraser, partial eraser, the web's colours and widths, stylus, finger with "draw with finger", one core call per gesture, covered by page undo; saved ink settings and the camera are not built.

**Most used no-server rows, in order** (everyday flows first):

1. Create notebook / section / page, rename, page icon, delete to Trash and Trash: toasts "not in the native preview yet" today.
2. Floating formatting toolbar, marks, links editor and the editor ribbon: formatting can only be applied with a hardware keyboard.
3. Search and Calendar tabs: both are toasts.
4. Page title edit; save state with "Saving".
5. Task flows: tick and edit a task from its line in a page, Task button, Tasks on this page, filters, sort, group, Team view, reminders and the other detail fields.
6. Offline: cold start with no network, cached tasks.
7. Share, comments, version history, notification inbox.

### no-server

| Row | Android today | What it needs |
|---|---|---|
| Create account, email confirmation screen (without Resend), forgot password, profile, change password, delete account, invite link | missing (toasts "Creating an account", "Password reset"); Privacy · Terms · Support is text, not links | sign-in card forms and a Settings screen (none yet) on `register`, `restore_session`, change password, `delete_account`, accept invite |
| Release builds locked to the server, hidden Change server; Privacy, Terms, Support links | long-press shows the server field in every build; links not tappable | gate the field on `FLAG_DEBUGGABLE`; open the three pages |
| Bottom tab bar | Notes, Tasks, Calendar, Search; Calendar and Search are toasts; no Today or + | tabs as the web (Notes, Today, +, My Tasks, Search) |
| Section ribbons / colour tabs; Favourites and Recent | section colour bars only; Recent in the tablet sidebar, no Favourites | section tab strip; device-local favourites |
| Create notebook / section / page, rename, page icon, move and copy, share a notebook, delete to Trash | missing (the ribbon's "New section" and the menus are toasts) | tree write calls and dialogs |
| Tree drag; Trash list / restore; trashed page read-only with Restore | missing | move calls by drag; `CachedTrashedPages`, `RestoreFromTrash`, read-only banner |
| Floating formatting toolbar; marks; links editor; tables; callout, toggle, code | marks, tables, callouts, toggles and code are drawn; no way to apply a mark, edit a link, add a table row, set a callout emoji or code language | toolbar and ribbon buttons on the engine's mark, link and table commands; core `ViewLine` for the emoji and language |
| Page links: create page from link; page title edit; image resize; spellcheck | `[[` menu works; title is display only; images draw without handles; the custom view has no spell check | `CreatePage`; a title field; `setImageWidth` on a corner drag; Android spell-check on a real device |
| Boxes: select, cut/copy/paste/duplicate/delete, context menu; drag handle; cursors and presence; follow a collaborator | create, move, resize, delete-empty; no box selection, no presence | selection state, `DeleteBoxWithContent`, `CreateBoxWithId`; `AnnouncePresence`, `Presence`, `RemoteCursors`; engine `moveBlockUp/Down` |
| Save state with Saving; offline pill after 30 s; toasts with Undo | Saved, Offline, Connecting only; toasts have no action | an unsent-updates poll; an Undo action on the toast |
| Command palette; shortcut overlay; swipe actions; themes; accent colour | missing; the app follows the system | small UI work and a Settings screen |
| Deep links `notivelo://`; share target; Today widget; haptics; keyboard-aware layout; local notifications; launcher badge | missing (no intent filters, widget or receiver; no scroll above the keyboard) | manifest intent filters, an `ACTION_SEND` target, an app widget, haptic feedback, `imePadding` with scroll-into-view, `POST_NOTIFICATIONS` |
| Print page / selection / PDF, print section / notebook, print task view, export page | missing (the ribbon's Print is a toast) | `PrintManager`; Markdown export and the share sheet |
| Version history; share with people; public share link; Shared with me; comments, panel, @mentions in comments | missing (comment anchors are drawn only) | the Windows page-tools calls, panels and dialogs |
| Task in a note is the real task; insert task; deleting a task line deletes the task; Tasks on this page | task lines drawn with real task data; no tick or edit from the line, no Task button, no panel | `setTaskDone` from the line, `focus_task_id` (core request), ribbon and `/task`, a page task list |
| Task detail extras; views Team, status, streak; calendar; filters, sort, group; assignee groups by team; keyboard; bulk; inline rename; custom recurrence; tasks offline | Mine / Everyone, buckets and a detail with presets; no reminders, assigned-by, new tags, Calendar, filters, selection | reminder and notes calls, `TaskDetails`; client code; `CachedTasks` |
| Reminders; notification inbox; notification settings | missing | reminder calls, `notifications`, settings calls |
| Lock / unlock a page, one password and keepalive; Settings > Security > Locked notes; app lock with biometrics | missing | the lock calls (built on Windows), `SetLockedNotesPassword`, `BiometricPrompt` (device only) |
| Search; access changes take effect | Search tab is a toast; a page you lose shows "You no longer have access" (other cases unchecked) | `search`; check removal from a workspace |
| Opens offline from a cold start; tree and tasks cached | offline at launch keeps the token and shows an error on the sign-in screen; the tree is cached, tasks are not | open the shell from `cachedWorkspaces` / `cachedTree` and cached tasks |
| Import from OneNote; Connected apps | missing | link out to the web importer; list and revoke |

### Devon

| Row | What it needs |
|---|---|
| Push reminders with snooze | Firebase project and `google-services.json`, Play signing, a core call for the device token |
| "New version available" | decision: Play in-app updates, or only the Play Store |
| App links for `/w/…` | `assetlinks.json` on app.notiveloapp.com with the release signing SHA-256 |

### M7 (a new core call on an existing server route, or the local-first work)

| Rows | Missing |
|---|---|
| Resend verification email; export my data; send feedback; error reporting | resend-verification, `GET /me/export`, `POST /feedback`, `POST /client-errors` |
| Create workspace; rename/delete workspace; workspace settings; activity feed | `/workspaces` create, `PATCH/DELETE /workspaces/:id`, activity |
| Templates: all seven rows | `/workspaces/:id/templates`, `/pages/:id/templates`, `/templates/:id(/use)`, `/sections/:id/default-template` |
| Backlinks; page colour and rule lines (write) | `GET /pages/:id/backlinks`; a page-settings write (shown, not changeable) |
| Saved views; tags rename/colour/delete; teams and members | `/workspaces/:id/task-views`, `/tags/:id`, `/teams/:id` |
| Export workspace, import from export | export and import routes |
| Fingerprint unlock and device registration | `/locked-notes/devices` call (check whether core has it) |
| Opened pages editable offline | store-backed offline pages and the offline queue |

**Counts:** ticked 24; left 118 = no-server 90, Devon 3, M7 25.

## Requests

- android -> core (optional): image width and height from `uploadFile`, or `insertImage` taking the natural size.

- android -> core: a change notification for `Core.tasks` (a tick or edit on another device or page does not redraw the task views; the app re-reads when the Tasks tab opens and after its own tick).
- ~~android -> core: `Task` team and recurrence~~ Not a core gap: read from `taskDetails` / `members` / `teams` / `tags` since step C.
- android -> core (step C): the callout emoji and code-block language on `ViewLine` (the view can't draw them); table cell row/column per line; a task-title edit path if the view should handle `focus_task_id`.
- android -> core (step C): a move or resize that also brings the box to the front in one undo step (or a `bringToFront` outside undo); a delete-empty-box outside undo, as the web's drop-on-leave.
- android -> core (low priority): an offline `LivePage` opening (local document, no server) so the emulator tests can cover page undo across text, ink and boxes.
- android -> core: an authenticated image/file fetch (`/uploads/..`) so images and file cards can open.

- android -> core (low priority): `Core.tasks` is used only to count open tasks per page row; a per-page count in `Tree` would save the call.
- android -> core: a way to set the Gradle plugin versions of `NotiveloCore/build.gradle.kts` from the including build (or a version catalog), so the app is not tied to AGP 8.7.3 / Kotlin 2.0.21.

## Handover

- Read `docs/rewrite/status/core.md` "For android" first. Build: `bash crates/nv-core/build-android.sh` (NDK + cargo-ndk), then `./gradlew assembleDebug testDebugUnitTest` in `apps/android-native` (pass `-PrustlsPlatformVerifierVersion=<value in target/android/NotiveloCore/gradle.properties>`).
- Step B unverified: a real page opened live on a device (listener thread to main, reconnects, ink outlines through JNA on Android), the task tick against staging, scrolling and pinch on the page canvas (tablet scrolls both ways, no zoom), the drawer swipe, Compose text metrics on real fonts, ink with a pen. Next: the editor ribbon and floating toolbar, reminders, Calendar and Search.
- Step C unverified: everything on a device: Gboard / Samsung keyboard composition, handles and the popup against the keyboard, scroll-into-view inside the Compose scroll, drag-bar and width-pill hit areas, box creation taps, task edits against staging, undo across text / ink / boxes live.
- Unverified: running on a device/emulator, `NotiveloCore.init` and a real TLS sign-in against staging, EncryptedSharedPreferences on devices, edge-to-edge insets, the drawer gesture (there is none yet: the menu button opens it), R8 on a release build.
