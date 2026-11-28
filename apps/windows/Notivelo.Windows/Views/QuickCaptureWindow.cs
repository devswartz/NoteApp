using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using WinRT.Interop;
using N = Notivelo.Native;

namespace Notivelo.Windows.Views;

/// <summary>Global quick capture (the Tauri app's <c>quick.rs</c> and the web's <c>quickCapture.tsx</c>): Ctrl+Alt+N, or Quick Capture in the tray menu, toggles a small always-on-top window, 560 x 132,
/// that adds a task (one line of natural language, as in quick add) or a page (its title; the first section of the notebook, then the page opens in the main window) without switching to the app.
/// Enter adds and hides it, Tab switches between a task and a page, Esc hides it, and clicking elsewhere hides it once it has had the keyboard.</summary>
internal sealed class QuickCaptureWindow
{
    private const double WidthDip = 560, HeightDip = 132;

    private readonly Func<INotesSource?> _source;
    private readonly Action _showMain;
    private readonly Action<string> _openPage;
    private Window? _w;
    private TextBox _input = null!;
    private TextBlock _hintMode = null!, _hintKeys = null!, _error = null!;
    private StackPanel _chips = null!;
    private Border _card = null!;
    private QuickMode _mode = QuickMode.Task;
    private bool _busy, _signedOut, _hadFocus, _quitting;

    public QuickCaptureWindow(Func<INotesSource?> source, Action showMain, Action<string> openPage)
    {
        _source = source; _showMain = showMain; _openPage = openPage;
    }

    public bool IsVisible => _w?.AppWindow.IsVisible == true;

    /// <summary>The hotkey and the tray item: show it, or hide it when it is already up with the keyboard (quick.rs toggle).</summary>
    public void Toggle()
    {
        if (IsVisible && _hadFocus) Hide(); else Show();
    }

    public void Show()
    {
        Ensure();
        var w = _w!;
        _error.Visibility = Visibility.Collapsed; _signedOut = false; _hadFocus = false;
        Centre(w);
        w.AppWindow.Show();
        w.Activate();
        SetForegroundWindow(WindowNative.GetWindowHandle(w));
        _input.Focus(FocusState.Programmatic);
        _input.SelectAll();
        Refresh();
    }

    public void Hide()
    {
        if (_w is null) return;
        _hadFocus = false;
        _w.AppWindow.Hide();
    }

    /// <summary>The app is quitting: let the window close for real.</summary>
    public void Quit()
    {
        _quitting = true;
        try { _w?.Close(); } catch (Exception) { }
    }

    // ---- the window ----

    private void Ensure()
    {
        if (_w is not null) return;
        var theme = Theme();
        Brush B(string k) => ThemeBrushes.Get(k, theme);

        _input = new TextBox { Height = 44, FontSize = 17, Padding = new Thickness(12, 9, 12, 9), CornerRadius = new CornerRadius(8), AcceptsReturn = false };
        _hintMode = Ui.Text("", 12, B("Text2"), 700);
        _hintKeys = Ui.Text("", 12, B("TextMuted"));
        _chips = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var hint = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        hint.Children.Add(_hintMode); hint.Children.Add(_hintKeys); hint.Children.Add(_chips);
        _error = Ui.Text("", 12, B("Danger")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.Visibility = Visibility.Collapsed; });
        var panel = new StackPanel { Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
        panel.Children.Add(_input); panel.Children.Add(hint); panel.Children.Add(_error);
        _card = new Border
        {
            Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12),
            Padding = new Thickness(16, 14, 16, 14), Child = panel,
        };
        _card.RequestedTheme = theme;
        AutomationProperties.SetAutomationId(_input, "quickcapture-input");
        _input.TextChanged += (_, _) => { _signedOut = false; Refresh(); };
        _input.PreviewKeyDown += OnKey;

        _w = new Window { Title = "Quick Capture", Content = _card };
        var hwnd = WindowNative.GetWindowHandle(_w);
        if (_w.AppWindow.Presenter is OverlappedPresenter p)
        {
            p.SetBorderAndTitleBar(false, false);
            p.IsResizable = false; p.IsMaximizable = false; p.IsMinimizable = false; p.IsAlwaysOnTop = true;
        }
        try { _w.AppWindow.IsShownInSwitchers = false; } catch (Exception) { }   // no taskbar button (skip_taskbar)
        var corner = 2; DwmSetWindowAttribute(hwnd, 33, ref corner, sizeof(int));   // DWMWA_WINDOW_CORNER_PREFERENCE: round
        var scale = GetDpiForWindow(hwnd) / 96.0;
        _w.AppWindow.Resize(new global::Windows.Graphics.SizeInt32((int)(WidthDip * scale), (int)(HeightDip * scale)));
        _w.AppWindow.Closing += (_, e) => { if (!_quitting) { e.Cancel = true; Hide(); } };
        // like Spotlight: hide when the user clicks elsewhere, but only after the window really had the keyboard (a blur before that would hide it the moment it appears)
        _w.Activated += (_, e) =>
        {
            if (e.WindowActivationState == WindowActivationState.Deactivated) { if (_hadFocus) Hide(); }
            else { _hadFocus = true; _input.Focus(FocusState.Programmatic); }
        };
    }

    private static ElementTheme Theme()
    {
        var mode = ShellRules.ParseTheme(AppSettings.Theme, ThemeMode.Hybrid);
        bool dark;
        switch (Environment.GetEnvironmentVariable("NOTIVELO_SYSTEM_THEME")?.ToLowerInvariant())
        {
            case "dark": dark = true; break;
            case "light": dark = false; break;
            default:
                try { dark = new global::Windows.UI.ViewManagement.UISettings().GetColorValue(global::Windows.UI.ViewManagement.UIColorType.Background).R < 128; } catch (Exception) { dark = false; }
                break;
        }
        return ShellRules.Resolve(mode, dark) == ThemeMode.Light ? ElementTheme.Light : ElementTheme.Dark;
    }

    private static void Centre(Window w)
    {
        try
        {
            GetCursorPos(out var c);
            var area = DisplayArea.GetFromPoint(new global::Windows.Graphics.PointInt32(c.X, c.Y), DisplayAreaFallback.Nearest);
            var wa = area.WorkArea; var s = w.AppWindow.Size;
            w.AppWindow.Move(new global::Windows.Graphics.PointInt32(wa.X + (wa.Width - s.Width) / 2, wa.Y + (wa.Height - s.Height) / 2));
        }
        catch (Exception) { }
    }

    // ---- keys and drawing ----

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        switch (e.Key)
        {
            case global::Windows.System.VirtualKey.Enter:
                e.Handled = true;
                if (_signedOut) { _signedOut = false; _error.Visibility = Visibility.Collapsed; Hide(); _showMain(); }   // the sign-in screen is in the main window
                else Submit();
                break;
            case global::Windows.System.VirtualKey.Escape: e.Handled = true; Hide(); break;
            case global::Windows.System.VirtualKey.Tab: e.Handled = true; _mode = QuickCaptureRules.Toggle(_mode); Refresh(); break;
        }
    }

    private static N.QuickAddResult Parse(string text)
    {
        try { return N.NvCore.ParseQuickAdd(text, DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd")); }
        catch (Exception) { return new N.QuickAddResult(text.Trim(), null, null, null, null, null, Array.Empty<string>(), null, Array.Empty<N.QuickAddToken>()); }
    }

    private void Refresh()
    {
        if (_w is null) return;
        var theme = Theme();
        Brush B(string k) => ThemeBrushes.Get(k, theme);
        _input.PlaceholderText = QuickCaptureRules.Placeholder(_mode);
        AutomationProperties.SetName(_input, QuickCaptureRules.Label(_mode));
        AutomationProperties.SetItemStatus(_input, QuickCaptureRules.Readout(_mode, _busy, _signedOut));
        _input.IsReadOnly = _busy;
        _hintMode.Text = QuickCaptureRules.Name(_mode);
        _hintKeys.Text = $"· ↵ add · Tab {QuickCaptureRules.Other(_mode)} · Esc close";
        _hintMode.Visibility = _hintKeys.Visibility = _error.Visibility == Visibility.Visible ? Visibility.Collapsed : Visibility.Visible;
        _chips.Children.Clear();
        if (_mode != QuickMode.Task || _error.Visibility == Visibility.Visible) return;
        var q = Parse(_input.Text);
        var chips = new List<string>();
        if (q.DueDate is { } d) chips.Add(DueWords(d));
        if (q.DueTime is { Length: > 0 } t) chips.Add(t);
        if (q.Priority is { } pr) chips.Add("P" + pr);
        if (q.Recurrence is not null) chips.Add("repeats");
        if (q.Assignee is { } a) chips.Add("@" + a);
        if (q.Team is { } tm) chips.Add("+" + tm);
        chips.AddRange(q.Tags.Select(x => "#" + x));
        foreach (var c in chips)
            _chips.Children.Add(new Border
            {
                Padding = new Thickness(6, 0, 6, 0), CornerRadius = new CornerRadius(999), Background = B("AccentSoft"),
                Child = Ui.Text(c, 12, B("Accent")),
            });
    }

    private static string DueWords(string day)
    {
        if (!DateOnly.TryParseExact(day, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var d)) return day;
        var diff = d.DayNumber - DateOnly.FromDateTime(DateTime.Now).DayNumber;
        return diff == 0 ? "Today" : diff == 1 ? "Tomorrow" : diff == -1 ? "Yesterday" : d.ToString("ddd d MMM");
    }

    private void Fail(string message, bool signedOut = false)
    {
        _signedOut = signedOut;
        _error.Text = message; _error.Visibility = Visibility.Visible;
        Refresh();
    }

    private async void Submit()
    {
        var text = _input.Text.Trim();
        if (_busy || text.Length == 0) return;
        _error.Visibility = Visibility.Collapsed;
        if (_source() is not { } src) { Fail(QuickCaptureRules.SignedOut, true); return; }
        _busy = true; Refresh();
        try
        {
            string? err = null; string? page = null;
            if (_mode == QuickMode.Task)
            {
                var q = Parse(text);
                var due = q.DueDate ?? (q.DueTime is not null ? DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd") : null);
                var title = q.Title.Trim().Length > 0 ? q.Title.Trim() : text;
                err = await src.AddTask(new NewTask(title, "", q.Priority ?? 4, due, q.DueTime, q.Recurrence, q.Assignee, q.Team, q.Tags.ToList(), null));
            }
            else if (ShellKeys.SectionForNewPage(src.Notebooks, null, null) is { } section)
            {
                var r = await src.CreatePage(section, text);
                err = r.Error; page = r.Id;
            }
            else err = QuickCaptureRules.NoNotebook;
            if (err is not null) { _busy = false; Fail(err); return; }
            _input.Text = "";
            _busy = false;
            Hide();
            if (page is not null) _openPage(page);
        }
        catch (Exception e)
        {
            _busy = false;
            Fail(e is N.CoreException.Network ? QuickCaptureRules.Offline : e.Message);
        }
        Refresh();
    }

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
}

