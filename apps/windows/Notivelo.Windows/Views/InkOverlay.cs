using System.Numerics;
using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Windows.Foundation;
using Windows.System;
using Notivelo.Native;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The top layer of the page canvas while a pen tool is chosen (Apple's InkSession + MacInkInput): it takes the pointer instead of the boxes and
/// turns it into the core's ink calls, one call at the end of each gesture. Pen and highlighter feed an InkStrokeBuilder (pen pressure, the
/// intermediate points) and show its preview while drawing; the eraser (and the pen's eraser end) removes strokes; the lasso selects strokes, drags them
/// and Delete / Backspace removes them. Coordinates are page points from the surface origin. Test readout: automation id "ink-overlay", ItemStatus
/// "strokes=N;selected=M;tool=pen;live=0".</summary>
internal sealed class InkOverlay : UserControl
{
    private enum Mode { None, Stroke, Erase, Lasso, Move }

    private readonly INotesSource _source;
    private readonly string _pageId;
    private readonly InkLayer _under, _over;
    private readonly Action _reload;
    private readonly InkTool _tool = InkTool.Shared;
    private readonly CanvasControl _c = new() { IsHitTestVisible = false };

    private List<InkStroke> _strokes = new();
    private HashSet<string> _selected = new();
    private bool _dark;

    private Mode _mode;
    private uint _pointerId;
    private InkStrokeBuilder? _builder;
    private (byte Tool, uint Color, float Width) _style;
    private bool _pen;
    private ulong _t0;
    private bool _partial;
    private readonly List<float> _track = new();
    private readonly List<Vector2> _poly = new();
    private Vector2 _moveStart, _shift;
    private float[]? _liveOps;
    private Vector2? _disc;

    public InkOverlay(INotesSource source, string pageId, InkLayer under, InkLayer over, Action reload)
    {
        _source = source; _pageId = pageId; _under = under; _over = over; _reload = reload;
        Background = new SolidColorBrush(Colors.Transparent);
        HorizontalAlignment = HorizontalAlignment.Left; VerticalAlignment = VerticalAlignment.Top;
        IsTabStop = true; UseSystemFocusVisuals = false;
        Content = new Grid { Background = new SolidColorBrush(Colors.Transparent), Children = { _c } };   // a filled backdrop takes the pointer
        AutomationProperties.SetAutomationId(this, "ink-overlay");
        AutomationProperties.SetName(this, "Ink");
        _c.Draw += Draw;
        PointerPressed += OnPressed;
        PointerMoved += OnMoved;
        PointerReleased += OnReleased;
        PointerCanceled += (_, _) => Cancel();
        PointerCaptureLost += (_, _) => Cancel();
        KeyDown += OnKey;
        Loaded += (_, _) => _tool.Changed += ToolChanged;
        Unloaded += (_, _) => { _tool.Changed -= ToolChanged; _tool.DeleteSelection = null; _tool.SetSelectionCount(0); };
        ToolChanged();
    }

    /// <summary>The page's readable strokes in drawing order (after any read of the page's ink).</summary>
    public void SetStrokes(IReadOnlyList<InkStroke> strokes, bool dark)
    {
        _strokes = strokes.ToList(); _dark = dark;
        SetSelection(_selected.Where(id => _strokes.Any(s => s.Id == id)).ToHashSet());
        _c.Invalidate();
    }

    private void ToolChanged()
    {
        IsHitTestVisible = _tool.Inking;
        ProtectedCursor = InputSystemCursor.Create(InputSystemCursorShape.Cross);
        if (_mode != Mode.None) Cancel();
        if (_tool.Kind != InkKind.Lasso && _selected.Count > 0) SetSelection(new());
        Status();
    }

    private void Status() =>
        AutomationProperties.SetItemStatus(this, $"strokes={_strokes.Count};selected={_selected.Count};tool={_tool.Kind.ToString().ToLowerInvariant()};live={(_mode == Mode.None ? 0 : 1)}");

    // ---- pointer -----------------------------------------------------------------------------------------------------------------

    private double[] Sample(PointerPoint p)
    {
        var pen = p.PointerDeviceType == PointerDeviceType.Pen;
        var pressure = pen ? Math.Clamp(p.Properties.Pressure, 0.0, 1.0) : 0.5;
        return new[] { p.Position.X, p.Position.Y, pressure, Math.PI / 2, 0, (p.Timestamp - _t0) / 1000.0 };
    }

    private static Vector2 V(PointerPoint p) => new((float)p.Position.X, (float)p.Position.Y);

    private void OnPressed(object sender, PointerRoutedEventArgs e)
    {
        if (!_tool.Inking || _mode != Mode.None) return;
        var p = e.GetCurrentPoint(this);
        var eraserEnd = p.PointerDeviceType == PointerDeviceType.Pen && p.Properties.IsEraser;
        if (!eraserEnd && !p.Properties.IsLeftButtonPressed) return;
        if (!_source.CanInk(_pageId)) return;
        // drawing ends any text editing (an empty box is removed), and the overlay keeps the keyboard for Delete and undo
        BoxTextView.CloseLinkEditor(); BoxTextView.Focused?.Unfocus(); BoxTextView.LeaveEditing();
        Focus(FocusState.Pointer);
        e.Handled = true;
        CapturePointer(e.Pointer);
        _pointerId = e.Pointer.PointerId;
        _t0 = p.Timestamp;
        _pen = p.PointerDeviceType == PointerDeviceType.Pen;
        Begin(eraserEnd ? InkKind.Eraser : _tool.Kind, p);
    }

    private void OnMoved(object sender, PointerRoutedEventArgs e)
    {
        if (_mode == Mode.None || e.Pointer.PointerId != _pointerId) return;
        // the points since the last event, oldest first (a pen reports more often than the event rate)
        var pts = e.GetIntermediatePoints(this).Reverse().ToList();
        if (pts.Count == 0) pts.Add(e.GetCurrentPoint(this));
        Move(pts);
        e.Handled = true;
    }

    private void OnReleased(object sender, PointerRoutedEventArgs e)
    {
        if (_mode == Mode.None || e.Pointer.PointerId != _pointerId) return;
        var p = e.GetCurrentPoint(this);
        End(p);   // before releasing capture: PointerCaptureLost cancels a live gesture
        ReleasePointerCapture(e.Pointer);
        e.Handled = true;
    }

    // ---- gestures (Apple's InkSession.begin / move / end) --------------------------------------------------------------------------

    private void Begin(InkKind kind, PointerPoint p)
    {
        var at = V(p);
        switch (kind)
        {
            case InkKind.Pen or InkKind.Highlighter:
                if (_tool.StrokeStyle is not { } style) return;
                _style = style;
                _builder = new InkStrokeBuilder(style.Tool, style.Color, style.Width, _pen, false);
                try { _builder.PushMany(Sample(p)); } catch (Exception) { }
                _mode = Mode.Stroke;
                DrawLive();
                break;
            case InkKind.Eraser or InkKind.PartialEraser:
                _mode = Mode.Erase; _partial = kind == InkKind.PartialEraser;
                _track.Clear(); _track.Add(at.X); _track.Add(at.Y);
                _disc = at;
                break;
            case InkKind.Lasso:
                if (_selected.Count > 0 && SelectionRect() is { } r && Inflate(r, 12).Contains(new Point(at.X, at.Y)))
                {
                    _mode = Mode.Move; _moveStart = at; _shift = default;
                }
                else
                {
                    SetSelection(new());
                    _mode = Mode.Lasso; _poly.Clear(); _poly.Add(at);
                }
                break;
            default: return;
        }
        Status(); _c.Invalidate();
    }

    private void Move(List<PointerPoint> pts)
    {
        switch (_mode)
        {
            case Mode.Stroke:
                try { _builder?.PushMany(pts.SelectMany(Sample).ToArray()); } catch (Exception) { }
                DrawLive();
                break;
            case Mode.Erase:
                foreach (var p in pts) { var v = V(p); _track.Add(v.X); _track.Add(v.Y); }
                _disc = V(pts[^1]);
                break;
            case Mode.Lasso:
                foreach (var p in pts) { var v = V(p); if (Vector2.Distance(v, _poly[^1]) >= 1.5f) _poly.Add(v); }
                break;
            case Mode.Move:
                _shift = V(pts[^1]) - _moveStart;
                _under.Translate(_selected, _shift.X, _shift.Y); _over.Translate(_selected, _shift.X, _shift.Y);
                break;
        }
        _c.Invalidate();
    }

    private void End(PointerPoint last)
    {
        var mode = _mode;
        _mode = Mode.None;
        var at = V(last);
        switch (mode)
        {
            case Mode.Stroke:
                if (_builder is { } b)
                {
                    try { b.PushMany(Sample(last)); } catch (Exception) { }
                    if (b.PointCount() > 0) _source.AddInkStroke(_pageId, b, _style.Tool, _style.Color);
                    b.Dispose();
                }
                _builder = null; _liveOps = null;
                _reload();
                break;
            case Mode.Erase:
                _track.Add(at.X); _track.Add(at.Y);
                _disc = null;
                if (_track.Count >= 2) _source.EraseInk(_pageId, _track.ToArray(), InkTool.EraserRadius, _partial);
                _reload();
                break;
            case Mode.Lasso:
                _poly.Add(at);
                LassoEnded();
                _poly.Clear();
                break;
            case Mode.Move:
                MoveEnded(at - _moveStart);
                _shift = default;
                break;
        }
        Status(); _c.Invalidate();
    }

    /// <summary>The gesture was interrupted (a tool change, lost capture): nothing is written.</summary>
    private void Cancel()
    {
        if (_mode == Mode.None) return;
        _mode = Mode.None;
        _builder?.Dispose(); _builder = null; _liveOps = null; _disc = null; _poly.Clear(); _shift = default;
        _under.Translate(new(), 0, 0); _over.Translate(new(), 0, 0);
        Status(); _c.Invalidate();
    }

    private void DrawLive()
    {
        try { _liveOps = _builder?.Preview(Array.Empty<float>()); } catch (Exception) { _liveOps = null; }
    }

    private void LassoEnded()
    {
        float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
        foreach (var p in _poly) { x0 = Math.Min(x0, p.X); x1 = Math.Max(x1, p.X); y0 = Math.Min(y0, p.Y); y1 = Math.Max(y1, p.Y); }
        var tap = _poly.Count < 3 || Math.Sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) < 6;
        IReadOnlyList<string> ids = tap
            ? _source.InkHitPoint(_pageId, (x0 + x1) / 2, (y0 + y1) / 2, 6)
            : _source.InkHitLasso(_pageId, _poly.SelectMany(p => new[] { p.X, p.Y }).ToArray());
        if (tap)   // a tap picks the top stroke only
        {
            var top = ids.OrderBy(id => _strokes.FindIndex(s => s.Id == id)).LastOrDefault();
            ids = top is null ? Array.Empty<string>() : new[] { top };
        }
        SetSelection(ids.ToHashSet());
    }

    private void MoveEnded(Vector2 d)
    {
        var ids = _selected.ToList();
        if (d.Length() < 1 || ids.Count == 0) { _under.Translate(new(), 0, 0); _over.Translate(new(), 0, 0); return; }
        var moved = _source.MoveInkStrokes(_pageId, ids, d.X, d.Y);
        if (moved is null) { _under.Translate(new(), 0, 0); _over.Translate(new(), 0, 0); return; }
        // the moved strokes have new ids: the selection follows them
        var map = moved.ToDictionary(m => m.OldId, m => m.NewId);
        _selected = ids.Select(id => map.GetValueOrDefault(id, id)).ToHashSet();
        _reload();
        _under.Translate(new(), 0, 0); _over.Translate(new(), 0, 0);
    }

    private void DeleteSelected()
    {
        if (_selected.Count == 0) return;
        _source.DeleteInkStrokes(_pageId, _selected.ToList());
        SetSelection(new());
        _reload();
    }

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        if ((e.Key == VirtualKey.Delete || e.Key == VirtualKey.Back) && _selected.Count > 0) { DeleteSelected(); e.Handled = true; }
        else if (e.Key == VirtualKey.Escape && _selected.Count > 0) { SetSelection(new()); e.Handled = true; }
    }

    private void SetSelection(HashSet<string> ids)
    {
        _selected = ids;
        _tool.DeleteSelection = ids.Count == 0 ? null : DeleteSelected;
        _tool.SetSelectionCount(ids.Count);
        Status(); _c.Invalidate();
    }

    private Rect? SelectionRect()
    {
        float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
        foreach (var s in _strokes.Where(s => _selected.Contains(s.Id))) { x0 = Math.Min(x0, s.MinX); y0 = Math.Min(y0, s.MinY); x1 = Math.Max(x1, s.MaxX); y1 = Math.Max(y1, s.MaxY); }
        return x0 > x1 ? null : new Rect(x0, y0, x1 - x0, y1 - y0);
    }

    private static Rect Inflate(Rect r, double d) => new(r.X - d, r.Y - d, r.Width + 2 * d, r.Height + 2 * d);

    // ---- drawing: the live stroke, the eraser's disc, the lasso loop and the selection frame ---------------------------------------

    private void Draw(CanvasControl sender, CanvasDrawEventArgs args)
    {
        var ds = args.DrawingSession;
        var accent = ((SolidColorBrush)ThemeBrushes.Get("Accent", this)).Color;
        if (_liveOps is { Length: > 0 } ops)
        {
            try { using var g = InkGeometry.Build(ds, ops); ds.FillGeometry(g, InkGeometry.Color(_style.Color, _dark)); } catch (Exception) { }
        }
        using var dash = new CanvasStrokeStyle { DashStyle = CanvasDashStyle.Dash };
        if (_disc is { } c) ds.DrawCircle(c, InkTool.EraserRadius, global::Windows.UI.Color.FromArgb(160, 128, 128, 128), 1);
        if (_mode == Mode.Lasso && _poly.Count > 1)
            for (var i = 1; i < _poly.Count; i++) ds.DrawLine(_poly[i - 1], _poly[i], accent, 1.5f, dash);
        if (_selected.Count > 0 && SelectionRect() is { } r)
        {
            var f = Inflate(r, 4);
            var off = _mode == Mode.Move ? _shift : default;
            ds.DrawRectangle(new Rect(f.X + off.X, f.Y + off.Y, f.Width, f.Height), accent, 1.5f, dash);
        }
    }
}
