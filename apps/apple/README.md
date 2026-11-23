# Notivelo for iPad, iPhone and Mac (native rewrite)

SwiftUI apps on the shared Rust core (`docs/ARCHITECTURE.md`, `docs/rewrite/PLAN.md`). Today (M5): sign-in through the core (refresh token in the keychain), the workspace tree in the sidebar, pages open live, the iPad/iPhone canvas edits a box at a time through the editor engine (`EditorSession`; `Sources/iOS/BoxTextView.swift` is the UITextInput view, `Sources/Shared/PageEditing.swift` the sync glue), and the task list with ticks. `-previewSignedIn YES` skips sign-in and shows the bundled corpus pages, editable on the device only (CI screenshots); add `-demoEdit YES` to type into the first box through UITextInput.

- `project.yml`: the XcodeGen project. Targets **Notivelo** (iPad + iPhone, bundle ID `com.devswartz.notivelo`, iOS 17+) and **NotiveloMac** (same bundle ID, macOS 14+). The `.xcodeproj` is generated, not committed.
- `Sources/Shared`: code for both (SwiftUI). `Sources/iOS`, `Sources/macOS`: platform-only code.
- `Sources/Shared/CoreBridge.swift`: the one call into the Rust core (`nv-core`), compiled in once the core's XCFramework is linked.

Build on a Mac:

```sh
brew install xcodegen
cd apps/apple && xcodegen generate && open Notivelo.xcodeproj
```

CI: `.github/workflows/apple-native.yml` (macos-15) builds both on pushes to `rewrite/**`. A commit message with `[testflight]` also archives the iPad/iPhone app and uploads it to TestFlight as **1.99.x** (internal testing only, never App Review). The build number is `<mobile.yml's latest run>.<this run>`, so it sorts above every build already uploaded and below the next real release build.

Test steps for each TestFlight build: `docs/rewrite/status/apple.md`, "How Devon tests this build".

The core's task, search and comment calls are used by `Sources/iOS/Shell/TaskDetail.swift`, `TaskPickers.swift`, `Search.swift` and `Comments.swift`.
The Mac app (M6, AppKit) shares Sources/Shared with the iPad/iPhone app; its own code is in Sources/macOS.

Tree edits, sharing, version history, the Trash and locked pages call the core from Sources/Shared/Shell (TreeActions, Sheets, LockScreen, SharedWithMe).

The Mac build also goes to TestFlight (macOS) with the iPad/iPhone build, as the same 1.99.x version and build number.

Ink on iPad pages: pen tools are in the ribbon's Draw button; the Pencil draws, and with "Draw with a finger" on a finger does too (two fingers scroll and zoom). Undo and redo (ribbon, Cmd-Z, three-finger swipes) cover the ink and the box's text. The Mac draws with the mouse or trackpad through the same Draw button; iPhone shows ink read-only (the web has no ink on phones either).

Mac parity: right-click tree menus, Esc closes dialogs, Cmd-F opens the search.

The page icon row (Add icon, emoji picker) is in the shared page header; it saves through the core's setPageIcon.

Calendar (month and week, drag a task to another day), quick add (natural-language line), Settings (theme, accent colour, locked pages password) and the page panel's Tasks tab are in the shared SwiftUI shell, so iPad, iPhone and the Mac have them.

Create account, Check your email, invite links, Members and Export as Markdown (2026-11-23).
