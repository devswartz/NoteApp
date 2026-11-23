# android stream status

Progress, requests and handover for the **android** workstream (`apps/android-native/`, `.github/workflows/android-native.yml`). `apps/mobile/android` is today's Capacitor app and is not touched.

## Now

- Step A (branch `rewrite/android-shell`): Gradle project, CI, sign-in, workspaces, the notes tree (read-only), look scenes and screenshots. Built only in CI (this machine has no JDK/SDK); nothing has run on a device or emulator.
- Step B (next): the page screen (editor, boxes, tasks) on the core's editor/live-page calls.

## Done

- **Project** `apps/android-native/`: Kotlin DSL, version catalog, wrapper (Gradle 8.10.2), app id `com.notivelo.app.native` (debug `.debug`), minSdk 26, target/compile 35, Compose (BOM 2024.12.01) with Material3 only as a base; every colour, size and type is custom (`look/Palette.kt`, `look/Theme.kt` = tokens from LOOK.md). AGP 8.7.3 / Kotlin 2.0.21 are pinned because the core module (`crates/nv-core/kotlin/NotiveloCore/build.gradle.kts`) pins them and a module in the same build must match; newer needs the core module bumped too.
- **Core**: `settings.gradle.kts` includes `target/android/NotiveloCore` (built by `crates/nv-core/build-android.sh`, never committed). `NotiveloCore.init(this)` in `NotiveloApp.onCreate`; calls run on `Dispatchers.IO` (`AppViewModel`), results go to a `StateFlow<AppState>`. ABIs: arm64-v8a and x86_64 only (`NV_ABIS` in CI, `abiFilters`).
- **Session**: sign-in (server defaults to `https://app.notiveloapp.com`; long-press the app name on the sign-in card shows a server field), refresh token in EncryptedSharedPreferences (`data/SessionStore.kt`), restored at launch (cached workspaces/tree first, then the server), rotated token stored again, sign out (core clears its store). Offline at launch keeps the token and shows an error on the sign-in screen.
- **Shell**: phone (<= 760 dp): top bar, tab bar, FAB, drawer with workspace switcher, notebook picker, sections tree, user row; Notes drill-down notebooks, notebook, section, page. Tablet (>= 761 dp): Notes ribbon, rail, sidebar (open from 900 dp), overview / empty section / page. Pages open a placeholder; Tasks, Calendar, Search, notifications, row menus and every write show "... is not in the native preview yet."
- **Look scenes**: `look/LookData.kt` (in-memory data of docs/rewrite/look/seed.ts), `LookRoot(state)`; a debug build opens one with `--es lookState <name>`. Paparazzi tests `app/src/test/kotlin/.../look/Shots.kt` (JVM, no emulator) render them at 390x844 @2x and 820x1180, 1180x820 @1x. CI: `recordPaparazziDebug -Pshots`, `scripts/collect-shots.py` names them like the references, `docs/rewrite/look/side-by-side.py` makes pairs. Artifacts: `notivelo-android-debug`, `android-shots`, `android-side-by-side`. No goldens committed.
- **Icons**: `scripts/lucide-to-vector.py` turns the Lucide SVGs in `docs/rewrite/look/icons/` into vector drawables (only the ones listed in the script).
- **Tests** (JVM): `TreeIndexTest` (ordering as web/Apple), `AppViewModelTest` (restore, rejected/offline token, sign-in errors, workspace switch and memory, navigation, sign out), `RelativeTimeTest`. Screenshot tests only run with `-Pshots`.

## Differences from the references (known)

- Font: system sans (Roboto). LOOK.md's stack lists Roboto after SF Pro, Inter and Segoe UI, none of which ship on Android; the references are Segoe UI, so widths and glyph shapes differ a little.
- The phone drawer shows no open-task counts (the reference has none); the tablet tree does.
- Paparazzi caps snapshots at 1000 px high, so the iphone and ipad-portrait shots are scaled down (and the side-by-side scales them back up).
- Emoji page icons depend on the renderer's emoji font.
- Shadows (card, FAB, drawer) use Compose elevation shadows, not the CSS two-layer blur.
- Phone notebook screen and section page rows have no reference; they follow the section screen's style.
- No hover, drag-resize of the sidebar, ribbon collapse, Recent group contents, Favourites, row menus, search, notifications.

## Requests

- android -> core (low priority): `Core.tasks` is used only to count open tasks per page row; a per-page count in `Tree` would save the call.
- android -> core: a way to set the Gradle plugin versions of `NotiveloCore/build.gradle.kts` from the including build (or a version catalog), so the app is not tied to AGP 8.7.3 / Kotlin 2.0.21.

## Handover

- Read `docs/rewrite/status/core.md` "For android" first. Build: `bash crates/nv-core/build-android.sh` (NDK + cargo-ndk), then `./gradlew assembleDebug testDebugUnitTest` in `apps/android-native` (pass `-PrustlsPlatformVerifierVersion=<value in target/android/NotiveloCore/gradle.properties>`).
- Unverified: running on a device/emulator, `NotiveloCore.init` and a real TLS sign-in against staging, EncryptedSharedPreferences on devices, edge-to-edge insets, the drawer gesture (there is none yet: the menu button opens it), R8 on a release build.
