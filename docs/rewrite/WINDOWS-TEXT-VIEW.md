# Windows box text view (design)

Status: design, 2026-11-22, Windows stream step 3. Nothing here is built. Written against `EDITOR.md` 10 (view text, `CoreTextEditContext` in 10.6), the uniffi surface of `crates/nv-core/src/editor_session.rs`, `LOOK.md` 2.3, 2.4, 4.5-4.7, and core's C# bindings on `origin/rewrite/core-windows` (763a7bc, `status/core.md` "For windows").

From core's note: `using Notivelo.Native;`; `EditorSession`, `LivePage`, `Core` are `IDisposable`; methods and record members are PascalCase (`session.ViewRender()`, `session.Key("Enter")`, `r.View.Lines`); options are nullable; callbacks (`TaskCallbacks`, `LivePageListener`) are C# interfaces called on core's threads; no async. `nv_core.dll` ships per RID in the `Notivelo.Core` package (`runtimes/win-x64|win-arm64/native`, statically linked CRT). There is no win-x86 DLL, so the app drops x86 from its runtime identifiers.

## 0. Decisions

- **One `BoxTextView` control per canvas box**, drawing text with DirectWrite through **Win2D** (`CanvasControl` + one `CanvasTextLayout` per line-table line), with a thin overlay of XAML for interactive chrome. It replaces `PageView.Box` and its `TextBlock`s.
- **Input is `CoreTextEditContext`** over the single view string (EDITOR 10.1). No hidden `RichEditBox`.
- **One `ViewRender` per frame**, skipped when `revision` hasn't moved, relaid out only when `text_revision` or the width moved.
- Drawing marks, atoms, tables and toggles needs data the line table lacks (section 11: R1-R5). R1 gates the step.

## 1. Control structure

### 1.1 Options

| Option | Look | Geometry for IME, hit test, UIA | Verdict |
|---|---|---|---|
| **A. Win2D `CanvasTextLayout` in a `CanvasControl`** | Same engine as the shell's `TextBlock`s (DirectWrite, Segoe UI), but we set every metric: uniform line pitch (27.2, 36.4, 29.16), tracking per range, weight/colour/underline/strike per range; rounded backgrounds (inline code, mention pill, comment anchor) drawn under the text from `GetCharacterRegions`; atoms as inline objects. | `HitTest`, `GetCaretPosition`, `GetCharacterRegions`, line metrics: all that `LayoutRequested`, pointer input and UIA bounding rectangles need. | **Chosen** |
| B. `RichTextBlock`/`TextBlock` per line, rebuilt from the line table | Plain text matches; a `Run` has no rounded background, no 2 pt comment underline, no exact per-range spacing; an atom as `InlineUIContainer` doesn't map to one UTF-16 unit. | Caret and selection geometry across many elements has to be stitched (`TextPointer` rects only for arranged elements). Rebuilding hundreds of elements per keystroke flickers and moves the IME candidate window. | Rejected |
| C. Hidden `RichEditBox` as input sink, drawing elsewhere | Drawing is ours anyway. | A second document that isn't the engine's: two sources of truth for text, selection, undo and autocorrect; its own formatting and clipboard to disable; IME UI appears at the mirror unless layout is faked. `CoreTextEditContext` is the same TSF document without the editor. | Rejected |

"Matching today's look exactly" is the rule, and LOOK 2.3 is specified in CSS terms (27.2 line at 16 pt, tracking -0.02 em, rounded `--bg-hover` code) that only a per-range layout we drive reproduces. XAML text is DirectWrite too, so glyph shapes and fallback stay identical to the rest of the shell. Cost: the Win2D package (`Microsoft.Graphics.Win2D`, WinUI 3, x64 and ARM64), our own block layout, our own UIA peer. Segoe UI has no 500/650: use Medium/Semibold as the shell does.

### 1.2 Visual tree

```
BoxTextView : Control                  // per canvas box; owns session, edit context, focus
 `- Border                              // chrome LOOK 4.5.2: idle/hover/editing/selected, radius 6, padding 6 10
     `- Grid
         |- CanvasControl  Text         // text, backgrounds, quote bars, rules, borders, selection, caret, remote cursors
         |- Canvas  Chrome              // XAML placed from the layout: task rows, checkboxes, toggle triangle,
         |                              // callout emoji, code header (language, Copy), file cards, images, table frames
         `- Popup  Menu                 // slash / [[ / @ (3.3)
```

Text, carets and highlights redraw constantly and want one draw call. Interactive chrome needs focus, hover, tooltips and automation, so it stays XAML (existing `TaskParts`, `Icon`). Chrome elements are keyed by `task_id` or line index+kind and moved, not rebuilt.

### 1.3 Block layout

`BlockLayout` turns `ViewRender.View.Lines` into per-line rectangles when `text_revision` or width changes.

```csharp
sealed class LineLayout { ViewLine Line; double X, Y, Height, TextX; CanvasTextLayout? Text; }
// indent from Containers: list 1.6 em, blockquote 3 pt bar + 1 em, callout 12+28+10, toggle 2 (+24 summary),
//   taskRef notes 26 + 10 + 2 pt guide, table cell padding
// vertical margins collapse CSS-style: 0.4 em (6.4) between top-level blocks, heading margins from LOOK 2.3
// Text = new CanvasTextLayout(dev, View.Text[line.Offset..+Len], fmt, width - indent, float.MaxValue)
//   fmt: Segoe UI, size by kind/level, LineSpacingMode.Uniform + exact spacing/baseline; runs from ViewLine.Runs (R1)
```
Rects, hit tests, `LayoutRequested` and UIA read this table; the session is never asked for geometry. Start by rebuilding all lines on `text_revision`; diff per line (offset, len, run hash) only if a profile asks. A selection or blink change only calls `Invalidate()`.

## 2. CoreTextEditContext wiring

One context per `BoxTextView`, created on first focus: `ctx = CoreTextServicesManager.GetForCurrentView().CreateEditContext(); ctx.InputScope = CoreTextInputScope.Text; ctx.InputPaneDisplayPolicy = CoreTextInputPaneDisplayPolicy.Manual;`. State, UI thread only:

```csharp
ViewRender R;           // last frame; handlers read it, never the core, for TextRequested/SelectionRequested
bool composing; string compText; int compStart;
bool inPlatformCall;    // true inside TextUpdating/SelectionUpdating: no Notify* from there
List<ImeSpan> imeSpans; // from FormatUpdating
bool backward;          // selection direction (CoreTextRange is always ordered)
```

### 2.1 Events

| Event | Handler |
|---|---|
| `TextRequested(Range)` | `Request.Text = R.View.Text[clamp(start)..clamp(end)]`. The composition is part of the view text (the engine shows marked text in place). |
| `SelectionRequested` | `min(anchor,head)..max(anchor,head)` of `R.View.Selection`; while `R.View.Marked` is set and TSF is inside it, `Marked.SelFrom..SelTo`. |
| `SelectionUpdating(Selection)` | Not composing: `session.SetViewSelection(a, h)` (core selects the node for one U+FFFC, moves a caret off an object line). Composing: `session.SetComposition(compText, s - compStart, e - compStart)` so the selection inside the marked text follows. `Result = Succeeded`. |
| `TextUpdating(Range, Text, NewSelection)` | 2.2. |
| `FormatUpdating(Range, underline, colours)` | Store spans in `imeSpans` for the canvas (single / dotted / thick underline; the converted clause is thick). Never touches the core. `Result = Succeeded`. |
| `CompositionStarted` | `composing = true; compText = ""; compStart = selection start`. No core call (the engine's composition starts with the first `SetComposition`, EDITOR 10.6). |
| `CompositionCompleted` | Non-empty `compText` or unknown: `session.FinishComposition()`. If the IME ended with an empty string (Esc), `CancelComposition()`. Clear `composing`, `imeSpans`; render. |
| `LayoutRequested` | 2.4. |
| `FocusRemoved` | System took the context away: `FinishComposition()` if marked text exists; stop drawing the caret. Don't call `NotifyFocusLeave` in reply. |
| `NotifyFocusEnter` / `NotifyFocusLeave` (ours) | Enter in `GotFocus` (also after a pointer press focuses the box). Leave in `LostFocus`, after `FinishComposition()`; also when focus moves to a task title field. |
| `InputPaneDisplayPolicy` | `Manual`. Touch focus (`FocusState.Pointer` from a touch pointer, or `KeyboardCapabilities.KeyboardPresent == 0`): `InputPane.GetForCurrentView().TryShow()`; `TryHide()` when the box loses focus. Mouse/pen with a hardware keyboard: leave the pane alone. On `InputPane.Showing`, scroll the page so the caret rect clears `OccludedRect` by 24 DIP and call `NotifyLayoutChanged`. |

### 2.2 `TextUpdating`

Ranges and selections are UTF-16 view offsets, WinRT's own unit: no conversion.

```csharp
void OnTextUpdating(CoreTextEditContext c, CoreTextTextUpdatingEventArgs a) {
  inPlatformCall = true;
  try {
    var (r, t, sel) = (a.Range, a.Text, a.NewSelection);
    if (composing && InsideComposition(r)) {
      compText = Splice(compText, r.Start - compStart, r.End - compStart, t);
      session.SetComposition(compText, sel.Start - compStart, sel.End - compStart);
    } else {
      if (composing) { session.FinishComposition(); composing = false; }   // range outside the marked text (reconversion)
      var (s0, s1) = SelRange(R.View.Selection);
      bool atSel = r.Start == s0 && r.End == s1;
      if (atSel && (t == "\r" || t == "\n")) session.Key("Enter");           // EDITOR 10.2 keys in disguise
      else if (atSel && t == "\t")            session.Key("Tab");
      else if (t.Length == 0 && s0 == s1 && r.End == s0 && r.Start == s0 - 1 && !char.IsLowSurrogate(R.View.Text[s0 - 1]))
                                              session.Key("Backspace");
      else if (atSel)                         session.InsertText(t);          // rules run
      else if (!session.ReplaceViewRange(r.Start, r.End, t)) { a.Result = CoreTextTextUpdatingResult.Failed; return; }
      var now = session.ViewSelection();                                      // engine may have moved the caret by a rule
      if (!EngineMovedCaretByRule(now) && (now.Anchor, now.Head) != (sel.Start, sel.End))
        session.SetViewSelection(sel.Start, sel.End);
    }
    a.Result = CoreTextTextUpdatingResult.Succeeded;
  } finally { inPlatformCall = false; }
  RenderNow();                    // read ViewRender, relayout, Invalidate; no Notify*
}
```
- **TextUpdating away from the caret** is routine on Windows: autocorrect rewriting the previous word, dictation (Win+H) revising text it inserted earlier, the emoji panel replacing `:)`, predictions, reconversion of committed text. All go to `ReplaceViewRange` (no input rules, marks of the first replaced character, own undo step) and then `NewSelection`. A refused range (ends not in text) answers `Failed` so TSF re-reads via `TextRequested` instead of desyncing.
- Deleting one code unit is `Backspace` only when it isn't half a surrogate pair; an emoji deletion is a two-unit `ReplaceViewRange`.
- If `ReplaceViewRange` changed lines (text became a list item through `InsertText`), `RenderNow` reads the new table before TSF's next `TextRequested`.

### 2.3 When to call `Notify*`

Tell TSF about changes the platform didn't make itself; never from inside `TextUpdating`/`SelectionUpdating` (EDITOR 10.2).

```csharp
void AfterRender(ViewRender prev, ViewRender next) {       // called after every RenderNow() outside a platform call
  if (next.Revision == prev.Revision) return;              // skip the frame
  Invalidate();                                            // caret, selection, remote cursors, blink phase reset
  if (next.TextRevision != prev.TextRevision) {            // ribbon command, chord, undo/redo, paste, remote edit
    var (start, oldEnd, newLen) = DiffRange(prev.View.Text, next.View.Text);   // common prefix/suffix, UTF-16
    ctx.NotifyTextChanged(new CoreTextRange{StartCaretPosition=start, EndCaretPosition=oldEnd}, newLen, Sel(next));
    if (prev.View.Marked != null && next.View.Marked == null && composing) { composing = false;
      ctx.NotifyFocusLeave(); ctx.NotifyFocusEnter(); }    // engine dropped the composition (undo, remote edit): restart TSF
    ctx.NotifyLayoutChanged();
  } else if (next.View.Selection != prev.View.Selection) { // arrows, our pointer code, SetViewSelection
    ctx.NotifySelectionChanged(Sel(next)); ctx.NotifyLayoutChanged();
  }                                                        // only remote cursors / can_undo changed: no Notify*
}
```
Also `NotifyLayoutChanged` on box move or resize, page scroll, DPI change and `InputPane` showing. `inPlatformCall` suppresses all of it, because the IME knows about its own edits.

### 2.4 `LayoutRequested`

```csharp
var rects = layout.RectsForRange(range.Start, range.End);     // GetCharacterRegions per line; a caret gives a zero-width line-height rect
req.LayoutBounds.TextBounds    = ToScreen(Union(rects));      // during composition: the marked range, so the candidate window hugs it
req.LayoutBounds.ControlBounds = ToScreen(contentRect);
```
`ToScreen`: `TransformToVisual(null)`, times `XamlRoot.RasterizationScale`, plus the client origin and `AppWindow.Position` (the edit context wants physical screen coordinates).

## 3. Keys, commands, menus

### 3.1 KeyDown

`KeyDown` and `PreviewKeyDown` (Tab and Enter, which XAML would use for focus navigation) on the box:
```csharp
string? ChordOf(VirtualKey k) {
  bool ctrl = Down(Control) && !AltGr(), alt = Down(Menu) && !AltGr(), shift = Down(Shift);
  var name = Name(k);                        // Enter Backspace Delete Tab Escape ArrowUp/Down a..z ...
  bool editing = name is "Enter" or "Backspace" or "Delete" or "Tab" or "Escape";
  if (!ctrl && !alt && !editing && !EngineArrow(name, shift)) return null;   // text arrives through TextUpdating, never as chords
  return (ctrl ? "Mod+" : "") + (alt ? "Alt+" : "") + (shift ? "Shift+" : "") + name;
}
```
- Mod = Ctrl. AltGr (reported as Ctrl+Alt) with a printable key is text, not a chord.
- While `composing`, leave the event unhandled so the IME gets Enter, arrows and Esc first. Otherwise `if (session.Key(chord)) { e.Handled = true; RenderNow(); }`; `false` lets Tab move focus to the next box.
- Caret movement the engine doesn't own (Left/Right/Home/End/PageUp/Down, Ctrl+arrows, with Shift) is done by the view from the layout (caret positions with a sticky x for Up/Down, `SelectableWordsSegmenter` for word moves, visual line edges for Home/End) then `SetViewSelection`.
- `Mod+a` goes to `key()`; undo/clipboard are 4 and 5.

### 3.2 Ribbon

Ribbon buttons set `AllowFocusOnInteraction=false` and `IsTabStop=false` so the box keeps focus (and the IME) and call `focusedBox.Command(name, argsJson)`: `("toggleMark", {"mark":"bold"})`, `("setHeading", {"level":1})`, `("insertTask", {"title": selectedText})`, list, link, colour, highlight and checklist commands by their `nv_editor::command` names (R11). Pressed state needs R2.

### 3.3 Slash, `[[` and `@`

`R.Suggestion != null` opens a non-focusable `Popup` (LOOK 4.7: 290 wide, max 320, radius 12, `--bg-elevated`, `--shadow-lg`) 6 pt below the caret line at `CaretRect(Suggestion.ViewFrom)` (above if no room), re-anchored on every frame (scroll, wrapping).
- **Slash**: rows from `Items` (Lucide `Icon`), highlight from `Highlighted`. ArrowUp/Down/Enter/Tab/Escape go to `session.Key` (the engine moves, picks, closes). Click: `Command("pickSlash", {"title": item.Id})`; taps may use `MoveSuggestionHighlight`/`PickSuggestion`/`DismissSuggestion`.
- **`[[` and `@`**: the app lists pages or people, keeps its own highlight (wrap; back to top when `Query` changes), consumes ArrowUp/Down/Enter/Tab while open, picks with `Command("pickPage", {"pageId":..})` / `("pickMention", {"id":..,"label":..})`; Escape goes to `key()`.
- Typing continues through TextUpdating; the query is `Suggestion.Query`.

## 4. Clipboard

Ctrl+C/X/V, the ribbon and the context menu (Cut, Copy, Paste; LOOK 4.5.2) are handled by the control, not `key()`.
```csharp
void CopyCut(bool cut) {
  var d = cut ? session.Cut() : session.Copy();                       // ClipboardData { Html, Text }
  if (d.Text.Length == 0 && d.Html.Length == 0) return;
  var p = new DataPackage { RequestedOperation = cut ? DataPackageOperation.Move : DataPackageOperation.Copy };
  p.SetText(d.Text);
  p.SetHtmlFormat(HtmlFormatHelper.CreateHtmlFormat(d.Html));         // CF_HTML header + <!--StartFragment-->...<!--EndFragment-->
  Clipboard.SetContent(p); Clipboard.Flush();                         // Flush: survives closing the app
  RenderNow();
}
async Task Paste(bool plain) {
  var v = Clipboard.GetContent(); string html = "", text = "";
  if (!plain && v.Contains(StandardDataFormats.Html)) html = HtmlFormatHelper.GetStaticFragment(await v.GetHtmlFormatAsync());
  if (v.Contains(StandardDataFormats.Text)) text = await v.GetTextAsync();
  if (composing) session.FinishComposition();
  session.Paste(html, text); RenderNow();                             // re-read state after the awaits; one undo step
}
```
Images and files on the clipboard are the page's attachment flow, not this control (R8). Ctrl+Shift+V pastes plain text.

## 5. Undo

Ctrl+Z calls `session.Undo()`; Ctrl+Y and Ctrl+Shift+Z call `Redo()`. Each returns a bool, then `RenderNow()` and `AfterRender` (undo is not a platform call, so `NotifyTextChanged` fires). Ribbon Undo/Redo bind `IsEnabled` to `R.CanUndo/CanRedo` of the focused box, refreshed on every `revision` change. Typing groups in 500 ms windows in the engine. Only this session's edits undo, not remote ones. `CoreTextEditContext` has no undo stack of its own.

## 6. Rendering

Draw order in `CanvasControl.Draw`: (1) box fill when editing; (2) block decorations (quote bars, callout and code fills with 1 pt `--border`, table frames, rules, task-notes guides); (3) backgrounds under text; (4) selection; (5) text, list markers, atoms; (6) IME underlines, remote cursors, caret. Colours come from the existing token brushes through a `Palette` of `Color`s, refreshed on `ActualThemeChanged`; high contrast uses system colours.

- **Text and marks** (LOOK 2.3): 16/27.2 `--text`; h1 28/36.4 700 tracking -0.02 em, margins 33.6/8.4 (0 top when first); h2 21.6/29.16 700 -0.01 em, 23.76/5.4; h3 17.9/27.2 700; block gap 6.4. Bold, italic, underline, strike, link (`--accent`, underline), text colour and highlight (LOOK 1.5), inline code (Cascadia Mono, Consolas fallback, 0.88 em, `--bg-hover`, radius 4, padding 1x5), comment anchor (`rgba(250,204,21,.28)` + 2 pt `rgba(234,179,8,.8)` bottom; active .55). Per-range from R1.
- **Lists and checklists**: `ViewLine.Marker` drawn right-aligned in the 1.6 em gutter on the first line's baseline. `Checked != null`: no marker, a 15x15 accent checkbox (XAML) 0.2 em down; tapping toggles by command; checked text `--text-muted` + strike.
- **Task lines** (LOOK 2.4): `Kind == "taskRef"` with `TaskId` is an object line, drawn as `TaskRowChrome` XAML (circle, chips, avatar, Add checklist, open; reusing `TaskParts`): min height 36, padding 3 6 3 4, 26 pt hanging margin, hover `--bg-subtle`, selected (node selection covering its U+FFFC) `--accent-soft`. Title and meta come from the task store (`TaskCallbacks.Title`), edited in the row's own inline field (R6). Lines with `taskRef` in `Containers` are its notes: indent 26 + 10 and a 2 pt `--border` guide (dashed when done). Missing task: FileX2 + LOOK message + "Remove from page".
- **Code block**: fill and border around its lines, padding 34 top / 14 / 12, mono 13.5; XAML language picker (12 `--text-2`) and Copy (hover or touch). **Callout**: radius 8, padding 12 14 12 12, 28x28 emoji button, body indented 38. **Toggle**: 24x27 triangle button (rotates 90 degrees), summary 500. **Table**: equal fixed columns, cells 1 pt `--border`, padding 6 10, header `--bg-subtle` 600, row height = tallest cell. The last three need R4/R5.
- **Atoms (U+FFFC)**: inline ones (mention, page link, inline image) as `ICanvasTextInlineObject`: mention pill (`--accent-soft`, 500; yourself yellow), page link (emoji + title, 500, 1 pt `--border-strong` bottom, muted if missing), image scaled. Block atoms are object lines: image (`CanvasBitmap`, radius 8, 2 pt accent outline when selected, 5x44 resize bars), file card (XAML, LOOK 2.3), rule (1 pt `--border`, 1.4 em margins). Needs R3.
- **Caret**: 1.5 DIP `--text`, line height, from `GetCaretPosition(Head)`. Blink with a `DispatcherQueueTimer` at `UISettings.CaretBlinkRate` (0 or negative: solid); phase resets on every `revision` change; stopped when unfocused, when the selection is a range, or when the app is hidden, so idle cost is zero.
- **Selection**: fill from `GetCharacterRegions` per line, extended to the content edge on lines fully inside, radius 2, colour = LOOK's selection token if it has one, else accent at 25% over `--bg` (open question b). Drawn only while the box is focused. Node selection uses the node's own selected style.
- **Remote cursors** (`R.RemoteCursors`): 2 DIP caret and 40% alpha range in the user's colour (stable hash of `UserId` into the accent palette), a name flag (11 pt, white, radius 4) fading after 3 s idle. Not hit-testable and not in UIA.

## 7. Live sessions and threading

```csharp
var session = EditorSession.OpenLive(livePage, $"box:{box.Id}", new TaskStore(...));   // after Synced
```
- `LivePageListener.OnChange` runs on the core's sync thread. It touches nothing but a flag: `if (Interlocked.Exchange(ref pending, 1) == 0) dispatcher.TryEnqueue(() => { pending = 0; box.OnRemoteChange(); })`. `OnRemoteChange` calls `RenderNow()` then `AfterRender`, so `NotifyTextChanged` fires when `text_revision` moved. Remote cursors and `can_undo` changes only repaint.
- The session serialises its own calls with an internal mutex, so UI-thread calls are safe beside sync threads. Rules: **call the session only from the UI thread** (we hold `R` and layouts there); **never call the session from `TaskCallbacks`** (called on the session's thread with it locked: deadlock) and queue any follow-up with `TryEnqueue`; keep `TaskCallbacks` quick.
- A remote edit under a composition makes core drop it; `AfterRender` restarts the TSF context (2.3).
- Dispose the session on box removal, navigation and window close. Closing the `LivePage` stays with the page's owner. Layout of a very long box stays on the UI thread; the per-line diff in 1.3 is the first optimisation if profiling asks.

## 8. Accessibility (UI Automation)

`BoxTextAutomationPeer : FrameworkElementAutomationPeer, ITextProvider` (`ControlType.Document`, keyboard focusable, `Text` pattern) over `R.View.Text`; `BoxTextRange : ITextRangeProvider` holds `(start, end)` on a snapshot of `R`.
- `DocumentRange` = `0..Len`; `GetSelection` = selection or a degenerate caret range; `GetVisibleRanges` = lines in the scroller viewport; `RangeFromPoint` uses `HitOffset`; `RangeFromChild` maps a chrome element to its line.
- Ranges: `GetText(max)` slices (U+FFFC read as the atom's label from R3, "object" until then); `Move`, `MoveEndpointByUnit`, `ExpandToEnclosingUnit` for Character (grapheme clusters via `StringInfo`), Word (`SelectableWordsSegmenter`), Line (layout lines), Paragraph (`ViewLine`), Document; `Compare`, `CompareEndpoints`, `Clone`, `FindText`; `Select()` = `SetViewSelection`; `ScrollIntoView`; `GetBoundingRectangles` from the layout in screen pixels; `GetAttributeValue` for font, weight, italic, underline, strike, colours, heading style (`StyleId_Heading1-3`), bullets (from R1).
- After `NotifyTextChanged` raise `TextPatternOnTextChanged`, and `TextPatternOnTextSelectionChanged` when the selection moved, so Narrator reads typed text and caret moves.
- Chrome has its own peers (checkbox "Mark done", task title field, toggle "Expand"), exposed as children in line order.

## 9. Hit testing and pointer

```csharp
int HitOffset(Point p) {                                   // control DIPs -> view offset
  var l = LineAtY(p.Y);                                    // nearest line, clamped to first/last
  if (!l.Line.IsText) return l.Line.Offset + (p.X > l.Mid ? 1 : 0);        // before or after the U+FFFC
  var h = l.Text.HitTest((float)(p.X - l.TextX), (float)(p.Y - l.Y));
  return l.Line.Offset + h.CharacterIndex + (h.IsTrailing ? h.Length : 0);
}
```
- **Click or pen**: `Focus(Pointer)`, `FinishComposition()` if composing, `SetViewSelection(o, o)`. Shift-click `SetViewSelection(anchor, o)`. A click on an object line's U+FFFC selects the node (`SetViewSelection(o, o+1)`). Chrome elements take their own presses and are not hit tested.
- **Double and triple click**: counted with `GetDoubleClickTime`/`GetSystemMetrics(SM_CXDOUBLECLK)`. Double = the word at the offset from `SelectableWordsSegmenter` (word only, no trailing space); triple = the `ViewLine` (`Offset..Offset+Len`). Dragging after either extends by word or line.
- **Drag-select**: capture on press; on move `SetViewSelection(anchor, HitOffset(p))`, at most once per frame; autoscroll the page `ScrollViewer` within 24 DIP of its edge.
- **Touch**: a tap places the caret; long-press selects a word and shows handles. Two 20 DIP teardrop handles (XAML `Popup`s, so they may leave the box) at the selection ends, dragged through `HitOffset` with the contact point 36 DIP above the finger, plus a Cut/Copy/Paste/Select all flyout above the selection. Touch must not pan boxes: only the move bar moves them (LOOK 4.5.2).
- I-beam over text lines (`ProtectedCursor` on a subclass), arrow over chrome. Right-click opens the box context menu (LOOK 4.5.2).

## 10. Testing

1. **Offset mapping, plain xunit** in the Windows CI job: pure helpers `DiffRange`, `Splice`, `ClassifyUpdate` (TextUpdating -> insert / replace / Enter / Tab / Backspace / composition), `ChordOf`, `HtmlFormat` round trip, `LineAtY`. Table-driven from `tests/editor/scenarios/input.json` (same recorded behaviour as 10.8).
2. **Scenarios through the session, no window**: load `EditorSession` from the corpus (`NV_CORPUS_DIR`, as core's xunit does) and replay `tests/editor/scenarios/*.json` through the same router the control uses (the XAML-free `UpdateRouter`), asserting `ViewRender` text, selection and marked range.
3. **UI test**: a test page hosting one `BoxTextView` over a fixture session, driven with UIA/FlaUI and `SendInput`: type, select, drag, assert through the Text pattern (this tests section 8 too); screenshot comparison against the LOOK references at 150% DPI. Local-only if the runner has no desktop session.
4. **Manual IME and input checklist** (Windows 11, x64 and ARM64 if available): Microsoft Japanese IME (hiragana to kanji, thick underline on the target clause, Space/Enter/Esc, candidate window under the marked text, reconversion); Microsoft Pinyin (digits pick candidates); Korean (jamo composition, Backspace splitting); emoji panel (Win+., search, skin tones, kaomoji); dictation (Win+H: partial results replace earlier text, "delete that"); touch keyboard (opens on tap, predictions replace words, handwriting panel, caret clears the occluded rect); autocorrect and spell-check settings; dead keys and AltGr layouts; Narrator reading while typing and by line/word; high contrast; 100/150/200% DPI and a monitor move.
5. **Perf**: typing in a 3k-line box, p95 per keystroke (call + render + layout) under 8 ms on x64.

## 11. Gaps and requests

R1-R3 gate rendering; the rest can follow.

| # | To | Request |
|---|---|---|
| **R1** | core + editor | **Formatting runs in `ViewLine`**: `runs: [ViewRun { from, len (line-relative UTF-16), marks }]`, a mark being `{ kind: bold/italic/underline/strike/code/link/textColor/highlight/comment, value: Option<String> (href, colour, thread id) }`. Today `ViewLine` has only line-level `kind`/`level`/`containers`, so bold, links and colours can't be drawn. Moves only with `text_revision`. |
| **R2** | core + editor | **Active marks and block type at the selection** in `ViewRender` (marks, heading level, list type) for ribbon pressed state. |
| **R3** | core + editor | **Atom payload**: per U+FFFC in a text line `atoms: [ViewAtom { offset, kind (mention/pageLink/image/file), label, attrs_json }]` (user id and "is me"; page id, emoji, missing; image source, size, alt). Object lines need the same `attrs_json` on `ViewLine`. For drawing, UIA labels and page-link click-through. |
| **R4** | editor | **Table coordinates** on lines: `table: Option<{row, col, rows, cols, header}>`. Containers give nesting, not a grid. |
| **R5** | editor | **Toggle open state** (`open` on the summary line, closed content omitted from lines or marked hidden, a toggle command), and **callout emoji** and **code language** (covered by `attrs_json`). |
| **R6** | core | **Task-title editing**: say what `ViewRender` describes while `focus_task_id` is set (its own text, selection, marked range in title offsets) or add a per-task render, so the title field can have its own `CoreTextEditContext`. |
| **R7** | core | **Cheap frames**: `ViewRender` returns the whole line table; at 5k lines a marshal per keystroke dominates. Let it return the line table only when `text_revision` moved (split `ViewState` into text/lines and selection/marked, or an `Option`), and keep `Revision()` cheap in C#. Keep anchor/head direction in `ViewRange`. |
| **R8** | core | Non-text paste (`paste` takes HTML and text only): a file/image attach path on the page and an `insertImage`/`insertFile` command. Not this control; listed for completeness. |
| **R9** | editor | `move_range(from, to, dest)` as one undo step for drag-moving selected text (later). |
| **R10** | editor | `set_comment` / `unset_comment` (already asked in `core.md`) and the comment thread id at a view offset for click-through. |
| **R11** | editor | The full command-name and argument table (toggleMark, setHeading, lists, link, colour, highlight, toggle checklist, code language, toggleOpen, table ops) documented in `nv_editor::command`; this doc only gives examples. |
| **R12** | core build | Make `nv_core.dll` + `Notivelo.Core` restorable by the app's CI (artifact from `windows-core.yml` or a feed); the app csproj lists `win-x64;win-arm64` only. |

Open questions: (a) Win2D as a dependency (planned; the alternative is raw DirectWrite via a COM wrapper, much more code); (b) selection colour on Windows: LOOK token or `SystemAccentColor`; (c) caret blink: system rate (planned) or the web's fixed rate; (d) touch handles: ours (planned; a custom control can't use the system ones).

## 12. Order of work

1. Core references and R12 (with the `INotesSource` over the core, a separate step).
2. `BoxTextView` with plain text: layout from `ViewRender`, caret, selection, `KeyDown` to `key()`, the `UpdateRouter` and its unit tests.
3. Full `CoreTextEditContext` wiring and the IME checklist, clipboard, undo.
4. Runs and marks (R1), headings, lists, code, quote, callout.
5. Task rows, atoms, tables, toggles (R3-R5).
6. Menus, touch handles, remote cursors, UIA.
