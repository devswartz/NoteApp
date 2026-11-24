# android stream status

Progress, requests and handover for the **android** workstream (`apps/android-native/`, `.github/workflows/android-native.yml`). `apps/mobile/android` is today's Capacitor app and is not touched.

## Now

- Step C (branch `rewrite/android-edit`, cut from `rewrite/native` 5b7f5f4, not merged; **android pauses**): editing. Box text view with IME, the / [[ @ menus, box create / move / resize, task writes, page undo. CI green (run 45308413289 at b50bfb2); compiled, unit-tested and screenshotted in CI only, nothing has run on a device or emulator (no IME, Gboard or touch tested).
- Steps A and B (shell, sign-in, tree, tasks, read-only live pages) are merged (5b7f5f4) and described under Done.

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

## Requests

- android -> core: a change notification for `Core.tasks` (a tick or edit on another device or page does not redraw the task views; the app re-reads when the Tasks tab opens and after its own tick).
- ~~android -> core: `Task` team and recurrence~~ Not a core gap: read from `taskDetails` / `members` / `teams` / `tags` since step C.
- android -> core (step C): the callout emoji and code-block language on `ViewLine` (the view can't draw them); table cell row/column per line; a task-title edit path if the view should handle `focus_task_id`.
- android -> core (step C): a move or resize that also brings the box to the front in one undo step (or a `bringToFront` outside undo); a delete-empty-box outside undo, as the web's drop-on-leave.
- android -> core: an authenticated image/file fetch (`/uploads/..`) so images and file cards can open.

- android -> core (low priority): `Core.tasks` is used only to count open tasks per page row; a per-page count in `Tree` would save the call.
- android -> core: a way to set the Gradle plugin versions of `NotiveloCore/build.gradle.kts` from the including build (or a version catalog), so the app is not tied to AGP 8.7.3 / Kotlin 2.0.21.

## Handover

- Read `docs/rewrite/status/core.md` "For android" first. Build: `bash crates/nv-core/build-android.sh` (NDK + cargo-ndk), then `./gradlew assembleDebug testDebugUnitTest` in `apps/android-native` (pass `-PrustlsPlatformVerifierVersion=<value in target/android/NotiveloCore/gradle.properties>`).
- Step B unverified: a real page opened live on a device (listener thread to main, reconnects, ink outlines through JNA on Android), the task tick against staging, scrolling and pinch on the page canvas (tablet scrolls both ways, no zoom), the drawer swipe, Compose text metrics on real fonts, ink with a pen. Next: the editor ribbon and floating toolbar, reminders, Calendar and Search.
- Step C unverified: everything on a device: Gboard / Samsung keyboard composition, handles and the popup against the keyboard, scroll-into-view inside the Compose scroll, drag-bar and width-pill hit areas, box creation taps, task edits against staging, undo across text / ink / boxes live.
- Unverified: running on a device/emulator, `NotiveloCore.init` and a real TLS sign-in against staging, EncryptedSharedPreferences on devices, edge-to-edge insets, the drawer gesture (there is none yet: the menu button opens it), R8 on a release build.
