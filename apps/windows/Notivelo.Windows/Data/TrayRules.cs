namespace Notivelo.Windows.Data;

/// <summary>What a tray menu item does (the ids of Tauri's tray.rs menu: app:show, app:quick-capture, cmd:nav.today, cmd:nav.upcoming, cmd:pages.new, app:quit).</summary>
public enum TrayCommand { None, Open, QuickCapture, Today, Upcoming, NewPage, Quit }

/// <summary>One row of the tray menu. <see cref="TrayCommand.None"/> is a separator.</summary>
public sealed record TrayItem(TrayCommand Command, string Label, string? Shortcut = null)
{
    public bool IsSeparator => Command == TrayCommand.None;
}

/// <summary>The tray icon's rules, with no WinUI and no Win32 (the unit tests compile this file): the tooltip, the menu, what a click does, and when closing the window keeps the app running.
/// The reference is the Tauri app's <c>tray.rs</c> (the same menu, the same tooltip words, left click opens the app, right click shows the menu) and <c>lib.rs</c> (closing the last window on Windows
/// keeps the app in the tray; there is no setting for it and no first-close notice; Quit exits).</summary>
public static class TrayRules
{
    public const string AppName = "Notivelo";

    /// <summary>The tooltip the Windows tray shows (tray.rs set_today_count). Windows cuts a tooltip at 127 characters.</summary>
    public static string Tooltip(string app, int count)
    {
        var tip = Math.Max(0, count) switch
        {
            0 => $"{app}: nothing due today",
            1 => $"{app}: 1 task due today",
            var n => $"{app}: {n} tasks due today",
        };
        return tip.Length <= 127 ? tip : tip[..127];
    }

    /// <summary>The menu, top to bottom: Open, Quick Capture… with its shortcut, a line, Today, Upcoming, New Page, a line, Quit.</summary>
    public static IReadOnlyList<TrayItem> Menu(string app, string hotkey) => new[]
    {
        new TrayItem(TrayCommand.Open, $"Open {app}"),
        new TrayItem(TrayCommand.QuickCapture, "Quick Capture…", hotkey),
        new TrayItem(TrayCommand.None, ""),
        new TrayItem(TrayCommand.Today, "Today"),
        new TrayItem(TrayCommand.Upcoming, "Upcoming"),
        new TrayItem(TrayCommand.NewPage, "New Page"),
        new TrayItem(TrayCommand.None, ""),
        new TrayItem(TrayCommand.Quit, $"Quit {app}"),
    };

    /// <summary>The menu item's text as Windows draws it: the label, a tab and the shortcut.</summary>
    public static string Text(TrayItem i) => i.Shortcut is { Length: > 0 } s ? i.Label + "\t" + s : i.Label;

    /// <summary>The app-menu key a tray command stands in for (the web runs cmd:nav.today, cmd:nav.upcoming and cmd:pages.new after showing the main window).</summary>
    public static ShellKey KeyOf(TrayCommand c) => c switch
    {
        TrayCommand.Today => ShellKey.Today,
        TrayCommand.Upcoming => ShellKey.Upcoming,
        TrayCommand.NewPage => ShellKey.NewPage,
        _ => ShellKey.None,
    };

    /// <summary>Whether a tray command brings the main window forward first (all but Quick Capture and Quit).</summary>
    public static bool ShowsMain(TrayCommand c) => c is TrayCommand.Open or TrayCommand.Today or TrayCommand.Upcoming or TrayCommand.NewPage;

    /// <summary>Closing the window: it is hidden, the app keeps running in the tray (lib.rs: Windows and Linux keep the app alive after the last window closes), unless the user chose Quit or
    /// there is no tray icon to get back in by (then hiding would leave a process nobody can reach).</summary>
    public static bool HideOnClose(bool quitting, bool trayInstalled) => !quitting && trayInstalled;

    /// <summary>The state a UI test reads from the shell (the tray icon itself cannot be read on a runner): <c>count=3;tip=...;menu=open,quick,today,upcoming,newpage,quit;hotkey=ok</c>.</summary>
    public static string Readout(int count, string app, string hotkey, string? hotkeyProblem)
    {
        var menu = string.Join(",", Menu(app, hotkey).Where(i => !i.IsSeparator).Select(i => i.Command switch
        {
            TrayCommand.Open => "open", TrayCommand.QuickCapture => "quick", TrayCommand.Today => "today", TrayCommand.Upcoming => "upcoming", TrayCommand.NewPage => "newpage", _ => "quit",
        }));
        return $"count={Math.Max(0, count)};tip={Tooltip(app, count)};menu={menu};hotkey={(hotkeyProblem is null ? "ok" : "taken")}";
    }
}
