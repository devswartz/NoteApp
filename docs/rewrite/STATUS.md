# Rewrite status

Updated by each workstream when it finishes a step (newest first under each heading). The overseeing session reads this to plan the next steps. Keep entries short.

## Now

- **core** (M1): page-format corpus, `nv-model`, `nv-core` + uniffi skeleton. Started 2026-11-21.
- **editor** (M2): editor test suite as data, then `nv-editor`. Started 2026-11-21.
- **apple** (M1): PARITY.md, Apple app skeleton, CI + TestFlight 1.99.x. Started 2026-11-21. Branch `rewrite/apple-m1`. Done: PARITY.md, XcodeGen skeleton, `apple-native.yml`, first TestFlight upload. Waiting on core for the XCFramework (request below), then link it and call it from `CoreBridge.swift`.

## Waiting on Devon

- (none yet)

## Requests between streams

- **apple → core** (2026-11-21): when the `nv-core` XCFramework exists, please say in this list (a) where CI publishes it (artifact name or release asset, and which workflow), (b) the Swift module name uniffi generates (apple expects `NvCore`) and (c) one no-argument function to call as a smoke test (apple's `apps/apple/Sources/Shared/CoreBridge.swift` expects `coreVersion() -> String`). apple then links it (SPM `binaryTarget` or a vendored `Frameworks/NvCore.xcframework`).

## Done

- 2026-11-21, apple: `docs/rewrite/PARITY.md` (inventory of today's app, one row per feature, columns iPad/iPhone/Mac/Windows/Android/Web; native progress marked with ✓). `apps/apple`: XcodeGen project, targets `Notivelo` (iPad+iPhone, iOS 17, `com.devswartz.notivelo`, App Group) and `NotiveloMac` (macOS 14, sandboxed), SwiftUI placeholder sign-in + sidebar. `.github/workflows/apple-native.yml` builds both on pushes to `rewrite/**` touching `apps/apple`; `[testflight]` in the commit message archives and uploads (cloud signing with the ASC key, like mobile.yml, internal testing only). Build numbers are `<mobile.yml's latest run>.<run>` so they sort above every uploaded build and below the next real release. **Uploaded 1.99.2 (130.2) to TestFlight** (run 44911049777); Apple's processing result not checked from here.
- 2026-11-21: architecture decided (`docs/ARCHITECTURE.md`, PR #197); this plan written.
