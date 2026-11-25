using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The task views' filters, sort and groups (Apple's TaskViewState / TaskViewUI): chosen from the Tasks ribbon's menus, kept per view on this device,
/// applied here over the tasks the source has loaded (<see cref="TaskViewLogic"/>). The default state shows the view's own lists untouched.</summary>
internal sealed partial class TasksView
{
    private readonly Dictionary<TaskViewKind, TaskViewState> _states = new();
    private StackPanel? _list;
    private TextBlock? _count;
    private TextBlock? _summary;
    private string? _teamsAskedFor;

    /// <summary>A filter, sort or group was chosen: the ribbon draws its pressed states again.</summary>
    public event Action? StateChanged;

    public TaskViewState State => StateOf(View);

    /// <summary>The conditions of a view (kept per view on this device).</summary>
    public TaskViewState StateOf(TaskViewKind kind)
    {
        if (!_states.TryGetValue(kind, out var s)) _states[kind] = s = TaskViewState.FromJson(AppSettings.TaskView(kind.ToString()));
        return s;
    }

    private void Save() { AppSettings.SetTaskView(View.ToString(), State.ToJson()); StateChanged?.Invoke(); }

    private void Apply() { Save(); Rebuild(); }

    /// <summary>The team of each task (and the teams and tags) come from the core's full task list: asked once per workspace, when a view needs them.</summary>
    private void EnsureTeams()
    {
        var s = State;
        if (View != TaskViewKind.Team && s.Group != TaskGrouping.Team && s.Teams.Count == 0) return;
        if (_teamsAskedFor == _source.CurrentWorkspaceId) return;
        _teamsAskedFor = _source.CurrentWorkspaceId ?? "";
        _source.LoadTaskTeams();
    }

    private TaskContext Context() => new(_source.UserId, DateOnly.FromDateTime(DateTime.Now), _source.Members(), _source.Teams(), id => _source.PageTitleOf(id));

    // ---- the controls row: search, Mine/Everyone on Upcoming, the count and the conditions in words ----

    private UIElement ControlsRow()
    {
        var s = State;
        var col = new StackPanel { Margin = new Thickness(0, 0, 0, 10), Spacing = 8 };
        var row = new Grid { ColumnSpacing = 10 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var q = new TextBox { Text = s.Q, PlaceholderText = "Filter tasks…", Height = 34, FontSize = 14, Padding = new Thickness(10, 6, 10, 6), CornerRadius = new CornerRadius(8), MaxWidth = 360, HorizontalAlignment = HorizontalAlignment.Left };
        AutomationProperties.SetAutomationId(q, "tasks-search");
        AutomationProperties.SetName(q, "Filter tasks");
        q.TextChanged += (_, _) => { if (State.Q == q.Text) return; State.Q = q.Text; AppSettings.SetTaskView(View.ToString(), State.ToJson()); FillList(); StateChanged?.Invoke(); };
        row.Children.Add(q);
        if (View == TaskViewKind.Upcoming)
        {
            var seg = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, Padding = new Thickness(2), Background = B("BgSubtle"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8) };
            foreach (var (label, every) in new[] { ("Mine", false), ("Everyone", true) })
            {
                var on = s.UpcomingEveryone == every;
                var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6), Background = on ? B("Bg") : null, Content = Ui.Text(label, 13, on ? B("Text") : B("TextMuted"), 500) };
                AutomationProperties.SetAutomationId(b, "tasks-upcoming-" + label.ToLowerInvariant());
                AutomationProperties.SetName(b, label + (on ? " (selected)" : ""));
                b.Click += (_, _) => { State.UpcomingEveryone = every; Apply(); };
                seg.Children.Add(b);
            }
            Grid.SetColumn(seg, 1);
            row.Children.Add(seg);
        }
        if (View != TaskViewKind.Team)
        {
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var sel = SelectButton();
            Grid.SetColumn(sel, 2);
            row.Children.Add(sel);
        }
        col.Children.Add(row);

        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        if (ViewChip() is { } chip) line.Children.Add(chip);
        _count = Ui.Text("", 13, B("TextMuted"));
        AutomationProperties.SetAutomationId(_count, "tasks-count");
        _summary = Ui.Text("", 13, B("TextMuted"));
        _summary.TextTrimming = TextTrimming.CharacterEllipsis;
        AutomationProperties.SetAutomationId(_summary, "tasks-filter-summary");
        line.Children.Add(_count);
        line.Children.Add(_summary);
        if (s.AnyFilter)
        {
            var clear = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 24, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6), Content = Ui.Text("Clear", 13, B("Text2"), 500) };
            AutomationProperties.SetAutomationId(clear, "tasks-clear-filters");
            AutomationProperties.SetName(clear, "Clear filters");
            clear.Click += (_, _) => { State.ClearAll(); Apply(); };
            line.Children.Add(clear);
        }
        col.Children.Add(line);
        return col;
    }

    // ---- the list ----

    /// <summary>Fill the list under the controls (also while typing in the search box: only this part is drawn again).</summary>
    private void FillList()
    {
        if (_list is null) return;
        _list.Children.Clear();
        var s = State;
        IReadOnlyList<TaskGroup> groups;
        UIElement? team = null;
        if (View == TaskViewKind.Team) { groups = Array.Empty<TaskGroup>(); team = TeamBody(); }
        else if (s.IsDefault) groups = _source.GetTaskGroups(View);
        else groups = Computed();
        var total = groups.Sum(g => g.Count);
        _order = groups.SelectMany(g => g.Tasks).Select(t => t.Id).ToList();
        _byId = new Dictionary<string, TaskItem>();
        foreach (var t in groups.SelectMany(g => g.Tasks)) _byId.TryAdd(t.Id, t);
        _rows.Clear();
        _sel.Prune(_order);
        if (team is not null && _sel.Active) _sel.Clear();
        UpdateBulkBar();
        if (_count is not null)
        {
            var text = View == TaskViewKind.Team ? "" : $"{total} task{(total == 1 ? "" : "s")}";
            _count.Text = text;
            AutomationProperties.SetName(_count, text);
            AutomationProperties.SetItemStatus(_count, "count=" + total);
        }
        if (_summary is not null)
        {
            var ctx = Context(); var tags = _source.Tags();
            var text = string.Join(" · ", s.ActiveKinds.Where(k => k != "status" || View == TaskViewKind.All).Select(k => s.Summary(k, ctx, tags)));
            _summary.Text = text;
            AutomationProperties.SetName(_summary, text);
        }
        if (team is not null) { _list.Children.Add(team); return; }
        foreach (var g in groups) _list.Children.Add(GroupBlock(g));
        if (_source.LoadError is { } err && groups.Count == 0)
            _list.Children.Add(Ui.Text(err, 13.5, B("Danger")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.Margin = new Thickness(0, 24, 0, 24); }));
        else if (groups.Count == 0 && _source.Loading)
            _list.Children.Add(Ui.Text("Loading…", 13.5, B("TextMuted")).With(t => t.Margin = new Thickness(0, 24, 0, 24)));
        else if (groups.Count == 0)
            _list.Children.Add(s.AnyFilter ? Ui.Text("No tasks match these filters.", 14, B("TextMuted")).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; t.Margin = new Thickness(0, 40, 0, 40); }) : EmptyState());
    }

    private IReadOnlyList<TaskGroup> Computed()
    {
        var s = State; var ctx = Context();
        var facts = _source.TaskFacts();
        var open = TaskViewLogic.Base(View, facts, ctx, s.UpcomingEveryone);
        var shown = View == TaskViewKind.All && s.Status == TaskStatusFilter.Done ? Array.Empty<TaskFact>() : TaskViewLogic.Filter(open, s, ctx);
        var groups = TaskViewLogic.Grouped(shown, s.Group, s.Sort, ctx, perDay: View == TaskViewKind.Upcoming).ToList();
        if (View == TaskViewKind.All && s.Status != TaskStatusFilter.Open)
        {
            var done = TaskViewLogic.Filter(facts.Where(t => t.Done), s, ctx).OrderByDescending(t => t.CompletedAt, StringComparer.Ordinal).Select(t => t.Item).ToList();
            if (done.Count > 0) groups.Add(new TaskGroup(s.Status == TaskStatusFilter.Any ? "Completed" : "", done.Count, false, done));
        }
        return groups;
    }

    // ---- Team: who is working on what (a card per person), or the open tasks by team ----

    private UIElement TeamBody()
    {
        var s = State; var ctx = Context();
        var all = _source.TaskFacts();
        var hasTeams = ctx.Teams.Count > 0;
        var byTeam = s.TeamByTeam && hasTeams;
        var root = new StackPanel { Spacing = 14 };
        if (hasTeams)
        {
            var seg = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, Padding = new Thickness(2), Background = B("BgSubtle"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), HorizontalAlignment = HorizontalAlignment.Left };
            foreach (var (label, t) in new[] { ("By person", false), ("By team", true) })
            {
                var on = byTeam == t;
                var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6), Background = on ? B("Bg") : null, Content = Ui.Text(label, 13, on ? B("Text") : B("TextMuted"), 500) };
                AutomationProperties.SetAutomationId(b, "team-" + (t ? "by-team" : "by-person"));
                AutomationProperties.SetName(b, label + (on ? " (selected)" : ""));
                b.Click += (_, _) => { State.TeamByTeam = t; Apply(); };
                seg.Children.Add(b);
            }
            root.Children.Add(seg);
        }
        var open = all.Where(t => !t.Done).ToList();
        if (byTeam)
        {
            var groups = TaskViewLogic.Grouped(TaskViewLogic.Filter(open, s, ctx), TaskGrouping.Team, TaskSort.Due, ctx);
            if (groups.Count == 0) root.Children.Add(Ui.Text("No open tasks.", 14, B("TextMuted")).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; t.Margin = new Thickness(0, 30, 0, 30); }));
            foreach (var g in groups) root.Children.Add(GroupBlock(g));
            return root;
        }
        var people = ctx.Members.Where(m => m.Role != "viewer" || all.Any(t => t.AssigneeId == m.Id)).Select(m => (Id: m.Id, Name: m.Name.Length > 0 ? m.Name : m.Email, Color: (string?)m.Color)).ToList();
        people.Add(("none", "Unassigned", null));
        List<TaskFact> Theirs((string Id, string Name, string? Color) p) => all.Where(t => p.Id == "none" ? t.AssigneeId is null : t.AssigneeId == p.Id).ToList();
        const int cols = 3;
        var grid = new Grid { ColumnSpacing = 10, RowSpacing = 10 };
        for (var c = 0; c < cols; c++) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (var i = 0; i < people.Count; i++)
        {
            var p = people[i];
            var (nOpen, nOver, nDone) = TaskViewLogic.PersonStats(Theirs(p), ctx);
            var active = s.TeamFocus == p.Id;
            var card = new StackPanel { Spacing = 8 };
            var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            head.Children.Add(p.Color is null ? Ui.Avatar("?", 28, "#94a3b8") : Ui.Avatar(AccountRules.Initials(p.Name, ""), 28, p.Color));
            head.Children.Add(Ui.Text(p.Name, 14, B("Text"), 650));
            card.Children.Add(head);
            var nums = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
            nums.Children.Add(Ui.Text(nOpen + " open", 12.5, B("Text2")));
            if (nOver > 0) nums.Children.Add(Ui.Text(nOver + " overdue", 12.5, B("Danger")));
            nums.Children.Add(Ui.Text(nDone + " done this week", 12.5, B("Text2")));
            card.Children.Add(nums);
            var total = nOpen + nDone;
            var bar = new Grid { Height = 4 };
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(0.0001, total == 0 ? 0 : (double)nDone / total), GridUnitType.Star) });
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(0.0001, total == 0 ? 1 : (double)nOpen / total), GridUnitType.Star) });
            bar.Children.Add(new Border { Background = B("Success"), CornerRadius = new CornerRadius(2) });
            var rest = new Border { Background = B("BgHover"), CornerRadius = new CornerRadius(2) };
            Grid.SetColumn(rest, 1); bar.Children.Add(rest);
            card.Children.Add(bar);
            var btn = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Padding = new Thickness(12),
                CornerRadius = new CornerRadius(12), Background = B("BgElevated"), BorderBrush = active ? B("Accent") : B("Border"), BorderThickness = new Thickness(1), Content = card,
            };
            AutomationProperties.SetAutomationId(btn, "team-card-" + p.Id);
            AutomationProperties.SetName(btn, $"{p.Name}, {nOpen} open" + (active ? " (selected)" : ""));
            var id = p.Id;
            btn.Click += (_, _) => { State.TeamFocus = State.TeamFocus == id ? null : id; Apply(); };
            Grid.SetColumn(btn, i % cols); Grid.SetRow(btn, i / cols);
            if (i % cols == 0) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            grid.Children.Add(btn);
        }
        root.Children.Add(grid);
        foreach (var p in people.Where(p => s.TeamFocus is null || s.TeamFocus == p.Id))
        {
            var rows = TaskViewLogic.Sorted(TaskViewLogic.Filter(Theirs(p).Where(t => !t.Done), s, ctx), TaskSort.Due);
            if (s.TeamFocus is null && rows.Count == 0) continue;
            var g = new TaskGroup(p.Name, rows.Count, false, rows.Select(t => t.Item).ToList());
            var block = GroupBlock(g);
            if (rows.Count == 0 && block is StackPanel sp) sp.Children.Add(Ui.Text("No open tasks.", 13, B("TextMuted")).With(t => t.Margin = new Thickness(6, 10, 0, 10)));
            root.Children.Add(block);
        }
        return root;
    }

    // ---- the ribbon's menus ----

    public void ClearFilters() { State.ClearAll(); Apply(); }

    /// <summary>Open the menu of a Tasks ribbon button under it.</summary>
    public void ShowMenu(string tip, FrameworkElement anchor)
    {
        if (Host is null) return;
        var s = State;
        var items = new List<MenuEntry>();
        MenuEntry Pick(string text, bool on, Action act, string id, string? icon = null) => new(text, icon, () => { act(); Apply(); }, Check: on, Id: id);
        switch (tip)
        {
            case "Group":
                foreach (var g in Enum.GetValues<TaskGrouping>()) items.Add(Pick(TaskViewState.GroupLabel(g), s.Group == g, () => { s.Group = g; EnsureTeams(); }, "menu-group-" + g.ToString().ToLowerInvariant()));
                break;
            case "Sort":
                foreach (var o in Enum.GetValues<TaskSort>()) items.Add(Pick(TaskViewState.SortLabel(o), s.Sort == o, () => s.Sort = o, "menu-sort-" + o.ToString().ToLowerInvariant()));
                break;
            case "Status":
                foreach (var o in Enum.GetValues<TaskStatusFilter>()) items.Add(Pick(TaskViewState.StatusLabel(o), s.Status == o, () => s.Status = o, "menu-status-" + o.ToString().ToLowerInvariant()));
                break;
            case "Assignee":
                items.Add(Pick("Me", s.Assignee.Contains("me"), () => TaskViewState.Toggle(s.Assignee, "me"), "menu-assignee-me"));
                items.Add(Pick("Someone else", s.Assignee.Contains("others"), () => TaskViewState.Toggle(s.Assignee, "others"), "menu-assignee-others"));
                items.Add(Pick("Unassigned", s.Assignee.Contains("unassigned"), () => TaskViewState.Toggle(s.Assignee, "unassigned"), "menu-assignee-unassigned"));
                var members = _source.Members().Where(m => m.Id != _source.UserId).ToList();
                if (members.Count > 0) items.Add(MenuEntry.Sep());
                foreach (var m in members) items.Add(Pick(m.Name.Length > 0 ? m.Name : m.Email, s.Assignee.Contains(m.Id), () => TaskViewState.Toggle(s.Assignee, m.Id), "menu-assignee-" + m.Id));
                break;
            case "Tags":
                var tags = _source.Tags();
                if (tags.Count == 0) items.Add(new MenuEntry("No tags yet", Id: "menu-tags-none"));
                foreach (var t in tags) items.Add(Pick(t.Name, s.Tags.Contains(t.Id), () => TaskViewState.Toggle(s.Tags, t.Id), "menu-tag-" + t.Id, "tag"));
                break;
            case "Team":
                EnsureTeams();
                items.Add(Pick("No team", s.Teams.Contains("none"), () => TaskViewState.Toggle(s.Teams, "none"), "menu-team-none"));
                foreach (var t in _source.Teams()) items.Add(Pick(t.Label, s.Teams.Contains(t.Id), () => TaskViewState.Toggle(s.Teams, t.Id), "menu-team-" + t.Id));
                items.Add(MenuEntry.Sep());
                items.Add(Pick("Include subteams", s.IncludeSubteams, () => s.IncludeSubteams = !s.IncludeSubteams, "menu-team-subteams"));
                break;
            case "Priority":
                for (var p = 1; p <= 4; p++)
                {
                    var n = p;
                    items.Add(Pick(TaskViewState.PriorityLabel(n), s.Priority.Contains(n), () => TaskViewState.Toggle(s.Priority, n), "menu-priority-" + n, "flag"));
                }
                break;
            case "More filters":
                items.Add(MenuEntry.Label("Due"));
                foreach (var d in Enum.GetValues<TaskDueFilter>()) items.Add(Pick(TaskViewState.DueLabel(d), s.Due == d, () => s.Due = d, "menu-due-" + d.ToString().ToLowerInvariant()));
                items.Add(MenuEntry.Sep());
                items.Add(MenuEntry.Label("Source"));
                items.Add(Pick("On pages", s.Source.Contains("notes"), () => TaskViewState.Toggle(s.Source, "notes"), "menu-source-notes"));
                items.Add(Pick("Standalone", s.Source.Contains("standalone"), () => TaskViewState.Toggle(s.Source, "standalone"), "menu-source-standalone"));
                break;
            case "Clear filters":
                s.ClearAll(); Apply();
                return;
            default: return;
        }
        PopupMenu.Show(Host.Overlay, items, anchor, id: "menu-" + PopupMenu.Slug(tip), width: 240);
    }
}
