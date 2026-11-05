# Desktop app (macOS + Windows)

A [Tauri 2](https://v2.tauri.app) app around the same React build as the web app. The window loads the bundled `dist/` from disk, so it starts instantly and opens offline. Only the API is remote, on a server the user picks (default `https://notes.devswartz.com`).

| Where | What |
|---|---|
| `apps/desktop/src-tauri/` | The Rust app: windows, keychain, menu, tray, global hotkey, deep links, single instance, window state, updater (`src/*.rs`, `tauri.conf.json`, `capabilities/`, `icons/`) |
| `apps/desktop/scripts/tauri.mjs` | Wraps the Tauri CLI: product name from `APP_NAME`, version from the tag, updater config only when signing secrets exist |
| `apps/desktop/scripts/latest-json.mjs` | Writes the updater manifest for a release |
| `src/platform/tauri.ts`, `src/platform/tauri/` | The desktop implementation of the platform adapter, plus the first-run server screen, the quick-capture window, the dock badge, the menu bridge and the updater UI |
| `.github/workflows/desktop.yml` | Builds macOS (universal) and Windows on tags `v*.*.*` or by hand → draft GitHub Release |

## Running it

Prerequisites: Node 22 and Rust (stable, via [rustup](https://rustup.rs)). On macOS, the Xcode command-line tools; on Windows, the MSVC build tools and WebView2 (preinstalled on Windows 11). On Linux (development only), `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.

```bash
npm ci
npm run desktop:dev     # starts `npm run dev` (API + Vite) and opens the app on the Vite dev server, with hot reload
npm run desktop:build   # npm run build, then a release build + installers in apps/desktop/src-tauri/target/release/bundle/
npm run desktop:build -- --target universal-apple-darwin   # macOS universal (rustup target add aarch64-apple-darwin x86_64-apple-darwin)
```

In development the app uses the Vite proxy (same origin), so no server setup appears. `NOTEAPP_SERVER_URL=https://notes-staging.devswartz.com npm run desktop:dev` points it somewhere else; the variable also overrides the saved choice in a release build.

**Renaming the app:** change `APP_NAME` in `shared/config.ts`; the build passes it to Tauri as `productName`. The bundle identifier (`com.devswartz.noteapp`), the `noteapp://` scheme and keychain entries stay, so existing installs keep their data and sign-in. **Icons** are generated from `apps/desktop/icon-source.svg` (`public/icon.svg` inset to the macOS icon grid): `npm run desktop:icons`, then delete the `android/`, `ios/` and `Square*` outputs. `icons/tray.png` is a black-on-transparent template image, generated from `tray-source.svg`.

## How it works

- **Server URL.** Stored in `<app config dir>/server.json` (`config.rs`). Each window gets it before any script runs, as `window.__NOTEAPP_API_URL__` (read by `src/api.ts`) and `window.__NOTEAPP_SERVER__`. On first launch the app shows a "Connect to a server" screen with the default filled in. It checks `GET /api/health` before saving. **Change Server…** is in the app menu on macOS and in File on Windows. Saving restarts the app. The server must allow cross-origin requests; ours sends `Access-Control-Allow-Origin: *` and uses bearer tokens, so that's safe.
- **Sign-in** is the normal token flow. The refresh token goes to the OS keychain (macOS Keychain, Windows Credential Manager) through the `secure_*` commands (`secure.rs`, `keyring` crate). Entries are per server, so switching servers never sends one server's token to another.
- **Platform adapter** (`src/platform/tauri.ts`). `initPlatform()` sees `__TAURI_INTERNALS__` and dynamic-imports it, so the web build never downloads Tauri code. It provides: keychain storage; native notifications (`tauri-plugin-notification`; the plugin can't report clicks, so when the app comes to the front within a minute of a notification shown while it was in the background, that notification's `onClick` runs, see `tauri/notificationClicks.ts`); external links in the default browser (`tauri-plugin-opener`); file pickers (WebKit/WebView2 show the native panel for `<input type=file>`); drag-and-drop handled by the page (Tauri's own handler is off); deep links; Web Locks; window focus.
- **Deep links.** `noteapp://page/<id>` and `noteapp://w/<ws>/…` arrive through `tauri-plugin-deep-link` (registered from `Info.plist` on macOS, in the registry by the installer on Windows). They go to `platform.deepLinks` and are routed by `components/DeepLinks.tsx`. `noteapp://task/<id>` is delivered too, but the shared parser doesn't handle it yet (requested from Foundation).
- **Menu** (`menu.rs`). File / Edit / View / Go / Window / Help, plus the app menu on macOS. App items carry command ids from the command registry (`src/hooks/useShortcuts.ts`): `pages.new`, `tasks.new`, `app.palette`, `app.sidebar`, `app.theme`, `nav.today` … `nav.completed`, `nav.notes`, `nav.settings`, `app.shortcuts`. A click emits `menu-command` to the main window, which calls `runCommand(id)`. If that command isn't registered, `nav.*` items fall back to plain navigation. Edit items are the OS's own (undo, copy, paste…). Accelerators: ⌘N new page, ⇧⌘T new task, ⌘K palette, ⌘\ sidebar, ⌘1–8 views and notes, ⌘, settings, ⌘/ shortcuts.
- **Quick capture.** ⌥⌘N (Ctrl+Alt+N on Windows), also File → Quick Capture and the tray, toggles a small always-on-top window (`quick.rs`, `src/platform/tauri/quickCapture.tsx`). It parses natural language like the in-app quick add (`shared/quickadd.ts`). Enter adds a task to the last-used workspace; Tab switches to a note, which creates a page in the first section and opens it in the main window. Esc or clicking away hides it (only after the window has actually had focus, so a slow activation can't hide it straight away). Signed out: it says so, and Enter opens the main window to sign in. Offline: it keeps the text and says to try again.
- **Tray / menu-bar icon** (`tray.rs`). Shows how many of your tasks are due today or overdue, as text next to the icon on macOS and in the tooltip on Windows. The menu has Open, Quick Capture, Today, Upcoming, New Page and Quit. The same count is the **dock badge** on macOS (`src/platform/tauri/badge.ts` keeps it in sync with the task store). Windows has no taskbar badge API in Tauri yet.
- **Window behaviour.** Size, position, maximised and full-screen state are saved (`tauri-plugin-window-state`); a position on a monitor that's gone falls back to the main screen. Visibility isn't saved, so the app always starts with its window showing. A second launch focuses the running app (`tauri-plugin-single-instance`; on Windows it also forwards the deep link). Closing the main window keeps the app running in the tray / menu bar; on macOS it hides the window and clicking the dock icon brings it back. Quit is in the menus.
- **Auto-update** (`tauri-plugin-updater`). Configured only in builds made with the signing secrets below. The app checks at most once a day on launch, and on **Check for Updates…**, against `https://github.com/devswartz/NoteApp/releases/latest/download/latest.json`. If an update exists, it asks, installs and restarts.

## First signed Mac build: checklist

Do this once; later releases are just step 6 onwards. Allow about an hour, most of it Apple paperwork.

1. **Make `main` the default branch** (GitHub → Settings → General → Default branch). Tag builds work without this, but **Actions → Desktop → Run workflow** only shows up for workflows on the default branch.
2. **Developer ID certificate** (needs the Apple Developer Program; the Account Holder creates it):
   - On a Mac, open Xcode → Settings → Accounts → your team → Manage Certificates → **+** → *Developer ID Application*. Alternatively use developer.apple.com → Certificates → **+** → *Developer ID Application* with a CSR from Keychain Access.
   - In Keychain Access → *My Certificates*, right-click "Developer ID Application: …" → Export → `.p12`, and set a password.
   - Run `base64 -i DeveloperID.p12 | pbcopy`. Save the result as secret `APPLE_CERTIFICATE`, and the password as `APPLE_CERTIFICATE_PASSWORD`.
3. **Notarisation key** (recommended over Apple ID):
   - App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **+**, role *Developer*.
   - Download the `.p8` file. It can only be downloaded once.
   - Secrets: `APPLE_API_KEY` = the Key ID, `APPLE_API_ISSUER` = the Issuer ID shown above the table, `APPLE_API_KEY_P8` = the whole contents of the `.p8` file, including the BEGIN/END lines.
4. **Updater signing key** (so installed apps can update themselves):
   - Run `npx tauri signer generate -w ~/.tauri/noteapp.key` and choose a password.
   - Secret `TAURI_SIGNING_PRIVATE_KEY` = the contents of `~/.tauri/noteapp.key`; secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the password.
   - **Variable** (not secret) `TAURI_UPDATER_PUBKEY` = the contents of `~/.tauri/noteapp.key.pub`.
   - Back up the private key and its password somewhere safe (a password manager).
5. Check that **Settings → Secrets and variables → Actions** now lists 7 secrets and 1 variable: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the variable `TAURI_UPDATER_PUBKEY`.
6. **Tag a release from `main`:** `git checkout main && git pull && git tag v0.1.0 && git push origin v0.1.0`. Any `vX.Y.Z` works; it becomes the app's version.
7. **Watch the build:** Actions → *Desktop* → the run for the tag. It takes about 20–40 minutes, and notarisation waits on Apple. The macOS log should show the app being signed with your Developer ID and a notarisation step that succeeds. The run fails loudly if the certificate is wrong. With no notarisation secrets it only warns.
8. **Download:** Releases → the **draft** `v0.1.0` → `NoteApp_0.1.0_universal.dmg` (macOS, Apple Silicon + Intel), or `NoteApp_0.1.0_x64-setup.exe` / `.msi` (Windows). Install it, then check on a Mac:
   - `spctl -a -vv /Applications/NoteApp.app` should say `accepted` / `source=Notarized Developer ID`;
   - `xcrun stapler validate /Applications/NoteApp.app` should say "The validate action worked".
9. **Publish the draft.** That makes it "latest", which is what installed apps check for updates.

Installs from unsigned builds have no updater. Replace them once by hand with the first signed build; after that, updates are automatic. Windows installers stay unsigned (SmartScreen warns) until Windows code signing is added; see below.

## Releasing

1. Bump `version` in `package.json` (optional: CI uses the tag's version anyway), then tag: `git tag v0.2.0 && git push origin v0.2.0`.
2. **Desktop** workflow builds both platforms and creates a **draft** release `v0.2.0` with the installers (`.dmg`, `-setup.exe`, `.msi`), the update bundles + `.sig` files, and `latest.json`.
3. Check the draft, then **publish** it. Only published releases count as "latest", so publishing is what ships the update to existing installs.

Manual run: Actions → Desktop → Run workflow. It builds the selected branch and keeps the installers as workflow artifacts. With "Upload to a draft release" ticked, it also makes a draft release `desktop-<run number>`. Tags also run the main CI workflow (image publish); the two are independent.

## Secrets to add (Settings → Secrets and variables → Actions)

None are required: without them CI builds **unsigned** installers and the app has **no auto-update**. Unsigned macOS apps need right-click → Open the first time (or `xattr -dr com.apple.quarantine NoteApp.app`). Windows shows a SmartScreen prompt.

**Auto-update signing (Tauri)** — enables updates on both platforms:

| Name | Kind | Value |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | secret | contents of the private key from `npx tauri signer generate -w ~/.tauri/noteapp.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | its password (if you set one) |
| `TAURI_UPDATER_PUBKEY` | variable (or secret) | contents of `~/.tauri/noteapp.key.pub` |

Keep the private key safe: losing it means existing installs can't verify future updates (users would have to reinstall manually).

**macOS signing + notarisation (Apple Developer Program)**:

| Name | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of a **Developer ID Application** certificate exported as .p12 (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | the .p12 export password |

Plus **one** of these for notarisation:

| Option | Names |
|---|---|
| App Store Connect API key (recommended) | `APPLE_API_KEY` (key ID), `APPLE_API_ISSUER` (issuer ID), `APPLE_API_KEY_P8` (contents of the `AuthKey_<id>.p8` file) |
| Apple ID | `APPLE_ID` (email), `APPLE_PASSWORD` (an [app-specific password](https://support.apple.com/102654)), `APPLE_TEAM_ID` |

With only the certificate, the app is signed but not notarised (CI warns), and Gatekeeper still prompts.

**Windows code signing** is not set up. Installers are unsigned, so SmartScreen warns until the app builds reputation. Adding it later needs an EV/OV certificate or Azure Trusted Signing, configured under `bundle.windows` in `tauri.conf.json`.

## What's verified where

- Linux container (each PR): `cargo check`, `cargo clippy` and `cargo test` (server URL normalisation) for the Rust crate; `npm run typecheck`, `npm test` (`tests/desktop.test.ts`: adapter selection, menu fallback, badge count, server probe, build/manifest scripts) and `npm run build`. A debug build of the app runs under Xvfb against a local server: sign-in, live sync, Go menu navigation and quick capture all work there. So do offline start with the server down (the bundled app renders), and quick capture while signed out, offline, and again after reconnecting.
- Only on real macOS / Windows (via `desktop.yml` or locally): bundling, signing and notarisation, the Keychain / Credential Manager backends, the dock badge, menu-bar text, deep-link registration and the updater.
