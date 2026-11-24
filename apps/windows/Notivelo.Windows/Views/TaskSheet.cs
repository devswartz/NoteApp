using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Windows.System;

namespace Notivelo.Windows.Views;

/// <summary>The task detail sheet (LOOK 4.10 / task-detail.png, Apple's TaskDetail.swift): slides in from the right, 480 wide. Title, tick, assignee, team, tags,
/// due date, time, priority, repeat, reminders, the description and the subtasks are written through <see cref="INotesSource.UpdateTask"/> (the core's update_task)
/// and the reminder / subtask calls as they are edited. The pickers are in <see cref="TaskPickers"/>.</summary>
internal sealed class TaskSheet
{
    private readonly ShellHost _h;
    private readonly OverlayHost _o;
    private readonly string _id;
    private OverlayHost.Layer? _layer;
    private readonly TextBox _title = new();
    private readonly TextBox _desc = new();
    private readonly Button _tick = new();
    private readonly Button _assignee = new();
    private readonly Button _team = new();
    private readonly Button _tags = new();
    private readonly Button _dueBtn = new();
    private readonly TimePicker _time = new();
    private readonly Button _clearTime = new();
    private readonly Button _priority = new();
    private readonly Button _repeat = new();
    private readonly StackPanel _reminders = new() { Spacing = 2 };
    private readonly TextBlock _assignedBy = new();
    private readonly StackPanel _subs = new();
    private readonly TextBox _subInput = new();
    private readonly StackPanel _subsList = new();
    private readonly Grid _subsAdd = new() { Height = 40, ColumnSpacing = 10 };
    private readonly TextBlock _crumb = new();
    private readonly TextBlock _created = new();
    private bool _syncing;
    private TaskDetailItem? _d;

    public static void Show(ShellHost host, string taskId)
    {
        if (host.Source.GetTaskDetail(taskId) is null) return;
        new TaskSheet(host, taskId).Open();
    }

    private TaskSheet(ShellHost host, string id) { _h = host; _o = host.Overlay; _id = id; }

    private Brush B(string k) => ThemeBrushes.Get(k, _o);
    private bool CanEdit => _d?.Editable ?? false;
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.Now);
    private void Patch(TaskPatch p) { if (CanEdit) _h.Source.UpdateTask(_id, p); }

    private void Open()
    {
        var body = new StackPanel { Padding = new Thickness(24, 19, 24, 24), Spacing = 2 };

        // title row: tick + title
        var tr = new Grid { ColumnSpacing = 2, Margin = new Thickness(0, 0, 0, 20) };
        tr.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        tr.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        _tick.Style = Ui.Style("GhostButtonStyle"); _tick.Width = 26; _tick.Height = 26; _tick.Padding = new Thickness(0); _tick.CornerRadius = new CornerRadius(13); _tick.Margin = new Thickness(-4, 0, 0, 0);
        AutomationProperties.SetAutomationId(_tick, "task-sheet-tick");
        _tick.Click += (_, _) => { if (_d is { } d) Patch(new TaskPatch(Done: !d.Done)); };
        tr.Children.Add(_tick);
        _title.FontSize = 19; _title.FontWeight = new FontWeight(600); _title.BorderThickness = new Thickness(0); _title.Background = new SolidColorBrush(Colors.Transparent);
        _title.TextWrapping = TextWrapping.Wrap; _title.AcceptsReturn = false; _title.PlaceholderText = "Task title"; _title.Padding = new Thickness(6, 4, 6, 4);
        AutomationProperties.SetAutomationId(_title, "task-sheet-title");
        AutomationProperties.SetName(_title, "Title");
        Grid.SetColumn(_title, 1);
        tr.Children.Add(_title);
        body.Children.Add(tr);
        _title.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) { e.Handled = true; CommitTitle(); _title.Focus(FocusState.Programmatic); } };
        _title.LostFocus += (_, _) => CommitTitle();

        foreach (var b in new[] { _assignee, _team, _tags, _dueBtn, _priority, _repeat })
        {
            b.Style = Ui.Style("GhostButtonStyle"); b.MinHeight = 30; b.Padding = new Thickness(0, 2, 8, 2); b.CornerRadius = new CornerRadius(6); b.HorizontalAlignment = HorizontalAlignment.Left;
        }
        _assignee.Click += (_, _) => { if (CanEdit) TaskPickers.Assignee(_o, _h.Source, _assignee, _d, Patch); };
        _team.Click += (_, _) => { if (CanEdit) TaskPickers.Team(_o, _h.Source, _team, _d?.TeamId, Patch); };
        _tags.Click += (_, _) => { if (CanEdit) TaskPickers.Tags(_o, _h.Source, _tags, _d?.TagIds ?? Array.Empty<string>(), Patch); };
        _dueBtn.Click += (_, _) => { if (CanEdit) TaskPickers.Due(_o, _dueBtn, _d?.DueDate, Patch); };
        _priority.Click += (_, _) => { if (CanEdit) PriorityMenu(); };
        _repeat.Click += (_, _) => { if (CanEdit) TaskPickers.Repeat(_o, _repeat, _d?.Recurrence, _d?.DueDate, Patch); };

        var assigneeCol = new StackPanel();
        assigneeCol.Children.Add(_assignee);
        _assignedBy.FontSize = 12.5; _assignedBy.Foreground = B("TextMuted"); _assignedBy.FontFamily = Ui.Font; _assignedBy.Margin = new Thickness(8, -2, 0, 4);
        assigneeCol.Children.Add(_assignedBy);
        body.Children.Add(Prop("user-round", "Assignee", assigneeCol, null));
        _assignee.IsTabStop = true; AutomationProperties.SetAutomationId(_assignee, "task-sheet-assignee");
        body.Children.Add(Prop("users", "Team", _team, "task-sheet-team"));
        body.Children.Add(Prop("tag", "Tags", _tags, "task-sheet-tags"));
        body.Children.Add(Prop("calendar-days", "Due date", _dueBtn, "task-sheet-due"));

        _time.ClockIdentifier = "24HourClock"; _time.MinuteIncrement = 5; _time.SelectedTime = null; _time.MinWidth = 150;
        AutomationProperties.SetName(_time, "Time");
        _clearTime.Style = Ui.Style("GhostButtonStyle"); _clearTime.Width = 28; _clearTime.Height = 28; _clearTime.CornerRadius = new CornerRadius(6);
        _clearTime.Content = new Icon("x", 13, B("TextMuted"));
        AutomationProperties.SetAutomationId(_clearTime, "task-sheet-time-clear");
        AutomationProperties.SetName(_clearTime, "Clear time");
        ToolTipService.SetToolTip(_clearTime, "Clear time");
        _clearTime.Click += (_, _) => Patch(new TaskPatch(ClearDueTime: true));
        _time.SelectedTimeChanged += (_, e) =>
        {
            if (_syncing || e.NewTime is not { } t) return;
            var s = $"{t.Hours:00}:{t.Minutes:00}";
            if (s == _d?.DueTime) return;
            // as the web: a time on a task without a date sets the date to today
            Patch(new TaskPatch(DueTime: s, DueDate: _d?.DueDate is null ? TaskLogic.Day(Today) : null));
        };
        var timeRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        timeRow.Children.Add(_time); timeRow.Children.Add(_clearTime);
        body.Children.Add(Prop("clock", "Time", timeRow, "task-sheet-time"));
        body.Children.Add(Prop("flag", "Priority", _priority, "task-sheet-priority"));
        body.Children.Add(Prop("repeat", "Repeat", _repeat, "task-sheet-repeat"));
        AutomationProperties.SetName(_reminders, "Reminders");   // a plain panel has no automation peer without a name
        body.Children.Add(Prop("bell", "Reminders", _reminders, "task-sheet-reminders"));

        _desc.AcceptsReturn = true; _desc.TextWrapping = TextWrapping.Wrap; _desc.MinHeight = 120; _desc.PlaceholderText = "Add details…"; _desc.CornerRadius = new CornerRadius(8);
        _desc.Background = B("BgSubtle"); _desc.BorderBrush = B("Border"); _desc.FontSize = 14; _desc.Padding = new Thickness(12, 10, 12, 10);
        _desc.Margin = new Thickness(0, 16, 0, 0);
        AutomationProperties.SetAutomationId(_desc, "task-sheet-description");
        AutomationProperties.SetName(_desc, "Description");
        _desc.LostFocus += (_, _) => CommitDescription();
        body.Children.Add(_desc);

        // subtasks (a subtask has none of its own)
        _subs.Margin = new Thickness(0, 18, 0, 0);
        AutomationProperties.SetAutomationId(_subs, "task-sheet-subtasks");
        AutomationProperties.SetName(_subs, "Subtasks");
        body.Children.Add(_subs);
        // the add-a-subtask input lives in one persistent row (never re-parented: moving a focused TextBox during a refresh threw COMException)
        _subsAdd.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });
        _subsAdd.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        _subsAdd.Children.Add(new Icon("plus", 15, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(_subInput, 1);
        _subsAdd.Children.Add(_subInput);
        _subs.Children.Add(_subsList);
        _subs.Children.Add(_subsAdd);
        _subInput.Style = Ui.Style("PlainTextBoxStyle"); _subInput.PlaceholderText = "Add a subtask…"; _subInput.FontSize = 14; _subInput.BorderThickness = new Thickness(0);
        _subInput.Background = new SolidColorBrush(Colors.Transparent); _subInput.Padding = new Thickness(0, 6, 0, 6);
        AutomationProperties.SetAutomationId(_subInput, "task-sheet-subtask-input");
        AutomationProperties.SetName(_subInput, "Add a subtask");
        _subInput.KeyDown += async (_, e) =>
        {
            if (e.Key != VirtualKey.Enter || _subInput.Text.Trim().Length == 0) return;
            e.Handled = true;
            var t = _subInput.Text; _subInput.Text = "";
            if (await _h.Source.AddSubtask(_id, t) is { } err) _h.Toast(err, true);
        };

        _created.FontSize = 12.5; _created.Foreground = B("TextMuted"); _created.Margin = new Thickness(0, 20, 0, 0); _created.FontFamily = Ui.Font;
        _created.TextWrapping = TextWrapping.Wrap;
        body.Children.Add(_created);

        // head: crumb, delete, close
        var head = new Grid { Padding = new Thickness(12, 10, 12, 10), BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1), ColumnSpacing = 4 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _crumb.FontSize = 13; _crumb.Foreground = B("TextMuted"); _crumb.FontFamily = Ui.Font; _crumb.VerticalAlignment = VerticalAlignment.Center; _crumb.TextTrimming = TextTrimming.CharacterEllipsis;
        AutomationProperties.SetAutomationId(_crumb, "task-sheet-crumb");
        _crumb.Tapped += (_, _) => OpenCrumb();
        head.Children.Add(_crumb);
        var del = Ui.IconButton("trash", 16, 32, 32, "Delete task");
        AutomationProperties.SetAutomationId(del, "task-sheet-delete");
        del.Click += (_, _) => DeleteTask();
        Grid.SetColumn(del, 1);
        head.Children.Add(del);
        var close = Ui.IconButton("x", 16, 32, 32, "Close");
        AutomationProperties.SetAutomationId(close, "task-sheet-close");
        close.Click += (_, _) => _layer?.Close();
        Grid.SetColumn(close, 2);
        head.Children.Add(close);

        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.Children.Add(head);
        var sv = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(sv, 1);
        root.Children.Add(sv);
        var sheet = new Border { Width = 480, Background = B("Bg"), BorderBrush = B("Border"), BorderThickness = new Thickness(1, 0, 0, 0), Child = root };
        AutomationProperties.SetAutomationId(sheet, "task-sheet");

        EventHandler changed = (_, _) => Sync();
        _h.Source.Changed += changed;
        _layer = _o.Show(sheet, HorizontalAlignment.Right, VerticalAlignment.Stretch, new Thickness(0), closed: () => { _h.Source.Changed -= changed; CommitTitle(); CommitDescription(); });
        Sync(first: true);
        _h.Source.LoadTaskExtras(_id);
    }

    private UIElement Prop(string icon, string label, UIElement value, string? id)
    {
        var g = new Grid { MinHeight = 38 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(120) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var l = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, VerticalAlignment = VerticalAlignment.Center };
        l.Children.Add(new Icon(icon, 15, B("TextMuted")));
        l.Children.Add(Ui.Text(label, 13, B("TextMuted")));
        g.Children.Add(l);
        if (value is FrameworkElement fe) { fe.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(fe, 1); }
        g.Children.Add(value);
        if (id is not null) AutomationProperties.SetAutomationId(value, id);
        return g;
    }

    /// <summary>Show the task as the source has it now. A box being typed in keeps its text.</summary>
    private void Sync(bool first = false)
    {
        var d = _h.Source.GetTaskDetail(_id);
        if (d is null) { _layer?.Close(); return; }
        _d = d;
        _syncing = true;
        try
        {
            _tick.Content = TaskParts.Circle(B, d.Priority, d.Done, 18);
            AutomationProperties.SetName(_tick, d.Done ? "Mark not done" : "Mark done");
            AutomationProperties.SetItemStatus(_tick, d.Done ? "done=1" : "done=0");
            if (first || _title.FocusState == FocusState.Unfocused) { if (_title.Text != d.Title) _title.Text = d.Title; }
            _title.Foreground = d.Done ? B("TextMuted") : B("Text");
            if (first || _desc.FocusState == FocusState.Unfocused) { if (_desc.Text != d.Description) _desc.Text = d.Description; }
            _desc.IsEnabled = d.Editable;
            _crumb.Text = d.ParentId is not null ? "Subtask of " + d.ParentTitle : d.PageTitle is null ? "Standalone task" : d.PageTitle;
            _crumb.Foreground = d.ParentId is not null || d.PageId is not null ? B("Text2") : B("TextMuted");
            _created.Text = d.CreatedLine;
            foreach (var b in new Control[] { _assignee, _team, _tags, _dueBtn, _priority, _repeat, _time, _clearTime }) b.IsEnabled = d.Editable;

            _assignee.Content = Chip(d.AssigneeName is { } n ? Ui.Avatar(Initials(n), 18) : new Icon("user-round", 15, B("TextMuted")), d.AssigneeName ?? "Unassigned", d.AssigneeName is null);
            _assignedBy.Text = d.AssignedByName is { } by ? "Assigned by " + by : "";
            _assignedBy.Visibility = d.AssignedByName is null ? Visibility.Collapsed : Visibility.Visible;

            var team = d.TeamId is null ? null : _h.Source.Teams().FirstOrDefault(t => t.Id == d.TeamId);
            _team.Content = team is null
                ? Chip(null, d.TeamId is null ? "No team" : "Team", true)
                : Chip(new Border { Width = 8, Height = 8, CornerRadius = new CornerRadius(4), Background = Ui.Hex(team.Color), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(5, 0, 5, 0) }, team.Label, false);
            AutomationProperties.SetItemStatus(_team, "team=" + (d.TeamId ?? ""));

            var known = _h.Source.Tags();
            var own = (d.TagIds ?? Array.Empty<string>()).Select(id => known.FirstOrDefault(t => t.Id == id)).Where(t => t is not null).Select(t => t!).ToList();
            if (own.Count == 0) _tags.Content = Chip(null, "No tags", true);
            else
            {
                var wrap = new WrapPanel { HorizontalSpacing = 4, VerticalSpacing = 4, MaxWidth = 300 };
                foreach (var t in own) wrap.Children.Add(TagChip(t));
                _tags.Content = wrap;
            }
            AutomationProperties.SetItemStatus(_tags, "tags=" + string.Join(",", own.Select(t => t.Name)));
            AutomationProperties.SetName(_tags, own.Count == 0 ? "Tags" : "Tags: " + string.Join(", ", own.Select(t => t.Name)));

            var p = d.Priority is >= 1 and <= 3 ? d.Priority : 0;
            _priority.Content = Chip(new Icon("flag", 15, p > 0 ? TaskParts.PriorityBrush(B, p) : B("TextMuted")) { Fill = p > 0 ? TaskParts.PriorityBrush(B, p) : null }, p > 0 ? "Priority " + p : "No priority", p == 0);
            AutomationProperties.SetItemStatus(_priority, "priority=" + p);

            var words = TaskLogic.DueWords(d.DueDate, null, Today);
            _dueBtn.Content = words is null ? Ui.Text("No date", 14, B("TextMuted")) : Ui.Text(words, 14, d.Done ? B("Text") : TaskParts.ToneBrush(B, d.Tone));
            AutomationProperties.SetItemStatus(_dueBtn, "due=" + (d.DueDate ?? ""));
            AutomationProperties.SetName(_dueBtn, "Due date: " + (words ?? "No date"));

            _time.SelectedTime = TimeSpan.TryParse(d.DueTime, System.Globalization.CultureInfo.InvariantCulture, out var ts) ? ts : null;
            _clearTime.Visibility = d.DueTime is null ? Visibility.Collapsed : Visibility.Visible;
            AutomationProperties.SetItemStatus(_time, "time=" + (d.DueTime ?? ""));

            _repeat.Content = d.RecurrenceText is { } rt ? Ui.Text(rt, 14, B("Text")) : Ui.Text("Does not repeat", 14, B("TextMuted"));
            AutomationProperties.SetItemStatus(_repeat, "repeat=" + (d.RecurrenceText ?? ""));
            AutomationProperties.SetName(_repeat, "Repeat: " + (d.RecurrenceText ?? "Does not repeat"));

            SyncReminders(d);
            SyncSubtasks(d);
        }
        finally { _syncing = false; }
    }

    private UIElement TagChip(TagInfo t) => new Border
    {
        Height = 22, CornerRadius = new CornerRadius(6), Padding = new Thickness(7, 0, 7, 0), Background = new SolidColorBrush(Ui.ColorOf(t.Color)) { Opacity = 0.16 },
        Child = Ui.Text(t.Name, 12, B("Text"), 500).With(x => x.VerticalAlignment = VerticalAlignment.Center),
    };

    private void SyncReminders(TaskDetailItem d)
    {
        _reminders.Children.Clear();
        var list = _h.Source.Reminders(_id);
        var n = 0;
        foreach (var r in list)
        {
            var line = new Grid { MinHeight = 30, ColumnSpacing = 8 };
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.Children.Add(new Icon("bell", 13, B("Text2")) { VerticalAlignment = VerticalAlignment.Center });
            var text = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center, Opacity = r.Note is "sent" or "done" ? 0.7 : 1 };
            text.Children.Add(Ui.Text(r.Text, 13, B("Text")));
            if (r.Note is not null) text.Children.Add(Ui.Text(r.Note, 12, B("TextMuted")));
            Grid.SetColumn(text, 1);
            line.Children.Add(text);
            AutomationProperties.SetAutomationId(text, "task-sheet-reminder-" + n);
            AutomationProperties.SetName(text, r.Text);
            if (d.Editable)
            {
                var del = Ui.IconButton("trash", 13, 30, 30, "Remove reminder");
                AutomationProperties.SetAutomationId(del, "task-sheet-reminder-del-" + n);
                AutomationProperties.SetName(del, "Remove reminder: " + r.Text);
                var rid = r.Id;
                del.Click += async (_, _) => { if (await _h.Source.DeleteReminder(_id, rid) is { } err) _h.Toast(err, true); };
                Grid.SetColumn(del, 2);
                line.Children.Add(del);
            }
            _reminders.Children.Add(line);
            n++;
        }
        if (d.Editable)
        {
            var add = new Button { Style = Ui.Style("GhostButtonStyle"), MinHeight = 30, Padding = new Thickness(0, 0, 8, 0), CornerRadius = new CornerRadius(6), HorizontalAlignment = HorizontalAlignment.Left };
            var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            sp.Children.Add(new Icon("plus", 15, B("Text2")));
            sp.Children.Add(Ui.Text(list.Count == 0 ? "Add reminder" : "Add another", 13, B("Text2"), 600));
            add.Content = sp;
            AutomationProperties.SetAutomationId(add, "task-sheet-add-reminder");
            AutomationProperties.SetName(add, "Add reminder");
            add.Click += (_, _) => TaskPickers.Reminder(_o, _h.Source, add, d.DueDate is not null, async r =>
            {
                if (await _h.Source.AddReminder(_id, r) is { } err) _h.Toast(err, true);
            });
            _reminders.Children.Add(add);
        }
        AutomationProperties.SetItemStatus(_reminders, "reminders=" + list.Count);
    }

    private string? _subsSig;

    private void SyncSubtasks(TaskDetailItem d)
    {
        var subs = d.Subtasks ?? Array.Empty<SubtaskInfo>();
        // redrawn only when they changed: the input keeps its focus and text while the sheet refreshes
        var sig = d.ParentId + "|" + d.Editable + "|" + string.Join(";", subs.Select(s => s.Id + s.Title + s.Done + s.Priority));
        if (sig == _subsSig) return;
        _subsSig = sig;
        _subsList.Children.Clear();
        _subsAdd.Visibility = d.ParentId is null ? Visibility.Visible : Visibility.Collapsed;
        if (d.ParentId is not null) return;
        var done = subs.Count(s => s.Done);
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Height = 22 };
        head.Children.Add(new Icon("list-checks", 15, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        head.Children.Add(Ui.Text("Subtasks", 13, B("Text2"), 600).With(t => t.VerticalAlignment = VerticalAlignment.Center));
        if (subs.Count > 0) head.Children.Add(Ui.Text($"{done}/{subs.Count}", 12.5, B("TextMuted")).With(t => t.VerticalAlignment = VerticalAlignment.Center));
        AutomationProperties.SetItemStatus(_subs, $"subtasks={done}/{subs.Count}");
        _subsList.Children.Add(head);
        if (subs.Count > 0)
        {
            var bar = new Grid { Height = 4, Margin = new Thickness(0, 8, 0, 4) };
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(done, 0.0001), GridUnitType.Star) });
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(subs.Count - done, 0.0001), GridUnitType.Star) });
            bar.Children.Add(new Border { Background = B("BgHover"), CornerRadius = new CornerRadius(2) }.With(b => Grid.SetColumnSpan(b, 2)));
            bar.Children.Add(new Border { Background = B("Success"), CornerRadius = new CornerRadius(2) });
            _subsList.Children.Add(bar);
        }
        foreach (var s in subs)
        {
            var row = new Grid { MinHeight = 36, ColumnSpacing = 10 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var circle = new Button { Style = Ui.Style("GhostButtonStyle"), Width = 26, Height = 26, Padding = new Thickness(0), CornerRadius = new CornerRadius(13), Content = TaskParts.Circle(B, s.Priority, s.Done, 18) };
            var sid = s.Id; var sdone = s.Done;
            circle.Click += (_, _) => Patch2(sid, new TaskPatch(Done: !sdone));
            AutomationProperties.SetAutomationId(circle, "task-sheet-sub-tick-" + s.Id);
            AutomationProperties.SetName(circle, (s.Done ? "Mark not done: " : "Mark done: ") + s.Title);
            AutomationProperties.SetItemStatus(circle, s.Done ? "done=1" : "done=0");
            row.Children.Add(circle);
            var title = Ui.Text(s.Title.Length == 0 ? "Untitled" : s.Title, 14, s.Done ? B("TextMuted") : B("Text"));
            title.TextDecorations = s.Done ? TextDecorations.Strikethrough : TextDecorations.None;
            title.VerticalAlignment = VerticalAlignment.Center;
            title.Tapped += (_, _) => { _layer?.Close(); _h.OpenTask(sid); };
            Grid.SetColumn(title, 1);
            row.Children.Add(title);
            AutomationProperties.SetAutomationId(title, "task-sheet-sub-" + s.Id);
            AutomationProperties.SetName(title, s.Title);
            _subsList.Children.Add(row);
        }
        _subsAdd.Margin = new Thickness(2, subs.Count == 0 ? 8 : 0, 0, 0);
        _subInput.IsEnabled = d.Editable;
    }

    private void Patch2(string taskId, TaskPatch p) { if (CanEdit) _h.Source.UpdateTask(taskId, p); }

    private void OpenCrumb()
    {
        if (_d is null) return;
        if (_d.ParentId is { } parent) { _layer?.Close(); _h.OpenTask(parent); }
        else if (_d.PageId is { } page) { _layer?.Close(); _h.OpenPage(page); }
    }

    private UIElement Chip(UIElement? icon, string text, bool muted)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        if (icon is not null) sp.Children.Add(icon);
        sp.Children.Add(Ui.Text(text, 14, muted ? B("TextMuted") : B("Text")));
        return sp;
    }

    private static string Initials(string name)
    {
        var parts = name.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length >= 2 ? (parts[0][..1] + parts[^1][..1]).ToUpperInvariant() : name.Length > 1 ? name[..2].ToUpperInvariant() : name.ToUpperInvariant();
    }

    private void CommitTitle()
    {
        var t = _title.Text.Trim();
        if (_d is { } d && t.Length > 0 && t != d.Title) Patch(new TaskPatch(Title: t));
    }

    private void CommitDescription()
    {
        if (_d is { } d && _desc.Text != d.Description) Patch(new TaskPatch(Description: _desc.Text));
    }

    private void PriorityMenu()
    {
        var cur = _d?.Priority is >= 1 and <= 3 ? _d.Priority : 4;
        var names = new[] { "", "Priority 1 (urgent)", "Priority 2 (high)", "Priority 3 (medium)", "No priority" };
        var items = new List<MenuEntry>();
        for (var p = 1; p <= 4; p++)
        {
            var pp = p;
            items.Add(new MenuEntry(names[p], "flag", () => Patch(new TaskPatch(Priority: pp)), Hint: cur == p ? "✓" : null));
        }
        PopupMenu.Show(_o, items, _priority);
    }

    private void DeleteTask()
    {
        var title = _d?.Title ?? "this task";
        Dialogs.Confirm(_o, "Delete task?", $"“{title}” will be deleted for good. This can't be undone.", "Delete", true, () =>
        {
            _layer?.Close();
            _h.Source.DeleteTask(_id);
            return Task.FromResult<string?>(null);
        });
    }
}
