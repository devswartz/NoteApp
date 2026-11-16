# Ink I2: iPad test checklist (go / no-go)

The I2 gate in `docs/PLAN_INK.md`: does our native pen layer match Notability for latency and stroke quality, and do ink and text stay together while panning and zooming? One sitting, about 30 minutes, on the 2020 iPad Pro with Apple Pencil 2, with Notability installed. Note results in the table at the end.

## Setup

1. Install the TestFlight build of the I2 branch (made with the Mobile workflow's **ink** option on, see "Getting the build" in the I2 report). Ink is on in that build without any setting.
2. Sign in, open a notebook, and make a new **canvas page** (pages are canvas pages by default). Make a second one for the heavy-page test.
3. Pick the **pen** in the pen toolbar (top right of the page). The **bug** button at the end of the toolbar opens the debug menu:
   - **Notivelo renderer / PencilKit (not saved)**: swaps our renderer for Apple's PencilKit on the same page. PencilKit strokes vanish when you switch back, and scrolling is off while it's on.
   - **Web ink overlay**: also draws the web's own ink, faint, under the native ink. They should coincide exactly; a visible double line means the two are misaligned (note where, and at what zoom).
   - **Fill with test strokes**: adds text boxes up to 50 and 3,000 test strokes (press twice for 6,000).
4. Gestures: the Pencil draws; one finger scrolls; two fingers pinch-zoom (0.5× to 4×); a two-finger tap undoes and a three-finger tap redoes (as in Notability, whatever tool is picked); Pencil double-tap switches between the eraser and the last pen. While a pen or eraser is picked, the text boxes can't be typed in (pick **Select and type** to type).

## 1. Latency (slow motion against Notability)

- [ ] Film the screen with an iPhone in **240 fps slow motion**, from the side, so the Pencil tip and the line are both in shot.
- [ ] In Notivelo: quick scribbles and fast straight strokes, 5 seconds. Then the same in Notability, same lighting and distance.
- [ ] Repeat in Notivelo with the **PencilKit** renderer.
- [ ] Step through frame by frame. For a fast stroke, count the frames between the tip and the end of the line (at 240 fps, 1 frame ≈ 4 ms). Note the typical gap for each: Notivelo, PencilKit, Notability.
- **Pass:** Notivelo's gap is not visibly bigger than Notability's (within about 1 frame at 120 Hz, i.e. 2 slow-motion frames).

## 2. Stroke quality

- [ ] Write the same sentence ("The quick brown fox jumps over the lazy dog 0123456789") in Notivelo and in Notability: slowly, normally, and fast.
- [ ] Draw with light, medium and heavy pressure; draw some long curves and spirals; tilt the Pencil.
- [ ] Look for: corners or flat spots on fast curves, wobble on slow strokes, a blob or gap at the start or end, the line shifting when the pen lifts (the live stroke is replaced by the saved one; it must not move or blink).
- [ ] Highlighter: a few strokes over text and over pen ink (in this prototype the highlighter draws over the text, not under it).
- [ ] Dark theme: black ink shows light, as on the web.
- **Pass:** at least as smooth as Notability at every speed, with a visible pressure taper, and no jump on lift.

## 3. Palm rejection

- [ ] Write a full page of notes with your hand resting on the screen as you normally would, starting with the palm already down, and moving the hand between lines.
- [ ] Rest the palm, then lift and replace it several times mid-page.
- **Pass:** zero stray marks, no accidental scrolling or zooming from the palm, and no text box created or cursor placed by the Pencil.

## 4. Pan and zoom drift (heavy page)

- [ ] On the second page: debug menu, **Fill with test strokes** twice (50 boxes, 6,000 strokes). Turn on **Web ink overlay** for the first part.
- [ ] Pan slowly, then fling hard up and down, then sideways. Watch the test strokes against the words in the boxes.
- [ ] Pinch-zoom in to about 3×, out to about 0.6×, and back, with your fingers over a box. When the fingers lift the page settles (the picture fades into the sharp page): note any jump of ink against text at that moment, and whether the zoomed page ends up where your fingers left it.
- [ ] Draw a few strokes at 2× and at 0.6×: they land under the Pencil and stay put after lifting.
- [ ] Turn the iPad (portrait/landscape) and open/close the sidebar, then pan again.
- **Pass:** ink never visibly separates from the text while panning; after a pinch the page settles in under 1 frame of visible jump; panning stays smooth (no stutter at 120 Hz) with 6,000 strokes.
- Known in the prototype: during a pinch you see a picture of the page (blank edges when zooming out); zoom-out below 1× shows less detail until the fingers lift.

## 5. Sync to the web

- [ ] Open the same page in a browser on the PC (app.notiveloapp.com, or staging for a staging build), with ink visible (no flag needed to see ink).
- [ ] Draw on the iPad: each stroke appears in the browser within about a second (the PLAN's target is 300 ms p50 online).
- [ ] Draw in the browser (set `localStorage['noteapp.flags.ink']='1'` there and reload to get the pen): it appears on the iPad.
- [ ] Erase on the iPad (stroke eraser and partial eraser): the browser follows. Two-finger tap on the iPad undoes; Ctrl+Z in the browser undoes the browser's strokes only.
- [ ] Airplane mode on the iPad, draw a few strokes, airplane mode off: they reach the browser.
- **Pass:** every stroke arrives once, nothing is lost or doubled.

## 6. Scribble, undo and redo (fixes after the first TestFlight build)

- [ ] With the **pen**, write and draw right over the text of a box (several words, a scribble across a line). Nothing turns into typed text, no caret or keyboard appears, and the box's text is unchanged.
- [ ] With the **eraser** and the **partial eraser**, scrub back and forth over strokes that sit on a box's text (Scribble's scratch-out gesture). Only ink goes; the text is untouched.
- [ ] Pick **Select and type**: tapping a box puts the caret there again, and Scribble (writing into the box with the Pencil) works again there, as before.
- [ ] Draw three strokes, then **two-finger tap** three times: they go one by one, newest first. Then **three-finger tap** three times: they come back in order. No iPadOS undo/redo banner or copy/paste bar appears.
- [ ] The same taps with the **select** tool picked and with the **eraser** picked (undo brings an erased stroke back).
- [ ] Two-finger tap after typing in a box (select tool): undoes the typing, then the strokes before it (one undo history for the page).
- [ ] A two-finger tap that doesn't move never scrolls or zooms the page; a two-finger drag still scrolls and a pinch still zooms.
- **Pass:** no handwriting or erasing ever changes text while a pen tool is picked, and the taps undo and redo every time.

## Results

| Check | Notivelo | PencilKit | Notability | Pass? | Notes |
|---|---|---|---|---|---|
| Latency (slow-motion frames, fast stroke) | | | | | |
| Stroke quality | | — | | | |
| Palm rejection | | — | — | | |
| Pan drift, 6,000 strokes | | — | — | | |
| Pinch zoom settle | | — | — | | |
| Sync to web | | — | — | | |
| Scribble off, undo/redo taps | | — | — | | |

**Gate decision:** go with our Metal renderer / switch to PencilKit (latency or quality) / switch to the native page view (drift). See `docs/PLAN_INK.md`, I2.
