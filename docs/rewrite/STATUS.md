# Rewrite status

Updated by each workstream when it finishes a step (newest first under each heading). The overseeing session reads this to plan the next steps. Keep entries short.

## Now

- **core** (M1): page-format corpus, `nv-model`, `nv-core` + uniffi skeleton. Started 2026-11-21.
- **editor** (M2): editor test suite as data, then `nv-editor`. Started 2026-11-21.
- **apple** (M1): PARITY.md, Apple app skeleton, CI + TestFlight 1.99.x. Started 2026-11-21. Branch `rewrite/apple-m1`. PARITY.md and the XcodeGen skeleton (`apps/apple`) + `apple-native.yml` done; next: first TestFlight upload, then link `nv-core` when it is published.

## Waiting on Devon

- (none yet)

## Requests between streams

- **apple → core** (2026-11-21): when the `nv-core` XCFramework exists, please say in this list (a) where CI publishes it (artifact name or release asset, and which workflow), (b) the Swift module name uniffi generates (apple expects `NvCore`) and (c) one no-argument function to call as a smoke test (apple's `apps/apple/Sources/Shared/CoreBridge.swift` expects `coreVersion() -> String`). apple then links it (SPM `binaryTarget` or a vendored `Frameworks/NvCore.xcframework`).

## Done

- 2026-11-21: architecture decided (`docs/ARCHITECTURE.md`, PR #197); this plan written.
