# Mobile apps (iPhone + Android)

The mobile apps are a **Capacitor 8** shell around the same React build as the web app. The project lives in `apps/mobile/`. The native side of the platform adapter is `src/platform/capacitor.ts`. Owner: Mobile (agent 10).

```
apps/mobile/
  capacitor.config.ts   app id, name (from shared/config.ts), plugins, dev live-reload
  package.json          which plugins `cap sync` links (deps are installed at the repo root)
  assets/               icon + splash sources rendered from public/icon.svg (npm run mobile:icons)
  scripts/icons.mjs     regenerates assets/ and every native icon/splash size
  scripts/identity.mjs  copies APP_NAME into strings.xml / Info.plist (run by mobile:sync)
  ios/App/              Xcode project (Swift Package Manager, no CocoaPods)
    App/                app target: AppDelegate, MainViewController + NoteAppNativePlugin (the app's own plugin)
    Shared/             Swift shared by the app and its extensions (App Group store)
    ShareExtension/     "Share to NoteApp"
    TodayWidget/        WidgetKit "Today" widget
  scripts/xcode-extensions.rb  re-adds the extension targets if the Xcode project is ever regenerated
  android/              Gradle project
```

## Building

You need Node 22 and, for iOS, a Mac with Xcode 16 or newer; for Android, Android Studio (or the SDK + JDK 21).

```bash
npm ci
npm run mobile:sync      # build dist/ for the app, then `cap sync` (copies web assets + plugins into ios/ and android/)
npm run mobile:ios       # …and open Xcode   (Run on a simulator or a device)
npm run mobile:android   # …and open Android Studio
```

- **Server URL.** The web app is bundled into the app (instant start, opens offline) and talks to the server at `VITE_API_URL`. `mobile:build` sets that from `MOBILE_SERVER_URL`, default `https://notes.devswartz.com`. For staging: `MOBILE_SERVER_URL=https://notes-staging.devswartz.com npm run mobile:sync`. It's fixed per build; a runtime "server" field on the login screen is a possible follow-up (it needs a change in `src/api.ts`).
- **Live reload while developing:** run `npm run dev` with `API_URL` pointing at a server, then `CAP_SERVER_URL=http://<your-LAN-IP>:5173 npx cap sync` in `apps/mobile` and run the app. The app then loads the Vite dev server instead of the bundled files. Don't ship a build made this way.
- **App id:** `com.devswartz.noteapp` (`APP_ID` in `capacitor.config.ts`). Changing it creates a different app in the stores.
- **App name:** `APP_NAME` in `shared/config.ts`. `npm run mobile:sync` copies it into the native projects, so a rename stays a one-line change.
- **Icons and splash** come from `public/icon.svg`. After changing it, run `npm run mobile:icons` (uses Playwright's Chromium and `npx @capacitor/assets`) and commit the generated files.
- **Versions:** CI sets the version from the tag (`v1.2.3` or `mobile-v1.2.3` → `1.2.3`) and the build number from the workflow run number. Local builds are 0.1.0 (1).

## What the native shell adds

`src/platform/capacitor.ts` implements the `Platform` interface (`src/platform/types.ts`); `initPlatform()` loads it lazily when `window.Capacitor.isNativePlatform()` is true, so the web bundle doesn't carry it.

| Feature | How |
|---|---|
| Refresh token | Keychain (iOS, `afterFirstUnlockThisDeviceOnly`, never restored to another device) / Android Keystore-encrypted storage, via `@aparajita/capacitor-secure-storage`. Small preferences stay in the web view's `localStorage`. Android backups are off (`allowBackup="false"`). |
| Push reminders | After sign-in the app asks for notification permission, registers with APNs (iOS) or FCM (Android) and sends the token to `POST /api/notifications/devices {platform, token}`. The server's reminder worker delivers through `server/reminders/apns.ts` / `fcm.ts`. On sign-out the app unregisters, which invalidates the token; the server drops it on the next delivery attempt. |
| Tapping a reminder | The payload's `url` (an in-app path) becomes `noteapp://w/…` and goes through the normal deep-link router (`components/DeepLinks.tsx`). Only paths starting with `/` are accepted. |
| Snooze | iOS reminder notifications (category `REMINDER`) have *Snooze 10 minutes / 1 hour / Tomorrow* actions; the app opens and calls `POST /api/reminders/snooze`. FCM notifications on Android show no actions yet. |
| Local notifications | `platform.notifications.show()` (reminders for a task while the app is open) uses `@capacitor/local-notifications`, Android channel `reminders`. |
| Deep links | `noteapp://page/<id>`, `noteapp://w/<ws>/…` and the universal / app links `https://notes.devswartz.com/w/…` (see "Server files" below). Links that arrive before the router mounts (cold start from a notification) are queued. |
| App badge | The number of my open tasks due today or overdue in the current workspace, updated as tasks change (`@capawesome/capacitor-badge`). Cleared on sign-out. |
| Haptics | A light tap whenever a checkbox (`input[type=checkbox]`, `[role=checkbox]`) or any `[data-haptic]` element is clicked. `platform.haptics.tap()` / `.success()` for app code (`'haptics' in platform`). |
| Status bar / safe areas | The web view draws edge to edge on both platforms; the layout pads with `env(safe-area-inset-*)` (the `--safe-*` tokens in `src/styles.css`). Status bar text follows `<html data-theme>`. |
| Keyboard | The web view resizes above the keyboard. iOS's prev/next/done accessory bar is hidden. While the keyboard is open `<html>` has class `keyboard-open` and `--keyboard-height` is set, so bottom bars can hide or move. |
| Android back button | Goes back in history; at the root it backgrounds the app. |
| Share to NoteApp | iOS: a Share Extension (`ios/App/ShareExtension`) with *Add as task* / *Save as note*. Android: two share targets, *Add task* and *Save as note* (activity-aliases of `MainActivity`). The item waits in the App Group (iOS) or in memory (Android) until the app is active and someone is signed in. Then a **task** opens quick add, prefilled with the text (and link), on Today; a **note** becomes a new page in the workspace's section named *Inbox* (or the first section), with the text and link as its body. The body is written to the page's local Yjs cache, and the editor syncs it like an offline edit. iOS extensions can't open their app, so the share appears the next time you switch to NoteApp. |
| Today widget | iOS: a WidgetKit extension (`ios/App/TodayWidget`), small/medium/large. Android: a home-screen widget (`TodayWidgetProvider`). Both show my open tasks due today or overdue in the current workspace, with priority and time; tapping opens Today, and tapping a row (iOS medium/large, Android) opens that task. The app writes a JSON snapshot (`WidgetSnapshot` in `capacitor.ts`) to the App Group (iOS) or SharedPreferences (Android) whenever tasks change and when it comes to the foreground; the widget never calls the server. After midnight, tasks from an older snapshot show as overdue until the app is opened. |
| App lock | Optional. Turn it on with the ⌘K command *Lock app with Face ID* (or Touch ID / fingerprint / passcode). It asks to unlock on launch and after more than a minute in the background, falling back to the device passcode. While the app is in the background a cover hides its content from the app switcher. A Settings toggle can use `platform.appLock` (`method()`, `enabled()`, `setEnabled()`, `subscribe()`). Stored per device. |
| Splash screen | Native splash (light and dark) until React's first render. |
| `<html>` classes | `native`, plus `native-ios` or `native-android`, for any shell-only CSS. |

## Secrets and accounts

Nothing below is needed to build or run debug builds. CI skips the steps whose secrets are missing.

### GitHub Actions secrets (`.github/workflows/mobile.yml`)

| Secret | What it is | Used for |
|---|---|---|
| `APPLE_TEAM_ID` | 10-character Team ID (developer.apple.com → Membership) | TestFlight |
| `ASC_KEY_ID` | App Store Connect API key id | TestFlight |
| `ASC_ISSUER_ID` | The issuer id shown above the keys list | TestFlight |
| `ASC_KEY_P8` | Contents of the downloaded `AuthKey_XXXX.p8` | TestFlight |
| `FIREBASE_GOOGLE_SERVICES_JSON` | Contents of `google-services.json` for the Android app | Android push (FCM). Without it the APK builds but gets no push. |
| `ANDROID_KEYSTORE_BASE64` | `base64 -i upload.jks` of the upload keystore | Signed release bundle (`.aab`) for Play internal testing |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | The keystore's passwords and alias | same |

**iOS signing uses Xcode cloud signing**: the API key lets `xcodebuild -allowProvisioningUpdates` create the distribution certificate and the provisioning profiles for the app (and any extensions) itself, so there's no `.p12` or `.mobileprovision` to export. Create the key in App Store Connect → Users and Access → Integrations → App Store Connect API with the **Admin** role (cloud-managed certificates need it).

One-time Apple setup:
1. developer.apple.com → Identifiers: register `com.devswartz.noteapp` with **Push Notifications**, **Associated Domains** and **App Groups** (`group.com.devswartz.noteapp`) enabled, and `com.devswartz.noteapp.ShareExtension` (and `.TodayWidget`) with **App Groups**. Cloud signing in CI usually registers these on its own; doing it by hand avoids surprises.
2. App Store Connect → Apps → New App with that bundle id (the name can be a placeholder and changed later).
3. Keys → create an **APNs key** (.p8) for the server (below). It's a different key from the App Store Connect API key.

### Server environment (reminder delivery)

Set these on the server (`docs/DEPLOY_CONTRACT.md` lists the server env). Each channel turns itself on when its variables are present.

| Var | Value |
|---|---|
| `APNS_KEY_ID` | The APNs key's id |
| `APNS_TEAM_ID` | Team ID |
| `APNS_BUNDLE_ID` | `com.devswartz.noteapp` |
| `APNS_PRIVATE_KEY` | Contents of the APNs `.p8` (newlines may be written as `\n`) |
| `APNS_ENV` | `production` for TestFlight/App Store builds (default); `sandbox` for builds run from Xcode |
| `FCM_SERVICE_ACCOUNT_JSON` | Firebase console → Project settings → Service accounts → Generate new private key (the JSON, raw or base64) |

Firebase setup: create a Firebase project, add an Android app with package `com.devswartz.noteapp`, and download `google-services.json` (that's the GitHub secret above). iOS doesn't use Firebase; it talks to APNs directly.

### Server files for universal links / app links

For `https://notes.devswartz.com/w/…` links to open the app, the server must serve (not done yet; requested from the server owner):

- `/.well-known/apple-app-site-association` (`application/json`, no redirect):
  `{"applinks":{"details":[{"appIDs":["<TEAM_ID>.com.devswartz.noteapp"],"components":[{"/":"/w/*"}]}]}}`
- `/.well-known/assetlinks.json`:
  `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"com.devswartz.noteapp","sha256_cert_fingerprints":["<SHA-256 of the signing cert>"]}}]`

Until then, `noteapp://` links work and https links open in the browser.

## CI

`.github/workflows/mobile.yml` runs on version tags, on manual dispatch (with a TestFlight checkbox and a server URL), and on PRs that touch `apps/mobile/**` or `src/platform/capacitor.ts`. It never runs for other PRs, so the main `CI` check isn't slowed.

| Job | Runner | Does |
|---|---|---|
| `android` | ubuntu | web build → `cap sync android` → `assembleDebug`, uploads the APK as an artifact; with the keystore secrets (not on PRs) also a signed `bundleRelease` `.aab` |
| `ios` | macOS 15, newest stable Xcode | web build → `cap sync ios` → unsigned simulator build; on tags or when the TestFlight box is ticked, and only with the App Store Connect secrets, archive + upload to TestFlight |

To ship a TestFlight build: push a tag `mobile-v0.1.0` (or `v0.1.0`, which also releases the server), or run the workflow by hand with *TestFlight* ticked.

## Verified so far / known gaps

- Verified on Linux: `cap add`/`cap sync` for both platforms, the adapter's logic (`tests/mobile.test.ts`, fake plugins), typecheck and web build.
- **Not verifiable here** (no macOS; the Android SDK download host is blocked in the agent sandbox): compiling the Swift and Gradle projects. The `mobile` workflow builds both on every PR that touches them.
