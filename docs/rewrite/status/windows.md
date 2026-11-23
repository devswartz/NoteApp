# Windows stream status

Newest first. The overseeing session folds this into `docs/rewrite/STATUS.md`.

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
