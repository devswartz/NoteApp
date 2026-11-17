# Architecture: where Notivelo is going

Status: direction agreed with Devon on 2026-11-14. Nothing here is built yet. This is the plan for the next few years. Each phase below gets its own plan doc and PRs, and every step ships on its own.

The goal: the best notes-and-tasks product we can make. That means the best performance, the fewest bugs, room for big new features (handwriting first), and **as little per-platform code as possible**.

## 1. The decision

**One web-based UI everywhere, one Rust core underneath it, and thin native pieces only where the operating system really matters.**

```
┌────────────────────────────────────────────────────────────────────┐
│ UI: React + ProseMirror/TipTap, one codebase                       │
│ web · Windows/Mac (Tauri) · iPhone/iPad/Android (Capacitor)        │
├────────────────────────────────────────────────────────────────────┤
│ Core API: one typed boundary (commands, queries, subscriptions)    │
├────────────────────────────────────────────────────────────────────┤
│ Rust core ("notivelo-core"), one codebase                          │
│ page model · sync (yrs) · local store + change queue · ink engine  │
│ local search · import/export · API client                          │
│ → WebAssembly in a worker (web) · native library (apps, server)    │
├────────────────────────────────────────────────────────────────────┤
│ Thin native edges, small and stable, per platform                  │
│ iPad/Windows pen layer · widgets · share sheet · push · keychain   │
└────────────────────────────────────────────────────────────────────┘
  Server: Node + SQLite today; it uses the same core for page rules
```

### Why this and not the alternatives

| Option | Verdict |
|---|---|
| **Web UI + Rust core + thin native edges** | **Chosen.** One UI codebase, one rules codebase, native only for the pen tip and OS features. It keeps ProseMirror, the most mature collaborative rich-text editor there is. |
| Rust core + separate native UIs (SwiftUI, Compose, WinUI) | Best feel, but 3–4 UI codebases forever, plus a native collaborative rich-text editor per platform. It goes against the "one codebase" goal. |
| Flutter (one natively drawn UI) + Rust core | The fallback if the web UI ever truly limits us (AppFlowy works this way). It means rebuilding the editor and every screen, and collaborative rich text in Flutter is clearly weaker today. |
| Own GPU-drawn UI everywhere (Figma, Zed) | Total control, but we would own text layout, input methods for every language and accessibility. Too costly for a notes app. |
| Stay purely web (today) | Can't reach Notability-level pen feel on iPad, and the rules are spread across server TS, client TS and `shared/`. |

What we already have that fits: a Rust toolchain (the Tauri shell, `apps/desktop/src-tauri`), Yjs documents that **yrs** (the Rust Yjs) reads and writes byte for byte, `shared/` code that is already the "core" in TypeScript, and native shells with plugins.

## 2. Principles

1. **Every rule exists once.** If two platforms or client and server need the same logic (list numbering, page reading order, task extraction, merge rules, ink geometry), it lives in the core. The UI shows things and the edges talk to the OS.
2. **Local-first.** Every screen reads from the on-device store, and network sync runs in the background. The UI never waits on the network to show or change something the user can see. Offline is the normal case, not a special mode.
3. **The server stays the authority for who may do what** (permissions, sharing, invites, locks) and for relational data. Clients are optimistic and the server confirms or corrects. Page content merges as a CRDT (Yjs/yrs).
4. **Versioned formats.** Every document and local store carries a schema version, with explicit upgrade steps in the core. A newer document opened by an older app degrades gracefully (unknown blocks shown as "update to see this"), and is never corrupted.
5. **Measured performance.** Budgets (section 6) are tests. A change that breaks a budget fails CI like a broken test.
6. **No big-bang rewrites.** Each phase replaces one piece behind the core API while the app keeps shipping. The old and new implementations are compared on the same test corpus before the switch.
7. **Native code is a last resort** and gets a written reason: pen latency, an OS feature, or a measured performance need.

## 3. The pieces

### 3.1 UI (stays React + TipTap)

- Screens, editor, dialogs and the canvas stay one codebase in `src/`.
- The UI talks to data **only through the Core API** (3.2). It has no direct `fetch`, IndexedDB or WebSocket calls outside it. Today that access is spread across `src/api.ts`, `src/store/*`, `src/lib/offlineCache.ts`, `src/lib/pageCache.ts` and `src/editor/collab.ts`.
- **Editor binding.** TipTap's collaboration binding (`@tiptap/y-tiptap`) needs a JS `Y.Doc`. The core owns the authoritative page doc (yrs). Each open page keeps a JS `Y.Doc` replica that exchanges Yjs updates with the core (the same binary format both ways). That doubles memory only for pages that are open, which is acceptable. If a maintained ProseMirror ↔ yrs binding appears, the replica can go.
- Long lists are virtualized (sidebar, tasks, search). The sidebar isn't yet: 1,500 pages make about 21k DOM nodes.

### 3.2 Core API (the boundary)

One typed interface between UI and core, designed before any Rust exists, so swapping the implementation behind it is mechanical:

- **Commands**: `createPage`, `updateTask`, `moveSection`, `addStrokes`, … They are applied locally at once and queued for the server.
- **Queries and subscriptions**: `tree(workspaceId)`, `tasks(view)`, `page(pageId)`, `search(q)`. They return data and keep pushing updates.
- **Page channels**: Yjs update streams for open pages (for the editor replica).
- Types are written once (in Rust, with TS types generated from them, e.g. `ts-rs` or `specta`) so the two sides can't drift.
- Transport: `postMessage` to a Web Worker (web, and the Capacitor and Tauri web views at first), Tauri commands when the desktop core runs natively, and a Capacitor plugin when the mobile core runs natively.

### 3.3 Rust core (`crates/`)

A Cargo workspace at the repo root, one crate per area so each can be adopted on its own:

| Crate | What it does | Replaces today |
|---|---|---|
| `nv-model` | Page format: boxes, reading order, page settings, list numbering, task nodes, sanitising, searchable text, Markdown in/out. Schema versions and upgrades. | `shared/pageDoc.ts`, `shared/listMarker.ts`, `shared/sections.ts`, parts of `server/markdown.ts`, `server/sanitizeDoc.ts`, `server/locks.ts` (searchableText) |
| `nv-ink` | Stroke format, smoothing, pressure outlines, tessellation, hit testing, erasing, lasso. See `docs/PLAN_INK.md`. | new |
| `nv-sync` | yrs documents, the y-websocket protocol, awareness, the change queue for non-page data, and catch-up from the server's change log. | `y-websocket` client, `src/store/taskWrites.ts`, `src/store/events.ts` |
| `nv-store` | The local database: SQLite natively, SQLite-WASM on OPFS on the web. It holds the user's visible tree, tasks, members, settings and page docs. | `y-indexeddb`, `src/lib/offlineCache.ts`, `src/lib/pageCache.ts` |
| `nv-search` | Local full-text search over pages, tasks and recognised handwriting (SQLite FTS5 in the local store). | server-only FTS5 for offline use; the server keeps its own index |
| `nv-api` | The typed REST client, auth tokens and retries. | `src/api.ts` |
| `nv-io` | Workspace export/import (zip), OneNote HTML conversion, PDF/print geometry for ink. | `server/export.ts`, `server/zip.ts`, `server/onenoteHtml.ts` (shared with the server) |
| `nv-core` | Ties them together and exposes the Core API. Builds to WASM (`wasm-bindgen`), native libraries (`uniffi` for Swift/Kotlin, direct for Tauri) and a Node addon (`napi-rs`) for the server. | |

Builds: `wasm32-unknown-unknown` for the web (lazy-loaded, run in a worker, size-budgeted), `aarch64-apple-ios`, `aarch64-linux-android` and friends via `uniffi`, the host targets for Tauri, and the Node addon for the server.

### 3.4 Data and sync

**Page content** stays a Yjs CRDT, one doc per page. Nothing changes on the wire: the server's y-websocket protocol in `server/collab.ts` keeps working, and yrs clients speak it.

**Everything else** (tree, tasks, tags, members, settings) moves to a server-sequenced change log, the model Linear and Figma use for relational data:

- Each client keeps a local copy of what it can see (in `nv-store`) and a queue of pending changes (generalising `taskWrites.ts`: per-entity ordering, merged patches, deletes cancelling queued writes).
- The server applies each change, checks permissions, assigns a sequence number and broadcasts it. Today's events hub (`server/events.ts`, `boot:seq` cursor, in-memory buffer) becomes a **durable** log in SQLite, so a client offline for a week catches up with deltas instead of a full reload.
- A change the server rejects (permissions, conflict) is rolled back locally with a visible message.
- Result: **tasks become editable offline** (today they're read-only offline), and every screen opens from local data instantly.

**Locked pages** keep their rule: never stored on a device (`src/lib/pageCache.ts` today), enforced in `nv-store`.

**End-to-end encryption** isn't planned. If it ever is, a local-first core is the right base for it, but it changes server search, the AI connector and sharing, so it would be its own decision.

### 3.5 Native edges

Small, stable pieces per platform, each with a reason:

| Platform | Native pieces |
|---|---|
| iPad / iPhone | **Native drawing pages** (UIKit page with Metal ink over nv-ink's C ABI, see PLAN_INK), widgets, share extension, push, Face ID, keychain, handwriting recognition (Vision). Most already exist as Capacitor plugins. |
| Windows | Pen via WebView2 **delegated ink** (`navigator.ink`), tray, quick capture, updater (Tauri). |
| Mac | Menu bar, Dock badge, quick capture, updater (Tauri). |
| Android | Push, widgets, share target. Stylus via web pointer events at first. |
| Web | Service worker, web push. |

### 3.6 Server

- Stays **Node + Express + SQLite** (`better-sqlite3`). It works, and rewriting it buys little.
- Uses the core through a **Node addon (`napi-rs`)** for anything shared with clients: page model, searchable text, task extraction from pages, sanitising, Markdown, export/import, ink rendering for print/PDF. Client and server can then never disagree about a page.
- Gains the durable change log (3.4).
- A Rust server (e.g. `axum`) stays an **option**, decided later on evidence (CPU cost per collaborative page, memory per connection), not a goal.
- Self-hosting stays possible: still one process plus SQLite, with the addon prebuilt for linux-x64 and linux-arm64.

## 4. Quality: how we keep bugs down

- **One test corpus for the page format.** A folder of real page docs (Yjs binary + expected JSON, Markdown, searchable text, task list, reading order), run against the TS implementation now and the Rust one later. The switch to Rust happens only when both pass the same corpus. It also guards format upgrades.
- **Property tests for merging** (`proptest`): random concurrent edits from several clients, applied in random orders, must converge, and must keep invariants (every task node has a task, no duplicate box ids, strokes decode).
- **Fuzzing** of everything that reads untrusted input (Yjs updates, imports, OneNote HTML, ink blobs) with `cargo fuzz`.
- **End-to-end tests stay** (Playwright, the current `tests/`), and they run against every build target we can automate: the web, plus Tauri on CI where possible.
- **A device lab for what automation can't judge:** Devon's iPad + Pencil, a Surface pen if possible, an Android tablet. There's a written checklist per release that touches the pen or the canvas.
- **Crash and error reporting everywhere.** Today it's web errors (`src/lib/errorReporting.ts`). Extend it to the core (panics caught at the boundary and reported with no note content) and to native crashes (iOS and Android).
- **Feature flags,** server-controlled per user or workspace, so big features (ink, offline tasks, the new store) ship dark, roll out to Devon first, then everyone.

## 5. Flexibility: what this makes easy later

- **New platforms** (Linux desktop, visionOS, web embeds) are a shell plus the same UI and core.
- **New block or object types** are a model change in one place (`nv-model`), automatically understood by the server, the AI connector, export and search.
- **AI features** run against the same model locally or on the server. The MCP connector already reads pages; it would use the core for page text instead of its own copy.
- **A native UI later,** for one platform if we ever need it: the core and Core API are already there, so only screens would be rebuilt.

## 6. Performance budgets

Measured on fixed reference devices (to be chosen: a mid-range Windows laptop, a recent iPad, an older iPhone, a mid-range Android phone) and enforced by benchmarks in CI where they can be automated.

| What | Budget |
|---|---|
| Cold start to usable (cached data, desktop) | < 1 s |
| Open a page from local store | < 100 ms to first paint, < 250 ms for a 200-box page |
| Typing latency in a box | < 16 ms per keystroke (one frame) |
| Pen latency on iPad | matches Notability side by side (240 fps slow-motion test) |
| Pan and zoom on a page with 5,000 strokes | 60 fps (120 on ProMotion) |
| Sidebar with 5,000 pages | opens < 200 ms, scrolls at 60 fps |
| Local search over 10,000 pages | < 50 ms |
| A change syncing to another device (online) | < 300 ms p50 |
| WASM core download (gzipped, lazy) | < 1.5 MB |

## 7. Roadmap

Each phase lists what ships and the gate to pass before the next one. Phases 0–2 are concrete; later ones get their own plan docs when we reach them.

### Phase 0: groundwork in TypeScript (no Rust yet)

- Draw the **Core API boundary** in TS: one `core` module the UI goes through for data, with today's code behind it. No behaviour change.
- The page-format **test corpus** (section 4) and a benchmark harness with the first budgets (page open, sidebar, typing).
- **Schema version** in page docs, with a no-op upgrade step, plus the "unknown block" placeholder.
- **Sidebar virtualization** (an open QA item).
- **Canvas prep for ink and zoom:** one screen↔page coordinate transform, one pointer-input router, and an `ink` hook in everything that reads a page (PLAN_INK, phase I0).
- Feature-flag mechanism.

Gate: the boundary covers all data access, the corpus and benchmarks run in CI, and nothing has regressed.

### Phase 1: Rust core starts with ink

- Cargo workspace (`crates/`), CI for `cargo test`, WASM builds, iOS builds (a C ABI, `NvInkFFI.xcframework`) and size checks.
- `nv-ink` with its WASM build, the web ink renderer, and Windows delegated ink.
- **The iPad prototype:** a native drawing page (PLAN_INK, Stage 1). Native ink over the web page was tried in I2 (2026-11-16/17) and didn't feel like Notability, so handwriting moved to a page kind of its own.

Gate: **the native drawing page passes Devon's feel test** against Notability.

### Phase 2: ink v1 ships

PLAN_INK Stages 2–5: the synced drawing page kind (native on iPad, web canvas elsewhere), text boxes, paper, print, lasso and shapes. It ships behind a flag, then to everyone.

### Phase 3: page model in the core

- `nv-model` passes the corpus, then replaces `shared/pageDoc.ts` and friends on the client (WASM) and the server (napi). TS duplicates are deleted.
- The MCP connector, export and search use it.

Gate: corpus identical, no measurable slowdown in collab saves, WASM size within budget.

### Phase 4: local-first store and sync

- The server's durable change log, `nv-store` and `nv-sync` on the client, and the editor replica binding.
- Offline task editing, instant screens from local data, `y-indexeddb` and `offlineCache.ts` retired.
- Rolled out per user behind a flag, with a migration from existing IndexedDB caches.

Gate: the merge property tests pass, a week-long offline/online soak test on all platforms passes, and the error rate doesn't rise during rollout.

### Phase 5: local search, import/export in the core

`nv-search` and `nv-io`. Search works offline, and handwriting text is searchable (from PLAN_INK, phase I7).

### Phase 6: native core in the apps

The desktop (Tauri) and mobile (Capacitor) apps run the core natively instead of WASM where measurements show it helps (startup, big notebooks, battery).

### Options, decided later on evidence

- A Rust server.
- A native UI for one platform.
- End-to-end encryption.

## 8. Risks

| Risk | Mitigation |
|---|---|
| iPad pen layer and web page drift apart when scrolling or zooming | Native code owns pan and zoom for both layers. Prototype first (phase 1 gate), with a defined fallback. |
| Two copies of each open page doc (JS replica + core) | Only for open pages. Measure in phase 4, and drop the replica if a ProseMirror↔yrs binding becomes viable. |
| WASM size and startup | Lazy load, run in a worker, size budget in CI, start using the core where it's needed first (ink). |
| Bugs in moving from TS to Rust | The shared corpus and property tests, both implementations side by side until identical, flags for rollout. |
| Debugging across the UI↔core boundary | Typed messages, request ids in logs on both sides, core panics turned into reported errors. |
| WebKit or WebView quirks (Capacitor, Tauri on Mac) | The device lab, and Playwright WebKit runs in CI. |
| Scope creep from "best possible" | Every phase has a gate and ships on its own. Options stay options until evidence says otherwise. |

## 9. Open questions for Devon

1. **Reference devices:** the iPad is decided (Devon's iPad Pro with Apple Pencil 2nd gen, see `PLAN_INK.md`). There's no Windows pen device yet. Still needed: the Windows laptop, older iPhone and Android phone for the other budgets.
2. **Self-hosting:** keep supporting it? It affects how the server addon is packaged.
3. **End-to-end encryption:** ever? It's no for now, but it changes design choices if it's "eventually".
4. **Order after ink:** offline tasks (phase 4) may matter more to users than local search (phase 5).
