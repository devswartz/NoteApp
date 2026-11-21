# Architecture: where Notivelo is going

Status: direction changed with Devon on 2026-11-21: **separate native apps per platform on one shared Rust core**, with our own editor. It replaces the 2026-11-14 plan (one web UI everywhere on a Rust core), whose core, sync and server design carries over. Nothing here is built yet, apart from the `nv-ink` crate (on main, behind the off-by-default `ink` flag). This is the plan for the next few years. Each phase below gets its own plan doc and PRs, and every step ships on its own.

The goal: the best notes-and-tasks product we can make. That means the best feel on every device (Notability-level handwriting on iPad included), the best performance, the fewest bugs, and room for big new features. Every rule is written once, in the core; only what the user sees and touches is written per platform.

## 1. The decision

**One Rust core with all the rules and data, our own editor engine inside it, and a native app per platform that draws the screens and handles input.**

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Native apps, one per platform: screens, gestures, text input, pen          │
│ iPad/iPhone (SwiftUI + UIKit) · Mac (SwiftUI + AppKit)                     │
│ Android (Jetpack Compose) · Windows (WinUI 3) · Web (React)                │
├────────────────────────────────────────────────────────────────────────────┤
│ Core API: one typed boundary (commands, queries, subscriptions, editor)    │
│ generated bindings: Swift and Kotlin (uniffi) · C# · TypeScript (WASM)     │
├────────────────────────────────────────────────────────────────────────────┤
│ Rust core ("notivelo-core"), one codebase                                  │
│ editor engine · page model · sync (yrs) · local store + change queue       │
│ ink engine · local search · import/export · API client                     │
│ → native library (apps) · WebAssembly in a worker (web) · Node addon       │
└────────────────────────────────────────────────────────────────────────────┘
  Server: Node + SQLite today; it uses the same core for page rules
```

### Why this and not the alternatives

| Option | Verdict |
|---|---|
| **Rust core + separate native UIs + our own editor engine in the core** | **Chosen.** The best feel on each platform: native scrolling, zoom, text input, pen and accessibility, with no web view in the way. The editor's rules live once in the core, so each platform writes only the drawing and input layer. |
| Web UI + Rust core + thin native edges (the 2026-11-14 plan) | One UI codebase, but 13 TestFlight rounds of ink on a web page (I2, Nov 2026) never felt like Notability. Native pan, zoom and pen kept fighting WebKit's scroll view. A second page kind just for drawing was rejected as clunky. |
| Native UIs, each with a platform rich-text editor | No platform has a collaborative rich-text editor we can adopt, and four different editors would each behave differently. Our own engine in the core keeps one behaviour everywhere. |
| Flutter (one natively drawn UI) + Rust core | One UI codebase, but Flutter's text input and rich text are weaker than each platform's own, and it doesn't feel native on iPad or Mac. |
| Own GPU-drawn UI everywhere (Figma, Zed) | Total control, but we would own text layout, input methods for every language and accessibility on every platform. |

### Why Rust for the core, not C or C++

- **yrs** (the official Rust Yjs) reads and writes today's page documents byte for byte, so sync and the server's y-websocket protocol carry over unchanged. There's no Yjs in C or C++ except yrs's own C bindings.
- **Memory safety.** The core parses untrusted data from the network (sync updates, imports, shared pages). Rust rules out the out-of-bounds and use-after-free bugs that make that dangerous in C or C++, and most of the code will be written by AI sessions, where the compiler catching mistakes matters most.
- **Bindings are generated.** `uniffi` writes the Swift and Kotlin wrappers, the web gets `wasm-bindgen`, the server `napi-rs`, and Windows a C interface with generated C# bindings. C's one advantage (Swift and C# call it directly) is available from Rust through that C interface.
- **One build tool for every target** (cargo), and it's already in the repo: the `nv-ink` crate with its WASM build and CI, and the Tauri desktop shell.

## 2. Principles

1. **Every rule exists once.** If two platforms or client and server need the same logic (editing commands, list numbering, page reading order, task extraction, merge rules, ink geometry), it lives in the core. The native apps show things and handle input; they never decide what an edit means.
2. **Native where the user touches.** Scrolling, zoom, text input, selection, pen, menus, accessibility and system integration use each platform's own frameworks. A platform app should be indistinguishable from a first-party app.
3. **Local-first.** Every screen reads from the on-device store, and network sync runs in the background. The UI never waits on the network to show or change something the user can see. Offline is the normal case, not a special mode.
4. **The server stays the authority for who may do what** (permissions, sharing, invites, locks) and for relational data. Clients are optimistic and the server confirms or corrects. Page content merges as a CRDT (Yjs/yrs).
5. **Versioned formats.** Every document and local store carries a schema version, with explicit upgrade steps in the core. A newer document opened by an older app degrades gracefully (unknown blocks shown as "update to see this"), and is never corrupted.
6. **Measured performance.** Budgets (section 6) are tests. A change that breaks a budget fails CI like a broken test.
7. **No big-bang rewrites.** Today's app keeps shipping on every platform until that platform's native app reaches parity and passes its gate. Old and new run side by side on the same documents and test corpus.
8. **Platforms never fork behaviour.** One shared test suite drives the core's editor and data commands; each platform app adds tests only for its own drawing and input.

## 3. The pieces

### 3.1 Native apps

| Platform | UI | Replaces today |
|---|---|---|
| iPad and iPhone | SwiftUI for screens, UIKit for the page canvas, text input and pen (ink drawn with Metal from `nv-ink`) | Capacitor app (`apps/mobile`) |
| Mac | SwiftUI + AppKit, sharing most Swift code with iPad (how much: open question) | Tauri app (`apps/desktop`) on Mac |
| Android | Jetpack Compose, with a custom `View` for the page canvas and text input | Capacitor app on Android |
| Windows | WinUI 3 (C#), with a custom canvas control using `CoreTextEditContext` for text input and Windows Ink for the pen | Tauri app on Windows |
| Web | React, kept as the web's native UI (see 3.2 for its editor) | today's `src/` |

- Each app talks to data **only through the Core API** (3.3). No platform has its own networking, storage or sync.
- Each app owns: navigation and screens, the page canvas (boxes, pan, zoom, ink), text rendering and input, gestures, menus and shortcuts, accessibility, and OS features (widgets, share sheet, push, Face ID and keychain, quick capture, tray and menu bar, updater).
- Order (section 7): iPad first, since that's where the web app falls short (ink, zoom), then iPhone and Mac, then Android and Windows.

### 3.2 The editor

We build our own editor engine, matching today's features: text boxes on a canvas, headings, bold/italic/underline/strike, colours and highlights, bullet, numbered and smart lists, checklists, task lines with their notes and subtasks, tables, code blocks with highlighting, quotes, links, page links, mentions, images and files, comment highlights, live collaborators' cursors, page-wide undo, paste from other apps, and handwriting on the same page.

It splits in two:

**The engine, in the core (`nv-editor`), written once:**
- The document model on yrs: boxes, blocks, inline marks, tasks and ink, in today's format (so web and native edit the same pages).
- Positions and selections that survive concurrent edits (yrs relative positions), for the user and for remote cursors.
- Every editing command: typing, deleting, splitting and joining blocks, lists and indenting (including into a task's notes), input rules (`- ` makes a bullet, `[] ` a checklist, `/task`), smart lists, tables, links, marks, task creation and deletion (today's `undoTasks.ts` rules), page-wide undo and redo.
- Clipboard: to and from HTML, Markdown and plain text.
- Layout-independent queries the UI needs: what's at a position, word and line boundaries for the model, the list marker for a line.

**The view, per platform, kept thin:**
- Lays out and draws text with the platform's own text system (TextKit 2 on Apple, Android's `Layout`/`StaticLayout`, DirectWrite on Windows, the DOM on the web).
- Takes input through the platform's input protocol (`UITextInput`, `NSTextInputClient`, Android `InputConnection`, Windows `CoreTextEditContext`), so input methods for Chinese, Japanese and Korean, dictation, autocorrect, the iPad's Scribble and spellcheck work the native way.
- Draws selection handles, the caret and the magnifier natively, and exposes the text to VoiceOver, TalkBack and Narrator.
- Turns each input into an engine command and redraws from the engine's result. It never edits the document itself.

**The web:** keeps ProseMirror/TipTap at first, editing the same yrs documents through y-prosemirror. Its schema and commands are checked against `nv-editor` by the shared editor tests, and move into the engine (via WASM) one by one, so the web ends up behaving identically. Whether the web eventually drops ProseMirror for a thin view on `nv-editor` is decided on evidence.

What makes this tractable: the hard parts of text editing (input methods, accessibility, spellcheck, bidirectional text) come from each platform's text system, and the parts that must behave the same everywhere (commands, merging, undo, tasks) are written once.

### 3.3 Core API (the boundary)

One typed interface between apps and core:

- **Commands**: `createPage`, `updateTask`, `moveSection`, `addStrokes`, … They are applied locally at once and queued for the server.
- **Queries and subscriptions**: `tree(workspaceId)`, `tasks(view)`, `page(pageId)`, `search(q)`. They return data and keep pushing updates.
- **Editor sessions**: open a page, send editor commands, receive the changed document regions, selections and remote cursors to redraw.
- Types are written once in Rust. Swift, Kotlin, C# and TypeScript types are generated from them, so the sides can't drift.
- Transport: in-process calls on native platforms (`uniffi`, C interface for C#); `postMessage` to a Web Worker on the web.

### 3.4 Rust core (`crates/`)

A Cargo workspace at the repo root, one crate per area so each can be adopted on its own:

| Crate | What it does | Replaces today |
|---|---|---|
| `nv-model` | Page format: boxes, reading order, page settings, list numbering, task nodes, sanitising, searchable text, Markdown in/out. Schema versions and upgrades. | `shared/pageDoc.ts`, `shared/listMarker.ts`, `shared/sections.ts`, parts of `server/markdown.ts`, `server/sanitizeDoc.ts`, `server/locks.ts` (searchableText) |
| `nv-editor` | The editor engine (3.2): selections, commands, input rules, undo, clipboard. | TipTap extensions and editor logic in `src/editor/` |
| `nv-ink` | Stroke format, smoothing, pressure outlines, tessellation, hit testing, erasing, lasso. See `docs/PLAN_INK.md`. **Exists** (`crates/nv-ink`). | new |
| `nv-sync` | yrs documents, the y-websocket protocol, awareness, the change queue for non-page data, and catch-up from the server's change log. | `y-websocket` client, `src/store/taskWrites.ts`, `src/store/events.ts` |
| `nv-store` | The local database: SQLite natively, SQLite-WASM on OPFS on the web. It holds the user's visible tree, tasks, members, settings and page docs. | `y-indexeddb`, `src/lib/offlineCache.ts`, `src/lib/pageCache.ts` |
| `nv-search` | Local full-text search over pages, tasks and recognised handwriting (SQLite FTS5 in the local store). | server-only FTS5 for offline use; the server keeps its own index |
| `nv-api` | The typed REST client, auth tokens and retries. | `src/api.ts` |
| `nv-io` | Workspace export/import (zip), OneNote HTML conversion, PDF/print geometry. | `server/export.ts`, `server/zip.ts`, `server/onenoteHtml.ts` (shared with the server) |
| `nv-core` | Ties them together and exposes the Core API. Builds to native libraries (`uniffi` for Swift/Kotlin, a C interface for C#), WASM (`wasm-bindgen`) and a Node addon (`napi-rs`) for the server. | |

Builds: `aarch64-apple-ios`, `aarch64-apple-darwin`/`x86_64-apple-darwin`, `aarch64-linux-android` and friends, `x86_64-pc-windows-msvc`/`aarch64-pc-windows-msvc`, `wasm32-unknown-unknown` for the web (lazy-loaded, in a worker, size-budgeted), and the Node addon for the server.

### 3.5 Data and sync

**Page content** stays a Yjs CRDT, one doc per page. Nothing changes on the wire: the server's y-websocket protocol in `server/collab.ts` keeps working, and yrs clients speak it. Native and web clients edit the same pages live during the transition.

**Everything else** (tree, tasks, tags, members, settings) moves to a server-sequenced change log, the model Linear and Figma use for relational data:

- Each client keeps a local copy of what it can see (in `nv-store`) and a queue of pending changes (generalising `taskWrites.ts`: per-entity ordering, merged patches, deletes cancelling queued writes).
- The server applies each change, checks permissions, assigns a sequence number and broadcasts it. Today's events hub (`server/events.ts`, `boot:seq` cursor, in-memory buffer) becomes a **durable** log in SQLite, so a client offline for a week catches up with deltas instead of a full reload.
- A change the server rejects (permissions, conflict) is rolled back locally with a visible message.
- Result: **tasks become editable offline** (today they're read-only offline), and every screen opens from local data instantly.

**Locked pages** keep their rule: never stored on a device (`src/lib/pageCache.ts` today), enforced in `nv-store`.

**End-to-end encryption** isn't planned. If it ever is, a local-first core is the right base for it, but it changes server search, the AI connector and sharing, so it would be its own decision.

### 3.6 Server

- Stays **Node + Express + SQLite** (`better-sqlite3`). It works, and rewriting it buys little.
- Uses the core through a **Node addon (`napi-rs`)** for anything shared with clients: page model, searchable text, task extraction from pages, sanitising, Markdown, export/import, ink rendering for print/PDF. Client and server can then never disagree about a page.
- Gains the durable change log (3.5).
- A Rust server (e.g. `axum`) stays an **option**, decided later on evidence (CPU cost per collaborative page, memory per connection), not a goal.
- Self-hosting stays possible: still one process plus SQLite, with the addon prebuilt for linux-x64 and linux-arm64.

## 4. Quality: how we keep bugs down

- **One test corpus for the page format.** A folder of real page docs (Yjs binary + expected JSON, Markdown, searchable text, task list, reading order), run against the TS implementation now and the Rust one later. It also guards format upgrades.
- **One editor test suite.** Editing scenarios written as data (starting document and selection, a sequence of commands or typed input, the expected document and selection), run against `nv-editor` and against the web editor while it is still ProseMirror. Today's editor e2e cases move into it.
- **Property tests for merging** (`proptest`): random concurrent edits from several clients, applied in random orders, must converge and keep invariants (every task node has a task, no duplicate box ids, strokes decode).
- **Fuzzing** of everything that reads untrusted input (Yjs updates, imports, OneNote HTML, ink blobs, clipboard HTML) with `cargo fuzz`.
- **UI tests per platform** for drawing and input only: XCUITest (Apple), Compose UI tests (Android), WinAppDriver or Appium (Windows), Playwright (web, the current `tests/`).
- **A device lab for what automation can't judge:** Devon's iPad + Pencil, an iPhone, a Mac, an Android phone, a Windows laptop (pen if possible). A written checklist per release that touches the editor, the canvas or the pen.
- **Crash and error reporting everywhere.** Today it's web errors (`src/lib/errorReporting.ts`). Extend it to the core (panics caught at the boundary and reported with no note content) and to native crashes on every platform.
- **Feature flags,** server-controlled per user or workspace, so big features (native apps, ink, offline tasks, the new store) ship dark, roll out to Devon first, then everyone.

## 5. Flexibility: what this makes easy later

- **New block or object types** are a model and editor change in one place (`nv-model`, `nv-editor`), automatically understood by the server, the AI connector, export and search; each platform adds only how it draws.
- **New platforms** (Linux, visionOS, watch) are a native app on the same core.
- **AI features** run against the same model locally or on the server. The MCP connector already reads pages; it would use the core for page text instead of its own copy.
- **Ink and text on one page, everywhere,** since every native page owns its own pan, zoom and drawing.

## 6. Performance budgets

Measured on fixed reference devices (Devon's 2020 iPad Pro is decided; the others are open, section 9) and enforced by benchmarks in CI where they can be automated.

| What | Budget |
|---|---|
| Cold start to usable (cached data) | < 1 s desktop, < 1.5 s phone |
| Open a page from local store | < 100 ms to first paint, < 250 ms for a 200-box page |
| Typing latency in a box | < 16 ms per keystroke (one frame) |
| Pen latency on iPad | matches Notability side by side (240 fps slow-motion test) |
| Pan and zoom on a page with 5,000 strokes | 60 fps (120 on ProMotion) |
| Sidebar with 5,000 pages | opens < 200 ms, scrolls at 60 fps |
| Local search over 10,000 pages | < 50 ms |
| A change syncing to another device (online) | < 300 ms p50 |
| Core library size | WASM < 1.5 MB gzipped (lazy); native < 10 MB per platform |

## 7. Roadmap

Each phase lists what ships and the gate to pass before the next one. Phases 0–3 are concrete; later ones get their own plan docs when we reach them. Today's app keeps shipping throughout.

### Phase 0: groundwork in TypeScript (no new Rust)

- Draw the **Core API boundary** in TS: one `core` module the web UI goes through for data, with today's code behind it. No behaviour change. It is the shape the Rust Core API will have.
- The page-format **test corpus** and the **editor test suite** as data, run against today's editor.
- **Schema version** in page docs, with a no-op upgrade step, plus the "unknown block" placeholder.
- A benchmark harness with the first budgets (page open, sidebar, typing), and the feature-flag mechanism.

Gate: the boundary covers all data access; the corpus, editor suite and benchmarks run in CI; nothing has regressed.

### Phase 1: the core's foundations

- The Cargo workspace grows: `nv-model` (passes the corpus), `nv-sync` and `nv-api` (talk to today's server), `nv-store`, and `nv-core` exposing the Core API.
- Bindings and CI for every target: `uniffi` Swift and Kotlin builds, the C# bindings, WASM, the Node addon, size checks.
- The server uses `nv-model` through the addon, so client and server share page rules from here on.

Gate: corpus identical between TS and Rust, the core syncs a page with today's server, and every target builds in CI.

### Phase 2: the editor engine

- `nv-editor`: model, selections, commands, input rules, undo, clipboard, passing the editor test suite.
- A bare **iPad page prototype** on TestFlight: a native canvas of text boxes on TextKit 2 driving `nv-editor`, with native pan and zoom and `nv-ink` drawn with Metal, on the same page. Live sync with the web app.

Gate: **Devon judges the prototype on his iPad**: typing (including Scribble and dictation), selection, zoom and the pen feel at least as good as Notability, and edits merge live with the web.

### Phase 3: the iPad app

- The full iPad app on the core: notebooks, sections and pages, tasks and the task views, search, sharing, settings, offline, locked pages with Face ID.
- Ships to TestFlight, then replaces the Capacitor app on iPad once it reaches parity (the parity checklist is its own plan doc).
- Ink v1 ships here: pen, highlighter, erasers, lasso, paper, print (PLAN_INK's I3–I5, rewritten for native pages).

Gate: parity checklist complete, crash-free rate and error rate at least as good as the Capacitor app.

### Phase 4: iPhone and Mac

Most of the Swift code is shared with the iPad app. Each replaces its current app (Capacitor on iPhone, Tauri on Mac) at parity.

### Phase 5: local-first everywhere

The server's durable change log; `nv-store` and `nv-sync` take over on every client, the web included (WASM). Offline task editing, instant screens from local data; `y-indexeddb` and `offlineCache.ts` retired. Rolled out per user behind a flag. Gate: the merge property tests and a week-long offline/online soak test pass on all platforms.

### Phase 6: Android and Windows

Compose and WinUI 3 apps on the same core and editor engine, each replacing its current app at parity.

### Phase 7: the web on the core

The web's editor commands, and then its data layer, move onto the core via WASM, until web and native behave identically. Local search and import/export (`nv-search`, `nv-io`) land for everyone.

### Options, decided later on evidence

- A Rust server.
- The web dropping ProseMirror for a thin view on `nv-editor`.
- End-to-end encryption.

## 8. Risks

| Risk | Mitigation |
|---|---|
| **Building our own editor is the largest piece of work** | Use each platform's text system for layout and input (input methods, accessibility, spellcheck come free); keep all behaviour in `nv-editor` with one test suite; start with iPad only and gate on Devon's test before more platforms. |
| Five UIs to keep in step | Behaviour lives in the core; platforms differ only in drawing and input. Features land in the core and web first, with a per-platform parity checklist. |
| Text input edge cases (Chinese/Japanese input, dictation, Scribble, autocorrect) | Implement each platform's input protocol fully rather than intercepting keys; add these to the device-lab checklist from phase 2. |
| Two editors (ProseMirror on web, `nv-editor` native) disagree during the transition | The shared editor test suite runs against both; mixed web and native editing of one page is part of every gate. |
| Bugs in moving from TS to Rust | The shared corpus and property tests, both implementations side by side until identical, flags for rollout. |
| Debugging across the UI↔core boundary | Typed messages, request ids in logs on both sides, core panics turned into reported errors. |
| More release work per platform (more stores, more builds) | One CI per platform from phase 1; releases keep one synced version number across platforms (as today). |
| Scope creep from "best possible" | Every phase has a gate and ships on its own. Options stay options until evidence says otherwise. |

## 9. Open questions for Devon

1. ~~**Mac:** share the iPad app's code or a separate AppKit app?~~ Decided 2026-11-21 (Devon): **full native Mac**, not Catalyst. Shared Swift for models, the core and SwiftUI where it is native on both; AppKit for the page canvas and text (NSTextView/TextKit 2 over EditorSession, NSTextInputClient), Mac menus, windows and shortcuts. It still matches today's look.
2. **Windows:** WinUI 3 in C#, or keep the Tauri web app on Windows longer since you have no Windows pen device?
3. **Reference devices** beyond the iPad: the iPhone, Mac, Android phone and Windows laptop for the budgets.
4. **Self-hosting:** keep supporting it? It affects how the server addon is packaged.
5. **End-to-end encryption:** ever? It's no for now, but it changes design choices if it's "eventually".
