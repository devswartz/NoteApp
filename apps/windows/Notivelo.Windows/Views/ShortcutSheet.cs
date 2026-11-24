using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The keyboard-shortcut sheet (the web's "?" overlay, Apple's Keyboard shortcuts section): the shortcuts in groups, each key in a small cap.
/// Opened from the account menu, Ctrl+/ and ?. Esc or the x closes it.</summary>
internal static class ShortcutSheet
{
    public static void Show(ShellHost h)
    {
        var o = h.Overlay;
        if (o.IsOpen) o.CloseAll();   // one thing at a time (the account menu that opened this is already closed)
        Brush B(string k) => ThemeBrushes.Get(k, o);
        var panel = PageDialogs.Named("shortcuts-sheet", "Keyboard shortcuts", 6);
        OverlayHost.Layer? layer = null;
        var head = PageDialogs.Header(o, "Keyboard shortcuts", "For a keyboard. Press Esc to close.", () => layer?.Close(), "shortcuts-x");
        panel.Children.Add(head);
        var list = new StackPanel { Spacing = 2, Margin = new Thickness(0, 6, 0, 0) };
        foreach (var g in ShellRules.Shortcuts)
        {
            list.Children.Add(Ui.Text(g.Title.ToUpperInvariant(), 11.5, B("TextMuted"), 600, tracking: 0.04).With(t => t.Margin = new Thickness(2, list.Children.Count == 0 ? 2 : 16, 0, 4)));
            foreach (var s in g.Items)
            {
                var row = new Grid { Height = 30, Padding = new Thickness(2, 0, 2, 0) };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.Children.Add(Ui.Text(s.Title, 14, B("Text")).With(t => t.VerticalAlignment = VerticalAlignment.Center));
                var keys = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
                foreach (var k in s.Keys) keys.Children.Add(Cap(k, B));
                Grid.SetColumn(keys, 1);
                row.Children.Add(keys);
                AutomationProperties.SetAutomationId(row, "shortcut-" + PopupMenu.Slug(s.Title));
                AutomationProperties.SetName(row, s.Title + ": " + string.Join(" ", s.Keys));
                list.Children.Add(row);
            }
        }
        panel.Children.Add(new ScrollViewer { MaxHeight = 520, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(0, 0, 8, 0) });
        layer = PageDialogs.Open(o, 480, panel, 70);
        // the Esc key is read on the layer: give the keyboard to the close button
        if (head.Children.OfType<Button>().FirstOrDefault() is { } x) x.Loaded += (_, _) => x.Focus(FocusState.Programmatic);
        else head.Loaded += (_, _) => { if (FindFocusable(head) is { } f) f.Focus(FocusState.Programmatic); };
    }

    private static Control? FindFocusable(DependencyObject d)
    {
        for (var i = 0; i < Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChildrenCount(d); i++)
        {
            var c = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChild(d, i);
            if (c is Button b) return b;
            if (FindFocusable(c) is { } f) return f;
        }
        return null;
    }

    private static Border Cap(string key, Func<string, Brush> b) => new()
    {
        MinWidth = 22, Height = 22, Padding = new Thickness(6, 0, 6, 0), CornerRadius = new CornerRadius(5), Background = b("BgSubtle"),
        BorderBrush = b("Border"), BorderThickness = new Thickness(1, 1, 1, 2),
        Child = Ui.Text(key, 12, b("Text2"), 500).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; t.VerticalAlignment = VerticalAlignment.Center; t.FontFamily = Ui.Mono; }),
    };
}
