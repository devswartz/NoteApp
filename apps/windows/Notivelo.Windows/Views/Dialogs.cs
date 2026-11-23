using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Windows.System;

namespace Notivelo.Windows.Views;

/// <summary>Small modal forms on the overlay: a name prompt, a confirmation, a destination picker.</summary>
internal static class Dialogs
{
    public static Button Btn(OverlayHost host, string text, bool primary, bool danger = false, string? id = null)
    {
        Brush B(string k) => ThemeBrushes.Get(k, host);
        var b = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 32, Padding = new Thickness(14, 0, 14, 0), CornerRadius = new CornerRadius(8),
            Content = Ui.Text(text, 13.5, primary || danger ? B("TextOnAccent") : B("Text"), 600),
            Background = danger ? B("Danger") : primary ? B("AccentSolid") : B("BgElevated"),
            BorderBrush = primary || danger ? B("Border") : B("Border"), BorderThickness = new Thickness(primary || danger ? 0 : 1),
        };
        if (id is not null) AutomationProperties.SetAutomationId(b, id);
        AutomationProperties.SetName(b, text);
        return b;
    }

    public static Border Card(OverlayHost host, double width, UIElement content) => new()
    {
        Width = width, Background = ThemeBrushes.Get("BgElevated", host), BorderBrush = ThemeBrushes.Get("Border", host), BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(14), Padding = new Thickness(20, 18, 20, 16), Child = content,
    };

    /// <summary>A name form. <paramref name="submit"/> returns an error sentence to show (the form stays open) or null (it closes).</summary>
    public static void Prompt(OverlayHost host, string title, string label, string initial, string okText, Func<string, Task<string?>> submit)
    {
        Brush B(string k) => ThemeBrushes.Get(k, host);
        var panel = new StackPanel { Spacing = 10 };
        panel.Children.Add(Ui.Text(title, 16, B("Text"), 650));
        panel.Children.Add(Ui.Text(label, 12.5, B("TextMuted")));
        var input = new TextBox { Text = initial, Height = 36, FontSize = 14, Padding = new Thickness(10, 7, 10, 7), CornerRadius = new CornerRadius(8) };
        AutomationProperties.SetAutomationId(input, "prompt-input");
        AutomationProperties.SetName(input, label);
        panel.Children.Add(input);
        var error = Ui.Text("", 12.5, B("Danger"));
        error.TextWrapping = TextWrapping.Wrap; error.TextTrimming = TextTrimming.None; error.Visibility = Visibility.Collapsed;
        panel.Children.Add(error);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 6, 0, 0) };
        var cancel = Btn(host, "Cancel", false, id: "prompt-cancel");
        var ok = Btn(host, okText, true, id: "prompt-ok");
        row.Children.Add(cancel); row.Children.Add(ok);
        panel.Children.Add(row);
        var layer = host.Show(Card(host, 400, panel), HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, 140, 0, 0));
        var busy = false;
        async void Go()
        {
            var text = input.Text.Trim();
            if (busy || text.Length == 0) return;
            busy = true; ok.IsEnabled = false;
            var err = await submit(text);
            busy = false; ok.IsEnabled = true;
            if (err is null) layer.Close();
            else { error.Text = err; error.Visibility = Visibility.Visible; }
        }
        ok.Click += (_, _) => Go();
        cancel.Click += (_, _) => layer.Close();
        input.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) { e.Handled = true; Go(); } };
        input.Loaded += (_, _) => { input.Focus(FocusState.Programmatic); input.SelectAll(); };
    }

    public static void Confirm(OverlayHost host, string title, string body, string okText, bool danger, Func<Task<string?>> run)
    {
        Brush B(string k) => ThemeBrushes.Get(k, host);
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(Ui.Text(title, 16, B("Text"), 650).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; }));
        panel.Children.Add(Ui.Text(body, 13.5, B("Text2")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; }));
        var error = Ui.Text("", 12.5, B("Danger"));
        error.TextWrapping = TextWrapping.Wrap; error.TextTrimming = TextTrimming.None; error.Visibility = Visibility.Collapsed;
        panel.Children.Add(error);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 8, 0, 0) };
        var cancel = Btn(host, "Cancel", false, id: "confirm-cancel");
        var ok = Btn(host, okText, !danger, danger, "confirm-ok");
        row.Children.Add(cancel); row.Children.Add(ok);
        panel.Children.Add(row);
        var layer = host.Show(Card(host, 400, panel), HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, 140, 0, 0));
        ok.Click += async (_, _) =>
        {
            ok.IsEnabled = false;
            var err = await run();
            ok.IsEnabled = true;
            if (err is null) layer.Close(); else { error.Text = err; error.Visibility = Visibility.Visible; }
        };
        cancel.Click += (_, _) => layer.Close();
        ok.Loaded += (_, _) => cancel.Focus(FocusState.Programmatic);
    }

    /// <summary>One destination of the "Move to…" picker: a label only (not pickable: a notebook when moving a page) or a row to pick, indented by depth.</summary>
    internal sealed record Dest(string Label, int Depth, bool Pickable, string NotebookId, string? SectionId, bool Current = false);

    public static void Pick(OverlayHost host, string title, IReadOnlyList<Dest> dests, Func<Dest, Task<string?>> choose)
    {
        Brush B(string k) => ThemeBrushes.Get(k, host);
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(Ui.Text(title, 16, B("Text"), 650));
        var list = new StackPanel();
        OverlayHost.Layer? layer = null;
        var error = Ui.Text("", 12.5, B("Danger"));
        error.TextWrapping = TextWrapping.Wrap; error.TextTrimming = TextTrimming.None; error.Visibility = Visibility.Collapsed;
        foreach (var d in dests)
        {
            if (!d.Pickable)
            {
                list.Children.Add(Ui.Text(d.Label.ToUpperInvariant(), 11.5, B("TextMuted"), 600, tracking: 0.04).With(t => t.Margin = new Thickness(10, list.Children.Count == 0 ? 2 : 12, 0, 4)));
                continue;
            }
            var dest = d;
            var g = new Grid { ColumnSpacing = 8, Margin = new Thickness(14 * d.Depth, 0, 0, 0) };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.Children.Add(new Icon(d.SectionId is null ? "book-open" : "folder", 14, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
            var label = Ui.Text(d.Label + (d.Current ? "  (current)" : ""), 14, d.Current ? B("TextMuted") : B("Text"));
            Grid.SetColumn(label, 1);
            g.Children.Add(label);
            var b = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), Height = 32, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6), IsEnabled = !d.Current,
                HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g,
            };
            AutomationProperties.SetAutomationId(b, "dest-" + PopupMenu.Slug(d.Label));
            AutomationProperties.SetName(b, d.Label);
            b.Click += async (_, _) =>
            {
                var err = await choose(dest);
                if (err is null) layer?.Close(); else { error.Text = err; error.Visibility = Visibility.Visible; }
            };
            list.Children.Add(b);
        }
        panel.Children.Add(new ScrollViewer { MaxHeight = 360, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        panel.Children.Add(error);
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 4, 0, 0) };
        var cancel = Btn(host, "Cancel", false, id: "pick-cancel");
        row.Children.Add(cancel);
        panel.Children.Add(row);
        layer = host.Show(Card(host, 420, panel), HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, 100, 0, 0));
        cancel.Click += (_, _) => layer.Close();
    }
}
