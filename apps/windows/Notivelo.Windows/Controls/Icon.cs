using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Path = Microsoft.UI.Xaml.Shapes.Path;
using Notivelo.Windows.Icons;

namespace Notivelo.Windows.Controls;

/// <summary>A Lucide icon (LOOK 5): 24x24 viewBox, 2-unit round stroke that scales with the size, no fill.
/// Colour: <see cref="Tint"/> if set, otherwise the foreground of the nearest ContentPresenter/Control ancestor
/// (so hover and checked states of the button it sits in recolour it).</summary>
internal sealed class Icon : UserControl
{
    private readonly Path _path = new()
    {
        StrokeThickness = 2,
        StrokeStartLineCap = PenLineCap.Round,
        StrokeEndLineCap = PenLineCap.Round,
        StrokeLineJoin = PenLineJoin.Round,
    };
    private readonly Viewbox _box = new() { Stretch = Stretch.Uniform };
    private DependencyObject? _watched;
    private DependencyProperty? _watchedProp;
    private long _token;
    private Brush? _tint;
    private Brush? _fill;

    public Icon(string kind, double size = 18, Brush? tint = null)
    {
        IsHitTestVisible = false;
        IsTabStop = false;
        var canvas = new Canvas { Width = 24, Height = 24 };
        canvas.Children.Add(_path);
        _box.Child = canvas;
        Content = _box;
        Kind = kind;
        Size = size;
        _tint = tint;
        _path.Stroke = tint;
        Loaded += (_, _) => Attach();
        Unloaded += (_, _) => Detach();
    }

    public string Kind
    {
        set
        {
            _path.Data = (Geometry)XamlBindingHelper.ConvertValue(typeof(Geometry), IconData.Paths[value]);
        }
    }

    public double Size
    {
        set { _box.Width = value; _box.Height = value; Width = value; Height = value; }
    }

    public Brush? Tint
    {
        set { _tint = value; if (value is not null) _path.Stroke = value; }
    }

    /// <summary>Fill (priority flags are filled with their colour as well as stroked).</summary>
    public Brush? Fill
    {
        set { _fill = value; _path.Fill = value; }
    }

    public double StrokeUnits { set => _path.StrokeThickness = value; }

    private void Attach()
    {
        Detach();
        if (_tint is not null) { _path.Stroke = _tint; return; }
        DependencyObject? p = VisualTreeHelper.GetParent(this);
        while (p is not null)
        {
            if (p is ContentPresenter cp) { Watch(cp, ContentPresenter.ForegroundProperty, cp.Foreground); return; }
            if (p is Control c) { Watch(c, Control.ForegroundProperty, c.Foreground); return; }
            p = VisualTreeHelper.GetParent(p);
        }
    }

    private void Watch(DependencyObject src, DependencyProperty prop, Brush current)
    {
        _watched = src; _watchedProp = prop;
        _path.Stroke = current;
        _token = src.RegisterPropertyChangedCallback(prop, (s, _) => _path.Stroke = (Brush)s.GetValue(prop));
    }

    private void Detach()
    {
        if (_watched is not null && _watchedProp is not null) _watched.UnregisterPropertyChangedCallback(_watchedProp, _token);
        _watched = null; _watchedProp = null;
    }
}
