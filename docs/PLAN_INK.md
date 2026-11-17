# Plan: handwriting and drawing (ink)

Status: re-planned 2026-11-17 with Devon. The quality bar is still **Notability or better**. The change is that handwriting moves to a **page kind of its own, the drawing page**, which is fully native on the iPad. Text pages keep the light web ink built in I1/I2 for annotation, but no more work goes into it.

**Why the change:** I2 tried to put native ink over the web canvas page. After eight TestFlight rounds (0.5.90 builds 104–112), the web pen drew well, but zoom and pan never felt like Notability. The title didn't scale with the page, elements moved clunkily, and it was "obviously not a full canvas". A page that mixes a web rich-text editor with native ink always has two things to keep in step. A drawing page has only one.

## What the user gets

- **A new page kind, "Drawing"**, next to Document and Canvas in the new-page menu.
- **On the iPad, a drawing page is native from edge to edge.** One surface scrolls with momentum, bounces and pinch-zooms, and the title, ink and text boxes scale as one picture. The Pencil draws the moment it touches. Pencil double-tap switches to the eraser, a two-finger tap undoes and a three-finger tap redoes.
- **Tools:**
  - pen (with styles later), highlighter, stroke eraser and partial eraser, with colours and widths
  - lasso and hold-to-snap shapes (I5), which Devon called a definite want
  - simple text boxes: font, size, colour, bold, maybe bullets. There's no rich editor.
- **Elsewhere** (Mac, Windows, web, Android): drawing pages open on a web canvas with the I1 web pen and the same Rust engine, so strokes look identical. Those platforms don't need to match the iPad's feel.
- Sync, offline, version history, sharing, print/PDF and export work like they do for every page.
- **Later:**
  - PDF markup (I6): a drawing page with a PDF as its background
  - handwriting search and conversion (I7)
  - audio synced to ink (I8)

## Quality bar and how we test it

"Notability or better" is judged side by side on Devon's iPad Pro (2020, Pencil 2):

| Check | How |
|---|---|
| Feel (Stage 1 gate) | Write, pan, flick, pinch and zoom in both apps. Notivelo feels no worse. |
| Latency | Slow-motion video (240 fps) of a fast scribble: the gap between the Pencil tip and the line, Notivelo against Notability. It must not be visibly worse. |
| Stroke quality | Write the same sentence at several speeds and pressures. Curves are smooth, with no corners at speed and a pressure taper. |
| Palm rejection | Write a full page with the palm resting. There are zero stray marks. |
| Pan/zoom | A page with 5,000 strokes and 50 text boxes runs at 120 fps on ProMotion. |
| Sync | A stroke appears on a second device within 300 ms (p50) online, and after reconnecting when it was offline. |
| Durability | Kill the app mid-stroke, go offline and online, and erase concurrently on two devices. Nothing is lost or duplicated. |

## Architecture

```
iPad (drawing page)                         Mac / Windows / web / Android (drawing page)
┌──────────────────────────────────┐        ┌──────────────────────────────────────┐
│ DrawingPageViewController (UIKit)│        │ React drawing canvas (web)           │
│  UIScrollView: zoom, momentum    │        │  I1 web pen, tiles, coalesced/       │
│   └ page view: title, ink, text  │        │  predicted events, delegated ink     │
│  Metal live stroke, PencilKit-   │        │                                      │
│  free; native toolbar            │        │                                      │
└───────────────┬──────────────────┘        └──────────────────┬───────────────────┘
                │ C ABI                                          │ WASM
        ┌───────▼────────────────────────────────────────────────▼───────┐
        │ nv-ink (Rust): blob format, smoothing, outline, tessellation,  │
        │ hit tests, erase split, (lasso, shapes)                        │
        └────────────────────────────────────────────────────────────────┘
                │                                                │
        ┌───────▼────────────────────────────────────────────────▼───────┐
        │ Page doc (Yjs): `ink` map + `items` map (text boxes), synced   │
        └────────────────────────────────────────────────────────────────┘
```

### Hosting the native page on the iPad

- Opening a drawing page in the iOS app on an iPad **presents a native `DrawingPageViewController` full screen** over the Capacitor web view. It is presented by a plugin call, and the web app stays loaded underneath, so closing the page returns instantly to the notebook.
- **A native toolbar** sits across the top: Close (back to the notebook), the title, tools, colours, widths, undo/redo and a share menu. A web ribbon over a native page would bring back the two-layer problem. *Devon's call:* a native toolbar is recommended; the alternative is the web ribbon with the page under it (decision D1).
- **Sync while native:** the page doc lives on the web side, which already syncs it. Stage 2 keeps it there: native sends each finished stroke or text edit across the bridge once (as I2 already does), and the web sends remote changes back. So there is still one Yjs doc and one sync path. Moving the doc into native code (yrs over the C ABI) is possible later if the bridge shows up in measurements.
- **The sidebar and notebook navigation stay web.** On iPad, the page covers them, as Notability's page view does.

### Each platform

| Platform | Drawing page | Text pages |
|---|---|---|
| iPad (iOS app) | Native (this plan) | Web canvas with light web ink (I1/I2) |
| iPhone (iOS app) | Native, with finger drawing on by default. *Devon's call (D2):* native, or view-only web on the phone. | Web |
| Mac (App Store app) | Web canvas with the web pen (trackpad, mouse, Sidecar Pencil) | Web |
| Windows | Web canvas, delegated ink trail for pens | Web |
| Web, Android | Web canvas | Web |

## Data model

- `PageKind` (`shared/types.ts`) gains `'drawing'`. The server, templates, trash and every page list treat it like `'canvas'` except where the content differs. Old apps that don't know the kind show "This page needs a newer version of Notivelo" and never edit it.
- The page's Y.Doc holds:
  - `ink` (Y.Map): stroke id → blob, exactly as I1 stores it (versioned, little-endian, delta- and varint-packed points, a header with tool, colour, width, a fractional z key and a bounding box). Strokes are immutable: erasing part of a stroke deletes it and adds the pieces, all in one transaction.
  - `items` (Y.Map): text box id → Y.Map `{x, y, w, z, text, font, size, color, bold, bullets?}`, where `text` is a Y.Text with no rich marks. *Devon's call (D3):* how much formatting a text box gets. Plain text with font, size, colour and bold is recommended to start; bullets come later.
  - `meta` (Y.Map): `paper` (plain, lined, grid or dotted), `width` (page px), and later the `pdf` background for I6.
- **Page shape:** a fixed page width with endless height, like Notability's continuous paper, with zoom as a view transform. *Devon's call (D4):* this, or an infinite canvas in both directions. Fixed width prints and exports cleanly, so it's recommended.
- **Coordinates** are page px, shared by ink and text boxes.
- **Undo:** a `Y.UndoManager` over `ink` and `items` with one origin per device, so only your own changes are undone.
- **Readers** (version previews, print/PDF, export, search, the AI connector): drawing pages render with the shared renderer. Ink is drawn as vector paths and text boxes as text. Search and the connector read the text boxes (and recognised handwriting after I7). The connector never writes ink.
- **Converting** a text page to a drawing page, or back, isn't offered at first. *Devon's call (D5):* whether it's needed.

## Stages

Each stage is one or more PRs behind the `ink` flag until Stage 4.

### Stage 1: does it feel like Notability? (iPad prototype, local only)

- A bare native drawing page on the iPad, opened from the ribbon (in Draw mode, the **Drawing page** button in the Touch group, on the iPad with the `ink` flag). It is not yet a page kind and has no sync. It saves to the device only.
- It has:
  - a UIScrollView with pinch zoom from 0.5× to 4×, momentum and bounce
  - a title, ink and lined paper that all scale together
  - a Metal live stroke with nv-ink smoothing and coalesced and predicted touches
  - finished ink drawn as vector layers that are re-rendered sharp after zooming
  - pen, highlighter, stroke eraser and partial eraser, with colours and widths
  - Pencil double-tap to the eraser
  - a two-finger tap to undo and a three-finger tap to redo, with toolbar buttons as well
- **Gate (Devon, on the device):** it feels like Notability. Write, flick, pinch and zoom, and erase. If it doesn't, fix that before building anything on top.

### Stage 2: the drawing page kind, synced

- `PageKind 'drawing'` with the data model above, created from the new-page menu.
- On the iPad, opening one presents the native page, with strokes going through the bridge to the page doc (sync, offline, version history). Remote strokes appear live.
- On other platforms, the web drawing canvas: the I1 web pen on an `ink` + `items` page with pinch zoom, and the web-side text boxes.
- **Gate:** a stroke drawn on the iPad appears on the web within 300 ms and survives offline/online. Version history restores a drawing page.

### Stage 3: text boxes

- Native text boxes on the iPad (UITextView, plain text plus the D3 formatting) and the same boxes on the web. Tap with a finger in Text mode to place one, and drag to move it.
- **Gate:** typing, moving and syncing boxes work on the iPad and the web.

### Stage 4: drawing pages v1 (ship)

- Paper styles, print/PDF and export (SVG per page), search over text boxes, the AI connector reading them, pen settings remembered per device, and the full quality-bar checklist.
- **Gate:** the full checklist on the iPad and the web. Then the flag goes to Devon's workspace, then to everyone.

### Stage 5 onward

- **I5:** lasso (move, resize, rotate, recolour, copy, delete) and hold-to-snap shapes, on drawing pages.
- **I6:** PDF markup, as a drawing page with a PDF background (PDFKit on iOS, PDF.js on the web).
- **I7:** handwriting search and conversion (Vision on iPad).
- **I8:** audio synced to ink.

## What stays from I1/I2

- **I1 (shipped behind the flag):** `crates/nv-ink`, the WASM build and the web pen. These are the engine for every platform and the web drawing canvas.
- **I2 (branch `claude/ink-i2-61c006`):**
  - Kept for text pages:
    - the ribbon Draw toggle with type/draw mode
    - no Scribble in draw mode
    - two- and three-finger undo/redo on pointer events
    - the Pencil-switches-to-Draw setting
    - the smoother strokes (Rust)
    - the status-bar padding
    - pinch zoom of the canvas as one transform
  - Kept for drawing pages: the C ABI and `NvInkFFI.xcframework`, the `NvInk` Swift package (InkEngine, StrokeBuilder, the Metal live stroke, vector tiles, the pen recogniser) and the iOS Rust CI.
  - Parked: the native layer over the web page (`NativeInkController`, the ack protocol and the PencilKit comparison). It stays in the tree behind the debug menu until Stage 2 lands, and is removed then.

## Risks

| Risk | Mitigation |
|---|---|
| Two editors for one page kind (native on the iPad, web elsewhere) drift apart | One data model and one engine (nv-ink). Text boxes stay deliberately simple. A shared test corpus of drawing pages is rendered by both. |
| The bridge is slow for big pages | Strokes cross once each. Measure in Stage 2, and move the doc to native (yrs) only if needed. |
| Old apps open drawing pages | They show an "update" note and never edit the page. Yjs keeps unknown keys. |
| Feel can't be tested by agents | Devon's device checks at every gate, with a written checklist (`docs/ink-i2-test.md`, then a drawing-page checklist). |

## Decisions for Devon

- **D1, iPad chrome:** a native toolbar on the drawing page (recommended) or the web ribbon.
- **D2, iPhone:** native drawing pages with finger drawing on (recommended, almost free), or view-only.
- **D3, text box formatting:** plain text with font, size, colour and bold (recommended), or more.
- **D4, page shape:** a fixed width with endless height (recommended), or an infinite canvas both ways.
- **D5, converting** text pages to drawing pages: not at first (recommended).

## Decided earlier (Devon, 2026-11-14)

- **Reference device:** Devon's iPad Pro 2020 (A12Z, ProMotion, Pencil 2). It has no hover. Everything must work on every iPad that supports a Pencil, and hover and squeeze are extras.
- **No Windows pen device for now.** Windows pen feel stays unverified, and the release notes say so.
- **Finger drawing is off by default** on iPad, with a toggle.
- **Pageless by default** (endless height). Fixed paper sizes are a later per-page option for printing and PDF markup.
- **PDF markup is nice to have** (I6).
