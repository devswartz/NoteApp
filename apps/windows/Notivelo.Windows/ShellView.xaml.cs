using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Notivelo.Windows.Views;

namespace Notivelo.Windows;

public enum ThemeMode { Hybrid, Light, Dark }

/// <summary>The app shell (LOOK 3.1 / 3.3): ribbon, rail, resizable sidebar, main (page, Tasks views). Wide layout only.</summary>
public sealed partial class ShellView : UserControl
{
    private const double SidebarDefault = 216, SidebarMin = 180, SidebarMax = 420;

    private readonly INotesSource _source;
    private readonly RailView _rail;
    private readonly SidebarView _sidebar;
    private readonly RibbonView _ribbon = new();
    private readonly PageView _page;
    private readonly TasksView _tasks;
    private AppRoute _route = AppRoute.Notes;
    private string? _pageId;
    private TaskViewKind _taskView = TaskViewKind.Today;
    private double _sidebarWidth = SidebarDefault;
    private bool _sidebarOpen = true;
    private ThemeMode _theme = ThemeMode.Hybrid;

    public ShellView(INotesSource source, Action? signOut = null)
    {
        _source = source;
        InitializeComponent();
        _pageId = source.InitialPageId;
        _rail = new RailView(source, signOut);
        _sidebar = new SidebarView(source);
        _page = new PageView(source);
        _tasks = new TasksView(source);

        RibbonHost.Child = _ribbon;
        RailHost.Child = _rail;
        SidebarHost.Child = _sidebar;
        PageCard.Child = _page;
        TasksHost.Child = _tasks;
        CalendarHost.Child = new TextBlock
        {
            Text = "Calendar comes later.", FontSize = 14, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Opacity = 0.6,
        };
        SidebarCell.Children.Add(MakeGrip());

        _rail.RouteChanged += r => { _route = r; Refresh(); };
        _rail.ToggleSidebar += () => { _sidebarOpen = !_sidebarOpen; ApplySidebar(); _rail.SetSidebarOpen(_sidebarOpen); };
        _rail.ThemeCycle += () => { _theme = (ThemeMode)(((int)_theme + 1) % 3); ApplyTheme(); };
        _sidebar.PageSelected += id => { _pageId = id; _route = AppRoute.Notes; Refresh(); };
        _page.PageOpened += id => { _pageId = id; _route = AppRoute.Notes; Refresh(); };
        _rail.WorkspaceSelected += id => { if (id == _source.CurrentWorkspaceId) return; _pageId = null; _source.SelectWorkspace(id); Refresh(); };
        // The source loads and syncs in the background and says so here (always on the UI thread).
        _source.Changed += (_, _) => Refresh();
        Unloaded += (_, _) => _source.OpenPage(null);
        _sidebar.TaskViewSelected += v => { _taskView = v; Refresh(); };

        SizeChanged += (_, e) => ApplyBreakpoints(e.NewSize.Width);
        ApplyTheme();
        ApplySidebar();
        Refresh();
    }

    /// <summary>Dev/test hook (NOTIVELO_ROUTE=tasks|calendar|notes): start on another route.</summary>
    public void Navigate(AppRoute route, TaskViewKind? view = null) { _route = route; if (view is { } v) _taskView = v; Refresh(); }

    public void SetTheme(ThemeMode m) { _theme = m; ApplyTheme(); }

    private void Refresh()
    {
        // The page is open (a live page) only while it is shown; leaving the Notes view closes it.
        _source.OpenPage(_route == AppRoute.Notes ? _pageId : null);
        _rail.SetRoute(_route);
        _sidebar.Update(_route, _pageId, _taskView);
        if (_page.PageId == _pageId) _page.Refresh(); else _page.SetPage(_pageId);
        _tasks.SetView(_taskView);
        PageCard.Visibility = _route == AppRoute.Notes ? Visibility.Visible : Visibility.Collapsed;
        TasksHost.Visibility = _route == AppRoute.Tasks ? Visibility.Visible : Visibility.Collapsed;
        CalendarHost.Visibility = _route == AppRoute.Calendar ? Visibility.Visible : Visibility.Collapsed;
        ApplyBreakpoints(ActualWidth);
    }

    private void ApplyBreakpoints(double width)
    {
        var mode = width >= 1280 ? RibbonMode.Full : width > 1023 ? RibbonMode.Compact : RibbonMode.Smallest;
        _ribbon.Update(_route, mode, _taskView);
    }

    private void ApplyTheme()
    {
        var chrome = _theme == ThemeMode.Light ? ElementTheme.Light : ElementTheme.Dark;
        var page = _theme == ThemeMode.Dark ? ElementTheme.Dark : ElementTheme.Light;
        Root.RequestedTheme = chrome;
        RibbonHost.RequestedTheme = chrome;
        RailHost.RequestedTheme = chrome;
        SidebarHost.RequestedTheme = chrome;
        // The main area: Hybrid shows the note page in the Light palette inset in dark chrome; other routes follow the chrome.
        MainHost.RequestedTheme = chrome;
        TasksHost.RequestedTheme = chrome;
        CalendarHost.RequestedTheme = chrome;
        PageCard.RequestedTheme = page;
        MainHost.Background = (Brush)ThemeBrushes.Get(_theme == ThemeMode.Light ? "Bg" : "BgSidebar", chrome);
        PageCard.Background = _theme == ThemeMode.Hybrid ? Ui.Hex("#fcfcfa") : ThemeBrushes.Get("Bg", page);
        // Hybrid: the page is inset 6 pt with 12 pt top corners and a 1 pt dark ring; other themes run it edge to edge.
        var inset = _theme == ThemeMode.Hybrid;
        PageCard.Margin = inset ? new Thickness(6, 6, 6, 0) : new Thickness(0);
        PageCard.CornerRadius = inset ? new CornerRadius(12, 12, 0, 0) : new CornerRadius(0);
        PageCard.BorderBrush = inset ? new SolidColorBrush(global::Windows.UI.Color.FromArgb(0x8C, 0, 0, 0)) : new SolidColorBrush(Colors.Transparent);
    }

    // ---- sidebar open/close and resize (6 pt grabber on its right edge, accent 2 pt line on hover/drag) ------------

    private void ApplySidebar()
    {
        SidebarColumn.Width = _sidebarOpen ? new GridLength(_sidebarWidth + 1) : new GridLength(0);
        SidebarCell.Visibility = _sidebarOpen ? Visibility.Visible : Visibility.Collapsed;
    }

    private UIElement MakeGrip()
    {
        var grip = new CursorBorder(InputSystemCursorShape.SizeWestEast)
        {
            Width = 6, HorizontalAlignment = HorizontalAlignment.Right, Background = new SolidColorBrush(Colors.Transparent), Margin = new Thickness(0, 0, -3, 0),
        };
        var line = new Border { Width = 2, HorizontalAlignment = HorizontalAlignment.Center, Visibility = Visibility.Collapsed };
        line.Background = ThemeBrushes.Get("Accent", ElementTheme.Dark);
        grip.Children.Add(line);
        var dragging = false;
        grip.PointerEntered += (_, _) => line.Visibility = Visibility.Visible;
        grip.PointerExited += (_, _) => { if (!dragging) line.Visibility = Visibility.Collapsed; };
        grip.PointerPressed += (s, e) => { dragging = true; grip.CapturePointer(e.Pointer); line.Visibility = Visibility.Visible; };
        grip.PointerMoved += (s, e) =>
        {
            if (!dragging) return;
            var x = e.GetCurrentPoint(Body).Position.X - 64;
            _sidebarWidth = Math.Clamp(x, SidebarMin, SidebarMax);
            ApplySidebar();
        };
        grip.PointerReleased += (s, e) => { dragging = false; grip.ReleasePointerCapture(e.Pointer); line.Visibility = Visibility.Collapsed; };
        return grip;
    }
}
