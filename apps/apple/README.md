# Notivelo for iPad, iPhone and Mac (native rewrite)

SwiftUI apps on the shared Rust core (`docs/ARCHITECTURE.md`, `docs/rewrite/PLAN.md`). Today (M5): sign-in through the core (refresh token in the keychain), the workspace tree in the sidebar, pages open live and read-only, and the task list with ticks. `-previewSignedIn YES` skips sign-in and shows the bundled corpus pages (CI screenshots).

- `project.yml`: the XcodeGen project. Targets **Notivelo** (iPad + iPhone, bundle ID `com.devswartz.notivelo`, iOS 17+) and **NotiveloMac** (same bundle ID, macOS 14+). The `.xcodeproj` is generated, not committed.
- `Sources/Shared`: code for both (SwiftUI). `Sources/iOS`, `Sources/macOS`: platform-only code.
- `Sources/Shared/CoreBridge.swift`: the one call into the Rust core (`nv-core`), compiled in once the core's XCFramework is linked.

Build on a Mac:

```sh
brew install xcodegen
cd apps/apple && xcodegen generate && open Notivelo.xcodeproj
```

CI: `.github/workflows/apple-native.yml` (macos-15) builds both on pushes to `rewrite/**`. A commit message with `[testflight]` also archives the iPad/iPhone app and uploads it to TestFlight as **1.99.x** (internal testing only, never App Review). The build number is `<mobile.yml's latest run>.<this run>`, so it sorts above every build already uploaded and below the next real release build.
