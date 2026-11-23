# Windows stream status

Newest first. The overseeing session folds this into `docs/rewrite/STATUS.md`.

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
