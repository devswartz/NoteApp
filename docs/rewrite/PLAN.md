# The native rewrite: how we build it

Target: everything in `docs/ARCHITECTURE.md`. Native apps per platform (iPad, iPhone, Mac, Android, Windows, web) on one Rust core, matching today's app feature for feature (the full list is `docs/rewrite/PARITY.md`), then going beyond it (ink on every page).

## Branches and rules

- **`rewrite/native`** is the integration branch. It is never merged to `main`, tagged or released without Devon's OK in chat.
- Each workstream session works on its own branch cut from `rewrite/native` (`rewrite/<stream>-<topic>`), and the overseeing session merges it into `rewrite/native` when its tests pass. Workstreams pull `rewrite/native` before starting a new step.
- `main` keeps shipping today's app. The rewrite must not change `main`'s behaviour: new code lives in `crates/`, `apps/apple/`, `apps/android-native/`, `apps/windows/`, `tests/corpus/`, `tests/editor/` and `docs/rewrite/`. Changes to today's code (`src/`, `server/`, `shared/`) only when a milestone needs them (e.g. the server's change log), on their own PR to `main`, with Devon's OK.
- Prototype iPad/iPhone builds may go to TestFlight without asking (Devon, 2026-11-21), as version **1.99.x** so they never collide with real releases. Nothing goes to App Review.
- Every crate has tests that run in CI (`.github/workflows/rust.yml`); every milestone ends green.
- Each session keeps its context small: one step per turn, notes in `docs/rewrite/STATUS.md`, and a handover note when it finishes.

## Order (milestones)

| # | Milestone | Done when |
|---|---|---|
| M1 | **Foundations.** Page-format test corpus from today's TS; `nv-model` passing it; `nv-core` skeleton with `uniffi` Swift bindings and an XCFramework built in CI; `PARITY.md`; the Apple app skeleton (XcodeGen) building on CI and uploading to TestFlight. | corpus identical TS vs Rust; a 1.99 build on TestFlight that links the core |
| M2 | **Editor engine.** Editor test suite as data (run against today's TipTap editor); `nv-editor` (model on yrs, selections, commands, input rules, lists, tasks, tables, marks, undo, clipboard) passing it. | suite green on both |
| M3 | **Sync and data.** `nv-api` (REST + auth), `nv-sync` (y-websocket + awareness with today's server), `nv-store` (SQLite), Core API queries and subscriptions. | the core signs in, lists the tree and tasks, and edits a page live with the web app |
| M4 | **iPad page prototype.** Native page: text boxes on TextKit 2 driving `nv-editor`, native pan/zoom, `nv-ink` drawn with Metal, live with the web. | on TestFlight; Devon's on-device gate (feel vs Notability) |
| M5 | **iPad app.** Every screen in PARITY.md: sign-in, notebooks/sections/pages, tasks and views, calendar, search, sharing, comments, settings, locked pages + Face ID, offline. | PARITY.md iPad column complete |
| M6 | **iPhone and Mac.** Shared Swift code; phone layouts; Mac with AppKit where needed. | parity columns complete |
| M7 | **Local-first.** Server durable change log (PR to `main`), offline task editing, store-backed screens. | soak test passes |
| M8 | **Windows** (WinUI 3, C# bindings). | parity column complete |
| M9 | **Android** (Compose, Kotlin bindings; built in CI). | parity column complete |
| M10 | **Web on the core** (WASM), `nv-search`, `nv-io`. | web passes the shared suites on the core |

Gates that need Devon (device feel, store submission, merging to `main`) are listed in STATUS.md as waiting; work continues on the next milestone meanwhile.

## Workstreams (about three at a time)

- **core**: `crates/` except the editor: corpus, model, core API, bindings, api, sync, store.
- **editor**: `tests/editor/` and `crates/nv-editor`.
- **apple**: `apps/apple/`, its CI workflow and TestFlight, PARITY.md.

Later streams (windows, android, web) replace these as milestones complete. Two streams never edit the same files; shared interfaces (Core API types) are owned by **core**, and others ask for changes through STATUS.md.
