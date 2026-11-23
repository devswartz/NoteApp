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
    private readonly OverlayHost _overlay = new();
    private readonly ShellHost _host;
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
        Root.Children.Add(_overlay);
        Grid.SetRowSpan(_overlay, 2);
        _host = new ShellHost(source, _overlay)
        {
            OpenPage = id => { _overlay.CloseAll(); _pageId = id; _route = AppRoute.Notes; Refresh(); },
            OpenTask = id => TaskSheet.Show(_host!, id),
            OpenSearch = () => { if (!_overlay.IsOpen) SearchPalette.Show(_host!); },
            OpenTrash = () => TrashDialog.Show(_host!),
        };
        _rail.Host = _host; _sidebar.Host = _host; _tasks.Host = _host; _page.Host = _host;
        KeyDown += OnShellKey;

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
        _rail.CurrentTheme = () => _theme;
        _rail.ThemeSelected += m => SetTheme(m);
        _sidebar.PageSelected += id => { _pageId = id; _route = AppRoute.Notes; Refresh(); };
        _page.TaskOpened += id => _host.OpenTask(id);
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
        DevShow();
    }

    /// <summary>Dev hook for passive screenshots (NOTIVELO_SHOW=search:text | trash | task:id | menu-section:id | menu-page:id | menu-notebook; loopback NOTIVELO_SERVER only):
    /// opens that overlay once the window has settled. No input is synthesised.</summary>
    private async void DevShow()
    {
        var spec = Environment.GetEnvironmentVariable("NOTIVELO_SHOW");
        if (string.IsNullOrEmpty(spec) || !(Environment.GetEnvironmentVariable("NOTIVELO_SERVER") ?? "").Contains("127.0.0.1")) return;
        await Task.Delay(2500);
        var i = spec.IndexOf(':');
        var kind = i < 0 ? spec : spec[..i]; var arg = i < 0 ? "" : spec[(i + 1)..];
        var at = new global::Windows.Foundation.Point(150, 190);
        switch (kind)
        {
            case "search": SearchPalette.Show(_host, arg); break;
            case "trash": await _source.Delete(TreeKind.Page, "geometry"); await _source.Delete(TreeKind.Page, "converted"); TrashDialog.Show(_host); break;
            case "task": TaskSheet.Show(_host, arg); break;
            case "menu-notebook": if (_source.Notebooks.FirstOrDefault() is { } nb) _host.Tree.NotebookMenu(_sidebar, nb); break;
            case "menu-section":
                foreach (var n in _source.Notebooks) foreach (var s in n.Sections) if (s.Id == arg) _host.Tree.SectionMenu(null, n, s, at);
                break;
            case "menu-page":
                foreach (var n in _source.Notebooks) foreach (var s in n.Sections) foreach (var p in s.Pages) if (p.Id == arg) _host.Tree.PageMenu(null, p, at);
                break;
        }
    }

    /// <summary>Dev/test hook (NOTIVELO_ROUTE=tasks|calendar|notes): start on another route.</summary>
    public void Navigate(AppRoute route, TaskViewKind? view = null) { _route = route; if (view is { } v) _taskView = v; Refresh(); }

    public void SetTheme(ThemeMode m) { _theme = m; ApplyTheme(); }

    // Dev hook (NOTIVELO_PAGE=<part of a title>): open that page as soon as the tree has loaded.
    private string? _devPage = Environment.GetEnvironmentVariable("NOTIVELO_PAGE");

    private void Refresh()
    {
        if (_devPage is not null && _pageId is null)
        {
            var hit = _source.RecentPages(500).FirstOrDefault(r => r.Page.Title.Contains(_devPage, StringComparison.OrdinalIgnoreCase));
            if (hit.Page is not null) { _pageId = hit.Page.Id; _route = AppRoute.Notes; _devPage = null; }
        }
        // a page that was deleted (or moved to the Trash) is no longer the one shown
        if (_pageId is not null && _source.CanEditTree && !_source.Loading && _source.PageTitleOf(_pageId) is null) _pageId = null;
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

    /// <summary>Ctrl+K (and Ctrl+Shift+F, Apple's Search shortcut) open the search palette. A focused box handles Ctrl+K itself (the link editor) and never lets it get here.</summary>
    private void OnShellKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Handled) return;
        var ctrl = InputKeyboardSource.GetKeyStateForCurrentThread(global::Windows.System.VirtualKey.Control).HasFlag(global::Windows.UI.Core.CoreVirtualKeyStates.Down);
        var shift = InputKeyboardSource.GetKeyStateForCurrentThread(global::Windows.System.VirtualKey.Shift).HasFlag(global::Windows.UI.Core.CoreVirtualKeyStates.Down);
        if (!ctrl) return;
        // no box has the keyboard: undo/redo still reach the live page (a box's own key handling marks the key handled first)
        if (_route == AppRoute.Notes && (e.Key == global::Windows.System.VirtualKey.Z || e.Key == global::Windows.System.VirtualKey.Y)
            && !_overlay.IsOpen && e.OriginalSource is not TextBox)
        {
            var undo = e.Key == global::Windows.System.VirtualKey.Z && !shift;
            if (_page.Undo(undo) is not null) e.Handled = true;
            return;
        }
        if ((e.Key == global::Windows.System.VirtualKey.K && !shift) || (e.Key == global::Windows.System.VirtualKey.F && shift))
        {
            e.Handled = true;
            _host.OpenSearch();
        }
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
