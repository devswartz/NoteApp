# apple stream status

Progress, requests and handover for the **apple** workstream (`apps/apple/`, `.github/workflows/apple-native.yml`, `docs/rewrite/PARITY.md`). Newest first. Since 2026-11-21 this file replaces apple's lines in `docs/rewrite/STATUS.md`.

## Now

- **M5 (iPad app on the online Core API)**: branch `rewrite/apple-m5`, cut from `rewrite/native` at f9ba1df. Not started: this file is the handover for a fresh session (the previous one's context ran large).

## Requests

- **apple → core** (open, core is on it): typed **box content** for a page (what's in each box), so the page view stops reading `tests/corpus/cases/*/expected.json`. Core will say when in `docs/rewrite/status/core.md`.
- **apple → core** (open, low priority): `x86_64` slices (simulator, macOS) in the XCFramework; apple excludes x86_64 for now (`EXCLUDED_ARCHS` in `apps/apple/project.yml`).

## Handover for a fresh session (2026-11-21)

### The task (from the overseeing session)

On `rewrite/apple-m5`, make the iPad app real against the online Core API (see "core → apple: online Core API (M3)" in `docs/rewrite/STATUS.md`):

1. **Sign-in**: `Core(serverUrl:)`, `signIn(email:password:)`. Keep the refresh token in the keychain and store `core.refreshToken()` again after calls (it rotates). `restoreSession(refreshToken:)` on launch; sign-out. Server `https://app.notiveloapp.com` by default, with a hidden staging setting (`https://staging.notiveloapp.com`). Run core calls off the main thread (they block).
2. **Sidebar**: workspaces, then notebooks, sections (nest up to 3 levels) and pages from `tree(workspaceId:)`, in today's order, in the NavigationSplitView.
3. **Open a page live, read-only**: `openPage(pageId:listener:)` returns a `LivePage`; implement `PageListener` (`onStatus`, `onChange(page:)`, called on the core's thread: hop to the main actor) and redraw the TextKit 2 view so web edits show up live. Keep the corpus-JSON content path behind a protocol until core's typed box content lands.
4. **Tasks list**: `tasks(workspaceId:)`; tick with `setTaskDone`.

Upload to TestFlight as 1.99.x after each working step (commit message with `[testflight]`), and add a "How Devon tests this build" note below (what to tap, what should happen). Don't edit `docs/rewrite/STATUS.md`; write here. Don't merge to `rewrite/native` or `main`.

### What exists (all in `apps/apple/`)

- `project.yml` (XcodeGen; the `.xcodeproj` is generated, not committed): targets `Notivelo` (iPad + iPhone, iOS 17, bundle ID `com.devswartz.notivelo`, App Group `group.com.devswartz.notivelo`) and `NotiveloMac` (macOS 14, sandbox + network client). Both depend on the local package `NotiveloCore` at `../../target/apple/NotiveloCore` (built by `crates/nv-core/build-xcframework.sh`; CI does it) and bundle `tests/corpus/cases` as the folder `cases`. arm64 only.
- `Sources/Shared/`:
  - `NotiveloApp.swift` (@main), `RootView.swift` (sign-in vs main), `SessionModel.swift` (**placeholder** sign-in: replace with the Core session; `-previewSignedIn YES` launch argument skips sign-in, CI screenshots use it).
  - `SignInView.swift`: placeholder form; shows `1.99.x (build) · core <version> · page format <n>`.
  - `MainView.swift`: NavigationSplitView; sidebar has task views (placeholders) and "Sample pages (corpus)"; `-page <case>` launch argument opens a corpus page. `PageScreen` loads a page: iOS draws `PageCanvasView`, Mac shows `pageMarkdown`.
  - `CorpusPage.swift`: loads a corpus case: `readPage(update:)` for kind, settings and boxes in reading order; box content and task lines from the case's JSON. **This is the path to put behind a protocol** (e.g. `PageSource` giving `PageInfo` + per-box content + task lines), with a live implementation on `LivePage`.
  - `PageNode.swift`: box content tree (element/text runs with marks), same shape as the corpus fragments; `TaskLine` (shown/hidden).
  - `PageText.swift`: `PageTextRenderer`, nodes → `NSAttributedString` (every block and mark in the corpus; list markers via core `listMarker`; tasks with title/done/due; unknown task: notes only; hidden: left out).
  - `CoreBridge.swift`: `statusLine` (coreVersion, pageFormatVersion).
- `Sources/iOS/PageCanvasView.swift`: `UIViewRepresentable` → `PageScrollView` (UIScrollView, zoom 0.25–4, double-tap zoom) with `PageSurfaceView` (page colour, rule lines/grid every 28 pt from the page origin). One `UITextView(usingTextLayoutManager: true)` per box at its x/y/w, z order respected, surface grows to fit negative positions. `show(_:)` skips redraw when the page id is unchanged: **for live updates, redraw on change** (e.g. key on a revision, or update text views in place).
- `scripts/testflight-builds.mjs`: lists recent App Store Connect builds and processing state (read-only; CI runs it).

### CI (`.github/workflows/apple-native.yml`, macos-15)

- Triggers: pushes to `rewrite/**` touching `apps/apple/**`, `crates/**`, `Cargo.*` or the workflow. Manual dispatch only works once the file is on `main`.
- Steps: Rust 1.99.1 + Apple targets, build NotiveloCore, `xcodegen generate`, iPad/iPhone simulator build, **iPad screenshots** (boots an "iPad Pro" simulator, screenshots sign-in plus 5 corpus pages via `-previewSignedIn YES -page <case>`; artifact `ipad-screenshots`; worth extending to a signed-in flow later, but don't put real credentials in CI), Mac build, then on `[testflight]` in the head commit message: archive with cloud-managed signing (ASC API key), export, check Apple Distribution signature and version 1.99.x, upload with `testFlightInternalTestingOnly`, revoke CI dev certificates before/after (`scripts/ios-revoke-ci-certs.mjs`), list recent builds.
- Versions: `1.99.<run_number>`; build `<mobile.yml's latest run>.<run_number>` (e.g. 130.8), always above uploaded builds and below the next real release build.
- A full run with upload takes about 8–12 minutes; `gh run watch <id> --exit-status` then `gh run view <id> --log | grep -E 'notice\]Uploaded|IOS 1.99'`.
- Risk: the cert-revoke script could revoke a concurrently running `mobile.yml` release's certificate; avoid `[testflight]` while a real release runs.

### TestFlight so far (all VALID)

1.99.2 (130.2) skeleton · 1.99.4 (130.4) core linked · 1.99.5 (130.5) corpus page view · 1.99.8 (130.8) task-line indent fix.

### Notes for M5

- Keychain: a small `Keychain` helper (generic password, service `com.devswartz.notivelo.native`, account = server URL) is enough; access group not needed yet. Today's Capacitor app stores its token via the secure-storage plugin under its own keys; don't share or migrate them now.
- Staging switch: hidden, e.g. a long-press on the version line on the sign-in screen, stored in UserDefaults; show the server host on the sign-in screen when it isn't production.
- Mac target must keep building (it shares `Sources/Shared`); keep UIKit-only code in `Sources/iOS` or behind `#if os(iOS)`.
- Release builds talk only to app.notiveloapp.com today (`src/platform/serverUrl.ts`); staging is a tester convenience, not shown to normal users.
- PARITY.md: add ✓ to the iPad cells of rows that become native (sign-in, sidebar tree, live page read-only is partial, tasks list partial).

## How Devon tests this build

- **1.99.8 (130.8)**: open the app from TestFlight. Sign-in screen shows "Native preview" and the version line with `core 0.1.0 · page format 2`. Tap **Sign in** (nothing is sent anywhere). The sidebar lists "Sample pages (corpus)": tap **canvas-boxes** (boxes at their positions; pan, pinch to zoom, double-tap to zoom in/out), **tasks** (task circles, due date, notes and subtask indented), **settings-and-ink** (blue page with a grid).

## Done

- 2026-11-21: page view merged into `rewrite/native` (41c64bc); see `docs/rewrite/STATUS.md` Done for M1 and the M4 groundwork.
