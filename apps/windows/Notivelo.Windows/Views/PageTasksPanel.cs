using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>"Tasks on this page" (Apple's PageTasks.swift, page-tasks-panel.png): the panel at the right of the page, opened by the top bar's tasks button. A "done / total"
/// line with a progress bar, the page's open tasks (by due date, then priority), the completed ones behind "Show n completed", and "Add task" (quick add for this page).
/// A tick and a click on a row work as in the Tasks lists. It redraws on every change of the source.</summary>
internal sealed class PageTasksPanel : ThemedControl
{
    private readonly INotesSource _src;
    private readonly string _pageId;
    private readonly Action _close;
    private bool _showDone;
    internal ShellHost? Host { get; set; }

    public PageTasksPanel(INotesSource src, string pageId, Action close)
    {
        _src = src; _pageId = pageId; _close = close;
        Loaded += (_, _) => _src.Changed += OnChanged;
        Unloaded += (_, _) => _src.Changed -= OnChanged;
    }

    private void OnChanged(object? s, EventArgs e) => Rebuild();

    protected override UIElement Build()
    {
        var all = _src.PageTasks(_pageId);
        var open = all.Where(t => !t.Done).ToList();
        var done = all.Where(t => t.Done).ToList();

        var root = new Grid { Width = 320, Background = B("Bg") };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        // tabs and close
        var head = new Grid { Padding = new Thickness(12, 10, 12, 4) };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var tabs = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, Padding = new Thickness(2), CornerRadius = new CornerRadius(8), Background = B("BgHover"), HorizontalAlignment = HorizontalAlignment.Left };
        tabs.Children.Add(Tab("list-todo", "Tasks", true));
        tabs.Children.Add(Tab("message-square", "Comments", false));
        head.Children.Add(tabs);
        var close = Ui.IconButton("x", 14, 28, 28, "Close");
        AutomationProperties.SetAutomationId(close, "page-tasks-close");
        close.Click += (_, _) => _close();
        Grid.SetColumn(close, 1);
        head.Children.Add(close);
        root.Children.Add(head);

        // done / total
        var prog = new StackPanel { Padding = new Thickness(14, 8, 14, 6) };
        if (all.Count > 0)
        {
            var line = new Grid { ColumnSpacing = 10 };
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var count = Ui.Text($"{done.Count}/{all.Count} done", 12.5, B("TextMuted"));
            AutomationProperties.SetAutomationId(count, "page-tasks-progress");
            AutomationProperties.SetName(count, $"{done.Count}/{all.Count} done");
            line.Children.Add(count);
            var bar = new Grid { Height = 6, VerticalAlignment = VerticalAlignment.Center };
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(done.Count, 0.0001), GridUnitType.Star) });
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(open.Count, 0.0001), GridUnitType.Star) });
            bar.Children.Add(new Border { Background = B("BgHover"), CornerRadius = new CornerRadius(3) }.With(b => Grid.SetColumnSpan(b, 2)));
            bar.Children.Add(new Border { Background = B("Success"), CornerRadius = new CornerRadius(3) });
            Grid.SetColumn(bar, 1);
            line.Children.Add(bar);
            prog.Children.Add(line);
        }
        Grid.SetRow(prog, 1);
        root.Children.Add(prog);

        var list = new StackPanel { Padding = new Thickness(6, 0, 6, 12) };
        foreach (var t in open) list.Children.Add(Row(t));
        if (all.Count == 0)
            list.Children.Add(Ui.Text("No tasks yet. Type /task in the page, or select text and press Ctrl+Enter to turn it into a task.", 12.5, B("TextMuted"), lineHeight: 18)
                .With(t => { t.TextWrapping = TextWrapping.Wrap; t.Margin = new Thickness(6, 8, 6, 8); }));
        if (done.Count > 0)
        {
            var more = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 30, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6), Margin = new Thickness(0, 6, 0, 0), HorizontalAlignment = HorizontalAlignment.Left };
            more.Content = Ui.Text($"{(_showDone ? "Hide" : "Show")} {done.Count} completed", 13, B("Text2"), 500);
            AutomationProperties.SetAutomationId(more, "page-tasks-showdone");
            AutomationProperties.SetName(more, $"{(_showDone ? "Hide" : "Show")} {done.Count} completed");
            more.Click += (_, _) => { _showDone = !_showDone; Rebuild(); };
            list.Children.Add(more);
            if (_showDone) foreach (var t in done) list.Children.Add(Row(t));
        }
        var add = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 34, Padding = new Thickness(6, 0, 8, 0), CornerRadius = new CornerRadius(6), Margin = new Thickness(0, 4, 0, 0), HorizontalAlignment = HorizontalAlignment.Left };
        var asp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        asp.Children.Add(new Icon("plus", 15, B("TextMuted")));
        asp.Children.Add(Ui.Text("Add task", 13.5, B("TextMuted")));
        add.Content = asp;
        AutomationProperties.SetAutomationId(add, "page-tasks-add");
        AutomationProperties.SetName(add, "Add task");
        add.Click += (_, _) => Host?.OpenQuickAdd(new QuickAddDialog.Seed(PageId: _pageId));
        list.Children.Add(add);
        var sv = new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(sv, 2);
        root.Children.Add(sv);

        // the id sits on a StackPanel inside the border (a Border has no UI Automation peer)
        var tagged = new StackPanel { Children = { root } };
        AutomationProperties.SetAutomationId(tagged, "page-tasks-panel");
        AutomationProperties.SetItemStatus(tagged, $"tasks={all.Count} open={open.Count} done={done.Count}");
        return new Border { BorderBrush = B("Border"), BorderThickness = new Thickness(1, 0, 0, 0), Child = tagged };
    }

    private UIElement Tab(string icon, string text, bool on)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Padding = new Thickness(10, 0, 10, 0), Height = 28, CornerRadius = new CornerRadius(6), Background = on ? B("BgElevated") : null };
        sp.Children.Add(new Icon(icon, 14, on ? B("Text") : B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        sp.Children.Add(Ui.Text(text, 13, on ? B("Text") : B("TextMuted"), 500).With(t => t.VerticalAlignment = VerticalAlignment.Center));
        return sp;
    }

    private UIElement Row(TaskItem t)
    {
        var normal = new SolidColorBrush(Colors.Transparent);
        var row = new Grid { Padding = new Thickness(8, 10, 8, 10), ColumnSpacing = 10, Background = normal, BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var sub = B("BgSubtle");
        row.PointerEntered += (_, _) => row.Background = sub;
        row.PointerExited += (_, _) => row.Background = normal;

        var circle = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Width = 26, Height = 26, Padding = new Thickness(0), CornerRadius = new CornerRadius(13), VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(-4, -3, 0, 0), Content = TaskParts.Circle(B, t.Priority, t.Done),
        };
        AutomationProperties.SetAutomationId(circle, "page-task-circle-" + t.Id);
        AutomationProperties.SetName(circle, (t.Done ? "Mark not done: " : "Mark done: ") + t.Title);
        AutomationProperties.SetItemStatus(circle, t.Done ? "done=1" : "done=0");
        circle.Tapped += (_, e) => e.Handled = true;
        circle.Click += (_, _) => _src.UpdateTask(t.Id, new TaskPatch(Done: !t.Done));
        row.Children.Add(circle);
        AutomationProperties.SetAutomationId(row, "page-task-row-" + t.Id);
        AutomationProperties.SetName(row, t.Title);
        row.Tapped += (_, _) => Host?.OpenTask(t.Id);

        var body = new StackPanel();
        var title = Ui.Text(t.Title.Length == 0 ? "Untitled" : t.Title, 13.5, t.Done ? B("TextMuted") : B("Text"), lineHeight: 19);
        title.TextWrapping = TextWrapping.Wrap;
        if (t.Done) title.TextDecorations = TextDecorations.Strikethrough;
        body.Children.Add(title);
        var meta = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(0, 3, 0, 0), MinHeight = 20 };
        if (t.DueLabel is not null)
        {
            var tone = TaskParts.ToneBrush(B, t.Tone);
            meta.Children.Add(TaskParts.IconText("calendar-days", 13, t.DueLabel, 12, tone, tone));
        }
        if (t.Priority > 0)
        {
            var pb = TaskParts.PriorityBrush(B, t.Priority);
            meta.Children.Add(new Icon("flag", 13, pb) { Fill = pb, VerticalAlignment = VerticalAlignment.Center });
        }
        if (t.ChecklistTotal > 0) meta.Children.Add(TaskParts.IconText("list-checks", 13, $"{t.ChecklistDone}/{t.ChecklistTotal}", 12, B("TextMuted"), B("TextMuted")));
        if (t.Recurring) meta.Children.Add(new Icon("repeat", 13, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        body.Children.Add(meta);
        Grid.SetColumn(body, 1);
        row.Children.Add(body);

        if (t.Assignee is not null)
        {
            var av = Ui.Avatar(t.Assignee, 20);
            av.VerticalAlignment = VerticalAlignment.Top; av.Margin = new Thickness(0, 2, 0, 0);
            Grid.SetColumn(av, 2);
            row.Children.Add(av);
        }
        return row;
    }
}
