using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Windows.System;

namespace Notivelo.Windows.Views;

/// <summary>The search palette (LOOK 4.12, Apple's Search.swift): a modal 620 wide, title matches from the tree at once, then the core's content search
/// (page text, task titles and descriptions) 150 ms after the last key. Enter opens the page or the task.</summary>
internal sealed class SearchPalette
{
    private sealed record Hit(bool IsTask, string Id, string Title, string Sub, IReadOnlyList<(string Text, bool Matched)>? Snippet, bool Done = false);

    private readonly ShellHost _h;
    private readonly OverlayHost _o;
    private readonly TextBox _input;
    private readonly StackPanel _list = new();
    private readonly List<Hit> _hits = new();
    private readonly List<Button> _rows = new();
    private readonly DispatcherTimerLite _timer;
    private string _query = "";
    private int _active;
    private OverlayHost.Layer? _layer;
    private bool _empty;

    public static void Show(ShellHost host, string initial = "") => new SearchPalette(host) { _initial = initial }.Open();
    private string _initial = "";

    private Brush B(string k) => ThemeBrushes.Get(k, _o);

    private SearchPalette(ShellHost host)
    {
        _h = host; _o = host.Overlay;
        _timer = new DispatcherTimerLite(150, () => _ = SearchCore());
        _input = new TextBox
        {
            Style = Ui.Style("PlainTextBoxStyle"), PlaceholderText = "Search pages and tasks…", FontSize = 16, BorderThickness = new Thickness(0), Background = new SolidColorBrush(Colors.Transparent),
            VerticalAlignment = VerticalAlignment.Center, Padding = new Thickness(0, 12, 0, 12), CornerRadius = new CornerRadius(0),
        };
        AutomationProperties.SetAutomationId(_input, "search-input");
        AutomationProperties.SetName(_input, "Search");
    }

    private void Open()
    {
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(52) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var head = new Grid { Padding = new Thickness(18, 0, 18, 0), ColumnSpacing = 12, BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1) };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.Children.Add(new Icon("search", 18, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(_input, 1);
        head.Children.Add(_input);
        root.Children.Add(head);
        var sv = new ScrollViewer { MaxHeight = 380, Content = _list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(6) };
        Grid.SetRow(sv, 1);
        root.Children.Add(sv);
        var foot = new Border
        {
            BorderBrush = B("Border"), BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(16, 9, 16, 9),
            Child = Ui.Text("↑↓ navigate · ↵ open · esc close", 12, B("TextMuted")),
        };
        Grid.SetRow(foot, 2);
        root.Children.Add(foot);
        var card = new Border
        {
            Width = 620, Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14), Child = root,
        };
        AutomationProperties.SetAutomationId(card, "search-palette");
        _layer = _o.Show(card, HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, Math.Max(40, _o.XamlRoot.Size.Height * 0.12), 0, 0), closed: () => _timer.Stop());
        _input.TextChanged += (_, _) => OnText();
        _input.KeyDown += OnKey;
        _input.Loaded += (_, _) => _input.Focus(FocusState.Programmatic);
        Show("");
        if (_initial.Length > 0) _input.Text = _initial;
    }

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        switch (e.Key)
        {
            case VirtualKey.Down: e.Handled = true; Move(1); break;
            case VirtualKey.Up: e.Handled = true; Move(-1); break;
            case VirtualKey.Enter: e.Handled = true; if (_active >= 0 && _active < _hits.Count) Choose(_hits[_active]); break;
        }
    }

    private void Move(int d)
    {
        if (_hits.Count == 0) return;
        _active = (_active + d + _hits.Count) % _hits.Count;
        Paint();
    }

    private void Choose(Hit h)
    {
        _layer?.Close();
        if (h.IsTask) _h.OpenTask(h.Id); else _h.OpenPage(h.Id);
    }

    private void OnText()
    {
        _query = _input.Text.Trim();
        if (_query.Length == 0) { _timer.Stop(); Show(""); return; }
        // the tree's title matches show at once; the core's answer replaces them
        var s = _h.Source;
        var hits = new List<Hit>();
        foreach (var (id, title, crumb) in s.SearchPages(_query, 8)) hits.Add(new Hit(false, id, title, crumb, null));
        foreach (var t in s.GetTaskGroups(TaskViewKind.All).SelectMany(g => g.Tasks).DistinctBy(t => t.Id).Where(t => t.Title.Contains(_query, StringComparison.OrdinalIgnoreCase)).Take(6))
            hits.Add(new Hit(true, t.Id, t.Title, t.DueLabel ?? "", null, t.Done));
        SetHits(hits);
        _timer.Restart();
    }

    private async Task SearchCore()
    {
        var q = _query;
        var r = await _h.Source.SearchAsync(q);
        if (r is null || q != _query) return;
        var hits = new List<Hit>();
        foreach (var p in r.Pages) hits.Add(new Hit(false, p.PageId, p.Title, p.Path, p.Snippet));
        foreach (var t in r.Tasks) hits.Add(new Hit(true, t.TaskId, t.Title, t.DueLabel ?? "", null, t.Done));
        SetHits(hits);
    }

    private void Show(string q)
    {
        // no query: the recent pages
        var hits = _h.Source.RecentPages(5).Select(r => new Hit(false, r.Page.Id, r.Page.Title, r.Where, null)).ToList();
        _empty = false;
        SetHits(hits, "Recent");
    }

    private void SetHits(List<Hit> hits, string? heading = null)
    {
        _hits.Clear(); _hits.AddRange(hits);
        _active = 0;
        _empty = hits.Count == 0 && _query.Length > 0;
        _heading = heading;
        Paint();
    }

    private string? _heading;

    private void Paint()
    {
        _list.Children.Clear(); _rows.Clear();
        if (_empty) { _list.Children.Add(Ui.Text("No results", 14, B("TextMuted")).With(t => t.Margin = new Thickness(12, 14, 12, 14))); return; }
        string? group = null;
        for (var i = 0; i < _hits.Count; i++)
        {
            var h = _hits[i];
            var g = _heading ?? (h.IsTask ? "Tasks" : "Pages");
            if (g != group)
            {
                group = g;
                _list.Children.Add(Ui.Text(g.ToUpperInvariant(), 11.5, B("TextMuted"), 600, tracking: 0.04).With(t => t.Margin = new Thickness(12, _list.Children.Count == 0 ? 6 : 12, 0, 4)));
            }
            _list.Children.Add(Row(h, i));
        }
    }

    private Button Row(Hit h, int i)
    {
        var g = new Grid { ColumnSpacing = 10 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(new Icon(h.IsTask ? "circle-check" : "file-text", 16, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        var title = Ui.Text(h.Title, 14, h.Done ? B("TextMuted") : B("Text"));
        title.MaxWidth = 300;
        if (h.Done) title.TextDecorations = TextDecorations.Strikethrough;
        Grid.SetColumn(title, 1);
        g.Children.Add(title);
        var sub = new TextBlock { FontSize = 12.5, Foreground = B("TextMuted"), TextTrimming = TextTrimming.CharacterEllipsis, TextWrapping = TextWrapping.NoWrap, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center, FontFamily = Ui.Font };
        if (h.Snippet is { Count: > 0 } runs && !h.IsTask)
        {
            sub.Inlines.Add(new Run { Text = h.Sub + " · " });
            foreach (var (text, matched) in runs)
                sub.Inlines.Add(matched ? new Run { Text = text, FontWeight = new FontWeight(700), Foreground = B("Accent") } : new Run { Text = text });
        }
        else sub.Text = h.Sub;
        Grid.SetColumn(sub, 2);
        g.Children.Add(sub);
        var b = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 38, Padding = new Thickness(12, 0, 12, 0), CornerRadius = new CornerRadius(8),
            HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g, IsTabStop = false,
            Background = i == _active ? B("BgHover") : new SolidColorBrush(Colors.Transparent),
        };
        AutomationProperties.SetAutomationId(b, (h.IsTask ? "search-result-task-" : "search-result-page-") + h.Id);
        AutomationProperties.SetName(b, h.Title);
        b.PointerEntered += (_, _) => { if (_active != i) { _active = i; foreach (var (r, k) in _rows.Select((r, k) => (r, k))) r.Background = k == i ? B("BgHover") : new SolidColorBrush(Colors.Transparent); } };
        b.Click += (_, _) => Choose(h);
        _rows.Add(b);
        return b;
    }
}

/// <summary>A one-shot debounce timer on the UI thread.</summary>
internal sealed class DispatcherTimerLite
{
    private readonly Microsoft.UI.Xaml.DispatcherTimer _t = new();
    public DispatcherTimerLite(int ms, Action fire)
    {
        _t.Interval = TimeSpan.FromMilliseconds(ms);
        _t.Tick += (_, _) => { _t.Stop(); fire(); };
    }
    public void Restart() { _t.Stop(); _t.Start(); }
    public void Stop() => _t.Stop();
}
