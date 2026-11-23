# Windows stream status

Newest first. The overseeing session folds this into `docs/rewrite/STATUS.md`.

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
