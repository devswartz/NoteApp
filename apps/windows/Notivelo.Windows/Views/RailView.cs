using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

public enum AppRoute { Notes, Tasks, Calendar, Settings }

/// <summary>Rail (LOOK 4.2): 64 wide; Notes / Tasks / Calendar on top, sidebar toggle, search, bell, workspace and account at the foot.</summary>
internal sealed class RailView : ThemedControl
{
    private readonly INotesSource _source;
    private readonly Action? _signOut;
    private Workspace _ws => _source.Workspace;
    public AppRoute Route { get; private set; } = AppRoute.Notes;
    public bool SidebarOpen { get; private set; } = true;
    public event Action<AppRoute>? RouteChanged;
    public event Action? ToggleSidebar;
    public event Action<ThemeMode>? ThemeSelected;
    /// <summary>The theme now in use (the account menu marks it).</summary>
    public Func<ThemeMode>? CurrentTheme { get; set; }
    public event Action<string>? WorkspaceSelected;
    internal ShellHost? Host { get; set; }

    public RailView(INotesSource source, Action? signOut) { _source = source; _signOut = signOut; }

    public void Refresh() => Rebuild();

    public void SetRoute(AppRoute r) { Route = r; Rebuild(); }
    public void SetSidebarOpen(bool open) { SidebarOpen = open; Rebuild(); }

    protected override UIElement Build()
    {
        var root = new Grid { Padding = new Thickness(0, 10, 0, 10) };
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var top = new StackPanel { Spacing = 4 };
        top.Children.Add(ViewButton("book-open", "Notes", AppRoute.Notes));
        top.Children.Add(ViewButton("list-checks", "Tasks", AppRoute.Tasks));
        top.Children.Add(ViewButton("calendar-days", "Calendar", AppRoute.Calendar));
        root.Children.Add(top);

        var foot = new StackPanel { Spacing = 4, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom };
        var toggle = Ui.IconButton(SidebarOpen ? "panel-left-close" : "panel-left-open", 19, 40, 40, SidebarOpen ? "Hide sidebar" : "Show sidebar", 9);
        toggle.Click += (_, _) => ToggleSidebar?.Invoke();
        foot.Children.Add(toggle);
        var search = Ui.IconButton("search", 19, 40, 40, "Search (Ctrl+K)", 9);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(search, "rail-search");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(search, "Search");
        search.Click += (_, _) => Host?.OpenSearch();
        foot.Children.Add(search);
        foot.Children.Add(Ui.IconButton("bell", 19, 40, 40, "Notifications", 9));

        var ws = new Button { Style = Ui.Style("GhostButtonStyle"), Width = 40, Height = 40, CornerRadius = new CornerRadius(9) };
        ToolTipService.SetToolTip(ws, "Workspace");
        ws.Content = new Border
        {
            Width = 28, Height = 28, CornerRadius = new CornerRadius(8),
            Background = new LinearGradientBrush
            {
                StartPoint = new global::Windows.Foundation.Point(0, 0), EndPoint = new global::Windows.Foundation.Point(1, 1),
                GradientStops = { new GradientStop { Color = Ui.ColorOf("#6366f1"), Offset = 0 }, new GradientStop { Color = Ui.ColorOf("#8b5cf6"), Offset = 1 } },
            },
            Child = Ui.Text(_ws.Initial, 14, new SolidColorBrush(Microsoft.UI.Colors.White), 700).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; }),
        };
        // LOOK 4.9 workspace menu: the workspaces (role as the hint, a check on the open one), then Trash; opens to the right, bottom-aligned
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(ws, "rail-workspace");
        ws.Click += (_, _) =>
        {
            if (Host is null) return;
            var items = new List<MenuEntry>();
            foreach (var w in _source.Workspaces)
            {
                var id = w.Id;
                items.Add(new MenuEntry(w.Name, id == _source.CurrentWorkspaceId ? "check" : null, () => WorkspaceSelected?.Invoke(id), Hint: w.Role));
            }
            if (_source.CanEditTree)
            {
                if (items.Count > 0) items.Add(MenuEntry.Sep());
                items.Add(new MenuEntry("Trash", "trash", () => Host?.OpenTrash()));
            }
            if (items.Count == 0) return;
            var tl = ws.TransformToVisual(null).TransformPoint(new global::Windows.Foundation.Point(0, 0));
            var h = items.Sum(i => i.Height) + 14;
            PopupMenu.Show(Host.Overlay, items, null, at: new global::Windows.Foundation.Point(tl.X + ws.ActualWidth + 6, tl.Y + ws.ActualHeight - h), id: "menu-workspace");
        };
        foot.Children.Add(ws);

        var acct = new Button { Style = Ui.Style("GhostButtonStyle"), Width = 40, Height = 40, CornerRadius = new CornerRadius(9), Content = Ui.Avatar(_ws.UserInitials, 26) };
        ToolTipService.SetToolTip(acct, "Account");
        // LOOK 4.9 account menu: name and email, the theme switch, then Sign out; opens to the right, bottom-aligned
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(acct, "rail-account");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(acct, "Account");
        acct.Click += (_, _) =>
        {
            if (Host is null) return;
            var items = new List<MenuEntry> { MenuEntry.Block(AccountHeader, 52), MenuEntry.Sep(), new MenuEntry("Settings", "settings", () => Host?.OpenSettings(), Id: "menu-settings"), MenuEntry.Sep(), MenuEntry.Label("Theme"), MenuEntry.Block(ThemeSwitch, 48) };
            if (_signOut is not null)
            {
                items.Add(MenuEntry.Sep());
                items.Add(new MenuEntry("Sign out", "log-out", () => _signOut()));
            }
            var tl = acct.TransformToVisual(null).TransformPoint(new global::Windows.Foundation.Point(0, 0));
            var h = items.Sum(i => i.Height) + 14;
            PopupMenu.Show(Host.Overlay, items, null, at: new global::Windows.Foundation.Point(tl.X + acct.ActualWidth + 6, tl.Y + acct.ActualHeight - h), id: "menu-account", width: 262);
        };
        foot.Children.Add(acct);
        Grid.SetRow(foot, 1);
        root.Children.Add(foot);
        return root;
    }

    private UIElement AccountHeader(Func<string, Brush> b, Action close)
    {
        var col = new StackPanel { Spacing = 2, Padding = new Thickness(10, 8, 10, 8) };
        col.Children.Add(Ui.Text(_ws.UserName, 14, b("Text"), 600));
        if (_ws.UserEmail.Length > 0) col.Children.Add(Ui.Text(_ws.UserEmail, 12.5, b("TextMuted")));
        return col;
    }

    /// <summary>The Theme switch: Light, Dark, Hybrid (chrome dark, page light) as three segments on a subtle track.</summary>
    private UIElement ThemeSwitch(Func<string, Brush> b, Action close)
    {
        var now = CurrentTheme?.Invoke() ?? ThemeMode.Hybrid;
        var track = new Grid
        {
            ColumnSpacing = 2, Padding = new Thickness(2), Margin = new Thickness(4, 0, 4, 2), Height = 46, CornerRadius = new CornerRadius(8),
            Background = b("BgSubtle"), BorderBrush = b("Border"), BorderThickness = new Thickness(1),
        };
        var modes = new[] { (ThemeMode.Light, "Light", "sun"), (ThemeMode.Dark, "Dark", "moon"), (ThemeMode.Hybrid, "Hybrid", "contrast") };
        for (var i = 0; i < modes.Length; i++)
        {
            var (mode, label, icon) = modes[i];
            track.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var active = mode == now;
            var col = new StackPanel { Spacing = 3, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            col.Children.Add(new Icon(icon, 14, active ? b("Text") : b("TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center });
            col.Children.Add(Ui.Text(label, 11.5, active ? b("Text") : b("TextMuted"), 500).With(t => t.HorizontalAlignment = HorizontalAlignment.Center));
            var seg = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch, Padding = new Thickness(0),
                CornerRadius = new CornerRadius(6), Content = col, Background = active ? b("Bg") : null,
            };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(seg, "theme-" + label.ToLowerInvariant());
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(seg, label + (active ? " (selected)" : ""));
            seg.Click += (_, _) => { close(); ThemeSelected?.Invoke(mode); };
            Grid.SetColumn(seg, i);
            track.Children.Add(seg);
        }
        return track;
    }

    private UIElement ViewButton(string icon, string label, AppRoute route)
    {
        var active = Route == route;
        var content = new StackPanel { Spacing = 3, HorizontalAlignment = HorizontalAlignment.Center };
        content.Children.Add(new Icon(icon, 20) { HorizontalAlignment = HorizontalAlignment.Center });
        content.Children.Add(Ui.Text(label, 10.5, B("TextMuted"), 600, lineHeight: 10.5).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; t.ClearValue(TextBlock.ForegroundProperty); }));
        var btn = new ToggleButton
        {
            Style = Ui.Style("NavToggleStyle"), Width = 52, Padding = new Thickness(0, 7, 0, 6), CornerRadius = new CornerRadius(9),
            IsChecked = active, Content = content, HorizontalAlignment = HorizontalAlignment.Center,
            Foreground = B("TextMuted"),
        };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(btn, "rail-" + label.ToLowerInvariant());
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(btn, label);
        btn.Click += (_, _) => RouteChanged?.Invoke(route);
        var g = new Grid { HorizontalAlignment = HorizontalAlignment.Stretch };
        g.Children.Add(btn);
        if (active)
        {
            g.Children.Add(new Border
            {
                Width = 3, Height = 27, Background = B("Accent"), HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center, CornerRadius = new CornerRadius(0, 3, 3, 0),
            });
        }
        return g;
    }
}

internal static class UiExt
{
    public static T With<T>(this T t, Action<T> a) { a(t); return t; }
}
