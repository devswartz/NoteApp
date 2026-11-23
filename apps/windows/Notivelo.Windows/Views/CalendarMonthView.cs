using System.Globalization;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The Calendar (Apple's CalendarScreen.swift, tasks-calendar.png): a month grid of your open tasks by due date, Monday first, today marked, with
/// Today / previous / next, and a "No date" tray. A task opens the task sheet; the + on a day starts quick add on that day.</summary>
internal sealed class CalendarMonthView : ThemedControl
{
    private readonly INotesSource _source;
    private DateOnly _month;
    internal ShellHost? Host { get; set; }

    public CalendarMonthView(INotesSource source) { _source = source; _month = FirstOf(Today); }

    private static DateOnly Today => DateOnly.FromDateTime(DateTime.Now);
    private static DateOnly FirstOf(DateOnly d) => new(d.Year, d.Month, 1);
    private static string Key(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public void Refresh() => Rebuild();
    public void GoToday() { _month = FirstOf(Today); Rebuild(); }
    public void Step(int months) { _month = _month.AddMonths(months); Rebuild(); }

    protected override UIElement Build()
    {
        var today = Today;
        var tasks = _source.CalendarTasks();
        var byDay = tasks.Where(t => t.Due is not null).GroupBy(t => t.Due!).ToDictionary(g => g.Key, g => g.ToList());
        var undated = tasks.Where(t => t.Due is null).ToList();

        var root = new Grid { Padding = new Thickness(40, 30, 40, 24), ColumnSpacing = 24 };
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(190) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        // header: month title, Today, previous, next
        var head = new Grid { Margin = new Thickness(0, 0, 0, 20), ColumnSpacing = 8 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var title = Ui.Text(_month.ToString("MMMM yyyy", CultureInfo.CurrentCulture), 24, B("Text"), 700, lineHeight: 32, tracking: -0.02);
        AutomationProperties.SetAutomationId(title, "calendar-title");
        AutomationProperties.SetName(title, title.Text);
        head.Children.Add(title);
        var todayBtn = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 30, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(8),
            Content = Ui.Text("Today", 13.5, B("Text"), 500), Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1),
        };
        AutomationProperties.SetAutomationId(todayBtn, "calendar-today");
        AutomationProperties.SetName(todayBtn, "Today");
        todayBtn.Click += (_, _) => GoToday();
        Grid.SetColumn(todayBtn, 1);
        head.Children.Add(todayBtn);
        var prev = Ui.IconButton("chevron-left", 18, 36, 36, "Previous month");
        var next = Ui.IconButton("chevron-right", 18, 36, 36, "Next month");
        AutomationProperties.SetAutomationId(prev, "calendar-prev"); AutomationProperties.SetName(prev, "Previous month");
        AutomationProperties.SetAutomationId(next, "calendar-next"); AutomationProperties.SetName(next, "Next month");
        prev.Click += (_, _) => Step(-1);
        next.Click += (_, _) => Step(1);
        Grid.SetColumn(prev, 2); Grid.SetColumn(next, 3);
        head.Children.Add(prev); head.Children.Add(next);
        Grid.SetColumnSpan(head, 2);
        root.Children.Add(head);

        var grid = MonthGrid(today, byDay);
        Grid.SetRow(grid, 1);
        root.Children.Add(grid);
        var tray = Tray(undated);
        Grid.SetRow(tray, 1); Grid.SetColumn(tray, 1);
        root.Children.Add(tray);
        return new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    private StackPanel MonthGrid(DateOnly today, Dictionary<string, List<CalendarTask>> byDay)
    {
        // Monday first; whole weeks from the one holding the 1st to the one holding the last day
        var lead = ((int)_month.DayOfWeek + 6) % 7;
        var start = _month.AddDays(-lead);
        var last = _month.AddMonths(1).AddDays(-1);
        var weeks = (last.DayNumber - start.DayNumber) / 7 + 1;

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
            Grid.SetColumn(t, i);
            names.Children.Add(t);
        }
        outer.Children.Add(names);

        var body = new Grid { BorderBrush = B("Border"), BorderThickness = new Thickness(1, 1, 0, 0) };
        for (var c = 0; c < 7; c++) body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (var r = 0; r < weeks; r++) body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(112) });
        for (var i = 0; i < weeks * 7; i++)
        {
            var day = start.AddDays(i);
            var cell = Cell(day, day.Month == _month.Month, day == today, today, byDay.GetValueOrDefault(Key(day)));
            Grid.SetRow(cell, i / 7); Grid.SetColumn(cell, i % 7);
            body.Children.Add(cell);
        }
        outer.Children.Add(body);
        return outer;
    }

    private Border Cell(DateOnly day, bool inMonth, bool isToday, DateOnly today, List<CalendarTask>? items)
    {
        var panel = new StackPanel { Spacing = 3, Padding = new Thickness(6, 6, 6, 4) };
        var top = new Grid { Height = 22 };
        var num = Ui.Text(day.Day.ToString(), 12.5, isToday ? new SolidColorBrush(Colors.White) : inMonth ? B("Text") : B("TextMuted"), 600);
        var badge = new Border
        {
            MinWidth = 22, Height = 22, CornerRadius = new CornerRadius(11), Padding = new Thickness(isToday ? 4 : 4, 0, 4, 0), HorizontalAlignment = HorizontalAlignment.Left,
            Background = isToday ? B("AccentSolid") : null, Child = num.With(t => t.HorizontalAlignment = HorizontalAlignment.Center),
        };
        AutomationProperties.SetAutomationId(badge, "cal-daynum-" + Key(day) + (isToday ? "-today" : ""));
        AutomationProperties.SetName(badge, (isToday ? "Today, " : "") + day.ToString("d MMMM", CultureInfo.CurrentCulture));
        top.Children.Add(badge);
        var add = Ui.IconButton("plus", 14, 22, 22, "Add a task on this day", 6);
        add.HorizontalAlignment = HorizontalAlignment.Right; add.Opacity = 0;
        AutomationProperties.SetAutomationId(add, "cal-add-" + Key(day));
        AutomationProperties.SetName(add, "Add a task on " + day.ToString("d MMMM", CultureInfo.CurrentCulture));
        add.Click += (_, _) => Host?.OpenQuickAdd(new QuickAddDialog.Seed(DueDate: Key(day)));
        top.Children.Add(add);
        panel.Children.Add(top);

        const int limit = 3;
        if (items is not null)
        {
            foreach (var t in items.OrderBy(x => x.DueTime ?? "99").Take(limit)) panel.Children.Add(TaskChip(t, day < today));
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
        var g = new Grid { Height = 22, CornerRadius = new CornerRadius(5), Background = B("BgHover") };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(new Border { Background = bar });
        var text = (t.DueTime is { Length: > 0 } tm ? tm + " " : "") + (item.Title.Length == 0 ? "Untitled" : item.Title);
        var label = Ui.Text(text, 12, late ? B("Danger") : B("Text"));
        label.Margin = new Thickness(6, 0, 4, 0);
        Grid.SetColumn(label, 1);
        g.Children.Add(label);
        AutomationProperties.SetAutomationId(g, "cal-task-" + item.Id);
        AutomationProperties.SetName(g, item.Title);
        g.Tapped += (_, _) => Host?.OpenTask(item.Id);
        return g;
    }

    private Border Tray(List<CalendarTask> undated)
    {
        var panel = new StackPanel { Spacing = 4, Padding = new Thickness(12, 10, 12, 12) };
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 0, 0, 6) };
        head.Children.Add(Ui.Text("No date", 13.5, B("Text"), 650));
        if (undated.Count > 0) head.Children.Add(Ui.Text(undated.Count.ToString(), 12, B("TextMuted"), 500));
        panel.Children.Add(head);
        panel.Children.Add(Ui.HLine(B("Border")));
        foreach (var t in undated) panel.Children.Add(TaskChip(t, false).With(c => c.Margin = new Thickness(0, 2, 0, 0)));
        return new Border
        {
            BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), VerticalAlignment = VerticalAlignment.Top, Child = panel,
        };
    }
}
