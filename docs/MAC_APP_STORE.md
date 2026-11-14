# Mac App Store build

The desktop app ships two ways on macOS:

| Build | Workflow | Signing | Updates |
|---|---|---|---|
| `.dmg` (direct download) | `.github/workflows/desktop.yml` | Developer ID, notarised | Tauri updater (GitHub Releases) |
| `.pkg` (Mac App Store) | `.github/workflows/mac-app-store.yml` | Apple Distribution + Mac Installer Distribution | The App Store |

The store build is the same app with:

- **App Sandbox** (`apps/desktop/src-tauri/Entitlements.mas.plist`): network client, user-selected files (read/write), Downloads (exports are WKWebView downloads), printing, plus `com.apple.application-identifier` / `com.apple.developer.team-identifier`. The team ID is a placeholder (`__APPLE_TEAM_ID__`) that CI fills from `APPLE_TEAM_ID`.
- **No self-updater** (App Review 2.4.5): built with `--no-default-features`, which drops the Cargo feature `updater` (the `tauri-plugin-updater` crate and the **Check for Updates…** menu item). `tauri.mas.conf.json` selects only the `default` capability, so `capabilities/updater.json` isn't used. `updater_enabled` returns false, so the web app's update checks do nothing.
- **Only the `.app` target**, `embedded.provisionprofile` in `Contents/`, and `CFBundleVersion` = the workflow's run number (always higher than the last upload, like the iOS build number in `mobile.yml`). `CFBundleShortVersionString` is the tag.

`Info.plist` (shared with the `.dmg`, harmless there) sets `ITSAppUsesNonExemptEncryption = false` and `LSApplicationCategoryType = public.app-category.productivity`.

## One-time Apple setup

All in [developer.apple.com](https://developer.apple.com/account) → Certificates, IDs & Profiles, and App Store Connect.

1. **App ID.** `com.devswartz.notivelo` already exists (iOS). Nothing to add for the sandbox; don't enable capabilities the Mac app doesn't use.
2. **Certificates** (Certificates → +). Make a CSR in Keychain Access (Certificate Assistant → Request a Certificate From a Certificate Authority, saved to disk), then create:
   - **Apple Distribution** (if the team doesn't already have one you can export; the iOS pipeline uses cloud-managed signing, so there may be none in a keychain).
   - **Mac Installer Distribution** (its common name reads "3rd Party Mac Developer Installer: …").
   Download both, double-click to install, then in Keychain Access export each **with its private key** as a `.p12` with a password.
3. **Provisioning profile** (Profiles → +): Distribution → **Mac App Store Connect**, App ID `com.devswartz.notivelo`, the Apple Distribution certificate. Download the `.provisionprofile`.
4. **App Store Connect**: open the existing Notivelo app → the platform list in the sidebar (or **+** next to the iOS platform) → **Add macOS**. Same bundle ID, so it becomes a universal purchase; the Mac version gets its own version number, screenshots and review. Fill in the macOS screenshots (1280×800 or larger) and the "What's New" text when you submit.

## Secrets

Repository → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `APPLE_MAS_APP_CERTIFICATE` | `base64 -i apple-distribution.p12` |
| `APPLE_MAS_APP_CERTIFICATE_PASSWORD` | its export password |
| `APPLE_MAS_INSTALLER_CERTIFICATE` | `base64 -i mac-installer.p12` |
| `APPLE_MAS_INSTALLER_CERTIFICATE_PASSWORD` | its export password |
| `APPLE_MAS_PROVISION_PROFILE` | `base64 -i Notivelo_Mac_App_Store.provisionprofile` |

Reused: `APPLE_TEAM_ID` (entitlements, profile check) and `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8` (upload, same API key as TestFlight for iOS). On macOS, `base64 -i file | pbcopy` copies the value.

Without the five `APPLE_MAS_*` secrets (or `APPLE_TEAM_ID`) the workflow skips every step with a notice, so tag builds stay green. Without the `ASC_*` secrets it builds and keeps the `.pkg` as a workflow artifact, but doesn't upload.

## Running it

- **Tags:** every `vX.Y.Z` tag builds and uploads, alongside the `.dmg` build.
- **By hand:** Actions → **Mac App Store** → Run workflow. Untick **upload** to only get the `.pkg` artifact (`mac-app-store-pkg`). Run from a branch (not a tag), the version is `package.json`'s, so Store submit won't pick that build up for a tag.
- **Submitting for review:** after the tag's upload, **Store submit** (approval required) attaches the build to the macOS App Store version and submits it, with the iOS one. See `docs/STORE_RELEASES.md`.

The job checks the profile (team + bundle ID, not a development profile), the signature (Apple Distribution, sandbox and application-identifier entitlements), that the updater isn't compiled in, and the `.pkg` signature (`pkgutil --check-signature`) before uploading with `xcrun altool --upload-app -t macos`. The build appears in App Store Connect → TestFlight (macOS) after processing, usually 10–30 minutes; Apple emails if processing rejects it.

Local build on a Mac (unsigned check that it compiles without the updater):

```bash
node apps/desktop/scripts/tauri.mjs build --target universal-apple-darwin \
  --config apps/desktop/src-tauri/tauri.mas.conf.json -- --no-default-features
```

## TestFlight sandbox checklist

Install from TestFlight on a Mac (remove any `.dmg` copy from /Applications first so the right one launches), then:

- [ ] Sign in, **Quit (⌘Q), reopen**: still signed in (keychain access from the sandbox).
- [ ] Notes and tasks load and sync; images in pages show (network client).
- [ ] **Export / save** a page: the file lands in Downloads (or the save panel works). Note that the `.dmg` build's export on macOS may already be unreliable (`src/platform/tauri.ts`: WKWebView may ignore downloads), so compare with it.
- [ ] Attach / import a file through the open panel.
- [ ] **Print** a page (⌘P / menu): the system print dialog opens.
- [ ] **Quick note**: ⌥⌘N from another app opens quick capture; File → Quick Capture too.
- [ ] **`notivelo://` links** (e.g. paste `notivelo://page/<id>` in Safari's address bar): the app opens on that page, cold and while running.
- [ ] **Notifications**: allow when asked, then a reminder shows while the app is in the background.
- [ ] **Tray / menu-bar icon**: shows today's count; its menu items work. Dock badge updates.
- [ ] App menu has **no "Check for Updates…"**.
- [ ] Window size/position is remembered after quitting.
- [ ] Opening the app a second time (e.g. `open -n`) doesn't leave two running copies.
- [ ] Spell-check underlines words in the editor.

## Known sandbox risks

- **Keychain:** `keyring` uses the legacy (file-based) login keychain API. That normally works in the sandbox for items the app itself creates, but a sign-in saved by the `.dmg` build (different signature) may prompt for keychain access or simply not be found, so users switching from the `.dmg` sign in again. Settings in `~/Library/Application Support/com.devswartz.notivelo` aren't moved into the sandbox container either.
- **Single instance:** `tauri-plugin-single-instance` uses a socket in `/tmp`, which the sandbox blocks. The plugin then logs an error and launches normally; LaunchServices already keeps one copy of an App Store app running, and deep links arrive as Apple events, so this should be harmless (checklist item above).
- **Restart** (`process:allow-restart`, used only by the server switch in internal builds) relaunches the executable directly; untested in the sandbox, and release builds don't offer it.
- **Notifications** use the deprecated `NSUserNotification` path via `mac-notification-sys`; untested in the sandbox.
- **SDK version:** App Store Connect rejects builds made with an old SDK. The job selects the newest Xcode on the `macos-15` image, as `mobile.yml` does; if Apple raises the minimum, move `runs-on` to a newer image.
