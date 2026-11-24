using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The pen row under the ribbon (Apple's InkBar): select / type, pen, highlighter, whole-stroke eraser, partial eraser, lasso; for the pen and
/// highlighter the colours and three widths; Delete for a lasso selection; close. Opened by the ribbon's Draw button.</summary>
internal sealed class InkBar : ThemedControl
{
    private readonly InkTool _ink = InkTool.Shared;

    static InkBar()
    {
        // Lucide "lasso" (ISC), not in the generated icon set
        Icons.IconData.Paths.TryAdd("lasso", "M3.704 14.467A10 8 0 0 1 2 10a10 8 0 0 1 20 0 10 8 0 0 1-10 8 10 8 0 0 1-5.181-1.158 M7 22a5 5 0 0 1-2-3.994 M3 16A2 2 0 1 0 7 16A2 2 0 1 0 3 16Z");
    }

    public InkBar()
    {
        Loaded += (_, _) => _ink.Changed += OnChanged;
        Unloaded += (_, _) => _ink.Changed -= OnChanged;
    }

    private void OnChanged() => Rebuild();

    private static Brush Swatch(uint rgb) => Ui.Hex($"#{rgb & 0xFFFFFF:X6}");

    private ButtonBase Tool(string icon, InkKind kind, string tip)
    {
        var b = new ToggleButton { Style = Ui.Style("RibbonToggleStyle"), IsChecked = _ink.Kind == kind, Height = 36, MinWidth = 36, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6), Content = new Icon(icon, 18) };
        Plain(b, tip, "ink-tool-" + kind.ToString().ToLowerInvariant());
        b.Click += (_, _) => _ink.SetKind(kind);
        return b;
    }

    private static void Plain(ButtonBase b, string tip, string id)
    {
        ToolTipService.SetToolTip(b, tip);
        AutomationProperties.SetAutomationId(b, id);
        AutomationProperties.SetName(b, tip);
        b.AllowFocusOnInteraction = false; b.IsTabStop = false;   // a box keeps the keyboard
    }

    private UIElement Sep() => new Border { Width = 1, Height = 22, Background = B("Border"), Margin = new Thickness(5, 0, 5, 0), VerticalAlignment = VerticalAlignment.Center };

    protected override UIElement Build()
    {
        var hl = _ink.Kind == InkKind.Highlighter;
        var drawing = _ink.Kind == InkKind.Pen || hl;
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(Tool("mouse-pointer-2", InkKind.Select, "Select and type"));
        row.Children.Add(Tool("pen", InkKind.Pen, "Pen"));
        row.Children.Add(Tool("highlighter", InkKind.Highlighter, "Highlighter"));
        row.Children.Add(Tool("eraser", InkKind.Eraser, "Eraser (whole strokes)"));
        row.Children.Add(Tool("slice", InkKind.PartialEraser, "Partial eraser"));
        row.Children.Add(Tool("lasso", InkKind.Lasso, "Lasso: select, move and delete strokes"));
        if (drawing)
        {
            row.Children.Add(Sep());
            var current = hl ? _ink.HighlighterColor : _ink.PenColor;
            foreach (var sw in hl ? InkTool.HighlighterColors : InkTool.PenColors)
            {
                var on = current == sw.Hex;
                var dot = new Grid { Width = 24, Height = 24 };
                dot.Children.Add(new Ellipse { Width = 24, Height = 24, Stroke = on ? B("Accent") : null, StrokeThickness = 2 });
                dot.Children.Add(new Ellipse { Width = 18, Height = 18, Fill = Swatch(sw.Hex), Stroke = B("Border"), StrokeThickness = 1 });
                var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 36, MinWidth = 32, Padding = new Thickness(0), CornerRadius = new CornerRadius(6), Content = dot };
                Plain(b, sw.Name, "ink-colour-" + sw.Name.ToLowerInvariant());
                var hex = sw.Hex;
                b.Click += (_, _) => { if (hl) _ink.SetHighlighterColor(hex); else _ink.SetPenColor(hex); };
                row.Children.Add(b);
            }
            row.Children.Add(Sep());
            var widths = hl ? InkTool.HighlighterWidths : InkTool.PenWidths;
            for (var i = 0; i < widths.Length; i++)
            {
                var w = widths[i];
                var on = (hl ? _ink.HighlighterWidth : _ink.PenWidth) == w;
                var d = 4 + i * 4;
                var b = new Button
                {
                    Style = Ui.Style("GhostButtonStyle"), Height = 36, MinWidth = 36, Padding = new Thickness(0), CornerRadius = new CornerRadius(6),
                    Background = on ? B("AccentSoft") : null,
                    Content = new Ellipse { Width = d, Height = d, Fill = on ? B("Accent") : B("Text2") },
                };
                Plain(b, InkTool.WidthNames[i], "ink-width-" + InkTool.WidthNames[i].ToLowerInvariant());
                b.Click += (_, _) => { if (hl) _ink.SetHighlighterWidth(w); else _ink.SetPenWidth(w); };
                row.Children.Add(b);
            }
        }
        if (_ink.Kind == InkKind.Lasso && _ink.SelectionCount > 0)
        {
            row.Children.Add(Sep());
            var del = Ui.IconButton("trash", 18, 36, 36, "Delete selected strokes");
            Plain(del, "Delete selected strokes", "ink-delete");
            del.Click += (_, _) => _ink.DeleteSelection?.Invoke();
            row.Children.Add(del);
        }

        var close = Ui.IconButton("x", 18, 36, 36, "Close pen tools");
        Plain(close, "Close pen tools", "ink-close");
        close.HorizontalAlignment = HorizontalAlignment.Right;
        close.Click += (_, _) => _ink.ToggleBar();

        var host = new Grid { Padding = new Thickness(12, 3, 10, 3), BorderBrush = B("Border"), BorderThickness = new Thickness(0, 1, 0, 0) };
        host.Children.Add(row);
        host.Children.Add(close);
        return host;
    }
}
