using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The notification inbox behind the bell (Apple's InboxModel; the web's inbox.ts): the newest notifications, how many are unread, "Load more" for older ones.
/// Online only (nothing is kept on the device). Calls go through the source, off the UI thread; this class lives on the UI thread.</summary>
internal sealed class InboxState
{
    private readonly INotesSource _source;
    private int _gen;

    public IReadOnlyList<InboxItem> Items { get; private set; } = Array.Empty<InboxItem>();
    public int Unread { get; private set; }
    public string? NextBefore { get; private set; }
    public bool Loaded { get; private set; }
    public bool LoadingMore { get; private set; }
    public string? Error { get; private set; }
    public event Action? Changed;

    public InboxState(INotesSource source) => _source = source;

    /// <summary>Ask again: the bell's count, and with <paramref name="list"/> (the inbox is open) the newest page too, unless older pages were loaded below it (then only the count follows).</summary>
    public async void Refresh(bool list)
    {
        var gen = _gen;
        try
        {
            if (list && (!Loaded || Items.Count <= 30))
            {
                var r = await _source.LoadInbox(null);
                if (gen != _gen) return;
                if (r.Ok) { Items = r.Value!.Items; Unread = r.Value.Unread; NextBefore = r.Value.NextBefore; Loaded = true; Error = null; }
                else if (!Loaded) Error = r.Error;
            }
            else
            {
                var n = await _source.UnreadCount();
                if (gen != _gen || n is not { } v) return;
                Unread = v;
            }
            Changed?.Invoke();
        }
        catch (Exception) { }
    }

    public async void LoadMore()
    {
        if (NextBefore is not { } before || LoadingMore) return;
        LoadingMore = true; Changed?.Invoke();
        var gen = _gen;
        try
        {
            var r = await _source.LoadInbox(before);
            if (gen != _gen) return;
            LoadingMore = false;
            if (r.Ok) { Items = AuditRules.Append(Items, r.Value!.Items); NextBefore = r.Value.NextBefore; Unread = r.Value.Unread; }
        }
        catch (Exception) { LoadingMore = false; }
        Changed?.Invoke();
    }

    public void MarkRead(string id)
    {
        var (items, unread) = AuditRules.MarkRead(Items, Unread, id);
        if (ReferenceEquals(items, Items)) return;
        Items = items; Unread = unread; Changed?.Invoke();
        _ = _source.MarkNotificationRead(id);
    }

    public void MarkAll()
    {
        (Items, Unread) = AuditRules.MarkAll(Items);
        Changed?.Invoke();
        _ = _source.MarkAllNotificationsRead();
    }
}

/// <summary>The bell's popover (the web's NotificationBell): title, "Mark all read", the list, an empty note; opens to the right of the rail's bell.</summary>
internal static class InboxPopover
{
    public static void Show(ShellHost host, FrameworkElement anchor)
    {
        var o = host.Overlay; var inbox = host.Inbox;
        Microsoft.UI.Xaml.Media.Brush B(string k) => ThemeBrushes.Get(k, o);
        var body = new StackPanel();
        var card = new Border
        {
            Width = 360, Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), Child = body,
        };
        AutomationProperties.SetAutomationId(body, "inbox-popover");
        AutomationProperties.SetName(body, "Notifications");
        OverlayHost.Layer? layer = null;
        void Draw()
        {
            body.Children.Clear();
            AutomationProperties.SetItemStatus(body, $"unread={inbox.Unread};items={inbox.Items.Count};more={(inbox.NextBefore is null ? 0 : 1)}");
            var head = new Grid { Padding = new Thickness(12, 10, 12, 10), ColumnSpacing = 8 };
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            head.Children.Add(Ui.Text("Notifications", 14, B("Text"), 600));
            if (inbox.Unread > 0)
            {
                var all = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6) };
                var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
                sp.Children.Add(new Icon("check-check", 14, B("Text2")));
                sp.Children.Add(Ui.Text("Mark all read", 12.5, B("Text2"), 500));
                all.Content = sp;
                AutomationProperties.SetAutomationId(all, "inbox-mark-all");
                AutomationProperties.SetName(all, "Mark all read");
                all.Click += (_, _) => inbox.MarkAll();
                Grid.SetColumn(all, 1);
                head.Children.Add(all);
            }
            body.Children.Add(head);
            body.Children.Add(Ui.HLine(B("Border")));
            if (!inbox.Loaded)
                body.Children.Add(Note(inbox.Error ?? "Loading…", inbox.Error is null ? B("TextMuted") : B("Danger"), "inbox-note"));
            else if (inbox.Items.Count == 0)
                body.Children.Add(Note("You’re all caught up. Mentions, replies and shares show up here.", B("TextMuted"), "inbox-empty"));
            else
            {
                var list = new StackPanel { Padding = new Thickness(4) };
                foreach (var n in inbox.Items) list.Children.Add(Row(n));
                if (inbox.NextBefore is not null)
                {
                    var more = new Button
                    {
                        Style = Ui.Style("GhostButtonStyle"), Height = 36, HorizontalAlignment = HorizontalAlignment.Stretch, CornerRadius = new CornerRadius(8), IsEnabled = !inbox.LoadingMore,
                        Content = Ui.Text(inbox.LoadingMore ? "Loading…" : "Load more", 12.5, B("Text2"), 500).With(t => t.HorizontalAlignment = HorizontalAlignment.Center),
                    };
                    AutomationProperties.SetAutomationId(more, "inbox-load-more");
                    AutomationProperties.SetName(more, "Load more");
                    more.Click += (_, _) => inbox.LoadMore();
                    list.Children.Add(more);
                }
                body.Children.Add(new ScrollViewer { MaxHeight = 440, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
            }
        }
        TextBlock Note(string text, Microsoft.UI.Xaml.Media.Brush fg, string id) => Ui.Text(text, 12.5, fg).With(t =>
        {
            t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.Margin = new Thickness(12, 16, 12, 16);
            AutomationProperties.SetAutomationId(t, id); AutomationProperties.SetName(t, text);
        });
        UIElement Row(InboxItem n)
        {
            var g = new Grid { ColumnSpacing = 10, Padding = new Thickness(8) };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            UIElement avatar = n.ActorName is { } who
                ? Ui.Avatar(AccountRules.Initials(who, ""), 28, n.ActorColor is { Length: 7 } c && c[0] == '#' ? c : "#6366f1")
                : new Border { Width = 28, Height = 28, CornerRadius = new CornerRadius(14), Background = B("BgSubtle"), Child = new Icon(AuditRules.InboxIcon(n.Kind), 15, B("Text2")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } };
            ((FrameworkElement)avatar).VerticalAlignment = VerticalAlignment.Top;
            g.Children.Add(avatar);
            var col = new StackPanel { Spacing = 2 };
            col.Children.Add(Ui.Text(n.Title, 13, B("Text"), n.IsRead ? 400 : 600).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; }));
            if (n.Body.Length > 0) col.Children.Add(Ui.Text(n.Body, 12, B("TextMuted")));
            col.Children.Add(Ui.Text(AuditRules.Ago(n.CreatedAt, DateTimeOffset.UtcNow), 12, B("TextMuted")));
            Grid.SetColumn(col, 1);
            g.Children.Add(col);
            if (!n.IsRead)
            {
                var dot = new Border { Width = 8, Height = 8, CornerRadius = new CornerRadius(4), Background = B("Accent"), VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 6, 0, 0) };
                Grid.SetColumn(dot, 2);
                g.Children.Add(dot);
            }
            var b = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), Padding = new Thickness(0), CornerRadius = new CornerRadius(8), HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g,
            };
            AutomationProperties.SetAutomationId(b, "inbox-item-" + n.Id);
            AutomationProperties.SetName(b, n.Title);
            AutomationProperties.SetItemStatus(b, n.IsRead ? "read" : "unread");
            b.Click += (_, _) =>
            {
                inbox.MarkRead(n.Id);
                layer?.Close();
                if (n.TaskId is { } t) host.OpenTask(t); else if (n.PageId is { } p) host.OpenPage(p);
            };
            return b;
        }
        Action redraw = Draw;
        inbox.Changed += redraw;
        Draw();
        var tl = anchor.TransformToVisual(null).TransformPoint(new global::Windows.Foundation.Point(0, 0));
        var hh = o.XamlRoot.Size.Height;
        var y = Math.Max(8, Math.Min(tl.Y - 200, hh - 480));
        layer = o.Show(card, HorizontalAlignment.Left, VerticalAlignment.Top, new Thickness(tl.X + anchor.ActualWidth + 6, y, 0, 0), dim: false, closed: () => inbox.Changed -= redraw);
        inbox.Refresh(list: true);
    }
}
