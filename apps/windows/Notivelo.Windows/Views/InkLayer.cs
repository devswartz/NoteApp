using System.Numerics;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>One layer of the page's ink (LOOK 4.5; the web's InkRenderer layers): the core's outlines filled with the nonzero rule, highlighters under
/// the boxes and pens over them. It never takes a click (<see cref="InkOverlay"/> does, while a pen tool is chosen). In the dark theme near-black ink
/// is drawn near-white. Strokes being dragged by the lasso follow <see cref="Shift"/>.</summary>
internal sealed class InkLayer : Grid
{
    private readonly CanvasControl _c = new() { IsHitTestVisible = false };
    private readonly bool _highlighters;
    private List<InkStroke> _items = new();
    private readonly Dictionary<string, CanvasGeometry> _geo = new();
    private bool _dark;
    private HashSet<string> _moving = new();
    private Vector2 _shift;

    public InkLayer(bool highlighters)
    {
        _highlighters = highlighters;
        IsHitTestVisible = false;
        HorizontalAlignment = HorizontalAlignment.Left; VerticalAlignment = VerticalAlignment.Top;
        Children.Add(_c);
        _c.Draw += Draw;
        _c.CreateResources += (_, _) => { foreach (var g in _geo.Values) g.Dispose(); _geo.Clear(); };
    }

    public void Set(IReadOnlyList<InkStroke> all, bool dark)
    {
        var next = all.Where(s => s.Highlighter == _highlighters).ToList();
        if (_dark == dark && next.Count == _items.Count && next.Zip(_items).All(p => p.First.Id == p.Second.Id && ReferenceEquals(p.First.Ops, p.Second.Ops))) return;
        _dark = dark; _items = next;
        var live = next.Select(s => s.Id).ToHashSet();
        foreach (var k in _geo.Keys.Where(k => !live.Contains(k)).ToList()) { _geo[k].Dispose(); _geo.Remove(k); }
        _c.Visibility = next.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        _c.Invalidate();
    }

    /// <summary>While the lasso's selection is dragged: these strokes are drawn moved by <paramref name="dx"/>, <paramref name="dy"/> ((0, 0) puts them back).</summary>
    public void Translate(HashSet<string> ids, float dx, float dy)
    {
        _moving = ids; _shift = new Vector2(dx, dy);
        _c.Invalidate();
    }

    private void Draw(CanvasControl sender, CanvasDrawEventArgs args)
    {
        var ds = args.DrawingSession;
        foreach (var s in _items)
        {
            try
            {
                if (!_geo.TryGetValue(s.Id, out var g)) _geo[s.Id] = g = InkGeometry.Build(ds, s.Ops);
                ds.Transform = _moving.Contains(s.Id) ? Matrix3x2.CreateTranslation(_shift) : Matrix3x2.Identity;
                ds.FillGeometry(g, InkGeometry.Color(s.Color, _dark));
            }
            catch (Exception) { }
        }
        ds.Transform = Matrix3x2.Identity;
    }
}
