# apple stream status

Progress, requests and handover for the **apple** workstream (`apps/apple/`, `.github/workflows/apple-native.yml`, `docs/rewrite/PARITY.md`). Newest first. Since 2026-11-21 this file replaces apple's lines in `docs/rewrite/STATUS.md`.

## Now

- **M5 basics done** on branch `rewrite/apple-m5` (not merged): the iPad app signs in through the core, shows the workspace tree, opens pages live and read-only, and lists tasks with ticks. Built and screenshotted in CI; **real sign-in and live updates are untested** (no credentials in CI): Devon's TestFlight check below is the first real test. Next: whatever that check finds, then editing (nv-editor) and the rest of the iPad PARITY column.

## Requests

- **apple → core** (open, low priority): `Core.openPage` blocks while it connects, and apple runs every core call on one serial queue, so a slow connect holds up a task tick. Either an async/non-blocking connect, or a note on which `Core` calls are safe to run concurrently (apple would then use a concurrent queue).
- **apple → core** (open): reconnect inside `LivePage` (nv-sync robustness, already planned). Until then apple reopens the page itself after `Failed` / `Closed` (2 s doubling to 30 s; 4401 reopens at once, up to 3 times; 4403 stops).
- **apple → core** (open, low priority): unlocking locked pages in the Core API; apple shows "Locked pages open in the web app for now".
- Done: typed box content (core M4 step 1) is what the page view draws now, for live and corpus pages; x86_64 slices exist (apple still sets `EXCLUDED_ARCHS` for x86_64; harmless, can go).

## What exists (all in `apps/apple/`)

- `project.yml` (XcodeGen; the `.xcodeproj` is generated, not committed): targets `Notivelo` (iPad + iPhone, iOS 17, bundle ID `com.devswartz.notivelo`, App Group) and `NotiveloMac` (macOS 14, sandbox + network client). Both depend on the local package `NotiveloCore` at `../../target/apple/NotiveloCore` (CI builds it) and bundle `tests/corpus/cases` as `cases`.
- `Sources/Shared/`:
  - `SessionModel.swift`: owns a `Core` for the server (production, or staging via a hidden switch stored in UserDefaults `useStaging`). Sign-in, `restoreSession` at launch, sign-out; the refresh token lives in the keychain (`Keychain.swift`: generic password, service `com.devswartz.notivelo.native`, account = server URL) and is stored again after every call. All core calls run on one serial queue, results on the main thread; a `SignedOut` from any call ends the session. Also workspaces (last choice per server in UserDefaults), tree, tasks, optimistic ticks (`setDone`). `-previewSignedIn YES` = corpus mode, no network.
  - `SignInView.swift`: form with errors; long-press (1.5 s) the version line to switch production/staging; the host shows in orange when not production; "Try again" when a kept sign-in couldn't be resumed (offline).
  - `MainView.swift`: NavigationSplitView. Sidebar: workspace picker (when there's more than one), Tasks, notebooks → sections (nested) → pages in `position` order (`TreeIndex`), pull to refresh; "Sample pages (corpus)" in corpus mode only. Detail: `LivePageScreen` (live page, read-only, sync badge), `SamplePageScreen`, `TasksView`.
  - `PageSource.swift`: `PageSnapshot` (what the view draws: `PageInfo` incl. typed box content, task lines, page titles), `PageSource` protocol, `LivePageModel` (opens with `Core.openPage`, a coalescing `PageListener` that hops to the main thread, reconnects, closes on leaving the page).
  - `CorpusPage.swift`: corpus pages through `readPage` (typed content too); task lines/title from `input.json`.
  - `PageText.swift`: `PageTextRenderer`, `ContentNode`s → `NSAttributedString` (blocks, marks, core's list markers, task lines, page links by title, unknown nodes).
  - `TasksView.swift`: open tasks (due, priority, checklist count; subtasks under their parent), Completed folded.
- `Sources/iOS/PageCanvasView.swift`: boxes as TextKit 2 text views on the page surface in a zooming scroll view; redraws when the page's content or task lines change, keeping zoom and scroll position.
- Mac: same shell; pages show the core's Markdown (`pageMarkdown` of `LivePage.document()`).

### CI (`.github/workflows/apple-native.yml`, macos-15)

- Triggers: pushes to `rewrite/**` touching `apps/apple/**`, `crates/**`, `Cargo.*` or the workflow. Manual dispatch only works once the file is on `main`.
- Steps: Rust 1.99.1 + Apple targets, build NotiveloCore, `xcodegen generate`, iPad/iPhone simulator build, **iPad screenshots** (boots an "iPad Pro" simulator, screenshots sign-in plus 5 corpus pages via `-previewSignedIn YES -page <case>`; artifact `ipad-screenshots`; worth extending to a signed-in flow later, but don't put real credentials in CI), Mac build, then on `[testflight]` in the head commit message: archive with cloud-managed signing (ASC API key), export, check Apple Distribution signature and version 1.99.x, upload with `testFlightInternalTestingOnly`, revoke CI dev certificates before/after (`scripts/ios-revoke-ci-certs.mjs`), list recent builds.
- Versions: `1.99.<run_number>`; build `<mobile.yml's latest run>.<run_number>` (e.g. 130.8), always above uploaded builds and below the next real release build.
- A full run with upload takes about 8–12 minutes; `gh run watch <id> --exit-status` then `gh run view <id> --log | grep -E 'notice\]Uploaded|IOS 1.99'`.
- Risk: the cert-revoke script could revoke a concurrently running `mobile.yml` release's certificate; avoid `[testflight]` while a real release runs.

### TestFlight so far (all VALID unless noted)

1.99.2 (130.2) skeleton · 1.99.4 (130.4) core linked · 1.99.5 (130.5) corpus page view · 1.99.8 (130.8) task-line indent fix · **1.99.20 (130.20) M5 basics** (run 44920271305, uploaded; Apple processing not checked).

## How Devon tests this build

- **1.99.20 (130.20)**, on the iPad from TestFlight:
  1. The sign-in screen shows "Native preview" and `1.99.20 (130.20) · core 0.1.0 · page format 2`. Sign in with your Notivelo email and password. A wrong password should say "Wrong email or password." under the button.
  2. The sidebar (tap the sidebar button in portrait) shows **Tasks** and your notebooks, open, with their sections folded; open a section (subsections nest) to see its pages in the web app's order. With more than one workspace, a **Workspace** picker sits at the top; switching reloads the tree. Pull down on the sidebar to refresh.
  3. Tap a page: "Opening…", then its boxes at their positions (read-only; pinch to zoom, double-tap). Task lines show title, done and due date from your task list.
  4. With the page open on the iPad, edit that page in the web app (type in a box, add a line, tick a checkbox). The iPad should show each change within a second or so, without jumping back to the top or losing the zoom.
  5. Tap **Tasks**: open tasks by due date, subtasks indented under their parent, "Completed (n)" folded at the bottom. Tap a circle: it ticks at once and moves to Completed; the web app should show it done. Tap it again in Completed to reopen.
  6. Quit the app (swipe it away) and reopen: it should go straight back in (kept sign-in). The person icon at the top of the sidebar → **Sign out** returns to the sign-in screen; reopening the app then asks to sign in again.
  7. Staging: on the sign-in screen, press and hold the version line for 1.5 s: "Server: staging.notiveloapp.com" appears in orange and sign-in now goes to staging. Hold again to go back to production.
  - Not there yet: editing, locked pages ("open in the web app"), images (shown as a placeholder line), comments, search, the task views beyond the one list. Please note anything that fails, especially at steps 1, 4 and 6 (never run against the real server before).
- In corpus mode (CI screenshots only, `-previewSignedIn YES`), the sidebar still lists the corpus sample pages.

## Done

- 2026-11-21, M5 basics (`rewrite/apple-m5`): real sign-in with the keychain and staging switch, workspace tree, live read-only pages from the core's typed box content (corpus pages through the same renderer), task list with optimistic ticks. CI green (simulator, screenshots, Mac); TestFlight 1.99.20 (130.20) uploaded by run 44920271305.
- 2026-11-21: page view merged into `rewrite/native` (41c64bc); see `docs/rewrite/STATUS.md` Done for M1 and the M4 groundwork.
