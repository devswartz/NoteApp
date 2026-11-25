using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Text;
using Notivelo.Windows.Data;
using Windows.Foundation;
using Windows.UI;
using Microsoft.UI;
using N = Notivelo.Native;

namespace Notivelo.Windows.Controls;

/// <summary>Other people's carets and selections in a box (apple-left3: the core's <c>RemoteCursors</c>, in view offsets of this box's text) and ours going out
/// (<c>SetLocalCursor</c>). A caret is a 1.5 px bar in the person's colour with their name on a small flag above it; a selection is the colour at about 25 %.</summary>
internal sealed partial class BoxTextView
{
    /// <summary>The box's id on the page (what the core's cursors name), or null for a box that has none.</summary>
    public string? BoxId { get; set; }

    private IReadOnlyList<RemoteCaret> _remote = Array.Empty<RemoteCaret>();

    /// <summary>The carets of other people in this box (the page hands over the ones whose box id is this one).</summary>
    public void SetRemoteCarets(IReadOnlyList<RemoteCaret> carets)
    {
        if (AdminRules.Same(carets, _remote)) return;
        _remote = carets;
        _canvas.Invalidate();
    }

    internal string RemoteReadout() => AdminRules.Readout(_remote, _r?.View.Text.Length ?? 0);

    private (uint, uint)? _caretSent;

    private void SendLocalCaret(N.ViewRender r)
    {
        if (PageId is null || BoxId is null) return;
        var sel = (r.View.Selection.Anchor, r.View.Selection.Head);
        if (_caretSent == sel) return;
        _caretSent = sel;
        _source.SetLocalCaret(PageId, BoxId, (int)sel.Anchor, (int)sel.Head);
    }

    private void ClearLocalCaret()
    {
        if (_caretSent is null || PageId is null) return;
        _caretSent = null;
        _source.ClearLocalCaret(PageId);
    }

    private void DrawRemoteCarets(CanvasDrawingSession ds, N.ViewRender r)
    {
        if (_remote.Count == 0) return;
        var len = r.View.Text.Length;
        foreach (var rc in _remote)
        {
            var (a, h) = AdminRules.Clamp(rc, len);
            var colour = Hex(rc.Color.Length == 7 ? rc.Color : "#888888");
            if (a != h) DrawRange(ds, Math.Min(a, h), Math.Max(a, h), Alpha(colour, 0.25));
            if (CaretAt(r, h) is not { } c) continue;
            ds.FillRectangle(new Rect(c.X - 0.75, c.Y + 1, 1.5, Math.Max(c.H - 2, 10)), colour);
            // the name flag sits on top of the caret; on the first line it goes below the caret instead so it isn't cut off
            using var fmt = new CanvasTextFormat { FontFamily = "Segoe UI", FontSize = 10.5f, FontWeight = new global::Windows.UI.Text.FontWeight(600), WordWrapping = CanvasWordWrapping.NoWrap };
            using var layout = new CanvasTextLayout(ds, rc.Name, fmt, 160, 16);
            var w = layout.LayoutBounds.Width + 10;
            var fy = c.Y - 15 >= 0 ? c.Y - 15 : c.Y + c.H;
            var flag = new Rect(Math.Max(0, c.X - 1), fy, w, 15);
            ds.FillRoundedRectangle(flag, 3, 3, colour);
            ds.DrawTextLayout(layout, (float)flag.X + 5, (float)flag.Y + 1, Colors.White);
        }
    }
}
