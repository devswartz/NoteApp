using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>Tasks views (LOOK 4.10): header, Today stats card, groups of TaskRows, "+ Add task".</summary>
internal sealed class TasksView : ThemedControl
{
    private readonly INotesSource _source;
    public TaskViewKind View { get; private set; } = TaskViewKind.Today;

    public TasksView(INotesSource source) => _source = source;

    public void SetView(TaskViewKind v) { View = v; Rebuild(); }

    private static string Title(TaskViewKind v) => v switch
    {
        TaskViewKind.Today => "Today",
        TaskViewKind.MyTasks => "My Tasks",
        TaskViewKind.Upcoming => "Upcoming",
        TaskViewKind.All => "All tasks",
        _ => "Team",
    };

    protected override UIElement Build()
    {
        var root = new StackPanel { Padding = new Thickness(40, 36, 40, 120) };
        root.Children.Add(Ui.Text(Title(View), 26, B("Text"), 700, lineHeight: 34, tracking: -0.02));
        var sub = Ui.Text(_source.TasksSubtitle(View), 14, B("TextMuted"), lineHeight: 21);
        sub.Margin = new Thickness(0, 4, 0, 20);
        root.Children.Add(sub);
        if (View == TaskViewKind.Today) root.Children.Add(StatsCard());

        foreach (var g in _source.GetTaskGroups(View)) root.Children.Add(GroupBlock(g));

        var add = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Padding = new Thickness(6, 8, 6, 8), Margin = new Thickness(0, 0, 0, 0) };
        add.Children.Add(new Icon("plus", 15, B("TextMuted")));
        add.Children.Add(Ui.Text("Add task", 13.5, B("TextMuted")));
        root.Children.Add(add);
        return new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    private UIElement StatsCard()
    {
        var st = _source.GetTodayStats();
        var card = new Grid { Padding = new Thickness(16, 14, 16, 14) };
        var left = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 24 };
        void Stat(int n, string label)
        {
            var sp = new StackPanel();
            sp.Children.Add(Ui.Text(n.ToString(), 22, B("Text"), 700, lineHeight: 28));
            sp.Children.Add(Ui.Text(label, 12, B("TextMuted"), lineHeight: 16));
            left.Children.Add(sp);
        }
        Stat(st.DoneToday, "done today"); Stat(st.Left, "left"); Stat(st.DayStreak, "day streak");
        card.Children.Add(left);

        var bars = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right };
        var letters = "SMTWTFS";
        for (var i = 0; i < 7; i++)
        {
            var col = new StackPanel { Spacing = 4, Width = 10 };
            col.Children.Add(new Border { Width = 10, Height = 32, CornerRadius = new CornerRadius(3), Background = st.WeekDone[i] ? B("AccentSolid") : B("BgHover") });
            col.Children.Add(Ui.Text(letters[i].ToString(), 10.5, B("TextMuted"), lineHeight: 12).With(t => t.HorizontalAlignment = HorizontalAlignment.Center));
            bars.Children.Add(col);
        }
        card.Children.Add(bars);

        // 3 pt progress line along the bottom edge.
        var progress = new Grid { Height = 3, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(1, 0, 1, 0) };
        progress.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(st.Progress, GridUnitType.Star) });
        progress.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1 - st.Progress, GridUnitType.Star) });
        progress.Children.Add(new Border { Background = B("Success"), CornerRadius = new CornerRadius(0, 0, 0, 11) });
        var outer = new Grid();
        outer.Children.Add(card);
        outer.Children.Add(progress);
        return new Border
        {
            BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), Background = B("BgElevated"),
            Margin = new Thickness(0, 0, 0, 22), Child = outer,
        };
    }

    private UIElement GroupBlock(TaskGroup g)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 0, 0, 22) };
        var head = new Grid { Padding = new Thickness(0, 8, 0, 6), BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1) };
        var hs = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        hs.Children.Add(Ui.Text(g.Title, 13.5, g.IsOverdue ? B("Danger") : B("Text"), 650));
        hs.Children.Add(Ui.Text(g.Count.ToString(), 12, B("TextMuted"), 500));
        head.Children.Add(hs);
        panel.Children.Add(head);
        foreach (var t in g.Tasks) panel.Children.Add(Row(t));
        return panel;
    }

    private UIElement Row(TaskItem t)
    {
        var normal = new SolidColorBrush(Colors.Transparent);
        var row = new Grid
        {
            Padding = new Thickness(12, 11, 12, 11), ColumnSpacing = 10, Background = normal,
            BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1),
        };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var sub = B("BgSubtle");
        row.PointerEntered += (_, _) => row.Background = sub;
        row.PointerExited += (_, _) => row.Background = normal;

        var circle = TaskParts.Circle(B, t.Priority, t.Done);
        ((FrameworkElement)circle).Margin = new Thickness(0, 1, 0, 0);
        row.Children.Add(circle);

        var body = new StackPanel();
        var title = Ui.Text(t.Title, 14, t.Done ? B("TextMuted") : B("Text"), lineHeight: 19.6);
        title.TextWrapping = TextWrapping.Wrap;
        if (t.Done) title.TextDecorations = TextDecorations.Strikethrough;
        body.Children.Add(title);

        var meta = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(0, 3, 0, 0), MinHeight = 22 };
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
        if (t.PageTitle is not null) meta.Children.Add(TaskParts.IconText("file-text", 13, t.PageTitle, 12, B("TextMuted"), B("TextMuted")));
        if (t.Team is not null) meta.Children.Add(TaskParts.IconText("users-round", 13, t.Team, 12, Ui.Hex("#0ea5e9"), B("TextMuted")));
        body.Children.Add(meta);
        Grid.SetColumn(body, 1);
        row.Children.Add(body);

        if (t.Assignee is not null)
        {
            var av = Ui.Avatar(t.Assignee, 20);
            av.VerticalAlignment = VerticalAlignment.Top;
            av.Margin = new Thickness(0, 2, 0, 0);
            Grid.SetColumn(av, 2);
            row.Children.Add(av);
        }
        return row;
    }
}
