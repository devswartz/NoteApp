using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

public enum AppRoute { Notes, Tasks, Calendar }

/// <summary>Rail (LOOK 4.2): 64 wide; Notes / Tasks / Calendar on top, sidebar toggle, search, bell, workspace and account at the foot.</summary>
internal sealed class RailView : ThemedControl
{
    private readonly Workspace _ws;
    public AppRoute Route { get; private set; } = AppRoute.Notes;
    public bool SidebarOpen { get; private set; } = true;
    public event Action<AppRoute>? RouteChanged;
    public event Action? ToggleSidebar;
    public event Action? ThemeCycle;

    public RailView(Workspace ws) => _ws = ws;

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
        foot.Children.Add(Ui.IconButton("search", 19, 40, 40, "Search", 9));
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
        foot.Children.Add(ws);

        var acct = new Button { Style = Ui.Style("GhostButtonStyle"), Width = 40, Height = 40, CornerRadius = new CornerRadius(9), Content = Ui.Avatar(_ws.UserInitials, 26) };
        ToolTipService.SetToolTip(acct, "Account and settings (click to cycle theme)");
        acct.Click += (_, _) => ThemeCycle?.Invoke();
        foot.Children.Add(acct);
        Grid.SetRow(foot, 1);
        root.Children.Add(foot);
        return root;
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
