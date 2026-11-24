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

/// <summary>The app shell (LOOK 3.1 / 3.3): ribbon, rail, resizable sidebar, main (page, Tasks views). Wide layout only.</summary>
public sealed partial class ShellView : UserControl
{
    private const double SidebarDefault = 216, SidebarMin = 180, SidebarMax = 420;

    private readonly INotesSource _source;
    private readonly RailView _rail;
    private readonly SidebarView _sidebar;
    private readonly RibbonView _ribbon = new();
    private readonly InkBar _inkBar = new() { Visibility = Visibility.Collapsed };
    private readonly PageView _page;
    private readonly TasksView _tasks;
    private readonly CalendarMonthView _calendar;
    private readonly SettingsView _settings;
    private AppRoute _before = AppRoute.Tasks;
    private readonly OverlayHost _overlay = new();
    private readonly ShellHost _host;
    private AppRoute _route = AppRoute.Notes;
    private string? _pageId;
    private TaskViewKind _taskView = TaskViewKind.Today;
    private double _sidebarWidth = SidebarDefault;
    private bool _sidebarOpen = true;
    private ThemeMode _theme = ShellRules.ParseTheme(AppSettings.Theme, ThemeMode.Hybrid);
    private readonly global::Windows.UI.ViewManagement.UISettings _ui = new();
    private readonly Border _offlinePill = new();
    private readonly global::Microsoft.UI.Xaml.DispatcherTimer _offlineTimer = new() { Interval = TimeSpan.FromSeconds(5) };
    private DateTime? _offlineSince;
    private bool _pillDismissed;
    private readonly global::Microsoft.UI.Xaml.DispatcherTimer _inboxTimer = new() { Interval = TimeSpan.FromSeconds(60) };
    private readonly global::Microsoft.UI.Xaml.DispatcherTimer _reminderTimer = new() { Interval = TimeSpan.FromMinutes(5) };
    private long _remindersFor = -1;
    private static readonly bool ForceOffline = Environment.GetEnvironmentVariable("NOTIVELO_FORCE_OFFLINE") == "1";

    public ShellView(INotesSource source, Action? signOut = null, string? server = null)
    {
        _source = source;
        ThemeBrushes.ApplyAccent(AppSettings.Accent);
        InitializeComponent();
        _pageId = source.InitialPageId;
        _rail = new RailView(source, signOut);
        _sidebar = new SidebarView(source);
        _page = new PageView(source);
        _tasks = new TasksView(source);
        _calendar = new CalendarMonthView(source);
        _settings = new SettingsView(source, () => _theme, m => SetTheme(m), signOut, server);
        Root.Children.Add(BuildOfflinePill());
        Root.Children.Add(_overlay);
        Grid.SetRowSpan(_overlay, 2);
        _host = new ShellHost(source, _overlay)
        {
            OpenPage = id => { _overlay.CloseAll(); _pageId = id; _route = AppRoute.Notes; Refresh(); },
            OpenTask = id => TaskSheet.Show(_host!, id),
            OpenSearch = () => { if (!_overlay.IsOpen) SearchPalette.Show(_host!); },
            OpenTrash = () => TrashDialog.Show(_host!),
            OpenQuickAdd = s => QuickAddDialog.Show(_host!, s),
            OpenSettings = () => { _overlay.CloseAll(); GoTo(AppRoute.Settings); },
            OpenShortcuts = () => ShortcutSheet.Show(_host!),
        };
        _rail.Host = _host; _sidebar.Host = _host; _tasks.Host = _host; _page.Host = _host; _calendar.Host = _host; _settings.Host = _host;
        KeyDown += OnShellKey;
        // pictures and files added in a box (upload errors, saved files) report through the shell's toasts
        Action<string, bool> notice = (t, err) => _host.Toast(t, err);
        Action<string> sourceNotice = t => DispatcherQueue.TryEnqueue(() => _host.Toast(t));
        Loaded += (_, _) => _source.Notice += sourceNotice;
        Unloaded += (_, _) => _source.Notice -= sourceNotice;
        Loaded += (_, _) => BoxTextView.Notice += notice;
        Unloaded += (_, _) => BoxTextView.Notice -= notice;

        var ribbonStack = new StackPanel();
        ribbonStack.Children.Add(_ribbon);
        ribbonStack.Children.Add(_inkBar);
        RibbonHost.Child = ribbonStack;
        InkTool.Shared.Changed += UpdateInkBar;
        RailHost.Child = _rail;
        SidebarHost.Child = _sidebar;
        PageCard.Child = _page;
        TasksHost.Child = _tasks;
        CalendarHost.Child = _calendar;
        SettingsHost.Child = _settings;
        SidebarCell.Children.Add(MakeGrip());

        _rail.RouteChanged += r => GoTo(r);
        _ribbon.Invoked += OnRibbon;
        _ribbon.TaskState = () => _tasks.State;
        _ribbon.MenuRequested += (tip, anchor) => _tasks.ShowMenu(tip, anchor);
        _tasks.StateChanged += () => _ribbon.Refresh();
        _ribbon.PageSettingChosen += OnPageSetting;
        // the bell: the unread count on sign-in, when the window comes to the front and every minute
        Action activated = () => DispatcherQueue.TryEnqueue(() => _host.Inbox.Refresh(false));
        Loaded += (_, _) => { MainWindow.WindowActivated += activated; _inboxTimer.Start(); _host.Inbox.Refresh(false); };
        Unloaded += (_, _) => { MainWindow.WindowActivated -= activated; _inboxTimer.Stop(); TaskbarBadge.Set(0); };
        _inboxTimer.Tick += (_, _) => _host.Inbox.Refresh(false);
        // reminder toasts: planned from the core's reminders on sign-in, every 5 minutes and when the task list changed
        _reminderTimer.Tick += (_, _) => _ = ReminderToasts.SyncAsync(_source);
        Action<Dictionary<string, string>, IDictionary<string, string>> toastTapped = (a, input) => DispatcherQueue.TryEnqueue(() => OnReminderToast(a, input));
        Loaded += (_, _) => { _reminderTimer.Start(); ReminderToasts.RegisterActivation(); ReminderToasts.Activated += toastTapped; _ = ReminderToasts.SyncAsync(_source); };
        Unloaded += (_, _) => { _reminderTimer.Stop(); ReminderToasts.Activated -= toastTapped; ReminderToasts.Clear(); };
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

        // System follows Windows' light / dark setting live
        _ui.ColorValuesChanged += (_, _) => DispatcherQueue.TryEnqueue(() => { if (_theme == ThemeMode.System) ApplyTheme(); });
        _offlineTimer.Tick += (_, _) => UpdateOffline();
        Loaded += (_, _) => { _offlineTimer.Start(); UpdateOffline(); };
        Unloaded += (_, _) => _offlineTimer.Stop();
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
    public void Navigate(AppRoute route, TaskViewKind? view = null) { if (view is { } v) _taskView = v; GoTo(route); }

    /// <summary>Show a route. Settings keeps the sidebar of the route it was opened from and the ribbon's back arrow returns to it.</summary>
    private void GoTo(AppRoute route)
    {
        if (route == AppRoute.Settings && _route != AppRoute.Settings) _before = _route;
        _route = route;
        Refresh();
    }

    /// <summary>The ribbon buttons that do something outside the page: New task (Tasks, Calendar), the Calendar's navigation, Settings' back arrow.</summary>
    /// <summary>A reminder toast was tapped: Open task shows the task; Snooze moves the reminder (the core's snooze with a push's token, else this PC's toast).</summary>
    private async void OnReminderToast(Dictionary<string, string> args, IDictionary<string, string> input)
    {
        var action = args.GetValueOrDefault("action", "open");
        if (action == "snooze")
        {
            var option = input.TryGetValue("snooze", out var o) ? o : "10m";
            _host.Toast(await ReminderToasts.SnoozeAsync(_source, args, option));
            return;
        }
        MainWindow.Instance?.Activate();
        if (args.GetValueOrDefault("task", "") is { Length: > 0 } task) _host.OpenTask(task);
    }

    private void OnRibbon(string tip)
    {
        switch (tip)
        {
            case "New task": QuickAddDialog.Show(_host, null); break;
            case "Print" when _route == AppRoute.Notes: _page.Print(); break;
            case "Today" or "Upcoming" or "My Tasks" or "All tasks" when _route == AppRoute.Tasks:
                _taskView = tip switch { "Today" => TaskViewKind.Today, "Upcoming" => TaskViewKind.Upcoming, "My Tasks" => TaskViewKind.MyTasks, _ => TaskViewKind.All };
                Refresh(); break;
            case "Today" when _route == AppRoute.Calendar: _calendar.GoToday(); break;
            case "Previous" when _route == AppRoute.Calendar: _calendar.Step(-1); break;
            case "Next" when _route == AppRoute.Calendar: _calendar.Step(1); break;
            case "Week" or "Month" when _route == AppRoute.Calendar: _calendar.SetWeek(tip == "Week"); _ribbon.Refresh(); break;
            case "Mine" or "Everyone" when _route == AppRoute.Calendar: _calendar.SetEveryone(tip == "Everyone"); _ribbon.Refresh(); break;
            case "Clear filters" when _route == AppRoute.Tasks: _tasks.ClearFilters(); break;
            case "Back" when _route == AppRoute.Settings: GoTo(_before == AppRoute.Settings ? AppRoute.Notes : _before); break;
        }
    }

    /// <summary>Page colour or Rule lines from the ribbon: written by the source, an error as a toast.</summary>
    private async void OnPageSetting(string kind, string value)
    {
        if (_pageId is not { } id) return;
        var err = await _source.SetPageSetting(id, kind, value);
        if (err is not null) _host.Toast(err, true);
    }

    public void SetTheme(ThemeMode m, bool persist = true)
    {
        _theme = m; ApplyTheme();
        if (persist) AppSettings.Theme = ShellRules.ThemeKey(m);
    }

    /// <summary>Windows is set to dark apps (NOTIVELO_SYSTEM_THEME=dark|light overrides it for the tests).</summary>
    private bool SystemIsDark()
    {
        switch (Environment.GetEnvironmentVariable("NOTIVELO_SYSTEM_THEME")?.ToLowerInvariant())
        {
            case "dark": return true;
            case "light": return false;
        }
        try { var c = _ui.GetColorValue(global::Windows.UI.ViewManagement.UIColorType.Background); return c.R < 128; } catch (Exception) { return false; }
    }

    // ---- offline pill (Apple's OfflineBanner): after 30 s without a connection, a small pill at the bottom centre; its x keeps it away until the next reconnect ----

    private UIElement BuildOfflinePill()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(new Border { Width = 7, Height = 7, CornerRadius = new CornerRadius(3.5), Background = ThemeBrushes.Get("Warn", ElementTheme.Dark), VerticalAlignment = VerticalAlignment.Center });
        row.Children.Add(Ui.Text(ShellRules.OfflineText, 11.5, ThemeBrushes.Get("TextMuted", ElementTheme.Dark), 500).With(t => t.VerticalAlignment = VerticalAlignment.Center));
        var x = Ui.IconButton("x", 12, 22, 22, "Dismiss");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(x, "offline-pill-x");
        x.Click += (_, _) => { _pillDismissed = true; UpdateOffline(); };
        row.Children.Add(x);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(row, "offline-pill");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(row, ShellRules.OfflineText);
        _offlinePill.Child = row;
        _offlinePill.Padding = new Thickness(12, 4, 4, 4);
        _offlinePill.CornerRadius = new CornerRadius(16);
        _offlinePill.BorderThickness = new Thickness(1);
        _offlinePill.HorizontalAlignment = HorizontalAlignment.Center;
        _offlinePill.VerticalAlignment = VerticalAlignment.Bottom;
        _offlinePill.Margin = new Thickness(0, 0, 0, 16);
        _offlinePill.RequestedTheme = ElementTheme.Dark;
        _offlinePill.Background = ThemeBrushes.Get("BgElevated", ElementTheme.Dark);
        _offlinePill.BorderBrush = ThemeBrushes.Get("Border", ElementTheme.Dark);
        _offlinePill.Visibility = Visibility.Collapsed;
        Grid.SetRowSpan(_offlinePill, 2);
        return _offlinePill;
    }

    private void UpdateOffline()
    {
        var off = _source.IsOffline;
        if (off && _offlineSince is null) _offlineSince = DateTime.UtcNow;
        if (!off) { _offlineSince = null; _pillDismissed = false; }
        _offlinePill.Visibility = ShellRules.ShowOfflinePill(_offlineSince, DateTime.UtcNow, _pillDismissed, ForceOffline) ? Visibility.Visible : Visibility.Collapsed;
    }

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
        _sidebar.Update(_route == AppRoute.Settings ? _before : _route, _pageId, _taskView);
        UpdateOffline();
        TaskbarBadge.Set(_source.GetTaskCounts().Today);
        if (_source.TasksVersion != _remindersFor) { _remindersFor = _source.TasksVersion; if (IsLoaded) _ = ReminderToasts.SyncAsync(_source, true); }
        if (_page.PageId == _pageId) _page.Refresh(); else _page.SetPage(_pageId);
        _tasks.SetView(_taskView);
        PageCard.Visibility = _route == AppRoute.Notes ? Visibility.Visible : Visibility.Collapsed;
        TasksHost.Visibility = _route == AppRoute.Tasks ? Visibility.Visible : Visibility.Collapsed;
        CalendarHost.Visibility = _route == AppRoute.Calendar ? Visibility.Visible : Visibility.Collapsed;
        SettingsHost.Visibility = _route == AppRoute.Settings ? Visibility.Visible : Visibility.Collapsed;
        if (_route == AppRoute.Calendar) _calendar.Refresh();
        ApplyBreakpoints(ActualWidth);
    }

    /// <summary>Ctrl+K (and Ctrl+Shift+F, Apple's Search shortcut) open the search palette. A focused box handles Ctrl+K itself (the link editor) and never lets it get here.</summary>
    private void OnShellKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Handled) return;
        var ctrl = InputKeyboardSource.GetKeyStateForCurrentThread(global::Windows.System.VirtualKey.Control).HasFlag(global::Windows.UI.Core.CoreVirtualKeyStates.Down);
        var shift = InputKeyboardSource.GetKeyStateForCurrentThread(global::Windows.System.VirtualKey.Shift).HasFlag(global::Windows.UI.Core.CoreVirtualKeyStates.Down);
        // Q opens quick add when no text box has the keyboard (Apple's shortcut shown on the sidebar's Add task)
        if (!ctrl && e.Key == global::Windows.System.VirtualKey.Q && e.OriginalSource is not TextBox && e.OriginalSource is not RichEditBox
            && !_overlay.IsOpen && BoxTextView.Focused is null && _route != AppRoute.Settings)
        {
            e.Handled = true;
            _host.OpenQuickAdd(null);
            return;
        }
        // Ctrl+/ opens the keyboard-shortcut sheet anywhere; a bare ? (Shift+/) does when no text field has the keyboard
        if ((int)e.Key == 191)
        {
            var typing = e.OriginalSource is TextBox || e.OriginalSource is RichEditBox || e.OriginalSource is PasswordBox || BoxTextView.Focused is not null;
            if (ShellRules.OpensShortcuts(ctrl, shift, typing, ctrl ? "/" : shift ? "?" : "/"))
            {
                e.Handled = true;
                ShortcutSheet.Show(_host);
                return;
            }
        }
        if (!ctrl) return;
        // no box has the keyboard: undo/redo still reach the live page (a box's own key handling marks the key handled first)
        if (_route == AppRoute.Notes && (e.Key == global::Windows.System.VirtualKey.Z || e.Key == global::Windows.System.VirtualKey.Y)
            && !_overlay.IsOpen && e.OriginalSource is not TextBox)
        {
            var undo = e.Key == global::Windows.System.VirtualKey.Z && !shift;
            if (_page.Undo(undo) is not null) e.Handled = true;
            return;
        }
        if (e.Key == global::Windows.System.VirtualKey.P && !shift && _route == AppRoute.Notes && !_overlay.IsOpen)
        {
            e.Handled = true;
            _page.Print();
            return;
        }
        if ((e.Key == global::Windows.System.VirtualKey.K && !shift) || (e.Key == global::Windows.System.VirtualKey.F && shift))
        {
            e.Handled = true;
            _host.OpenSearch();
        }
    }

    /// <summary>The pen row shows under the ribbon of a page while Draw is on.</summary>
    private void UpdateInkBar() => _inkBar.Visibility = _route == AppRoute.Notes && InkTool.Shared.BarOpen ? Visibility.Visible : Visibility.Collapsed;

    private void ApplyBreakpoints(double width)
    {
        var mode = width >= 1280 ? RibbonMode.Full : width > 1023 ? RibbonMode.Compact : RibbonMode.Smallest;
        _ribbon.Update(_route, mode, _taskView);
        UpdateInkBar();
    }

    private void ApplyTheme()
    {
        var mode = ShellRules.Resolve(_theme, SystemIsDark());   // System is Light or Dark by what Windows is set to
        var chrome = mode == ThemeMode.Light ? ElementTheme.Light : ElementTheme.Dark;
        var page = mode == ThemeMode.Dark ? ElementTheme.Dark : ElementTheme.Light;
        Root.RequestedTheme = chrome;
        RibbonHost.RequestedTheme = chrome;
        RailHost.RequestedTheme = chrome;
        SidebarHost.RequestedTheme = chrome;
        // The main area: Hybrid shows the note page in the Light palette inset in dark chrome; other routes follow the chrome.
        MainHost.RequestedTheme = chrome;
        TasksHost.RequestedTheme = chrome;
        CalendarHost.RequestedTheme = chrome;
        SettingsHost.RequestedTheme = chrome;
        PageCard.RequestedTheme = page;
        MainHost.Background = (Brush)ThemeBrushes.Get(mode == ThemeMode.Light ? "Bg" : "BgSidebar", chrome);
        PageCard.Background = mode == ThemeMode.Hybrid ? Ui.Hex("#fcfcfa") : ThemeBrushes.Get("Bg", page);
        // Hybrid: the page is inset 6 pt with 12 pt top corners and a 1 pt dark ring; other themes run it edge to edge.
        var inset = mode == ThemeMode.Hybrid;
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
