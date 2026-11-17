# Ink I2: iPad test checklist (go / no-go)

The I2 gate in `docs/PLAN_INK.md`: does our native pen layer match Notability for latency and stroke quality, and do ink and text stay together while panning and zooming? One sitting, about 30 minutes, on the 2020 iPad Pro with Apple Pencil 2, with Notability installed. Note results in the table at the end.

## Setup

1. Install the TestFlight build of the I2 branch (made with the Mobile workflow's **ink** option on, see "Getting the build" in the I2 report). Ink is on in that build without any setting.
2. Sign in, open a notebook, and make a new **canvas page** (pages are canvas pages by default). Make a second one for the heavy-page test.
3. Turn on **Draw** in the ribbon: the text groups give way to the pen groups (Tools, Colour, Width, Touch). Turning Draw off goes back to typing. The **bug** button in the Touch group opens the debug menu:
   - **Notivelo renderer / PencilKit (not saved)**: swaps our renderer for Apple's PencilKit on the same page. PencilKit strokes vanish when you switch back, and scrolling is off while it's on.
   - **Web ink overlay**: also draws the web's own ink, faint, under the native ink. They should coincide exactly; a visible double line means the two are misaligned (note where, and at what zoom).
   - **Fill with test strokes**: adds text boxes up to 50 and 3,000 test strokes (press twice for 6,000).
4. Gestures: the Pencil draws; one finger scrolls; two fingers pinch-zoom (0.5× to 4×); a two-finger tap undoes and a three-finger tap redoes (as in Notability, whatever tool is picked); Pencil double-tap switches between the eraser and the last pen. In draw mode the text boxes rest (no typing, caret, moving or resizing); turn Draw off to type.

**Status readout (bottom left of a canvas page, iOS app with the ink flag):** it says which part of the ink path works: the flag, the native pen layer (`native layer attached`, or `web pen: …` with the reason, e.g. the scroll views it saw), the mode, and the Pencil switch. If anything in this list misbehaves, photograph the readout first. Tap it to hide it.

- [ ] Open a short, new canvas page and a long one: both say **native layer attached** within a second or two. (Before this build, a page too short to scroll had no native scroll view for the layer to live in, so it silently used the web pen: no double-tap, no undo taps, no Pencil switch, and Scribble fired.)

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
- [ ] Turn **Draw** off: tapping a box with a finger or the Pencil puts the caret there, Scribble (writing into the box with the Pencil) works as before, and the Pencil never draws or erases. Pencil double-tap does nothing.
- [ ] Draw three strokes, then **two-finger tap** three times: they go one by one, newest first. Then **three-finger tap** three times: they come back in order. No iPadOS undo/redo banner or copy/paste bar appears.
- [ ] The same taps in type mode and with the **eraser** picked (undo brings an erased stroke back). The ribbon's Undo and Redo buttons do the same in both modes.
- [ ] Two-finger tap after typing in a box (type mode): undoes the typing, then the strokes before it (one undo history for the page).
- [ ] A two-finger tap that doesn't move never scrolls or zooms the page; a two-finger drag still scrolls and a pinch still zooms.
- **Pass:** no handwriting or erasing ever changes text while a pen tool is picked, and the taps undo and redo every time.

## 7. Draw mode in the ribbon

- [ ] The ribbon has a **Draw** toggle on canvas pages, first in the ribbon. Turning it on swaps the Text, Lists and Insert groups (and Table, when the caret is in a table) for Tools, Colour, Width and Touch; Draw, Page, View and History stay where they are, and the ribbon doesn't change height. There is no pen toolbar on the canvas any more.
- [ ] The ribbon starts below the iPad's status bar (time, battery), and every button in it responds to a tap.
- [ ] Collapse the ribbon (the chevron at its right end): the strip still has a **Draw** button, which turns draw mode on and off without opening the ribbon; tapping the strip's text opens the ribbon again.
- [ ] In draw mode, try to tap into a box, drag a box's top edge, or drag its right edge with a finger: nothing happens (fingers scroll). The Pencil draws straight across boxes.
- [ ] Leave the page in draw mode, open another page and come back, and close and reopen the app: draw mode is still on (it is remembered on this iPad). Turn it off: it stays off.
- [ ] On the PC (browser with the ink flag): the same Draw toggle; with it off the mouse selects text and moves boxes as before; with it on the mouse draws and the boxes rest.
- [ ] **Apple Pencil switches to Draw mode** (the Pencil button in the Touch group, on by default): in type mode, touch the page with the Pencil and write a word. Draw turns on and the first stroke is drawn in full (nothing lost), with the pen tool you last used. A finger tap or drag in type mode never turns Draw on. Draw turns off only from the ribbon.
- [ ] Turn that setting off, turn Draw off, and touch a box with the Pencil: the caret goes there and Scribble writes text, and nothing is drawn.
- [ ] On the PC, the setting isn't shown and the mouse never turns Draw on.
- **Pass:** the ribbon is the only way out of draw mode, each mode behaves wholly one way, and nothing about the pen gets in the way of typing in type mode.

## 8. Round 3 fixes (build after 0.5.90 (106))

- [ ] **Title:** in draw mode, touching the page title with the Pencil or a finger neither selects it nor brings up the keyboard (turn Draw off to rename the page).
- [ ] **Undo/redo taps:** two-finger tap undoes, three-finger tap redoes, in both modes. The readout's *last gesture* says `native: 2-finger tap` (or `web: …` if the native layer isn't attached). If a tap does nothing and the readout doesn't change, the tap never reached the app: note where on the page you tapped.
- [ ] **Pinch zoom:** pinch on the page in draw mode and in type mode. The readout says `native: pinch: zooming a picture of the page`, then `pinch: zoom 1.80` (or similar) when you lift, and the page settles at that zoom with ink on the text.
- [ ] **Smoothing:** write the same words slowly and quickly, with light and heavy pressure. Edges should be smooth (no flicker in width along a steady line) and slow strokes free of small wobbles; fast strokes should still follow the Pencil. Compare with Notability.

## 9. Round 4 fixes (build after 0.5.90 (107))

- [ ] **Draw beside the title:** in draw mode, write in the empty space right of the page title (and over the title). It draws and stays; nothing scrolls. In type mode the Pencil there still edits the title. (On the web, ink above the canvas is cut off at the canvas's top edge for now; on the iPad it shows in full.)
- [ ] **Undo/redo taps:** a two-finger tap anywhere on the page undoes, a three-finger tap redoes. The readout's last gesture shows `web: 2-finger tap → undo`. While fingers are down it shows `web: 2 fingers down`; if it shows nothing at all, the page gets no finger touches.
- [ ] **What native sees:** after a two-finger touch the readout may also briefly show `native: saw 2 fingers` / `native: 2-finger tap`. Note whether it ever does: it tells whether the native layer gets finger touches (pinch depends on it).
- [ ] **Pinch zoom:** as in section 8; if it still does nothing, note what the readout says during the pinch.

## 10. The native layer, for real (build after 0.5.90 (108))

Up to 0.5.90 (108) the native pen layer never started: finding the plugin hung (the readout stayed on **checking**), so every round so far tested the web pen. From this build the readout should go *native layer found* → *native layer ready* → *attaching (try 1)* → **native layer attached**. Then everything native is being tried for the first time: rerun sections 1–9, starting with drawing, the Pencil switch in type mode, drawing beside the title, pinch zoom and the double-tap eraser.

## 11. Finished ink drawn by the page (build after 0.5.90 (109))

With the native layer finally running (0.5.90 (109)), strokes vanished on lifting and were cut short. Now the web page draws finished ink (it is page content, so it pans and zooms with the text by itself); the native layer draws the live stroke with Metal and holds each finished stroke until the page has painted it. A resting palm no longer interrupts a stroke.

- [ ] Write a full line of words quickly: every stroke stays, none blink or vanish, none is cut short with the palm resting. The readout shows `native: stroke N: … points` per stroke (and `stroke cancelled …` if one was cut short: note when).
- [ ] Pan and pinch-zoom with ink on the page: the ink moves with the text (it is drawn by the page now), and is sharp after the zoom settles.
- [ ] Debug (bug button): **Ink: web / Ink: native** switches who draws finished ink; *native* is the old way (for comparison only).

## 12. Web pen (build after 0.5.90 (110))

Devon's finding: when the native layer detached, the **web pen** drew "great", and the native pen was what broke drawing. So the web pen draws now; the native layer only does Pencil double-tap and keeps Scribble off in draw mode (debug **Pen: web / native** brings the native Metal pen back for comparison). The readout says `pen: web`.

- [ ] **Drawing:** write a page quickly with the palm resting: every stroke stays, none cut short.
- [ ] **Latency (the deciding check):** 240 fps slow motion of fast scribbles, Notivelo vs Notability (section 1). If Notivelo is visibly behind, native drawing comes back as its own project.
- [ ] **Pinch zoom:** two-finger pinch on the page: the page (text and ink together) follows the fingers, and when they lift it settles sharp at the new zoom with what was under the fingers still under them. 0.5x to 4x. The readout says `web: pinch started`, then `web: pinch: zoom 1.80`. Draw at 2x and at 0.6x: strokes land under the Pencil.
- [ ] **Pencil switch:** in type mode, touch the page with the Pencil: draw mode turns on and that stroke draws.
- [ ] **Beside the title:** in draw mode, write right of the title and over it.
- [ ] **Double-tap:** Pencil double-tap switches to the eraser and back (draw mode).

## 13. Zoom as one layer (build after 0.5.90 (111))

On (111) zooming moved the text around and the eraser hit off to the side of the ink: the zoom was CSS `zoom`, which re-lays out text and which WebKit measures inconsistently. Now the canvas is scaled with a transform: boxes and ink are one layer, text never reflows, and every screen ↔ page conversion uses the same view (unit-tested at zoom with the page scrolled).

- [ ] Write a few words over and next to a text box, then pinch to about 2x and to about 0.6x: the box's text keeps its line breaks, and the ink stays exactly on the same letters, during the pinch and after.
- [ ] At 2x and at 0.6x, after scrolling: draw a stroke: it lands under the Pencil tip. Erase it (both erasers): the eraser takes it where it is drawn, not beside it.
- [ ] Type in a box at 2x (turn Draw off): the caret is where you tap.

## 14. Native drawing page (Stage 1 of the new plan, 0.5.90 (113))

A bare native page with no web view, to answer one question: **does this feel like Notability?** Open it on a canvas page by turning **Draw** on, then tapping **Drawing page** (a square with a pen) in the ribbon's Touch group. It opens full screen; **✕** closes it. It is saved on this iPad only (no sync yet), and reopening shows the same page.

- [ ] **Write:** fast and slow, with the palm resting. The line stays on the Pencil tip, curves are smooth, and pressure shows.
- [ ] **Pan:** flick with one finger. It glides and slows like Notability, bounces at the ends, and the Pencil stops a flick dead when it touches.
- [ ] **Zoom:** pinch from 50% to 400% (the zoom shows in the toolbar). The title, the paper's lines and the ink scale together, and after the fingers lift the ink and title are sharp. Draw at 300% and at 60%: strokes land under the tip.
- [ ] **Erase:** with the eraser (whole strokes) and the partial eraser (the dashed one). A grey ring shows the eraser under the tip. Pencil double-tap toggles the eraser and back.
- [ ] **Undo/redo:** a two-finger tap undoes and a three-finger tap redoes, and so do the toolbar arrows. A whole erase gesture is one undo step.
- [ ] **Heavy page:** ⋯ ▸ Fill with test strokes (3,000), then pan and zoom. It stays smooth. ⋯ ▸ Clear page (undoable) tidies up.
- [ ] **Finger drawing** (the hand button): one finger draws and two fingers pan and zoom.
- [ ] **Side by side with Notability:** write the same lines in both. Which feels better, and where?

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
| Draw mode in the ribbon | | — | — | | |

**Gate decision:** go with our Metal renderer / switch to PencilKit (latency or quality) / switch to the native page view (drift). See `docs/PLAN_INK.md`, I2.
