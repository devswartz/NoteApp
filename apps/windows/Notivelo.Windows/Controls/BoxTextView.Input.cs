using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Graphics.Canvas;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Icons;
using Notivelo.Windows.Text;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;
using Windows.UI;
using Windows.UI.Text.Core;
using N = Notivelo.Native;
using VirtualKey = Windows.System.VirtualKey;
using UnderlineType = Windows.UI.Text.UnderlineType;

namespace Notivelo.Windows.Controls;

/// <summary>Input for the box view (docs/rewrite/WINDOWS-TEXT-VIEW.md 2, 3, 4, 5, 9): focus, caret and selection from the pointer, the text services
/// (<c>CoreTextEditContext</c>) for typing and IME, keys, clipboard, the slash and [[ and @ menus. The session is only called from the UI thread.</summary>
internal sealed partial class BoxTextView
{
    // ---- state ------------------------------------------------------------------------------------------------------

    private CoreTextEditContext? _ctx;
    private bool _ctxFailed;
    private bool _focused;
    private bool _composing;
    private bool _inPlatformCall;
    private List<ImeSpan> _ime = new();
    private DispatcherQueueTimer? _blink;
    private bool _caretOn = true;
    private double _stickyX = -1;
    private Popup? _menu;
    private string _menuSig = "";
    private int _appHi;
    private string _appQuery = "";
    private List<(string Id, string Label, string Desc)> _appItems = new();
    private DispatcherQueue? _dq;

    private sealed record ImeSpan(int Start, int End, UnderlineType Type, bool Thick);

    /// <summary>The box that has the keyboard, for the ribbon.</summary>
    public static BoxTextView? Focused { get; private set; }

    /// <summary>The box that had the keyboard last (kept while a ribbon flyout menu holds focus), or null once it is unloaded.</summary>
    public static BoxTextView? LastFocused { get; private set; }

    /// <summary>The box a ribbon command acts on: the focused one, or the one a menu just took focus from.</summary>
    public static BoxTextView? Target => Focused ?? (LastFocused is { IsLoaded: true } l ? l : null);

    /// <summary>Raised when the focused box changes, or its marks, block type or undo state do.</summary>
    public static event Action? FocusedStateChanged;

    /// <summary>Escape left a box: the page selects the box as a whole (OneNote: Esc inside a box selects it).</summary>
    public static event Action<BoxTextView>? Escaped;

    /// <summary>Set once by the main window: the screen position of the client area is taken from it for the IME's candidate window.</summary>
    public static IntPtr WindowHandle { get; set; }

    /// <summary>The page the box is on, for the tasks it creates.</summary>
    public string? PageId { get; set; }

    public bool IsFocused => _focused;
    public N.ViewRender? Current => _r;
    public bool CanUndo => _r?.CanUndo ?? false;
    public bool CanRedo => _r?.CanRedo ?? false;
    public N.ViewActive? Active => _r?.Active;

    private bool Interactive => !_disposed && _r is not null;

    private void InitInput()
    {
        _dq = DispatcherQueue.GetForCurrentThread();
        IsTabStop = true;
        UseSystemFocusVisuals = false;
        AllowFocusOnInteraction = true;
        _root.Background = new SolidColorBrush(Colors.Transparent);
        ProtectedCursor = InputSystemCursor.Create(InputSystemCursorShape.IBeam);
        GotFocus += (_, _) => OnGotFocus();
        LostFocus += (_, _) => OnLostFocus();
        _root.PointerPressed += OnPointerPressed;
        _root.PointerMoved += OnPointerMoved;
        _root.PointerReleased += OnPointerReleased;
        _root.PointerCaptureLost += (_, _) => { _dragging = false; _rz = null; };
        CharacterReceived += OnCharacter;
        Unloaded += (_, _) => { StopBlink(); HideMenu(); HideFloatingBar(); if (LastFocused == this) LastFocused = null; if (Focused == this) { Focused = null; FocusedStateChanged?.Invoke(); } };
        SizeChanged += (_, _) => NotifyLayout();
    }

    // ---- focus and the caret --------------------------------------------------------------------------------------------

    /// <summary>The box was left (Escape, a click on the page, or another box taking the keyboard): the page removes it when it is empty.
    /// Not raised when focus only moves to the link editor or the ribbon.</summary>
    public event Action? Left;
    private static BoxTextView? _lastEdited;

    /// <summary>A click on the page outside every box.</summary>
    public static void LeaveEditing()
    {
        var b = _lastEdited; _lastEdited = null;
        b?.Left?.Invoke();
    }

    private void OnGotFocus()
    {
        Trace("got focus interactive=" + Interactive);
        if (!Interactive) return;
        if (_lastEdited is { } prev && !ReferenceEquals(prev, this)) prev.Left?.Invoke();
        _lastEdited = this;
        _focused = true;
        Focused = this; LastFocused = this;
        EnsureContext();
        try { _ctx?.NotifyFocusEnter(); } catch (Exception e) { Log("focus enter", e); }
        ResetBlink();
        UpdateMenu();
        _canvas.Invalidate();
        FocusedStateChanged?.Invoke();
    }

    private void OnLostFocus()
    {
        if (!_focused) return;
        // the ribbon's popups and the box's own menu take focus without ending the edit; a real loss commits the composition
        _focused = false;
        try { if (_r?.View.Marked is not null) { _session.FinishComposition(); } } catch (Exception e) { Log("finish composition", e); }
        _composing = false; _ime.Clear();
        try { _ctx?.NotifyFocusLeave(); } catch { }
        StopBlink();
        HideMenu();
        Render();
        _canvas.Invalidate();
        ClearLocalCaret();
        if (Focused == this) { Focused = null; FocusedStateChanged?.Invoke(); }
    }

    /// <summary>Escape or a click outside: give the keyboard to the page.</summary>
    public void Unfocus()
    {
        if (ReferenceEquals(_lastEdited, this)) _lastEdited = null;
        HideLinkEditor(false);
        Left?.Invoke();
        DependencyObject? p = this;
        while (p is not null)
        {
            p = VisualTreeHelper.GetParent(p);
            if (p is ScrollViewer sv) { sv.IsTabStop = true; sv.Focus(FocusState.Programmatic); return; }
        }
        FocusManager.TryMoveFocus(FocusNavigationDirection.Next);
    }

    private void StartBlink()
    {
        if (_blink is null)
        {
            _blink = (_dq ?? DispatcherQueue.GetForCurrentThread()).CreateTimer();
            _blink.IsRepeating = true;
            _blink.Tick += (_, _) => { _caretOn = !_caretOn; _canvas.Invalidate(); };
        }
        var ms = 530;
        try
        {
            var ui = new global::Windows.UI.ViewManagement.UISettings();
            var rate = ui.CaretBlinkRate;           // 0 (or the system's "never") means a solid caret
            ms = rate == 0 || rate > 10000 ? 0 : (int)rate;
        }
        catch { }
        if (ms <= 0) { _blink.Stop(); return; }
        _blink.Interval = TimeSpan.FromMilliseconds(ms);
        _blink.Start();
    }

    private void StopBlink() { _blink?.Stop(); _caretOn = true; }

    /// <summary>The caret is solid while something changes, and blinks only for a collapsed selection in a focused box.</summary>
    private void ResetBlink()
    {
        _caretOn = true;
        var collapsed = _r is { } r && r.View.Selection.Anchor == r.View.Selection.Head;
        if (_focused && collapsed) StartBlink(); else StopBlink();
    }

    // ---- after every render -----------------------------------------------------------------------------------------------

    private void AfterRender(N.ViewRender? prev, N.ViewRender next)
    {
        if (_focused) ResetBlink();
        if (_focused) SendLocalCaret(next);
        UpdateMenu();
        UpdateFloatingBar();
        if (_focused || ReferenceEquals(Focused, this)) FocusedStateChanged?.Invoke();
        if (_ctx is null || _inPlatformCall || !_focused || prev is null) return;
        try
        {
            if (next.TextRevision != prev.TextRevision)
            {
                var (start, oldEnd, newLen) = InputMap.DiffRange(prev.View.Text, next.View.Text);
                _ctx.NotifyTextChanged(new CoreTextRange { StartCaretPosition = start, EndCaretPosition = oldEnd }, newLen, SelOf(next));
                if (prev.View.Marked is not null && next.View.Marked is null && _composing)
                {
                    // the engine dropped the composition (undo, a remote edit): start the text services afresh
                    _composing = false; _ime.Clear();
                    _ctx.NotifyFocusLeave(); _ctx.NotifyFocusEnter();
                }
                _ctx.NotifyLayoutChanged();
            }
            else if (next.View.Selection != prev.View.Selection)
            {
                _ctx.NotifySelectionChanged(SelOf(next));
                _ctx.NotifyLayoutChanged();
            }
        }
        catch (Exception e) { Log("notify", e); }
    }

    private static CoreTextRange SelOf(N.ViewRender r)
    {
        var s = r.View.Selection;
        return new CoreTextRange { StartCaretPosition = (int)Math.Min(s.Anchor, s.Head), EndCaretPosition = (int)Math.Max(s.Anchor, s.Head) };
    }

    private void NotifyLayout() { if (_focused && !_inPlatformCall) try { _ctx?.NotifyLayoutChanged(); } catch { } }

    // ---- the text services ----------------------------------------------------------------------------------------------------

    private void EnsureContext()
    {
        if (_ctx is not null || _ctxFailed) return;
        try
        {
            var mgr = CoreTextServicesManager.GetForCurrentView();
            var c = mgr.CreateEditContext();
            c.InputScope = CoreTextInputScope.Text;
            c.InputPaneDisplayPolicy = CoreTextInputPaneDisplayPolicy.Automatic;
            c.TextRequested += (_, a) => OnTextRequested(a);
            c.SelectionRequested += (_, a) => OnSelectionRequested(a);
            c.SelectionUpdating += (_, a) => OnSelectionUpdating(a);
            c.TextUpdating += (_, a) => OnTextUpdating(a);
            c.FormatUpdating += (_, a) => OnFormatUpdating(a);
            c.LayoutRequested += (_, a) => OnLayoutRequested(a);
            c.CompositionStarted += (_, _) => OnCompositionStarted();
            c.CompositionCompleted += (_, _) => OnCompositionCompleted();
            c.FocusRemoved += (_, _) => OnFocusRemoved();
            _ctx = c;
            Trace("text services ready");
        }
        catch (Exception e)
        {
            _ctxFailed = true;
            Log("text services (typing falls back to key characters)", e);
        }
    }

    private static int Clamp(int v, int len) => Math.Clamp(v, 0, len);

    private void OnTextRequested(CoreTextTextRequestedEventArgs a)
    {
        var t = _r?.View.Text ?? "";
        var s = Clamp(a.Request.Range.StartCaretPosition, t.Length);
        var e = Clamp(a.Request.Range.EndCaretPosition, t.Length);
        a.Request.Text = e > s ? t.Substring(s, e - s) : "";
    }

    private void OnSelectionRequested(CoreTextSelectionRequestedEventArgs a)
    {
        if (_r is not { } r) return;
        var sel = r.View.Selection;
        a.Request.Selection = new CoreTextRange { StartCaretPosition = (int)Math.Min(sel.Anchor, sel.Head), EndCaretPosition = (int)Math.Max(sel.Anchor, sel.Head) };
    }

    private void OnSelectionUpdating(CoreTextSelectionUpdatingEventArgs a)
    {
        if (!Interactive) { a.Result = CoreTextSelectionUpdatingResult.Failed; return; }
        _inPlatformCall = true;
        try
        {
            var s = a.Selection;
            if (_composing && _r!.View.Marked is { } m)
            {
                var len = (int)(m.To - m.From);
                var text = _r.View.Text.Substring((int)m.From, len);
                _session.SetComposition(text, (uint)Math.Clamp(s.StartCaretPosition - (int)m.From, 0, len), (uint)Math.Clamp(s.EndCaretPosition - (int)m.From, 0, len));
            }
            else if (!_composing)
            {
                _session.SetViewSelection((uint)s.StartCaretPosition, (uint)s.EndCaretPosition);
            }
            a.Result = CoreTextSelectionUpdatingResult.Succeeded;
            Render();
        }
        catch (Exception e) { Log("selection updating", e); a.Result = CoreTextSelectionUpdatingResult.Failed; }
        finally { _inPlatformCall = false; }
    }

    private void OnTextUpdating(CoreTextTextUpdatingEventArgs a)
    {
        _textUpdates++;
        Trace("TextUpdating \"" + a.Text + "\" interactive=" + Interactive);
        if (!Interactive) { a.Result = CoreTextTextUpdatingResult.Failed; return; }
        _inPlatformCall = true;
        try
        {
            var r = a.Range; var t = a.Text ?? ""; var sel = a.NewSelection;
            var view = _r!.View;
            var text = view.Text;
            if (_composing && InsideComposition(r))
            {
                var from = view.Marked is { } m0 ? (int)m0.From : SelFrom(view);
                var cur = view.Marked is { } m1 ? text.Substring((int)m1.From, (int)(m1.To - m1.From)) : "";
                var rs = view.Marked is null ? 0 : r.StartCaretPosition - from;
                var re = view.Marked is null ? 0 : r.EndCaretPosition - from;
                var next = InputMap.Splice(cur, rs, re, t);
                if (next.Length == 0 && view.Marked is not null) _session.CancelComposition();
                else _session.SetComposition(next, (uint)Math.Clamp(sel.StartCaretPosition - from, 0, next.Length), (uint)Math.Clamp(sel.EndCaretPosition - from, 0, next.Length));
            }
            else
            {
                if (_composing) { _session.FinishComposition(); _composing = false; _ime.Clear(); view = _session.ViewRender().View; text = view.Text; }
                var (s0, s1) = (SelFrom(view), SelTo(view));
                var kind = InputMap.ClassifyUpdate(text, s0, s1, r.StartCaretPosition, r.EndCaretPosition, t);
                var ok = true;
                switch (kind)
                {
                    case UpdateKind.Enter: _session.Key("Enter"); break;
                    case UpdateKind.Tab: _session.Key("Tab"); break;
                    case UpdateKind.Backspace: _session.Key("Backspace"); break;
                    case UpdateKind.Insert: _session.InsertText(t); break;
                    default: ok = _session.ReplaceViewRange((uint)r.StartCaretPosition, (uint)r.EndCaretPosition, t); break;
                }
                if (!ok) { a.Result = CoreTextTextUpdatingResult.Failed; return; }
                var now = _session.ViewSelection();
                // the engine may have moved the caret itself (a rule ran): then the platform's idea of it is stale and the Notify* after
                // this call (not suppressed for a rule) is what corrects it; otherwise take the IME's selection
                var wanted = (s: (uint)sel.StartCaretPosition, e: (uint)sel.EndCaretPosition);
                var moved = kind == UpdateKind.Insert && t.Length > 0 && now.Anchor == now.Head && now.Head != (uint)(Math.Min(r.StartCaretPosition, r.EndCaretPosition) + t.Length) && now.Head != wanted.e;
                if (!moved && (Math.Min(now.Anchor, now.Head), Math.Max(now.Anchor, now.Head)) != wanted)
                    _session.SetViewSelection(wanted.s, wanted.e);
            }
            a.Result = CoreTextTextUpdatingResult.Succeeded;
            Render();
        }
        catch (Exception e) { Log("text updating", e); a.Result = CoreTextTextUpdatingResult.Failed; }
        finally { _inPlatformCall = false; }
    }

    private static int SelFrom(N.ViewState v) => (int)Math.Min(v.Selection.Anchor, v.Selection.Head);
    private static int SelTo(N.ViewState v) => (int)Math.Max(v.Selection.Anchor, v.Selection.Head);

    private bool InsideComposition(CoreTextRange r)
    {
        var v = _r!.View;
        if (v.Marked is { } m) return r.StartCaretPosition >= (int)m.From && r.EndCaretPosition <= (int)m.To;
        return r.StartCaretPosition == SelFrom(v) && r.EndCaretPosition == SelTo(v);
    }

    private void OnFormatUpdating(CoreTextFormatUpdatingEventArgs a)
    {
        try
        {
            var type = a.UnderlineType ?? UnderlineType.None;
            var thick = a.Reason is CoreTextFormatUpdatingReason.CompositionTargetConverted or CoreTextFormatUpdatingReason.CompositionTargetUnconverted;
            _ime.RemoveAll(s => s.Start < a.Range.EndCaretPosition && s.End > a.Range.StartCaretPosition);
            if (type != UnderlineType.None) _ime.Add(new ImeSpan(a.Range.StartCaretPosition, a.Range.EndCaretPosition, type, thick));
            a.Result = CoreTextFormatUpdatingResult.Succeeded;
            _canvas.Invalidate();
        }
        catch (Exception e) { Log("format updating", e); }
    }

    private void OnCompositionStarted()
    {
        _composing = true;
        _ime.Clear();
    }

    private void OnCompositionCompleted()
    {
        _inPlatformCall = true;
        try
        {
            if (_r?.View.Marked is not null)
            {
                _session.FinishComposition();
            }
        }
        catch (Exception e) { Log("composition completed", e); }
        finally
        {
            _composing = false; _ime.Clear();
            Render();
            _inPlatformCall = false;
        }
    }

    private void OnFocusRemoved()
    {
        try { if (_r?.View.Marked is not null) _session.FinishComposition(); } catch { }
        _composing = false; _ime.Clear();
        Render();
    }

    private void OnLayoutRequested(CoreTextLayoutRequestedEventArgs a)
    {
        try
        {
            if (_r is not { } r) return;
            var range = a.Request.Range;
            var s = Clamp(range.StartCaretPosition, r.View.Text.Length);
            var e = Clamp(range.EndCaretPosition, r.View.Text.Length);
            if (_composing && r.View.Marked is { } m) { s = (int)m.From; e = (int)m.To; }
            var rects = RectsForRange(s, e);
            var union = rects.Count == 0 ? new Rect(0, 0, 0, 20) : rects.Aggregate(RectUnion);
            a.Request.LayoutBounds.TextBounds = ToScreen(union);
            a.Request.LayoutBounds.ControlBounds = ToScreen(new Rect(0, 0, Math.Max(1, _width), Math.Max(1, _height)));
        }
        catch (Exception e) { Log("layout requested", e); }
    }

    private static Rect RectUnion(Rect a, Rect b)
    {
        var x0 = Math.Min(a.X, b.X); var y0 = Math.Min(a.Y, b.Y);
        return new Rect(x0, y0, Math.Max(a.Right, b.Right) - x0, Math.Max(a.Bottom, b.Bottom) - y0);
    }

    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [DllImport("user32.dll")] private static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);

    /// <summary>Control DIPs to physical screen pixels (what the edit context wants).</summary>
    private Rect ToScreen(Rect r)
    {
        var scale = XamlRoot?.RasterizationScale ?? 1.0;
        var tl = TransformToVisual(null).TransformPoint(new Point(r.X, r.Y));
        var origin = new POINT();
        if (WindowHandle != IntPtr.Zero) ClientToScreen(WindowHandle, ref origin);
        return new Rect(origin.X + tl.X * scale, origin.Y + tl.Y * scale, r.Width * scale, r.Height * scale);
    }

    // ---- geometry from the layouts -----------------------------------------------------------------------------------------

    /// <summary>Rectangles (control DIPs) covering view offsets [s, e): per line fragment; a caret is a zero-width line-height rect.</summary>
    private List<Rect> RectsForRange(int s, int e)
    {
        var res = new List<Rect>();
        if (_r is not { } r) return res;
        if (s == e)
        {
            var c = CaretRect(s);
            if (c is { } cr) res.Add(new Rect(cr.X, cr.Y, 0, cr.Height));
            return res;
        }
        foreach (var b in _boxes)
        {
            if (b.Hidden) continue;
            var part = RunMap.SelectionIn(b.Line, s, e);
            if (part is null) continue;
            if (b.Text is null || !b.Line.IsText) { res.Add(new Rect(b.X, b.Y, Math.Max(20, _width - b.X), Math.Max(1, b.H))); continue; }
            var (from, to) = part.Value;
            if (to > from) foreach (var reg in b.Text.GetCharacterRegions(from, to - from)) res.Add(new Rect(b.X + reg.LayoutBounds.X, b.Y + reg.LayoutBounds.Y, reg.LayoutBounds.Width, reg.LayoutBounds.Height));
            else { var c = CaretRect((int)b.Line.Offset + from); if (c is { } cr) res.Add(new Rect(cr.X, cr.Y, 1, cr.Height)); }
        }
        return res;
    }

    /// <summary>The caret rectangle (control DIPs, line height, no width) at a view offset.</summary>
    private Rect? CaretRect(int offset)
    {
        if (_r is not { } r) return null;
        var (li, col) = RunMap.ToLine(r.View.Lines, offset);
        if (li < 0 || li >= _boxes.Count) return null;
        var b = _boxes[li];
        if (b.Text is null) return new Rect(b.X, b.Y, 0, Math.Max(1, b.H));
        var cp = b.Text.GetCaretPosition(col, false);
        return new Rect(b.X + cp.X, b.Y + cp.Y, 0, b.M.Pitch);
    }

    // ---- hit testing ---------------------------------------------------------------------------------------------------------

    /// <summary>A point in control DIPs to a view offset: the line under it (or the nearest), then DirectWrite's hit test.</summary>
    internal int HitOffset(Point p)
    {
        if (_r is not { } r || _boxes.Count == 0) return 0;
        var rects = _boxes.Select(b => (b.X, b.Y, b.W, Math.Max(1, b.H), b.Hidden || b.Line.Kind == "" || (b.Text is null && b.H <= 0))).ToList();
        var i = InputMap.NearestRect(rects, p.X, p.Y);
        if (i < 0) return 0;
        var box = _boxes[i];
        var line = box.Line;
        if (!line.IsText || box.Text is null) return InputMap.ObjectOffset((int)line.Offset, p.X, box.X, box.W);
        var y = Math.Clamp(p.Y - box.Y, 0, Math.Max(0, box.Text.LayoutBounds.Height - 1));
        var x = p.X - box.X;
        int col;
        if (line.Len == 0) col = 0;
        else if (box.Text.HitTest((float)x, (float)y, out var reg))
        {
            col = reg.CharacterIndex;
            if (x > reg.LayoutBounds.X + reg.LayoutBounds.Width / 2) col += Math.Max(1, reg.CharacterCount);
        }
        else
        {
            // outside the text: before the first or after the last character of that visual line
            col = x < 0 ? 0 : (int)line.Len;
        }
        // never inside a surrogate pair
        var t = _r.View.Text; var abs = (int)line.Offset + Math.Clamp(col, 0, (int)line.Len);
        if (abs > 0 && abs < t.Length && char.IsLowSurrogate(t[abs]) && char.IsHighSurrogate(t[abs - 1])) abs--;
        return abs;
    }

    // ---- pointer ------------------------------------------------------------------------------------------------------------

    private bool _dragging;
    private int _anchor;
    private int _unit;            // 0 characters, 1 words, 2 lines
    private Span _unitSpan;
    private ulong _lastPressMs;
    private Point _lastPressAt;
    private int _clicks;

    private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
    {
        if (!Interactive) return;
        var pt = e.GetCurrentPoint(_root);
        var right = pt.Properties.IsRightButtonPressed;
        if (!pt.Properties.IsLeftButtonPressed && !right) return;
        var wasFocused = _focused;
        Focus(FocusState.Pointer);
        try
        {
            if (_composing || _r?.View.Marked is not null) { _session.FinishComposition(); _composing = false; _ime.Clear(); try { _ctx?.NotifyFocusLeave(); _ctx?.NotifyFocusEnter(); } catch { } Render(); }
            var off = HitOffset(pt.Position);
            var shift = Down(VirtualKey.Shift);
            var now = (ulong)Environment.TickCount64;
            var dbl = GetDoubleClickTime();
            var dx = Math.Max(2, GetSystemMetrics(36) / 2.0) / Math.Max(1, XamlRoot?.RasterizationScale ?? 1);
            var near = Math.Abs(pt.Position.X - _lastPressAt.X) <= dx + 2 && Math.Abs(pt.Position.Y - _lastPressAt.Y) <= dx + 2;
            _clicks = now - _lastPressMs <= dbl && near ? Math.Min(3, _clicks + 1) : 1;
            _lastPressMs = now; _lastPressAt = pt.Position;
            var text = _r!.View.Text;
            var sel = _r.View.Selection;
            _unit = 0;
            if (!right && BeginResize(pt.Position, e)) { e.Handled = true; return; }
            var media = MediaAt(pt.Position);
            if (right)
            {
                var s0 = SelFrom(_r.View); var s1 = SelTo(_r.View);
                if (media is { Line: >= 0 } mm) _session.SetViewSelection(_r.View.Lines[mm.Line].Offset, _r.View.Lines[mm.Line].Offset + 1);
                else if (off < s0 || off > s1) _session.SetViewSelection((uint)off, (uint)off);
                Render();
                ShowContextMenu(pt.Position, media is { Line: >= 0 } m2 ? m2.Line : -1);
                e.Handled = true;
                return;
            }
            // a page link opens its page; a link opens with Ctrl, or when the box was not being edited
            if (TryOpenAt(pt.Position, off, Down(VirtualKey.Control), wasFocused)) { e.Handled = true; return; }
            var line = media is { Line: >= 0 } hit ? _r.View.Lines[hit.Line] : _r.View.Lines.Length > 0 ? _r.View.Lines[Math.Max(0, RunMap.LineAt(_r.View.Lines, off))] : null;
            if (line is not null && !line.IsText)
            {
                // a double-click on a picture or file card opens it (downloaded to a temp folder); a click on the card's download icon saves it
                var openIt = _clicks >= 2 && media is { Line: >= 0 };
                var saveIt = media is { Kind: DecoKind.FileCard, Line: >= 0 } fc && pt.Position.X >= fc.Rect.Right - 10 - 28 - 4 && pt.Position.X <= fc.Rect.Right - 6;
                _session.SetViewSelection(line.Offset, line.Offset + 1);
                _anchor = (int)line.Offset; _clicks = 1;
                if (openIt) { _clicks = 0; _ = OpenMediaAsync(media!.Line); }
                else if (saveIt) _ = SaveMediaAsync(media!.Line);
            }
            else if (_clicks == 2 && !shift)
            {
                var w = InputMap.WordAt(text, off);
                _session.SetViewSelection((uint)w.Start, (uint)w.End);
                _unit = 1; _unitSpan = w; _anchor = w.Start;
            }
            else if (_clicks >= 3 && !shift && line is not null)
            {
                var span = new Span((int)line.Offset, (int)(line.Offset + line.Len));
                _session.SetViewSelection((uint)span.Start, (uint)span.End);
                _unit = 2; _unitSpan = span; _anchor = span.Start;
            }
            else
            {
                _anchor = shift ? (int)sel.Anchor : off;
                _session.SetViewSelection((uint)_anchor, (uint)off);
            }
            _stickyX = -1;
            _dragging = true;
            _root.CapturePointer(e.Pointer);
            e.Handled = true;
            Render();
        }
        catch (Exception ex) { Log("pointer pressed", ex); }
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (_rz is not null) { MoveResize(e.GetCurrentPoint(_root).Position); return; }
        if (!_dragging && Interactive && _r is not null) UpdateCursor(e.GetCurrentPoint(_root).Position);
        if (!_dragging || !Interactive) return;
        try
        {
            var p = e.GetCurrentPoint(_root).Position;
            var off = HitOffset(p);
            var text = _r!.View.Text;
            int a = _anchor, h = off;
            if (_unit == 1)
            {
                var w = InputMap.WordAt(text, off);
                if (off < _unitSpan.Start) { a = _unitSpan.End; h = w.Start; } else { a = _unitSpan.Start; h = w.End; }
            }
            else if (_unit == 2)
            {
                var li = RunMap.LineAt(_r.View.Lines, off);
                var l = _r.View.Lines[Math.Max(0, li)];
                var span = new Span((int)l.Offset, (int)(l.Offset + l.Len));
                if (span.Start < _unitSpan.Start) { a = _unitSpan.End; h = span.Start; } else { a = _unitSpan.Start; h = span.End; }
            }
            var cur = _r.View.Selection;
            if (cur.Anchor != (uint)a || cur.Head != (uint)h)
            {
                _session.SetViewSelection((uint)a, (uint)h);
                Render();
            }
            AutoScroll(e.GetCurrentPoint(null).Position);
        }
        catch (Exception ex) { Log("pointer moved", ex); }
    }

    private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
    {
        if (_rz is not null) { EndResize(e); return; }
        if (!_dragging) return;
        _dragging = false;
        _root.ReleasePointerCapture(e.Pointer);
        UpdateFloatingBar();   // a drag-selection is done: the bar may show now
    }

    /// <summary>Near the top or bottom edge of the page's scroller, scroll it.</summary>
    private void AutoScroll(Point windowPoint)
    {
        DependencyObject? p = this;
        while (p is not null && p is not ScrollViewer) p = VisualTreeHelper.GetParent(p);
        if (p is not ScrollViewer sv) return;
        var top = sv.TransformToVisual(null).TransformPoint(new Point(0, 0)).Y;
        var bottom = top + sv.ActualHeight;
        if (windowPoint.Y < top + 24) sv.ChangeView(null, Math.Max(0, sv.VerticalOffset - 24), null, true);
        else if (windowPoint.Y > bottom - 24) sv.ChangeView(null, sv.VerticalOffset + 24, null, true);
    }

    // ---- keys ----------------------------------------------------------------------------------------------------------------

    private static bool Down(VirtualKey k) =>
        InputKeyboardSource.GetKeyStateForCurrentThread(k).HasFlag(global::Windows.UI.Core.CoreVirtualKeyStates.Down);

    private static string? KeyName(VirtualKey k)
    {
        if (k >= VirtualKey.A && k <= VirtualKey.Z) return ((char)('a' + (k - VirtualKey.A))).ToString();
        if (k >= VirtualKey.Number0 && k <= VirtualKey.Number9) return ((char)('0' + (k - VirtualKey.Number0))).ToString();
        if (k >= VirtualKey.NumberPad0 && k <= VirtualKey.NumberPad9) return ((char)('0' + (k - VirtualKey.NumberPad0))).ToString();
        return k switch
        {
            VirtualKey.Enter => "Enter", VirtualKey.Back => "Backspace", VirtualKey.Delete => "Delete", VirtualKey.Tab => "Tab", VirtualKey.Escape => "Escape",
            VirtualKey.Left => "ArrowLeft", VirtualKey.Right => "ArrowRight", VirtualKey.Up => "ArrowUp", VirtualKey.Down => "ArrowDown",
            VirtualKey.Home => "Home", VirtualKey.End => "End", VirtualKey.PageUp => "PageUp", VirtualKey.PageDown => "PageDown",
            (VirtualKey)190 => ".", (VirtualKey)188 => ",", (VirtualKey)189 => "-", (VirtualKey)187 => "=",
            _ => null,
        };
    }

    protected override void OnKeyDown(KeyRoutedEventArgs e)
    {
        if (!Interactive || !_focused) { base.OnKeyDown(e); return; }
        try { if (HandleKey(e)) e.Handled = true; else base.OnKeyDown(e); }
        catch (Exception ex) { Log("key", ex); }
    }

    private bool HandleKey(KeyRoutedEventArgs e)
    {
        // characters held back for the text-services check go in before this key acts
        if (_pendingChars.Length > 0) { _charTimer?.Stop(); FlushPendingChars(); }
        // while the IME is composing it gets Enter, arrows and Esc first
        if (_composing || _r?.View.Marked is not null) return false;
        var name = KeyName(e.Key);
        Trace("KeyDown " + e.Key + " name=" + name);
        if (_pendingChars.Length == 0) _textUpdatesAtKey = _textUpdates;
        if (name is null) return false;
        var ctrl = Down(VirtualKey.Control);
        var alt = Down(VirtualKey.Menu);
        var shift = Down(VirtualKey.Shift);
        var altGr = ctrl && alt && Down((VirtualKey)165);   // right Alt (AltGr) with Ctrl
        if (altGr) { ctrl = false; alt = false; }

        if (ctrl && !alt)
        {
            switch (name)
            {
                case "c": CopyCut(false); return true;
                case "x": CopyCut(true); return true;
                case "v": _ = PasteAsync(shift); return true;
                case "z": DoUndoRedo(!shift); return true;
                case "y": DoUndoRedo(false); return true;
                case "k": if (!shift) { ShowLinkEditor(); return true; } break;
                case "m": if (shift) { OpenBlockMenu(BlockOps.CaretLine(_r!.View)); return true; } break;
            }
        }
        if (name == "Enter" && !ctrl && !alt && !shift && _r!.Suggestion is null && SelectedMedia() is { Line: >= 0 } sm) { _ = OpenMediaAsync(sm.Line); return true; }
        var menuOpen = _r!.Suggestion is not null;
        // /image and /file: the engine removes the typed text and answers "no node"; the picker opens instead
        if (name is "Enter" or "Tab" && !ctrl && !alt && HighlightedSlashId() is ("Image" or "File") and var slashId)
        {
            PickSlashMedia(slashId);
            return true;
        }
        // the [[ and @ menus are the app's: it keeps the highlight and picks
        if (menuOpen && _r.Suggestion!.Trigger != N.SuggestionTrigger.Slash && !ctrl && !alt)
        {
            var count = Math.Max(1, _appItems.Count);
            switch (name)
            {
                case "ArrowDown": _appHi = (_appHi + 1) % count; UpdateMenu(true); return true;
                case "ArrowUp": _appHi = (_appHi + count - 1) % count; UpdateMenu(true); return true;
                case "Enter" or "Tab": if (_appItems.Count > 0) { PickApp(_appHi); return true; } break;
            }
        }
        var chord = InputMap.ChordOf(name, ctrl, alt, shift, altGr, menuOpen);
        if (chord is not null)
        {
            var done = _session.Key(chord);
            Render();
            if (done) { _stickyX = -1; return true; }
            if (name == "Escape") { Unfocus(); Escaped?.Invoke(this); return true; }
            if (name is "Enter" or "Backspace" or "Delete") return true;
            return false;        // Tab: on to the next control
        }
        if (name is "ArrowLeft" or "ArrowRight" or "ArrowUp" or "ArrowDown" or "Home" or "End" or "PageUp" or "PageDown")
        {
            MoveCaret(name, ctrl, shift);
            return true;
        }
        return false;
    }

    /// <summary>Caret movement the engine does not own: from the layout (lines, words) and the text, then <c>set_view_selection</c>.</summary>
    private void MoveCaret(string name, bool ctrl, bool shift)
    {
        if (_r is not { } r) return;
        var text = r.View.Text;
        var sel = r.View.Selection;
        int anchor = (int)sel.Anchor, head = (int)sel.Head;
        var from = SelFrom(r.View); var to = SelTo(r.View);
        int target;
        var keepX = false;
        switch (name)
        {
            case "ArrowLeft":
                if (!shift && from != to) target = from;
                else target = ctrl ? InputMap.WordLeft(text, head) : InputMap.Prev(text, head);
                break;
            case "ArrowRight":
                if (!shift && from != to) target = to;
                else target = ctrl ? InputMap.WordRight(text, head) : InputMap.Next(text, head);
                break;
            case "Home": target = ctrl ? 0 : VisualEdge(head, false); break;
            case "End": target = ctrl ? text.Length : VisualEdge(head, true); break;
            case "ArrowUp": case "ArrowDown": case "PageUp": case "PageDown":
            {
                keepX = true;
                var up = name is "ArrowUp" or "PageUp";
                var page = name is "PageUp" or "PageDown";
                target = Vertical(head, up, page);
                break;
            }
            default: return;
        }
        var newAnchor = shift ? anchor : target;
        var sx = _stickyX;
        _session.SetViewSelection((uint)newAnchor, (uint)target);
        Render();
        _stickyX = keepX ? sx : -1;
    }

    private int VisualEdge(int offset, bool end)
    {
        if (CaretRect(offset) is not { } c) return offset;
        var y = c.Y + c.Height / 2;
        var o = HitOffset(new Point(end ? 1e6 : -1e6, y));
        // the end of a wrapped line is before the space that wrapped, not after it
        if (end && o > 0 && o <= _r!.View.Text.Length && o < _r.View.Text.Length && _r.View.Text[o - 1] == ' ' && o - 1 > offset) o--;
        return o;
    }

    private int Vertical(int offset, bool up, bool page)
    {
        if (CaretRect(offset) is not { } c) return offset;
        if (_stickyX < 0) _stickyX = c.X;
        var dy = page ? Math.Max(200, (XamlRoot?.Size.Height ?? 600) - 200) : c.Height;
        var y = up ? c.Y - dy + c.Height / 2 : c.Y + c.Height / 2 + dy;
        if (y < 0 && up) return 0;
        var o = HitOffset(new Point(_stickyX, y));
        if (o == offset)
            return up ? 0 : _r!.View.Text.Length;
        return o;
    }

    // typing when the text services are unavailable: key characters go straight in
    private void OnCharacter(UIElement sender, CharacterReceivedRoutedEventArgs e)
    {
        Trace("CharacterReceived " + (int)e.Character + " ctx=" + (_ctx is not null) + " focused=" + _focused);
        if (!Interactive || !_focused) return;
        var c = e.Character;
        if (char.IsControl(c)) return;
        if (_ctx is not null)
        {
            // The text services normally deliver the typed text (TextUpdating) before or with the key's character. Where they don't
            // (found on the CI runner: a context that never raises TextUpdating, with the characters still arriving here), type the
            // characters ourselves once no TextUpdating has come for this key. Never while an IME is composing.
            if (_composing || _r?.View.Marked is not null) return;
            _pendingChars.Append(c);
            if (_charTimer is null)
            {
                _charTimer = (_dq ?? DispatcherQueue.GetForCurrentThread()).CreateTimer();
                _charTimer.IsRepeating = false;
                _charTimer.Interval = TimeSpan.FromMilliseconds(60);
                _charTimer.Tick += (_, _) => FlushPendingChars();
            }
            _charTimer.Stop(); _charTimer.Start();
            return;
        }
        try { _session.InsertText(c.ToString()); Render(); e.Handled = true; }
        catch (Exception ex) { Log("char", ex); }
    }

    private readonly System.Text.StringBuilder _pendingChars = new();
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _charTimer;
    private int _textUpdates, _textUpdatesAtKey;

    private void FlushPendingChars()
    {
        var text = _pendingChars.ToString();
        _pendingChars.Clear();
        if (text.Length == 0 || !Interactive || !_focused) return;
        if (_textUpdates != _textUpdatesAtKey) { Trace("chars delivered by the text services: " + text); return; }
        Trace("chars typed by the fallback: " + text);
        try { _session.InsertText(text); Render(); } catch (Exception ex) { Log("char fallback", ex); }
    }

    // ---- ribbon ---------------------------------------------------------------------------------------------------------------

    /// <summary>Run an engine command from the ribbon or a menu (the box keeps the focus).</summary>
    public bool RunCommand(string name, string argsJson = "{}")
    {
        if (!Interactive) return false;
        try
        {
            if (_composing || _r?.View.Marked is not null) { _session.FinishComposition(); _composing = false; _ime.Clear(); }
            var ok = _session.Command(name, argsJson);
            Render();
            return ok;
        }
        catch (Exception e) { Log("command " + name, e); return false; }
    }

    public bool DoUndo() => Interactive && DoUndoRedo(true);
    public bool DoRedo() => Interactive && DoUndoRedo(false);

    /// <summary>Undo or redo: through the live page when there is one (core page undo covers this box's text, boxes and ink), else the box's own session.</summary>
    private bool DoUndoRedo(bool undo)
    {
        if (Notivelo.Windows.Views.PageView.Current is { } pv && pv.PageId == PageId && pv.Undo(undo) is { } done) return done;
        var ok = undo ? _session.Undo() : _session.Redo();
        Render();
        return ok;
    }

    // ---- clipboard ------------------------------------------------------------------------------------------------------------

    public void CopyCut(bool cut)
    {
        if (!Interactive) return;
        try
        {
            if (_r!.View.Marked is not null) { _session.FinishComposition(); Render(); }
            var d = cut ? _session.Cut() : _session.Copy();
            if (d.Text.Length == 0 && d.Html.Length == 0) return;
            var p = new DataPackage { RequestedOperation = cut ? DataPackageOperation.Move : DataPackageOperation.Copy };
            p.SetText(d.Text);
            if (d.Html.Length > 0) p.SetHtmlFormat(CfHtml.Create(d.Html));
            Clipboard.SetContent(p);
            try { Clipboard.Flush(); } catch { }
            Render();
        }
        catch (Exception e) { Log("copy", e); }
    }

    public async Task PasteAsync(bool plain)
    {
        if (!Interactive) return;
        try
        {
            var v = Clipboard.GetContent();
            if (await PasteMediaAsync(v)) return;
            string html = "", text = "";
            if (!plain && v.Contains(StandardDataFormats.Html)) html = CfHtml.Fragment(await v.GetHtmlFormatAsync());
            if (v.Contains(StandardDataFormats.Text)) text = await v.GetTextAsync();
            if (!Interactive) return;
            if (html.Length == 0 && text.Length == 0) return;
            if (_composing || _r?.View.Marked is not null) { _session.FinishComposition(); _composing = false; _ime.Clear(); }
            _session.Paste(html, text);
            Render();
        }
        catch (Exception e) { Log("paste", e); }
    }

    private void ShowContextMenu(Point at, int mediaLine = -1)
    {
        var f = new MenuFlyout();
        var has = _r is { } r && r.View.Selection.Anchor != r.View.Selection.Head;
        MenuFlyoutItem Item(string label, Action act, bool enabled, string keys)
        {
            var it = new MenuFlyoutItem { Text = label, IsEnabled = enabled, KeyboardAcceleratorTextOverride = keys };
            it.Click += (_, _) => { act(); Focus(FocusState.Programmatic); };
            return it;
        }
        if (mediaLine >= 0)
        {
            f.Items.Add(Item("Open", () => _ = OpenMediaAsync(mediaLine), true, "Enter"));
            f.Items.Add(Item("Save as…", () => _ = SaveMediaAsync(mediaLine), true, ""));
            f.Items.Add(new MenuFlyoutSeparator());
        }
        f.Items.Add(Item("Cut", () => CopyCut(true), has, "Ctrl+X"));
        f.Items.Add(Item("Copy", () => CopyCut(false), has, "Ctrl+C"));
        f.Items.Add(Item("Paste", () => _ = PasteAsync(false), true, "Ctrl+V"));
        f.Items.Add(new MenuFlyoutSeparator());
        f.Items.Add(Item("Select all", () => { _session.Key("Mod+a"); Render(); }, true, "Ctrl+A"));
        f.Items.Add(new MenuFlyoutSeparator());
        f.Items.Add(Item("Block options…", () => OpenBlockMenu(_r is { } rr ? BlockOps.CaretLine(rr.View) : -1), true, "Ctrl+Shift+M"));
        f.ShowAt(_root, new FlyoutShowOptions { Position = at });
    }

    // ---- suggestion menus ----------------------------------------------------------------------------------------------------

    private void HideMenu()
    {
        if (_menu is { IsOpen: true }) _menu.IsOpen = false;
        _menuSig = "";
    }

    private static string KebabOf(string name) => Regex.Replace(name, "(?<=[a-z])(?=[A-Z0-9])", "-").ToLowerInvariant();

    /// <summary>Show, move or close the popup for <c>ViewRender.Suggestion</c>, anchored under the caret at the suggestion's view range.</summary>
    private void UpdateMenu(bool force = false)
    {
        var s = _r?.Suggestion;
        if (s is null || !_focused) { HideMenu(); return; }
        var items = new List<(string Id, string Label, string Desc, string Icon)>();
        var dots = new Dictionary<string, string?>();
        int hi;
        if (s.Trigger == N.SuggestionTrigger.Slash)
        {
            items.AddRange(s.Items.Select(i => (i.Id, i.Label, i.Description, i.Icon)));
            hi = (int)(s.Highlighted ?? 0);
        }
        else
        {
            if (s.Query != _appQuery) { _appQuery = s.Query; _appHi = 0; }
            var list = s.Trigger == N.SuggestionTrigger.PageLink
                ? _source.SearchPages(s.Query, 8).Select(p => (p.Id, p.Title, p.Crumb)).ToList()
                : _source.People(s.Query).Select(p => (p.Id, p.Label, p.Detail)).ToList();
            if (s.Trigger != N.SuggestionTrigger.PageLink) foreach (var p in _source.People(s.Query)) dots[p.Id] = p.ColorHex;
            _appItems = list;
            _appHi = Math.Clamp(_appHi, 0, Math.Max(0, list.Count - 1));
            items.AddRange(list.Select(i => (i.Item1, i.Item2, i.Item3, s.Trigger == N.SuggestionTrigger.PageLink ? "file-text" : "")));
            hi = _appHi;
        }
        var sig = $"{s.Trigger}|{s.ViewFrom}|{hi}|{string.Join(",", items.Select(i => i.Id))}";
        if (!force && sig == _menuSig && _menu is { IsOpen: true }) return;
        _menuSig = sig;
        var panel = new StackPanel { Spacing = 0 };
        if (s.Trigger == N.SuggestionTrigger.Slash)
            panel.Children.Add(new TextBlock { Text = "INSERT BLOCK", FontSize = 11, FontWeight = new global::Windows.UI.Text.FontWeight(600), Foreground = C2("TextMuted"), Margin = new Thickness(8, 4, 8, 6), FontFamily = Ui.Font, CharacterSpacing = 40 });
        else
        {
            // "Link to page" has a header like the slash menu; people have none (Apple's MacPopups)
            if (s.Trigger == N.SuggestionTrigger.PageLink)
                panel.Children.Add(new TextBlock { Text = "LINK TO PAGE", FontSize = 11, FontWeight = new global::Windows.UI.Text.FontWeight(600), Foreground = C2("TextMuted"), Margin = new Thickness(8, 4, 8, 6), FontFamily = Ui.Font, CharacterSpacing = 40 });
            if (items.Count == 0) panel.Children.Add(new TextBlock { Text = s.Trigger == N.SuggestionTrigger.PageLink ? "Type a page title…" : "No matching people", FontSize = 12.5, Foreground = C2("TextMuted"), Margin = new Thickness(8, 6, 8, 6), FontFamily = Ui.Font });
        }
        Border? active = null;
        for (var i = 0; i < items.Count; i++)
        {
            var (id, label, desc, icon) = items[i];
            var row = MenuRow(label, desc, icon, i == hi, s.Trigger == N.SuggestionTrigger.Slash, dots.TryGetValue(id, out var dot) ? dot : null);
            var idx = i; var itemId = id; var itemLabel = label;
            row.PointerPressed += (_, e) =>
            {
                e.Handled = true;
                if (s.Trigger == N.SuggestionTrigger.Slash) { if (itemId is "Image" or "File") PickSlashMedia(itemId); else RunCommand("pickSlash", JsonSerializer.Serialize(new { title = itemId })); }
                else PickApp(idx);
                Focus(FocusState.Programmatic);
            };
            if (i == hi) active = row;
            panel.Children.Add(row);
        }
        var scroll = new ScrollViewer { Content = panel, MaxHeight = 320 - 12, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, IsTabStop = false };
        var card = new Border
        {
            Width = 290, MaxHeight = 320, Padding = new Thickness(6), CornerRadius = new CornerRadius(12), Background = C2("BgElevated"),
            BorderBrush = C2("Border"), BorderThickness = new Thickness(1), Child = scroll, IsTabStop = false,
        };
        try { card.Shadow = new ThemeShadow(); card.Translation = new System.Numerics.Vector3(0, 0, 24); } catch { }
        card.Measure(new Size(290, 320));
        var h = Math.Min(320, card.DesiredSize.Height);
        var anchor = CaretRect((int)s.ViewFrom) ?? new Rect(0, 0, 0, 27);
        var below = anchor.Bottom + 6;
        // 6 pt below the caret line, above it when the window has no room
        var winY = TransformToVisual(null).TransformPoint(new Point(0, below)).Y;
        var room = (XamlRoot?.Size.Height ?? 800) - winY;
        var top = room >= h + 8 ? below : Math.Max(-1000, anchor.Y - 6 - h);
        var left = Math.Max(0, Math.Min(anchor.X, Math.Max(0, (XamlRoot?.Size.Width ?? 1000) - 300 - TransformToVisual(null).TransformPoint(new Point(0, 0)).X)));
        if (_menu is null)
        {
            _menu = new Popup { IsLightDismissEnabled = false, IsTabStop = false };
            _menu.IsHitTestVisible = true;
            _root.Children.Add(_menu);
        }
        _menu.XamlRoot = XamlRoot;
        _menu.Child = card;
        _menu.HorizontalOffset = left;
        _menu.VerticalOffset = top;
        _menu.IsOpen = true;
        if (active is not null) { try { active.StartBringIntoView(); } catch { } }
    }

    private Border MenuRow(string title, string desc, string icon, bool active, bool tile, string? dotHex = null)
    {
        var g = new Grid { ColumnSpacing = 10 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var name = KebabOf(icon);
        UIElement? glyph = IconData.Paths.ContainsKey(name) ? new Icon(name, 18, C2("Text2")) : null;
        var t = new Border
        {
            Width = 36, Height = 36, BorderBrush = C2("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Background = C2("Bg"),
            Child = glyph is null ? null : new Grid { Children = { glyph } },
        };
        if (glyph is FrameworkElement fe) { fe.HorizontalAlignment = HorizontalAlignment.Center; fe.VerticalAlignment = VerticalAlignment.Center; }
        if (tile) g.Children.Add(t);
        var col = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        col.Children.Add(new TextBlock { Text = title, FontSize = 14, FontWeight = new global::Windows.UI.Text.FontWeight(500), Foreground = C2("Text"), FontFamily = Ui.Font, TextTrimming = TextTrimming.CharacterEllipsis });
        if (desc.Length > 0) col.Children.Add(new TextBlock { Text = desc, FontSize = 12, Foreground = C2("TextMuted"), FontFamily = Ui.Font, TextTrimming = TextTrimming.CharacterEllipsis });
        Grid.SetColumn(col, tile ? 1 : 0);
        if (!tile) Grid.SetColumnSpan(col, 2);
        g.Children.Add(col);
        if (!tile && dotHex is not null)
        {
            // a person: a colour dot before the name
            var dot = new Border { Width = 10, Height = 10, CornerRadius = new CornerRadius(5), Background = Ui.Hex(dotHex), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) };
            col.Orientation = Orientation.Vertical;
            Grid.SetColumnSpan(col, 1); Grid.SetColumn(col, 1);
            g.ColumnDefinitions[1].Width = new GridLength(1, GridUnitType.Star);
            Grid.SetColumn(dot, 0);
            g.Children.Add(dot);
        }
        return new Border { Padding = new Thickness(8, 6, 8, 6), CornerRadius = new CornerRadius(7), Background = active ? C2("BgHover") : new SolidColorBrush(Colors.Transparent), Child = g };
    }

    /// <summary>The slash menu's Image or File: the engine removes the typed "/image" and returns false (no node); the file dialog opens at that caret.</summary>
    private string? HighlightedSlashId()
    {
        if (_r?.Suggestion is not { Trigger: N.SuggestionTrigger.Slash } s || s.Items.Length == 0) return null;
        return s.Items[Math.Min((int)(s.Highlighted ?? 0), s.Items.Length - 1)].Id;
    }

    private void PickSlashMedia(string title)
    {
        RunCommand("pickSlash", JsonSerializer.Serialize(new { title }));
        _ = PickMediaAsync(title == "Image");
    }

    private void PickApp(int index)
    {
        if (index < 0 || index >= _appItems.Count || _r?.Suggestion is not { } s) return;
        var it = _appItems[index];
        if (s.Trigger == N.SuggestionTrigger.PageLink) RunCommand("pickPage", JsonSerializer.Serialize(new { pageId = it.Id }));
        else RunCommand("pickMention", JsonSerializer.Serialize(new { id = it.Id, label = it.Label }));
    }

    // ---- drawing helpers used by Draw --------------------------------------------------------------------------------------------

    /// <summary>The composition's underline (single, dotted, or thick for the clause being converted), from the text services' format spans, else under the marked range.</summary>
    private void DrawIme(CanvasDrawingSession ds, N.ViewRender r)
    {
        if (r.View.Marked is not { } m) return;
        var text = C("Text");
        var spans = _ime.Count > 0 ? _ime.Where(s => s.End > s.Start) : new[] { new ImeSpan((int)m.From, (int)m.To, UnderlineType.Single, false) };
        foreach (var s in spans)
        {
            foreach (var rc in RectsForRange(s.Start, s.End))
            {
                if (rc.Width <= 0) continue;
                var y = rc.Bottom - 3;
                var style = new Microsoft.Graphics.Canvas.Geometry.CanvasStrokeStyle { DashStyle = s.Type == UnderlineType.Dotted ? Microsoft.Graphics.Canvas.Geometry.CanvasDashStyle.Dot : Microsoft.Graphics.Canvas.Geometry.CanvasDashStyle.Solid };
                ds.DrawLine((float)rc.X, (float)y, (float)rc.Right, (float)y, text, s.Thick ? 2f : 1f, style);
            }
        }
    }
}
