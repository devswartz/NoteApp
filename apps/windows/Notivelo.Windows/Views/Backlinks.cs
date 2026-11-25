using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The pages that link to the open page with a [[link]] (Apple's Backlinks.swift, the web's backlinks bar): read through the source when the page panel opens,
/// shown in the panel's "Linked" tab. A row opens that page.</summary>
internal sealed class BacklinksModel
{
    private readonly INotesSource _src;
    public string PageId { get; }
    public IReadOnlyList<BacklinkItem> Items { get; private set; } = Array.Empty<BacklinkItem>();
    public bool Loaded { get; private set; }
    public string? Failure { get; private set; }
    public event Action? Changed;

    public BacklinksModel(INotesSource src, string pageId) { _src = src; PageId = pageId; }

    public async void Reload()
    {
        var r = await _src.LoadBacklinks(PageId);
        Loaded = true;
        if (r.Ok) { Items = r.Value ?? Array.Empty<BacklinkItem>(); Failure = null; } else Failure = r.Error;
        Changed?.Invoke();
    }

    /// <summary>"Linked from 2 pages" (the tab's count and the empty line).</summary>
    public static string Line(int n) => n == 0 ? "No pages link here yet" : n == 1 ? "Linked from 1 page" : $"Linked from {n} pages";
}

/// <summary>The body of the page panel's Linked tab.</summary>
internal sealed class BacklinksBody : ThemedControl
{
    private readonly BacklinksModel _m;
    internal ShellHost? Host { get; set; }

    public BacklinksBody(BacklinksModel m)
    {
        _m = m;
        Loaded += (_, _) => _m.Changed += OnChanged;
        Unloaded += (_, _) => _m.Changed -= OnChanged;
    }

    private void OnChanged() => Rebuild();

    protected override UIElement Build()
    {
        var col = new StackPanel { Padding = new Thickness(10, 6, 10, 12), Spacing = 2 };
        var head = Ui.Text(!_m.Loaded ? "Looking for links…" : _m.Failure ?? BacklinksModel.Line(_m.Items.Count), 12.5, _m.Failure is null ? B("TextMuted") : B("Danger"));
        head.TextWrapping = TextWrapping.Wrap; head.TextTrimming = TextTrimming.None; head.Margin = new Thickness(6, 4, 6, 8);
        AutomationProperties.SetAutomationId(head, "backlinks-summary");
        AutomationProperties.SetName(head, head.Text);
        AutomationProperties.SetItemStatus(head, "count=" + _m.Items.Count);
        col.Children.Add(head);
        if (_m.Loaded && _m.Failure is null && _m.Items.Count == 0)
            col.Children.Add(Ui.Text("Type [[ in another page and pick this one to link to it.", 12.5, B("TextMuted"), lineHeight: 18).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.Margin = new Thickness(6, 0, 6, 0); }));
        foreach (var b in _m.Items)
        {
            var g = new Grid { ColumnSpacing = 10 };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(20) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.Children.Add(string.IsNullOrEmpty(b.Icon)
                ? new Icon("file-text", 16, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 2, 0, 0) }
                : new TextBlock { Text = b.Icon, FontSize = 15, FontFamily = new Microsoft.UI.Xaml.Media.FontFamily("Segoe UI Emoji"), VerticalAlignment = VerticalAlignment.Top });
            var text = new StackPanel();
            text.Children.Add(Ui.Text(b.Title.Length == 0 ? "Untitled" : b.Title, 14, B("Text"), 500, lineHeight: 19));
            text.Children.Add(Ui.Text(b.Where + (b.Updated.Length > 0 ? " · " + b.Updated : ""), 12, B("TextMuted"), lineHeight: 16));
            Grid.SetColumn(text, 1);
            g.Children.Add(text);
            var row = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Padding = new Thickness(8, 8, 8, 8),
                CornerRadius = new CornerRadius(8), Content = g,
            };
            AutomationProperties.SetAutomationId(row, "backlink-" + b.PageId);
            AutomationProperties.SetName(row, b.Title);
            var id = b.PageId;
            row.Click += (_, _) => Host?.OpenPage(id);
            col.Children.Add(row);
        }
        return new ScrollViewer { Content = col, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }
}
