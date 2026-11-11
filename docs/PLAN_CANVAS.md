# Plan: canvas pages (text boxes anywhere)

Tester feedback round 1 asked for OneNote-style pages: click anywhere and type, with
boxes placed side by side or anywhere on the page. Decision: build real canvas pages
(not a columns block). Ink and drawing are out of scope.

## What the user gets

- A page can be a **canvas**. Click any empty spot to start a text box there; type.
- Each box is a full rich-text editor: headings, lists, inline tasks, tables, images,
  colours, mentions, links. The same toolbar acts on the box you're in.
- Drag a box by its top edge to move it; drag its right edge to set its width (height
  follows the content). Boxes may overlap, like OneNote.
- An empty box disappears when you click away.
- The page grows right and down as boxes move outward (scrolls both ways). No zoom at first.
- Live co-editing works as today: presence, cursors inside boxes, boxes moving live.
- **Phones:** boxes are shown one under the other in reading order (top to bottom,
  then left to right) and edited normally. Placing boxes is a desktop and tablet thing.
- **Convert** from the page menu: a document becomes a canvas with one box (lossless);
  a canvas becomes a document with the boxes joined in reading order.
- Search, tasks, mentions, backlinks, version history, export, templates and sharing
  all see every box.
- OneNote import keeps each box where it was on the page (if the page HTML gives
  positions; it usually does for pages made in OneNote).

## How it's stored

One Y.Doc per page, as today:

- `boxes` (Y.Map): box id → Y.Map `{ x, y, w, z }` in page pixels.
- `box:<id>` (Y.XmlFragment): the content of that box, the same schema as documents.
- `default` stays the content of document pages. A canvas page leaves it empty.

`pages.kind` becomes `'canvas'` (the value is already reserved in `shared/types.ts`).
No migration is needed for the column; a new migration is only needed if templates gain
a kind.

Server code that reads `getXmlFragment('default')` today (about 10 places in
`server/collab.ts`, `export.ts`, `links.ts`, `tree.ts`) moves to one helper:
`pageFragments(doc)`, which returns the fragments in reading order. Document pages
return `[default]`, so their behaviour doesn't change.

## Editor

- `CanvasPage.tsx` holds a positioned surface. Each box is a TipTap editor bound to its
  own fragment (`Collaboration.configure({ field: 'box:<id>' })`) and shares the page's
  awareness for cursors.
- Editors mount when visible; a page with many boxes stays light.
- The fixed toolbar and bubble menu follow the focused box's editor.
- Undo is per box at first (each Collaboration editor has its own undo manager).
  Moving, resizing and creating boxes get their own undo entries.
- Keyboard: Escape leaves a box, Tab and Shift+Tab move to the next or previous box in
  reading order, and arrow keys with a box selected nudge it.

## Phases (one PR each)

1. **Storage and server.** Add `pageFragments()` and point search text, task links,
   mentions, links, versions, export, sanitize and the demo seed at it. Allow
   `kind: 'canvas'` when creating a page. Unit tests: a canvas with two boxes indexes,
   links tasks and exports both.
2. **Desktop canvas editor.** The surface, click to create, move, resize, delete empty
   boxes, toolbar binding, presence, keyboard. Add "New canvas page" next to "New page".
   E2E: create boxes, type, move, a second user sees the boxes move live.
3. **Phones, conversion, templates.** Stacked layout on phones, document ↔ canvas
   conversion, canvas templates.
4. **OneNote import positions.** Read the positions in the page HTML into boxes; pages
   without positions stay documents.
5. **Polish, after testers use it.** Snap and align guides, selecting several boxes,
   bring to front, zoom.

Phases 1 and 2 are the core. Phases 3 and 4 can run in parallel once phase 1 has merged.

## Decisions (Devon, 2026-11-11)

1. **New pages are canvas by default.** "New page" makes a canvas, and documents stay
   available as "New document page". The default flips in phase 3, once the canvas editor
   and the phone view are in. Until then, the API keeps `document` as its default and
   tests choose the kind explicitly.
2. **Built-in templates get canvas versions** (phase 3). A template keeps its kind, and
   using it makes a page of that kind.

## Decision: canvas-only pages (Devon, 2026-11-11, later the same day)

**Every page is a canvas, OneNote-style; document pages go away.** This replaces decisions 1
and 2 above.

- **Ready first box.** A blank page shows its first box (id `first`) at the top left, focused
  for typing. It is only stored in `boxes` once something is typed in it, so pages you merely
  open stay empty. Clicking elsewhere still starts a box there.
- **Wide boxes.** That box, and the box a document becomes, has `wide: true` in its geometry:
  it is drawn at the readable width (the old 760px column: `READABLE_BOX_W`, text lined up
  with the title), or the page's width with "Full width", until someone drags its width. The
  page keeps the old centred column for the title and the surface's left edge; the surface
  reaches right to the edge of the page for boxes beside it. Wide boxes get the long-page
  rendering and the block handle, so a converted document looks and behaves as it did.
- **Outline** lists headings of every box in reading order (read from the Y.Doc) and jumps
  into the box, mounting its editor if needed. `?task=` deep links mount every box.
- **Conversion.** `server/dataMigrations.ts` runs at startup after the SQL migrations and
  converts every remaining `kind = 'document'` page (in batches, keyset-paginated) with the
  same lossless `convertPageDoc`, after saving a version. It is idempotent: a converted page
  is no longer a document. Imports (OneNote, workspace export) and seeded pages are made
  as canvases directly.
- **API.** `POST /sections/:id/pages` always makes a canvas (`kind` is ignored);
  `POST /pages/:id/convert` only accepts `canvas`. The server still reads `default` content
  (`pageFragments` includes it) as a safety net, e.g. for an offline client's late edits
  to a document page.
- **UI.** No "New document page", no convert items, no kind icons; all built-in and
  notebook templates are canvases, and a document template from before fills one wide box.

## Risks

- **Phones.** Free placement doesn't suit small screens, hence the stacked view.
- **Undo.** Undo across boxes isn't shared at first.
- **Performance.** Pages with dozens of boxes are mounted lazily, but this still needs
  measuring.
- **Moving tasks.** Moving inline tasks between boxes means cut and paste at first,
  not drag.
