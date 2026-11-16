# Plan: handwriting and drawing (ink)

Status: planned 2026-11-14 with Devon. The quality bar is **Notability or better**, even if it takes a redesign. It is the first project of the long-term architecture (`docs/ARCHITECTURE.md`, phases 0–2). Ink and drawing were out of scope for canvas pages (`docs/PLAN_CANVAS.md`); this plan brings them in.

## What the user gets

- Write and draw anywhere on a canvas page with a pen (Apple Pencil, Surface/Windows pens, Android styluses), a finger (when finger drawing is on) or a mouse.
- **Feel:** the line stays glued to the pen tip. Pressure and tilt shape the stroke, a resting palm is ignored, and Pencil double-tap/squeeze and hover preview work.
- **Tools:** pen (a few styles: fountain, ballpoint, fineliner), highlighter (drawn under ink and text), stroke eraser, partial eraser, lasso (move, resize, rotate, recolour, copy, delete), and shapes that snap when you hold at the end of a stroke (line, arrow, rectangle, ellipse, triangle).
- **Paper:** pinch zoom, pageless by default (endless) or fixed paper sizes (A4, Letter) per page, and paper styles (plain, lined, grid, dotted; the rule lines and grid exist today).
- Ink and text boxes live together. Write next to, over and around boxes, and lasso can select both.
- Live collaboration (see each other's strokes as they finish), offline drawing, version history, undo/redo, and sharing work like everything else.
- **Later phases:** PDF markup (import a PDF as page backgrounds and write on it), searching handwriting, converting handwriting to text, audio recording synced to ink.

## Quality bar and how we test it

"Notability or better" is judged on a real device, side by side:

| Check | How |
|---|---|
| Latency | Slow-motion video (240 fps) of a fast scribble: gap between Pencil tip and line in Notivelo vs Notability, same iPad. Must not be visibly worse. |
| Stroke quality | Write the same sentence in both apps at several speeds and pressures. Notivelo's strokes look at least as good: smooth curves, no corners at speed, pressure taper. |
| Palm rejection | Write a full page with the palm resting. Zero stray marks. |
| Pan/zoom | Pan and zoom a page with 5,000 strokes and 50 text boxes. 120 fps on ProMotion, and ink and text never visibly separate. |
| Sync | A stroke appears on a second device within 300 ms (p50) online, and after reconnecting when offline. |
| Durability | Kill the app mid-stroke, go offline and online, and run concurrent erasing on two devices. Nothing is lost or duplicated. |

Devon runs this checklist on his iPad and Pencil at each gate. Automated tests cover everything except feel.

## Architecture

```
          pen input                                 other devices
              │                                           ▲
┌─────────────▼──────────────┐   finished strokes   ┌─────┴──────────────┐
│ Pen layer (per platform)   │ ───────────────────▶ │ Page doc (Yjs/yrs) │
│ iPad: native Metal layer   │ ◀─────────────────── │ "ink" map          │
│ Windows: delegated ink     │   remote strokes     └────────────────────┘
│ Web/Android: canvas+predict│
└─────────────┬──────────────┘
              │ uses
┌─────────────▼──────────────────────────────────────────────────────┐
│ nv-ink (Rust): encode/decode, smoothing, pressure outline,         │
│ tessellation, hit testing, erase split, lasso, shapes              │
│ → WASM (web, server print via napi) and native library (iOS)       │
└────────────────────────────────────────────────────────────────────┘
```

- **One ink engine** (`crates/nv-ink`). Every platform turns the same stroke data into the same shape, so a page looks identical on iPad, Windows and the web, and print/PDF match the screen.
- **Per-platform drawing only:** each platform has its own drawing code, sized for that platform's latency.
- **Committing a stroke:** the pen layer draws the live stroke itself, so nothing waits on the network or on JS. When the pen lifts, the finished stroke goes to the page doc in one transaction. Remote strokes come back the same way. On iPad this crosses the native↔web bridge once per stroke, not once per point.

### iPad: native pen layer

- A **Metal-backed view** drawing with `nv-ink` geometry, fed by UIKit touches with **coalesced and predicted touches** (Apple's own low-latency path). It handles force, altitude/azimuth, Pencil hover (`UIHoverGestureRecognizer`), double-tap/squeeze (`UIPencilInteraction`), and palm rejection (`touch.type == .pencil` while the pen is in use; finger drawing optional).
- **PencilKit vs our own Metal renderer** is decided in the prototype (I2). PencilKit gives Apple's latency for free, but its stroke look is fixed and differs from what the web would draw. Our own renderer gives identical strokes everywhere, but we must match Apple's latency ourselves. The default expectation is our own renderer, with PencilKit as the fallback if we can't match its latency.
- **Lockstep pan and zoom:** native code owns scrolling and zooming. The WKWebView with the page sits inside a native `UIScrollView`-style container together with the pen layer, and both get one transform per frame. The web page doesn't scroll itself on iPad, and zoom is a transform plus a re-render at rest. The web editor still handles typing and text selection inside a box.
- **Fallback if lockstep can't be made smooth:** on iPad, draw the whole page natively (text boxes as rendered snapshots) and switch only the box being typed in to the web editor. This is bigger, but contained, and decided at the I2 gate.

### Windows

- WebView2/Edge **delegated ink trail** (`navigator.ink.requestPresenter()`): the OS draws the newest part of the stroke ahead of the page, and we draw the rest with `nv-ink` geometry. Pointer events give pressure and tilt, and the eraser end of the pen (`buttons`) switches tools.

### Web, Mac, Android

- A canvas renderer (Canvas2D first, WebGL when budgets need it) with `getCoalescedEvents()` and `getPredictedEvents()` where supported, drawing `nv-ink` geometry.
- **Tiled caching:** finished strokes are drawn into tiles at the current zoom, and only tiles that change are redrawn.

## Storage

Strokes live in the page's existing Y.Doc (`shared/pageDoc.ts` today, `nv-model` later), next to `boxes`:

- `ink` (Y.Map): stroke id → `Uint8Array` blob. Strokes are **immutable**: moving or recolouring writes a new blob under the same id, and erasing part of a stroke deletes it and adds the pieces with new ids, all in one transaction.
- **Blob format** (versioned, little-endian):
  - header: format version, tool, colour (RGBA), base width, z-order key (fractional index string), flags, bounding box (for culling and hit tests), point count, creation time
  - points: delta-encoded, varint-packed x/y at 1/8 page pixel, pressure (8 bit), tilt (8+8 bit, optional), time delta (ms)

  Roughly 4–6 bytes per point, so a typical handwritten word is a few hundred bytes. A page with 5,000 strokes is about 1–2 MB, comparable to a page with images.
- **Coordinates** are page pixels, the same space as `boxes` (`{x, y, w, z}`), so ink and boxes move together and zoom is a view transform only.
- **Ordering:** a fractional-index z key per stroke. Highlighters render in their own layer below text boxes, and pens above. Per-stroke "send behind text" can come later.
- **Recognised text** (I7) goes into a separate `inkText` Y.Map (cluster id → text + stroke ids) and is read by search, never shown as content.
- **Schema version** bump with an upgrade step (no-op for old pages). Older app versions that don't know `ink` leave it untouched. Yjs keeps unknown keys, so an old app can't destroy ink, and it shows a "this page has handwriting, update the app" note.
- **Locked pages:** ink is page content, so the existing lock rules apply unchanged.

### Server and everything that reads a page

Every place that reads page content (the `pageFragments(doc)` users in `server/collab.ts`, `export.ts`, `links.ts`, `tree.ts`, versions, print, the MCP connector) gets ink-aware:

| Reader | With ink |
|---|---|
| Version history | Previews render ink (shared renderer), and restore includes it. |
| Print / PDF | Ink drawn as vector paths from `nv-ink` geometry, the same as on screen. |
| Export (zip/Markdown) | Ink saved as an SVG per page, linked from the Markdown, plus the raw blobs in the full backup. |
| Search | Recognised text from `inkText` (I7). |
| AI connector | Reports "this page has handwriting", plus recognised text when available. It never writes ink. |
| OneNote import | OneNote ink usually arrives as images (unchanged). Real ink import is a later investigation. |
| Templates | Copy ink with the page. |

## Undo

- Ink changes are tracked by a `Y.UndoManager` on `ink` with an `INK_ORIGIN`, combined with the canvas geometry undo (`GEOM_ORIGIN` in `src/editor/canvasDoc.ts`) into one page-level undo stack outside text boxes.
- On iPad the native layer asks the web side to undo or redo (two-finger tap, three-finger swipe), so there is one stack, not two.
- Only your own changes are undone; collaborators' strokes are untouched (Yjs undo per origin).

## Phases

Each phase is one or more PRs and ships behind the `ink` feature flag until I3 passes its gate.

### I0: canvas prep (TypeScript, part of architecture phase 0)

- One **screen↔page coordinate transform** in `canvasGeom.ts`, used everywhere (box drag, resize, caret placement, hit tests), with zoom fixed at 1 for now.
- One **pointer router** for the canvas: pen, touch and mouse are told apart, and later the active tool decides who gets the event.
- **Reserve `ink`** in the page format with a schema version step, and give every page reader a hook that is a no-op for now.
- Test corpus entries for pages with an empty `ink` map.

### I1: `nv-ink` and the web renderer

- The Cargo workspace (`crates/`) and CI (architecture phase 1).
- `nv-ink`: blob encode/decode (with fuzzing), smoothing (a "one-euro" filter on input plus a curve fit), a pressure-to-width outline, tessellation into triangles (GPU) and paths (Canvas2D/SVG/PDF), hit testing (point, segment, lasso polygon), and erase-split.
- The WASM build, and the web canvas renderer with tiles, coalesced and predicted events, and Windows delegated ink.
- **Exit:** the web and Windows draw, save, sync and print ink. Property tests: encode∘decode is the identity, erase-split covers exactly the original minus the eraser, hit tests agree with rendering.
- **Built (2026-11-16, branch `feat/ink-i1`):**
  - `crates/nv-ink`: the blob format above; a stroke's shape is the union of discs along a centripetal Catmull-Rom fit of its points (radius from pressure), drawn as quads plus discs, so hit tests ask the same question as rendering. The partial eraser cuts where the eraser's disc touches the ink. Property tests run in `cargo test`; `crates/nv-ink/fuzz` is a `cargo fuzz` target for decoding (run by hand).
  - WASM: `scripts/build-ink-wasm.sh` writes `src/ink/generated/` (committed; the Rust workflow checks it matches the source and its size). App builds need no Rust. The page CSP allows `'wasm-unsafe-eval'` (WebAssembly only, no JS eval).
  - Web: `src/ink/` (renderer with 256 px tiles, pen input with coalesced/predicted events and the delegated ink trail where offered, pen toolbar). Behind the `ink` flag (`src/lib/flags.ts`: `localStorage['noteapp.flags.ink'] = '1'`, or `VITE_FLAG_INK=1` at build time). Ink shows for everyone on pages that have it; only the flag offers the tools. Not shown in the stacked phone layout.
  - Print: ink prints as SVG paths after the boxes, at its size on the page (placing it over the flowed boxes waits for fixed paper sizes, I4).
  - The server drops `ink` entries that aren't byte blobs of at most 512 KB from live edits; it doesn't decode blobs (a newer app's format must survive).

### I2: iPad prototype (go/no-go)

- The native pen layer in the Capacitor iOS app, using `nv-ink` through a C ABI (decided in I2, see below).
- Lockstep pan and zoom with the web page.
- Strokes commit to the page doc and appear live on the web.
- A quick comparison spike: our Metal renderer vs PencilKit for latency.
- **Gate (Devon, on device):** latency and quality match Notability side by side, and ink never visibly separates from text while panning or zooming. If either fails, choose the PencilKit or native-page-view fallback before I3.
- **Built (2026-11-16, branch `claude/ink-i2-61c006`), behind the `ink` flag, iPad only:**
  - **Rust to iOS: a hand-written C ABI, not uniffi.** `crates/nv-ink/src/ffi.rs` (`ffi` feature) and `crates/nv-ink/include/nv_ink.h`: a dozen functions over flat floats and byte buffers. The hot path (a pen sample, a preview per frame) passes pointers with no serialisation, and there is no code generator, extra crates or generated Swift to keep in step; uniffi would add all three for an API this small. `scripts/build-ink-ios.sh` builds `NvInkFFI.xcframework` (device, simulator arm64+x86_64, and macOS for tests); it isn't committed, CI builds it on macOS.
  - **The pen layer:** a Swift package, `apps/mobile/ios/App/NvInk` (`NativeInkController`), and a plugin, `App/NoteAppInkPlugin.swift`; the web side is `src/ink/nativeInk.ts`. Pencil input comes from a gesture recogniser on the web view that takes only Pencil touches (fingers too with finger drawing on), with coalesced and predicted touches, force, altitude and azimuth. The live stroke is drawn with Metal (nv-ink triangles, 4x MSAA) the moment touches arrive. Pencil double-tap toggles the eraser; a two-finger tap undoes and a three-finger tap redoes, anywhere on the page (the page's one undo stack, on the web side; the system's three-finger editing gestures are off while the pen layer is on). While a pen tool is picked the boxes aren't editable and an opt-out Scribble interaction is on the web view, so the Pencil never turns into typed text (Devon's first TestFlight round).
  - **Lockstep pan:** finished strokes are vector layers (nv-ink paths, as the web draws them) inside WebKit's own `UIScrollView` for the page scroller, found by matching its box to the one the web measures. Panning moves ink and text in the same Core Animation frame, so they can't drift. With the native layer on, the page scrolls in one place (`.page-scroll`, both ways), and scrolling is locked while the pen is down.
  - **Zoom (true, 0.5x to 4x):** native code owns the pinch. A snapshot of the page (text and ink as one picture) follows the fingers; when they lift, native computes the new zoom and scroll offset and sends them to the web (the transform goes native to web), the web lays the surface out at that zoom (CSS `zoom`, so text is sharp) and scrolls, answers `viewApplied`, and the snapshot fades. Known: a possible one-frame jump when the snapshot goes, blank edges while zooming out during the gesture, and box dragging and click-to-place at zoom != 1 are only roughly scaled (CanvasView gets the zoom, untested on device).
  - **Strokes cross the bridge once each:** pen-up sends the blob; the web writes it with `commitStroke` (INK_ORIGIN, the canvas undo), and every change to the `ink` map (remote, undo, ours) goes back to native. Native changes carry a token that comes back with the update that applies them, so the provisional drawing is swapped for the real stroke in the same frame. Erasing (stroke and partial) runs natively with nv-ink hit tests and is sent once per gesture.
  - **Draw mode (Devon, after the first TestFlight round):** the pen controls live in the ribbon, not on the canvas. A **Draw** toggle in the ribbon (only where ink works: the flag, an editable canvas page, not the stacked phone layout) switches the whole canvas between two modes, remembered per device:
    - *Type mode:* the normal canvas, with no pen behaviour at all. On the iPad the native layer still shows the ink but captures nothing, and the Pencil behaves like a finger (taps place the caret, Scribble works).
    - *Draw mode:* the ribbon's text groups give way to the pen groups (tools, colour, width, finger drawing), like OneNote's Draw tab done as a swap. The Pencil and the mouse draw anywhere, over boxes too, and the boxes are inert: not editable, no caret, keyboard or Scribble, no picking, moving or resizing. Fingers scroll (and draw only with finger drawing on).
    - Undo/Redo (ribbon, Ctrl/Cmd+Z, and the two- and three-finger taps) work in both. Nothing switches modes automatically; the ribbon is the control.
  - **Comparison:** a debug menu in the ribbon's draw groups (bug button) swaps our renderer for PencilKit (not saved), overlays the web's own ink to check alignment, and fills the page with 50 boxes and 3,000 test strokes.
  - **Prototype limits:** highlighters draw over text (not under it), no hover (the reference iPad has none), PencilKit mode turns scrolling off. The device checklist is `docs/ink-i2-test.md`.

### I3: ink v1

- Pen (styles), highlighter, stroke eraser, partial eraser, colours and widths with a pen toolbar, undo/redo, collaboration, offline, version previews, print/PDF, export (SVG).
- Pen settings remembered per device.
- **Gate:** the full quality-bar checklist on iPad, Windows pen if available, and the web. Then the flag goes to Devon's workspace, then everyone.

### I4: zoom and paper

- Pinch zoom on every platform: text re-renders sharp at rest, ink re-tessellates per zoom level.
- Paper: pageless (the default) or fixed sizes with page breaks, and paper styles. Print respects fixed sizes.

### I5: lasso and shapes

- Lasso over strokes and boxes: move, resize, rotate, recolour, copy/paste (including between pages), delete.
- Hold-to-snap shapes.

### I6: PDF markup

- Import a PDF as page backgrounds (rendered with PDF.js on the web, PDFKit on iOS; the original stored as an attachment), write on top, and export the marked-up PDF.

### I7: handwriting search and conversion

- On-device recognition on iPad (Vision), clustered into words and lines, stored in `inkText`, indexed by server search and the local search (architecture phase 5).
- Convert selected handwriting to a text box.
- Check that Scribble (Apple's handwriting-to-text in text fields) works in web text boxes.
- Windows recognition (Windows.Globalization/ink analysis) later.

### I8: audio synced to ink

- Record while writing, with timestamps per stroke. Tapping a stroke plays from that moment, and playback replays strokes appearing.
- Audio is stored as an attachment, with permission prompts on each platform.

## Risks

| Risk | Mitigation |
|---|---|
| Our renderer can't match Apple's latency | Compare it with PencilKit in I2, keep PencilKit as a fallback, and use predicted touches. |
| Lockstep scrolling between native and web | Native owns pan and zoom. Defined fallback (native page view) at the I2 gate. |
| Large pages get heavy (doc size, redraw cost) | Compact blobs, bounding-box culling, tiles, budgets in CI (5,000 strokes at 60/120 fps). |
| Concurrent erase and move conflicts | Immutable strokes and one transaction per operation. Last writer wins per stroke id, which reads naturally. Property tests. |
| Old app versions open pages with ink | Yjs keeps the unknown key, and old apps show an "update to see handwriting" note. |
| Feel can't be tested by agents | Devon's device checks at every gate, with a written checklist. Slow-motion video for latency. |

## Decided (Devon, 2026-11-14)

- **Reference device:** Devon's iPad Pro with an Apple Pencil (2nd generation). All quality-bar checks run on it, and it is the device for the I2 gate.
  - Pencil 2 supports pressure, tilt and double-tap. Squeeze is Pencil Pro only.
  - Hover preview needs an M2 iPad Pro or later, so check the model year, and treat hover as a bonus that is skipped where unsupported.
  - All iPad Pros have ProMotion, so the 120 fps budgets apply.
- **No Windows pen device for now.** Windows ink (delegated ink trail) is still built in I1, but tested only with mouse and touch plus automated tests. Pen feel on Windows stays unverified until a device is available, and the release notes say so. Revisit before I3 ships: borrow or buy a Surface pen, or keep Windows pen support marked as beta.
- **PDF markup is "nice to have":** it stays phase I6, after ink v1, zoom/paper and lasso. It isn't a launch requirement.

- **The iPad Pro is the 2020 model** (A12Z, ProMotion, Pencil 2). It has no Pencil hover, so hover preview isn't testable on it. **Everything must work on every iPad that supports a Pencil**, not just new ones: hover and squeeze are extras where the hardware has them, never required, and the 2020 iPad Pro sets the performance floor for the budgets.
- **Finger drawing is off by default,** with a toggle in the pen toolbar and in Settings, like Notability. With it off, a finger scrolls and zooms, and only the pen draws.
- **Pages are pageless by default** (endless, like Notability's pageless mode and OneNote). Fixed paper sizes (A4, Letter) with page breaks are a per-page option, mainly for printing and PDF markup.
