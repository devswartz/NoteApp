using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The pickers of the task sheet and quick add (Apple's TaskPickers.swift): assignee, team, tags (pick or create), due date, repeat and reminder. Each is a
/// popup menu under its row; a pick calls back with the choice and the caller writes it (the sheet through <see cref="INotesSource.UpdateTask"/>).</summary>
internal static class TaskPickers
{
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.Now);

    // ---- assignee ----

    public static void Assignee(OverlayHost o, INotesSource src, FrameworkElement anchor, TaskDetailItem? d, Action<TaskPatch> patch) =>
        AssigneeMenu(o, src, anchor, d?.AssigneeId, id => patch(id is null ? new TaskPatch(ClearAssignee: true) : new TaskPatch(AssigneeId: id)));

    public static void AssigneeMenu(OverlayHost o, INotesSource src, FrameworkElement anchor, string? current, Action<string?> pick)
    {
        var items = new List<MenuEntry> { new("Unassigned", "user-round", () => pick(null), Hint: current is null ? "✓" : null, Id: "pick-assignee-none") };
        foreach (var (id, label, _, _) in src.People(""))
        {
            var who = id;
            items.Add(new MenuEntry(label, "user", () => pick(who), Hint: current == id ? "✓" : null, Id: "pick-assignee-" + id));
        }
        PopupMenu.Show(o, items, anchor, id: "menu-pick-assignee");
    }

    // ---- team ----

    public static void Team(OverlayHost o, INotesSource src, FrameworkElement anchor, string? current, Action<TaskPatch> patch) =>
        TeamMenu(o, src, anchor, current, id => patch(id is null ? new TaskPatch(ClearTeam: true) : new TaskPatch(TeamId: id)));

    public static void TeamMenu(OverlayHost o, INotesSource src, FrameworkElement anchor, string? current, Action<string?> pick)
    {
        var items = new List<MenuEntry> { new("No team", "users", () => pick(null), Hint: current is null ? "✓" : null, Id: "pick-team-none") };
        var teams = src.Teams();
        foreach (var t in teams)
        {
            var id = t.Id;
            items.Add(new MenuEntry(t.Label, null, () => pick(id), Hint: current == id ? "✓" : null, TileColor: t.Color, Id: "pick-team-" + id));
        }
        if (teams.Count == 0) items.Add(new MenuEntry("No teams in this workspace", Heading: true));
        PopupMenu.Show(o, items, anchor, id: "menu-pick-team");
    }

    // ---- tags: pick any number, or type a new one ----

    public static void Tags(OverlayHost o, INotesSource src, FrameworkElement anchor, IEnumerable<string> current, Action<TaskPatch> patch) =>
        TagsMenu(o, src, anchor, current, ids => patch(new TaskPatch(TagIds: ids)));

    public static void TagsMenu(OverlayHost o, INotesSource src, FrameworkElement anchor, IEnumerable<string> current, Action<string[]> changed)
    {
        var sel = new List<string>(current);
        const double height = 292;
        PopupMenu.Show(o, new[]
        {
            MenuEntry.Block((B, close) =>
            {
                var root = new StackPanel { Spacing = 4 };
                var input = new TextBox { PlaceholderText = "Find or create a tag…", FontSize = 14, Height = 34, Margin = new Thickness(0, 0, 0, 2) };
                AutomationProperties.SetAutomationId(input, "pick-tag-input");
                AutomationProperties.SetName(input, "Find or create a tag");
                var list = new StackPanel();
                var scroll = new ScrollViewer { MaxHeight = 220, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
                root.Children.Add(input); root.Children.Add(scroll);

                void Row(string text, string? color, bool on, string id, Action click)
                {
                    var g = new Grid { ColumnSpacing = 10 };
                    g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });
                    g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                    g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    g.Children.Add(color is null ? new Icon("plus", 15, B("TextMuted")) : new Border { Width = 10, Height = 10, CornerRadius = new CornerRadius(5), Background = Ui.Hex(color), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
                    var label = Ui.Text(text, 14, B("Text")); Grid.SetColumn(label, 1); g.Children.Add(label);
                    if (on) { var chk = new Icon("check", 14, B("Accent")); Grid.SetColumn(chk, 2); g.Children.Add(chk); }
                    var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 32, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g };
                    AutomationProperties.SetAutomationId(b, id);
                    AutomationProperties.SetName(b, text + (on ? " (selected)" : ""));
                    b.Click += (_, _) => click();
                    list.Children.Add(b);
                }

                void Draw()
                {
                    list.Children.Clear();
                    var q = input.Text.Trim().TrimStart('#');
                    var all = src.Tags();
                    var shown = all.Where(t => q.Length == 0 || t.Name.Contains(q, StringComparison.OrdinalIgnoreCase)).ToList();
                    foreach (var t in shown)
                    {
                        var tag = t;
                        Row(t.Name, t.Color, sel.Contains(t.Id), "pick-tag-" + PopupMenu.Slug(t.Name), () => { Toggle(tag.Id); });
                    }
                    if (q.Length > 0 && !all.Any(t => string.Equals(t.Name, q, StringComparison.OrdinalIgnoreCase)))
                        Row("Create “" + q + "”", null, false, "pick-tag-create", () => _ = Create(q));
                    if (list.Children.Count == 0) list.Children.Add(Ui.Text("No tags yet. Type a name to make one.", 13, B("TextMuted")).With(t => t.Margin = new Thickness(10, 6, 10, 6)));
                }

                void Toggle(string id)
                {
                    if (!sel.Remove(id)) sel.Add(id);
                    changed(sel.ToArray());
                    Draw();
                }

                async Task Create(string name)
                {
                    var made = await src.CreateTag(name);
                    if (made is null) { input.Text = ""; Draw(); return; }
                    if (!sel.Contains(made.Id)) sel.Add(made.Id);
                    changed(sel.ToArray());
                    input.Text = "";
                    Draw();
                }

                input.TextChanged += (_, _) => Draw();
                input.KeyDown += (_, e) =>
                {
                    if (e.Key != global::Windows.System.VirtualKey.Enter) return;
                    e.Handled = true;
                    var q = input.Text.Trim().TrimStart('#');
                    if (q.Length == 0) { close(); return; }
                    var hit = src.Tags().FirstOrDefault(t => string.Equals(t.Name, q, StringComparison.OrdinalIgnoreCase));
                    if (hit is not null) { Toggle(hit.Id); input.Text = ""; Draw(); } else _ = Create(q);
                };
                input.Loaded += (_, _) => input.Focus(FocusState.Programmatic);
                Draw();
                return root;
            }, height),
        }, anchor, id: "menu-pick-tags", width: 280);
    }

    // ---- due date: a few days, then any day ----

    public static void Due(OverlayHost o, FrameworkElement anchor, string? current, Action<TaskPatch> patch) =>
        DueMenu(o, anchor, current, day => patch(day is null ? new TaskPatch(ClearDue: true) : new TaskPatch(DueDate: day)));

    public static void DueMenu(OverlayHost o, FrameworkElement anchor, string? current, Action<string?> pick)
    {
        var today = Today;
        var add = ((int)DayOfWeek.Monday - (int)today.DayOfWeek + 7) % 7;
        var nextMonday = today.AddDays(add == 0 ? 7 : add);
        var items = new List<MenuEntry>
        {
            new("Today", "sun", () => pick(TaskLogic.Day(today)), Hint: today.ToString("ddd"), Id: "pick-due-today"),
            new("Tomorrow", "calendar-days", () => pick(TaskLogic.Day(today.AddDays(1))), Hint: today.AddDays(1).ToString("ddd"), Id: "pick-due-tomorrow"),
            new("Next week", "calendar-range", () => pick(TaskLogic.Day(nextMonday)), Hint: nextMonday.ToString("ddd d MMM"), Id: "pick-due-nextweek"),
            MenuEntry.Block((B, close) =>
            {
                var cv = new CalendarView
                {
                    SelectionMode = CalendarViewSelectionMode.Single, IsTodayHighlighted = true, Width = 300, MaxWidth = 300,
                    FirstDayOfWeek = global::Windows.Globalization.DayOfWeek.Monday, CornerRadius = new CornerRadius(8),
                };
                if (TaskLogic.ParseDay(current) is { } cur)
                {
                    var dt = new DateTimeOffset(cur.Year, cur.Month, cur.Day, 12, 0, 0, TimeSpan.Zero);
                    cv.SelectedDates.Add(dt); cv.SetDisplayDate(dt);
                }
                AutomationProperties.SetAutomationId(cv, "pick-due-calendar");
                AutomationProperties.SetName(cv, "Pick a date");
                cv.SelectedDatesChanged += (_, e) =>
                {
                    if (e.AddedDates.Count == 0) return;
                    var d = e.AddedDates[0];
                    close();
                    pick(TaskLogic.Day(new DateOnly(d.Year, d.Month, d.Day)));
                };
                return new Border { Padding = new Thickness(0, 4, 0, 4), Child = cv };
            }, 372),
            MenuEntry.Sep(),
            new("No date", "x", () => pick(null), Id: "pick-due-none"),
        };
        PopupMenu.Show(o, items, anchor, id: "menu-pick-due", width: 320);
    }

    // ---- repeat: the web's presets anchored on the due date; "Custom…" is not built yet ----

    public static void Repeat(OverlayHost o, FrameworkElement anchor, Notivelo.Native.TaskRecurrence? current, string? due, Action<TaskPatch> patch)
    {
        var anchorDay = due ?? TaskLogic.Day(Today);
        var items = new List<MenuEntry>();
        var presets = TaskLogic.Presets(anchorDay);
        for (var i = 0; i < presets.Count; i++)
        {
            var rule = presets[i].Rule;
            items.Add(new MenuEntry(presets[i].Label, "repeat", () =>
            {
                // as the web: a rule on a task without a date sets the date to the rule's first day
                var first = due is null ? TaskLogic.FirstOccurrence(rule, TaskLogic.Day(Today)) : null;
                patch(new TaskPatch(DueDate: first, Recurrence: rule));
            }, Check: current is not null && TaskLogic.Key(current) == TaskLogic.Key(rule), Id: "pick-repeat-" + i));
        }
        // a rule the presets don't hold (made on another device) is shown, kept, and can be cleared
        if (current is not null && presets.All(p => TaskLogic.Key(p.Rule) != TaskLogic.Key(current)))
            items.Add(new MenuEntry(TaskLogic.Describe(current, due), "repeat", null, Check: true, Id: "pick-repeat-current"));
        if (current is not null)
        {
            items.Add(MenuEntry.Sep());
            items.Add(new MenuEntry("Does not repeat", "x", () => patch(new TaskPatch(ClearRecurrence: true)), Id: "pick-repeat-none"));
        }
        PopupMenu.Show(o, items, anchor, id: "menu-pick-repeat", width: 300);
    }

    // ---- reminder: before the due time, or at a fixed time ----

    public static void Reminder(OverlayHost o, INotesSource src, FrameworkElement anchor, bool hasDue, Action<ReminderInput> add)
    {
        var items = new List<MenuEntry>();
        if (hasDue)
        {
            items.Add(MenuEntry.Label("Before it is due"));
            foreach (var r in TaskLogic.Relative)
            {
                var m = r.Minutes;
                items.Add(new MenuEntry(r.Label, "bell", () => add(new ReminderInput(m, null)), Id: "pick-reminder-" + m));
            }
            items.Add(MenuEntry.Sep());
        }
        items.Add(new MenuEntry("At a time…", "clock", () => AtTime(o, anchor, add), Id: "pick-reminder-at"));
        PopupMenu.Show(o, items, anchor, id: "menu-pick-reminder", width: 280);
    }

    private static void AtTime(OverlayHost o, FrameworkElement anchor, Action<ReminderInput> add)
    {
        PopupMenu.Show(o, new[]
        {
            MenuEntry.Block((B, close) =>
            {
                var sp = new StackPanel { Spacing = 8, Padding = new Thickness(4) };
                var date = new CalendarDatePicker { Date = DateTimeOffset.Now.AddHours(1), MinDate = DateTimeOffset.Now.Date, FirstDayOfWeek = global::Windows.Globalization.DayOfWeek.Monday, HorizontalAlignment = HorizontalAlignment.Stretch };
                var time = new TimePicker { ClockIdentifier = "24HourClock", MinuteIncrement = 5, Time = DateTime.Now.AddHours(1).TimeOfDay, HorizontalAlignment = HorizontalAlignment.Stretch };
                AutomationProperties.SetAutomationId(date, "pick-reminder-date"); AutomationProperties.SetName(date, "Reminder date");
                AutomationProperties.SetAutomationId(time, "pick-reminder-time"); AutomationProperties.SetName(time, "Reminder time");
                var ok = Dialogs.Btn(o, "Add", true, id: "pick-reminder-add");
                ok.Click += (_, _) =>
                {
                    var d = date.Date ?? DateTimeOffset.Now;
                    var local = new DateTime(d.Year, d.Month, d.Day, time.Time.Hours, time.Time.Minutes, 0, DateTimeKind.Local);
                    close();
                    add(new ReminderInput(null, local.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.000'Z'", System.Globalization.CultureInfo.InvariantCulture)));
                };
                sp.Children.Add(date); sp.Children.Add(time); sp.Children.Add(ok);
                return sp;
            }, 160),
        }, anchor, id: "menu-pick-reminder-at", width: 280);
    }
}
