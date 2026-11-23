using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>Sidebar panel (LOOK 4.3): the notebook / sections / pages tree (pages folded into the tree) or the Tasks panel.</summary>
internal sealed class SidebarView : ThemedControl
{
    private readonly INotesSource _source;
    private readonly HashSet<string> _collapsed = new();
    public AppRoute Route { get; private set; } = AppRoute.Notes;
    public string? SelectedPageId { get; private set; }
    public TaskViewKind TaskView { get; private set; } = TaskViewKind.Today;
    public event Action<string>? PageSelected;
    public event Action<TaskViewKind>? TaskViewSelected;

    public SidebarView(INotesSource source) { _source = source; SelectedPageId = source.InitialPageId; }

    public void Update(AppRoute route, string? pageId, TaskViewKind view)
    {
        Route = route; SelectedPageId = pageId; TaskView = view; Rebuild();
    }

    protected override UIElement Build() => Route switch
    {
        AppRoute.Tasks => BuildTasks(),
        AppRoute.Calendar => BuildCalendar(),
        _ => BuildNotes(),
    };

    // ---- row helper -------------------------------------------------------------------------------------------

    private Border Row(double height, double radius, bool selected, Action? click, UIElement content, Thickness padding)
    {
        var normal = new SolidColorBrush(Colors.Transparent);
        var hover = B("BgHover");
        var row = new Border
        {
            Height = height, CornerRadius = new CornerRadius(radius), Padding = padding,
            Background = selected ? B("BgActive") : normal, Child = content,
        };
        if (!selected)
        {
            row.PointerEntered += (_, _) => row.Background = hover;
            row.PointerExited += (_, _) => row.Background = normal;
        }
        if (click is not null) row.Tapped += (_, _) => click();
        return row;
    }

    private static Grid Cols(params GridLength[] widths)
    {
        var g = new Grid();
        foreach (var w in widths) g.ColumnDefinitions.Add(new ColumnDefinition { Width = w });
        return g;
    }

    private static GridLength Px(double v) => new(v);
    private static readonly GridLength Auto = GridLength.Auto;
    private static readonly GridLength Star = new(1, GridUnitType.Star);

    // ---- Notes panel ------------------------------------------------------------------------------------------

    private UIElement BuildNotes()
    {
        var nb = _source.Notebooks[0];
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = Star });

        // head: notebook picker + options
        var head = Cols(Star, Auto);
        head.Padding = new Thickness(8, 10, 8, 6);
        head.MinHeight = 52;
        var picker = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 36, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(8), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch };
        var pg = Cols(Auto, Star, Auto);
        pg.ColumnSpacing = 8;
        pg.Children.Add(new Border
        {
            Width = 22, Height = 22, CornerRadius = new CornerRadius(6), Background = Ui.Hex(nb.ColorHex), VerticalAlignment = VerticalAlignment.Center,
            Child = Ui.Text(nb.Initial, 12, new SolidColorBrush(Colors.White), 700).With(t => t.HorizontalAlignment = HorizontalAlignment.Center),
        });
        var name = Ui.Text(nb.Name, 14, B("Text"), 650, tracking: -0.005);
        name.HorizontalAlignment = HorizontalAlignment.Left;
        name.ClearValue(TextBlock.ForegroundProperty);
        name.Foreground = B("Text");
        Grid.SetColumn(name, 1);
        pg.Children.Add(name);
        var chev = new Icon("chevron-down", 14, B("TextMuted"));
        Grid.SetColumn(chev, 2);
        pg.Children.Add(chev);
        picker.Content = pg;
        head.Children.Add(picker);
        var more = Ui.IconButton("ellipsis", 15, 24, 24, "Notebook options");
        more.Margin = new Thickness(4, 0, 0, 0);
        Grid.SetColumn(more, 1);
        head.Children.Add(more);
        root.Children.Add(head);

        // scroll area: SECTIONS
        var list = new StackPanel { Padding = new Thickness(8, 3, 8, 16) };
        list.Children.Add(GroupHeading("Sections", true));
        foreach (var s in nb.Sections) AddSection(list, s, 0);
        var sv = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollMode = ScrollMode.Disabled, Content = list };
        Grid.SetRow(sv, 1);
        root.Children.Add(sv);
        return root;
    }

    private UIElement GroupHeading(string text, bool plus)
    {
        var g = Cols(Star, Auto);
        g.MinHeight = 26;
        g.Margin = new Thickness(0, 0, 0, 2);
        var label = Ui.Text(text.ToUpperInvariant(), 11.5, B("TextMuted"), 600, tracking: 0.04);
        label.Margin = new Thickness(10, 0, 0, 0);
        g.Children.Add(label);
        if (plus)
        {
            var b = Ui.IconButton("plus", 15, 24, 24, "New section");
            Grid.SetColumn(b, 1);
            b.Margin = new Thickness(0, 0, 0, 0);
            g.Children.Add(b);
        }
        return g;
    }

    private void AddSection(Panel parent, Section s, int depth)
    {
        var selectedHere = s.Pages.Any(p => p.Id == SelectedPageId);
        var open = !_collapsed.Contains(s.Id);
        var g = Cols(Px(14), Px(4), Star, Auto);
        g.ColumnSpacing = 6;
        var chevron = new Icon(open ? "chevron-down" : "chevron-right", 13, B("TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        g.Children.Add(chevron);
        var tab = new Border { Width = 4, Height = 14, CornerRadius = new CornerRadius(2), Background = Ui.Hex(s.ColorHex), VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(tab, 1);
        g.Children.Add(tab);
        var nameTb = Ui.Text(s.Name, 14, selectedHere ? B("Accent") : B("Text2"), selectedHere ? 600 : 400);
        Grid.SetColumn(nameTb, 2);
        g.Children.Add(nameTb);
        var row = Row(30, 6, selectedHere, () => { if (open) _collapsed.Add(s.Id); else _collapsed.Remove(s.Id); Rebuild(); }, g, new Thickness(6 + 14 * depth, 0, 6, 0));
        parent.Children.Add(row);

        if (!open) return;
        var kids = new StackPanel
        {
            Margin = new Thickness(18, 0, 0, 0), Padding = new Thickness(4, 0, 0, 0),
            BorderBrush = B("Border"), BorderThickness = new Thickness(1, 0, 0, 0),
        };
        foreach (var c in s.Children) AddSection(kids, c, depth + 1);
        foreach (var p in s.Pages) kids.Children.Add(PageRow(p, depth));
        if (s.Pages.Count == 0 && s.Children.Count == 0)
        {
            var g2 = Cols(Px(14), Star);
            g2.ColumnSpacing = 6;
            g2.Children.Add(new Icon("plus", 14, B("TextMuted")));
            var t = Ui.Text("New page", 14, B("Text2"));
            Grid.SetColumn(t, 1);
            g2.Children.Add(t);
            kids.Children.Add(Row(28, 6, false, null, g2, new Thickness(6 + 14 * (depth + 1) + 20, 0, 6, 0)));
        }
        parent.Children.Add(kids);
    }

    private UIElement PageRow(PageSummary p, int depth)
    {
        var selected = p.Id == SelectedPageId;
        var g = Cols(Px(14), Star, Auto);
        g.ColumnSpacing = 6;
        g.Children.Add(new Icon("file-text", 14, selected ? B("Text2") : B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        var t = Ui.Text(p.Title, 14, selected ? B("Accent") : B("Text2"), selected ? 500 : 400);
        Grid.SetColumn(t, 1);
        g.Children.Add(t);
        if (p.OpenTasks > 0)
        {
            var c = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 3, Opacity = 0.8, VerticalAlignment = VerticalAlignment.Center };
            c.Children.Add(new Icon("circle-check", 11, B("TextMuted")));
            c.Children.Add(Ui.Text(p.OpenTasks.ToString(), 11, B("TextMuted")));
            Grid.SetColumn(c, 2);
            g.Children.Add(c);
        }
        return Row(28, 6, selected, () => PageSelected?.Invoke(p.Id), g, new Thickness(6 + 14 * (depth + 1) + 20 - 6 * 0, 0, 6, 0));
    }

    // ---- Tasks panel ------------------------------------------------------------------------------------------

    private UIElement BuildTasks()
    {
        var counts = _source.GetTaskCounts();
        var root = new StackPanel { Padding = new Thickness(8, 0, 8, 16) };
        var title = Ui.Text("Tasks", 15, B("Text"), 650);
        title.Margin = new Thickness(8, 18, 0, 12);
        title.Height = 24;
        root.Children.Add(title);

        // + Add task   [Q]
        var add = Cols(Px(16), Star, Auto);
        add.ColumnSpacing = 10;
        add.Children.Add(new Icon("plus", 16, B("Accent")));
        var at = Ui.Text("Add task", 14, B("Accent"), 500);
        Grid.SetColumn(at, 1);
        add.Children.Add(at);
        var kbd = new Border
        {
            MinWidth = 18, Height = 18, Padding = new Thickness(4, 0, 4, 0), CornerRadius = new CornerRadius(4), Background = B("Bg"),
            BorderBrush = B("Border"), BorderThickness = new Thickness(1, 1, 1, 2), VerticalAlignment = VerticalAlignment.Center,
            Child = Ui.Text("Q", 11, B("TextMuted"), 500).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; t.FontFamily = Ui.Font; }),
        };
        Grid.SetColumn(kbd, 2);
        add.Children.Add(kbd);
        root.Children.Add(Row(32, 7, false, null, add, new Thickness(10, 0, 10, 0)));
        root.Children.Add(new Border { Height = 14 });

        root.Children.Add(TaskItemRow("sun", "Today", TaskViewKind.Today, counts.Today, counts.TodayOverdue));
        root.Children.Add(TaskItemRow("inbox", "My Tasks", TaskViewKind.MyTasks, counts.MyTasks, false));
        root.Children.Add(TaskItemRow("calendar-range", "Upcoming", TaskViewKind.Upcoming, counts.Upcoming, false));
        root.Children.Add(TaskItemRow("list-checks", "All tasks", TaskViewKind.All, 0, false));
        root.Children.Add(TaskItemRow("users", "Team", TaskViewKind.Team, 0, false));

        var views = Ui.Text("VIEWS", 11.5, B("TextMuted"), 600, tracking: 0.04);
        views.Margin = new Thickness(10, 22, 0, 6);
        root.Children.Add(views);
        var nv = Cols(Px(16), Star);
        nv.ColumnSpacing = 10;
        nv.Children.Add(new Icon("plus", 15, B("TextMuted")));
        var nt = Ui.Text("New view", 14, B("Text2"), 500);
        Grid.SetColumn(nt, 1);
        nv.Children.Add(nt);
        root.Children.Add(Row(32, 7, false, null, nv, new Thickness(10, 0, 10, 0)));
        return new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    private UIElement TaskItemRow(string icon, string label, TaskViewKind kind, int count, bool danger)
    {
        var selected = TaskView == kind;
        var g = Cols(Px(16), Star, Auto);
        g.ColumnSpacing = 10;
        g.Children.Add(new Icon(icon, 16, selected ? B("Accent") : B("Text2")));
        var t = Ui.Text(label, 14, selected ? B("Accent") : B("Text2"), 500);
        Grid.SetColumn(t, 1);
        g.Children.Add(t);
        if (count > 0)
        {
            var badge = new Border
            {
                Height = 18, MinWidth = 18, Padding = new Thickness(6, 0, 6, 0), CornerRadius = new CornerRadius(9),
                Background = danger ? B("DangerSoft") : B("BgHover"), VerticalAlignment = VerticalAlignment.Center,
                Child = Ui.Text(count.ToString(), 10.5, danger ? B("Danger") : B("Text2"), 600).With(x => x.HorizontalAlignment = HorizontalAlignment.Center),
            };
            Grid.SetColumn(badge, 2);
            g.Children.Add(badge);
        }
        var row = Row(32, 7, selected, () => TaskViewSelected?.Invoke(kind), g, new Thickness(10, 0, 10, 0));
        row.Margin = new Thickness(0, 0, 0, 1);
        return row;
    }

    private UIElement BuildCalendar()
    {
        var root = new StackPanel { Padding = new Thickness(8, 0, 8, 16) };
        var title = Ui.Text("Calendar", 15, B("Text"), 650);
        title.Margin = new Thickness(8, 18, 0, 12);
        title.Height = 24;
        root.Children.Add(title);
        return root;
    }
}
