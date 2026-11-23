using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace Notivelo.Windows.Controls;

/// <summary>One row of a popup menu (LOOK 4.9): icon, label, optional hint, danger styling, or a separator.</summary>
internal sealed record MenuEntry(string Text, string? Icon = null, Action? Click = null, bool Danger = false, string? Hint = null, bool Separator = false,
    string? TileColor = null, bool Check = false, bool Lock = false, bool Heading = false, Func<Func<string, Brush>, Action, UIElement>? Custom = null, double CustomHeight = 0, string? Id = null)
{
    public static MenuEntry Sep() => new("", Separator: true);
    /// <summary>A small muted section label ("MY NOTEBOOKS").</summary>
    public static MenuEntry Label(string text) => new(text, Heading: true);
    /// <summary>A row of its own content (the account menu's header and theme switch); gets the brush lookup and the menu's close action.</summary>
    public static MenuEntry Block(Func<Func<string, Brush>, Action, UIElement> build, double height) => new("", Custom: build, CustomHeight: height);
    internal double Height => Separator ? 13 : Custom is not null ? CustomHeight : Heading ? 24 : 32;
}

/// <summary>The popover menu of LOOK 4.9, drawn on the <see cref="OverlayHost"/>: --bg-elevated, 1 pt border, radius 12, padding 6, min 220 wide;
/// items 32 high, radius 6, icon column 18 wide; opens 6 pt below its anchor and stays 8 pt inside the window.</summary>
internal static class PopupMenu
{
    private static TextBlock LetterOf(string name)
    {
        var t = Ui.Text(name.Length > 0 ? name[..1].ToUpperInvariant() : "N", 10, new SolidColorBrush(Microsoft.UI.Colors.White), 700);
        t.HorizontalAlignment = HorizontalAlignment.Center;
        return t;
    }

    public static string Slug(string text) => System.Text.RegularExpressions.Regex.Replace(new string(text.ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray()), "-+", "-").Trim('-');

    /// <summary>Open the menu under <paramref name="anchor"/> (end-aligned for "..." buttons) or, with <paramref name="at"/>, at a point in the host's coordinates.</summary>
    public static void Show(OverlayHost host, IReadOnlyList<MenuEntry> items, FrameworkElement? anchor, bool endAlign = false, Point? at = null, string? id = null, double width = 252)
    {
        Brush B(string k) => ThemeBrushes.Get(k, host);
        var list = new StackPanel();
        OverlayHost.Layer? layer = null;
        foreach (var it in items)
        {
            if (it.Separator)
            {
                var sep = Ui.HLine(B("Border"));
                sep.Margin = new Thickness(-6, 6, -6, 6);
                list.Children.Add(sep);
                continue;
            }
            if (it.Custom is not null) { list.Children.Add(it.Custom(B, () => layer?.Close())); continue; }
            if (it.Heading)
            {
                var h = Ui.Text(it.Text.ToUpperInvariant(), 11, B("TextMuted"), 600, tracking: 0.04);
                h.Margin = new Thickness(10, 6, 10, 4);
                list.Children.Add(h);
                continue;
            }
            var fg = it.Danger ? B("Danger") : B("Text");
            var g = new Grid { ColumnSpacing = 10 };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            if (it.Icon is not null) g.Children.Add(new Icon(it.Icon, 15, it.Danger ? B("Danger") : B("TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
            if (it.TileColor is not null)
                g.Children.Add(new Border
                {
                    Width = 18, Height = 18, CornerRadius = new CornerRadius(5), Background = Ui.Hex(it.TileColor), VerticalAlignment = VerticalAlignment.Center,
                    Child = LetterOf(it.Text),
                });
            var label = Ui.Text(it.Text, 14, fg);
            UIElement mid = label;
            if (it.Check || it.Lock)
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
                row.Children.Add(label);
                if (it.Check) row.Children.Add(new Icon("check", 14, B("Accent")) { VerticalAlignment = VerticalAlignment.Center });
                if (it.Lock) row.Children.Add(new Icon("lock", 13, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
                mid = row;
            }
            Grid.SetColumn((FrameworkElement)mid, 1);
            g.Children.Add(mid);
            if (it.Hint is not null)
            {
                var hint = Ui.Text(it.Hint, 12, B("TextMuted"));
                Grid.SetColumn(hint, 2);
                g.Children.Add(hint);
            }
            var b = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), Height = 32, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6),
                HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g, Foreground = fg,
            };
            AutomationProperties.SetAutomationId(b, it.Id ?? "menu-" + Slug(it.Text));
            AutomationProperties.SetName(b, it.Text);
            var click = it.Click;
            b.Click += (_, _) => { layer?.Close(); click?.Invoke(); };
            list.Children.Add(b);
        }
        var card = new Border
        {
            Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), Padding = new Thickness(6),
            MinWidth = Math.Min(220, width), Child = list,
        };
        if (id is not null) { AutomationProperties.SetAutomationId(list, id); AutomationProperties.SetName(list, id); }   // on the StackPanel: a Border has no UIA peer
        var height = items.Sum(i => i.Height) + 14;
        card.Width = Math.Max(card.MinWidth, width);
        var hw = host.XamlRoot.Size.Width; var hh = host.XamlRoot.Size.Height;
        double x, y;
        if (at is { } p) { x = p.X; y = p.Y; }
        else
        {
            var tl = anchor!.TransformToVisual(null).TransformPoint(new Point(0, 0));
            x = endAlign ? tl.X + anchor.ActualWidth - width : tl.X;
            y = tl.Y + anchor.ActualHeight + 6;
        }
        x = Math.Max(8, Math.Min(x, hw - width - 8));
        if (y + height > hh - 8) y = Math.Max(8, hh - height - 8);
        layer = host.Show(card, HorizontalAlignment.Left, VerticalAlignment.Top, new Thickness(x, y, 0, 0), dim: false);
        card.Loaded += (_, _) => { if (list.Children.OfType<Button>().FirstOrDefault() is { } first) first.Focus(FocusState.Programmatic); };
    }
}
