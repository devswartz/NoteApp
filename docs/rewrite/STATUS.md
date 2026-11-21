# Rewrite status

Updated by each workstream when it finishes a step (newest first under each heading). The overseeing session reads this to plan the next steps. Keep entries short.

## Now

- **core**: M1 core part done (see Done), on branch `rewrite/core-m1`, ready to merge. Next candidates: `nv-api` + `nv-sync` against today's server (M3), or Kotlin bindings and an Android build in CI.
- **editor** (M2): editor test suite as data, then `nv-editor`. Started 2026-11-21.
- **apple** (M1): PARITY.md, Apple app skeleton, CI + TestFlight 1.99.x. Started 2026-11-21.

## Waiting on Devon

- (none yet)

## Requests between streams

- **core → apple: linking the core.** Run `bash crates/nv-core/build-xcframework.sh` on a macOS runner (needs rustup targets `aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin`; the `apple` job in `.github/workflows/rust.yml` shows the steps). It writes a local Swift package at `target/apple/NotiveloCore/` (`nv_coreFFI.xcframework`: iOS device, iOS simulator arm64, macOS arm64; `Sources/NotiveloCore/nv_core.swift`: the bindings). Add it in XcodeGen as `packages: { NotiveloCore: { path: ../../target/apple/NotiveloCore } }` (path relative to your project.yml) with dependency `- package: NotiveloCore`, then `import NotiveloCore` and call e.g. `try readPage(update: data)`, `coreVersion()`. The same package is uploaded by each rust.yml run as the `NotiveloCore` artifact (14 days). Ask here for Core API changes; core owns `crates/nv-core/src/lib.rs`.

## Done

- 2026-11-21, **core** (M1, branch `rewrite/core-m1`): page-format corpus in `tests/corpus/` (12 pages built through the editor's schema, expectations from the real TS functions; `scripts/corpus/generate.ts`, checked by `tests/corpus.test.ts`); `crates/nv-model` (yrs) passes the whole corpus (`crates/nv-model/tests/corpus.rs`); `crates/nv-core` Core API slice over uniffi (`read_page`, `page_markdown`, `sanitize_page`, `list_marker`, `core_version`, `page_format_version`), with the NotiveloCore Swift package (XCFramework) built and Swift-tested in CI. Notes: the corpus records today's behaviour including quirks (inline mentions and page links drop out of Markdown, and page links are missing from searchable text); the macOS job runs on pushes and on PRs from/to `rewrite/*` only.
- 2026-11-21: architecture decided (`docs/ARCHITECTURE.md`, PR #197); this plan written.
