using System.Globalization;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The Calendar (Apple's CalendarScreen.swift, tasks-calendar.png): a month or a week of tasks by due date, Monday first, today marked, and a "No date" tray.
/// Week / Month, Mine / Everyone (ribbon) and the Status select (Open, Completed, All; top right) are kept on this device (<see cref="AppSettings"/>: the server stores no
/// calendar filters). Today / previous / next are the ribbon's. A task opens the task sheet; the + on a day starts quick add on that day.</summary>
internal sealed class CalendarMonthView : ThemedControl
{
    private readonly INotesSource _source;
    private DateOnly _month;
    private DateOnly _cursor = Today;
    internal ShellHost? Host { get; set; }

    public static bool Week => AppSettings.CalendarWeek;
    public static bool Everyone => AppSettings.CalendarEveryone;
    public static CalendarStatus Status => (CalendarStatus)Math.Clamp(AppSettings.CalendarStatus, 0, 2);

    public CalendarMonthView(INotesSource source) { _source = source; _month = FirstOf(Today); }

    private static DateOnly Today => DateOnly.FromDateTime(DateTime.Now);
    private static DateOnly FirstOf(DateOnly d) => new(d.Year, d.Month, 1);
    private static string Key(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public void Refresh() => Rebuild();
    public void GoToday() { _month = FirstOf(Today); _cursor = Today; Rebuild(); }
    /// <summary>Previous / next: a month, or a week in the Week view.</summary>
    public void Step(int n)
    {
        if (Week) { _cursor = _cursor.AddDays(7 * n); _month = FirstOf(_cursor); }
        else { _month = _month.AddMonths(n); _cursor = _month; }
        Rebuild();
    }

    public void SetWeek(bool week)
    {
        if (week == Week) return;
        // the week of the month shown (today's when this is the month of today); back to the month of the week
        if (week) _cursor = _month.Year == Today.Year && _month.Month == Today.Month ? Today : _month;
        else _month = FirstOf(_cursor);
        AppSettings.CalendarWeek = week;
        Rebuild();
    }

    public void SetEveryone(bool everyone) { if (everyone == Everyone) return; AppSettings.CalendarEveryone = everyone; Rebuild(); }

    private void SetStatus(CalendarStatus s) { AppSettings.CalendarStatus = (int)s; Rebuild(); }

    protected override UIElement Build()
    {
        var today = Today;
        var status = Status;
        // whose (Mine / Everyone), then the status on the days; the "No date" tray is always the open tasks
        var tasks = _source.CalendarTasks(Everyone).Where(t => TaskLogic.CalendarShows(status, t.Task.Done, t.Due is not null)).ToList();
        var byDay = tasks.Where(t => t.Due is not null).GroupBy(t => t.Due!).ToDictionary(g => g.Key, g => g.ToList());
        var undated = tasks.Where(t => t.Due is null).ToList();

        var root = new Grid { Padding = new Thickness(40, 26, 40, 24), ColumnSpacing = 16 };
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(220) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        // header: month title
        var head = new Grid { Margin = new Thickness(0, 0, 0, 23), ColumnSpacing = 8 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var week = Week;
        var ws = TaskLogic.WeekStart(_cursor);
        var titleText = week
            ? ws.ToString("MMM d", CultureInfo.CurrentCulture) + " – " + ws.AddDays(6).ToString("MMM d, yyyy", CultureInfo.CurrentCulture)
            : _month.ToString("MMMM yyyy", CultureInfo.CurrentCulture);
        var title = Ui.Text(titleText, 24, B("Text"), 700, lineHeight: 32, tracking: -0.02);
        AutomationProperties.SetAutomationId(title, "calendar-title");
        AutomationProperties.SetName(title, title.Text);
        head.Children.Add(title);
        var statusSel = StatusSelect(status);
        Grid.SetColumn(statusSel, 1);
        head.Children.Add(statusSel);
        // Today / previous / next are the ribbon's (tasks-calendar.png has no second set here)
        Grid.SetColumnSpan(head, 2);
        root.Children.Add(head);

        var grid = MonthGrid(today, byDay, week);
        Grid.SetRow(grid, 1);
        root.Children.Add(grid);
        var tray = Tray(undated);
        Grid.SetRow(tray, 1); Grid.SetColumn(tray, 1); tray.Margin = new Thickness(0, -6, 0, 0);
        root.Children.Add(tray);
        return new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    /// <summary>The web's Status select: the days show open tasks, completed ones, or both.</summary>
    private FrameworkElement StatusSelect(CalendarStatus status)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Top };
        row.Children.Add(Ui.Text("Status", 13, B("TextMuted")).With(t => t.VerticalAlignment = VerticalAlignment.Center));
        var label = status switch { CalendarStatus.Open => "Open", CalendarStatus.Completed => "Completed", _ => "All" };
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        sp.Children.Add(Ui.Text(label, 13.5, B("Text")));
        sp.Children.Add(new Icon("chevron-down", 13, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        var b = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 32, MinWidth = 96, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6), Content = sp,
            Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1),
        };
        AutomationProperties.SetAutomationId(b, "calendar-status");
        AutomationProperties.SetName(b, "Status: " + label);
        AutomationProperties.SetItemStatus(b, "status=" + label.ToLowerInvariant());
        b.Click += (_, _) => PopupMenu.Show(Host!.Overlay, new[]
        {
            new MenuEntry("Open", null, () => SetStatus(CalendarStatus.Open), Check: status == CalendarStatus.Open, Id: "calendar-status-open"),
            new MenuEntry("Completed", null, () => SetStatus(CalendarStatus.Completed), Check: status == CalendarStatus.Completed, Id: "calendar-status-completed"),
            new MenuEntry("All", null, () => SetStatus(CalendarStatus.All), Check: status == CalendarStatus.All, Id: "calendar-status-all"),
        }, b, endAlign: true, id: "menu-calendar-status", width: 180);
        row.Children.Add(b);
        return row;
    }

    private StackPanel MonthGrid(DateOnly today, Dictionary<string, List<CalendarTask>> byDay, bool weekView)
    {
        // Monday first; whole weeks from the one holding the 1st to the one holding the last day (the Week view: the week of the cursor)
        var lead = ((int)_month.DayOfWeek + 6) % 7;
        var start = weekView ? TaskLogic.WeekStart(_cursor) : _month.AddDays(-lead);
        var last = _month.AddMonths(1).AddDays(-1);
        var weeks = weekView ? 1 : (last.DayNumber - start.DayNumber) / 7 + 1;

        var outer = new StackPanel { VerticalAlignment = VerticalAlignment.Top };
        AutomationProperties.SetAutomationId(outer, "calendar-grid");
        AutomationProperties.SetName(outer, "Calendar " + _month.ToString("MMMM yyyy", CultureInfo.CurrentCulture));
        var names = new Grid { Margin = new Thickness(0, 0, 0, 8) };
        for (var i = 0; i < 7; i++)
        {
            names.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var d = start.AddDays(i);
            var t = Ui.Text(d.ToString("ddd", CultureInfo.CurrentCulture), 12, B("TextMuted"), 600);
            t.Margin = new Thickness(10, 0, 0, 0);
            if (weekView)
            {
                // the week shows each day's number beside its name (today in the accent)
                var isToday = d == today;
                var num = Ui.Text(d.Day.ToString(), 12, isToday ? new SolidColorBrush(Colors.White) : B("TextMuted"), 600);
                var badge = new Border { Padding = new Thickness(isToday ? 6 : 0, 0, isToday ? 6 : 0, 0), CornerRadius = new CornerRadius(8), Background = isToday ? B("AccentSolid") : null, Child = num };
                AutomationProperties.SetAutomationId(badge, "cal-daynum-" + Key(d) + (isToday ? "-today" : ""));
                AutomationProperties.SetName(badge, (isToday ? "Today, " : "") + d.ToString("d MMMM", CultureInfo.CurrentCulture));
                var pair = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(10, 0, 0, 0) };
                pair.Children.Add(Ui.Text(d.ToString("ddd", CultureInfo.CurrentCulture), 12, B("TextMuted"), 600));
                pair.Children.Add(badge);
                Grid.SetColumn(pair, i);
                names.Children.Add(pair);
                continue;
            }
            Grid.SetColumn(t, i);
            names.Children.Add(t);
        }
        outer.Children.Add(names);

        var body = new Grid { BorderBrush = B("Border"), BorderThickness = new Thickness(1, 1, 0, 0) };
        for (var c = 0; c < 7; c++) body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (var r = 0; r < weeks; r++) body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(weekView ? 320 : 110) });
        for (var i = 0; i < weeks * 7; i++)
        {
            var day = start.AddDays(i);
            var cell = Cell(day, weekView || day.Month == _month.Month, day == today, today, byDay.GetValueOrDefault(Key(day)), weekView);
            Grid.SetRow(cell, i / 7); Grid.SetColumn(cell, i % 7);
            body.Children.Add(cell);
        }
        outer.Children.Add(body);
        return outer;
    }

    private Border Cell(DateOnly day, bool inMonth, bool isToday, DateOnly today, List<CalendarTask>? items, bool weekView)
    {
        var panel = new StackPanel { Spacing = 3, Padding = new Thickness(6, 6, 6, 4) };
        var top = new Grid { Height = 22 };
        var num = Ui.Text(day.Day.ToString(), 12.5, isToday ? new SolidColorBrush(Colors.White) : inMonth ? B("Text") : B("TextMuted"), 600);
        var badge = new Border
        {
            MinWidth = isToday ? 26 : 0, Height = isToday ? 20 : 22, CornerRadius = new CornerRadius(10), Padding = new Thickness(isToday ? 4 : 2, 0, isToday ? 4 : 2, 0), HorizontalAlignment = HorizontalAlignment.Left,
            Background = isToday ? B("AccentSolid") : null, Child = num.With(t => t.HorizontalAlignment = HorizontalAlignment.Center),
        };
        if (!weekView)
        {
            AutomationProperties.SetAutomationId(badge, "cal-daynum-" + Key(day) + (isToday ? "-today" : ""));
            AutomationProperties.SetName(badge, (isToday ? "Today, " : "") + day.ToString("d MMMM", CultureInfo.CurrentCulture));
            top.Children.Add(badge);
        }
        var add = Ui.IconButton("plus", 14, 22, 22, "Add a task on this day", 6);
        add.HorizontalAlignment = HorizontalAlignment.Right; add.Opacity = 0;
        AutomationProperties.SetAutomationId(add, "cal-add-" + Key(day));
        AutomationProperties.SetName(add, "Add a task on " + day.ToString("d MMMM", CultureInfo.CurrentCulture));
        add.Click += (_, _) => Host?.OpenQuickAdd(new QuickAddDialog.Seed(DueDate: Key(day)));
        top.Children.Add(add);
        panel.Children.Add(top);

        var limit = weekView ? 99 : 3;
        if (items is not null)
        {
            foreach (var t in items.OrderBy(x => x.DueTime ?? "99").Take(limit)) panel.Children.Add(TaskChip(t, day < today && !t.Task.Done));
            if (items.Count > limit) panel.Children.Add(Ui.Text($"+{items.Count - limit} more", 12, B("TextMuted")).With(t => t.Margin = new Thickness(6, 0, 0, 0)));
        }
        var cell = new Border
        {
            BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 1, 1), Background = inMonth ? new SolidColorBrush(Colors.Transparent) : B("BgSubtle"), Child = panel,
        };
        AutomationProperties.SetAutomationId(cell, "cal-day-" + Key(day));
        cell.PointerEntered += (_, _) => add.Opacity = 1;
        cell.PointerExited += (_, _) => add.Opacity = 0;
        return cell;
    }

    /// <summary>A task in a day: a bar in the priority colour on its left, the time, the title; red when overdue.</summary>
    private Grid TaskChip(CalendarTask t, bool late)
    {
        var item = t.Task;
        var bar = item.Priority is >= 1 and <= 3 ? TaskParts.PriorityBrush(B, item.Priority) : B("TextMuted");
        var g = new Grid { Height = 22, CornerRadius = new CornerRadius(5), Background = B("BgHover"), Opacity = item.Done ? 0.65 : 1 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(new Border { Background = bar });
        var text = (t.DueTime is { Length: > 0 } tm ? tm + " " : "") + (item.Title.Length == 0 ? "Untitled" : item.Title);
        var label = Ui.Text(text, 12, item.Done ? B("TextMuted") : late ? B("Danger") : B("Text"));
        label.Margin = new Thickness(6, 0, 4, 0);
        if (item.Done) label.TextDecorations = TextDecorations.Strikethrough;
        Grid.SetColumn(label, 1);
        g.Children.Add(label);
        AutomationProperties.SetAutomationId(g, "cal-task-" + item.Id);
        AutomationProperties.SetName(g, item.Title);
        AutomationProperties.SetItemStatus(g, item.Done ? "done=1" : "done=0");
        g.Tapped += (_, _) => Host?.OpenTask(item.Id);
        return g;
    }

    private Border Tray(List<CalendarTask> undated)
    {
        var panel = new StackPanel { Spacing = 2, Padding = new Thickness(8, 16, 8, 8) };
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(2, 0, 0, 7) };
        head.Children.Add(Ui.Text("No date", 13.5, B("Text"), 650));
        if (undated.Count > 0) head.Children.Add(Ui.Text(undated.Count.ToString(), 12, B("TextMuted"), 500));
        panel.Children.Add(head);
        panel.Children.Add(Ui.HLine(B("Border")));
        foreach (var t in undated) panel.Children.Add(TaskChip(t, false).With(c => { c.Margin = new Thickness(0, 2, 0, 0); c.Height = 26; }));
        return new Border
        {
            BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), VerticalAlignment = VerticalAlignment.Top, Child = panel,
        };
    }
}
