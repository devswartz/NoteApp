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

/// <summary>The task detail sheet (LOOK 4.10 / task-detail.png): slides in from the right, 480 wide. Title, tick, assignee, due date, priority and the
/// description are written through <see cref="INotesSource.UpdateTask"/> (the core's update_task) as they are edited.</summary>
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
    private readonly Button _priority = new();
    private readonly CalendarDatePicker _due = new();
    private readonly Button _clearDue = new();
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

    private void Open()
    {
        var body = new StackPanel { Padding = new Thickness(24, 14, 24, 24), Spacing = 10 };

        // title row: tick + title
        var tr = new Grid { ColumnSpacing = 2, Margin = new Thickness(0, 0, 0, 22) };
        tr.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        tr.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        _tick.Style = Ui.Style("GhostButtonStyle"); _tick.Width = 26; _tick.Height = 26; _tick.Padding = new Thickness(0); _tick.CornerRadius = new CornerRadius(13); _tick.Margin = new Thickness(-4, 0, 0, 0);
        AutomationProperties.SetAutomationId(_tick, "task-sheet-tick");
        _tick.Click += (_, _) => { if (_d is { } d) _h.Source.UpdateTask(_id, new TaskPatch(Done: !d.Done)); };
        tr.Children.Add(_tick);
        _title.FontSize = 20; _title.FontWeight = new FontWeight(600); _title.BorderThickness = new Thickness(0); _title.Background = new SolidColorBrush(Colors.Transparent);
        _title.TextWrapping = TextWrapping.Wrap; _title.AcceptsReturn = false; _title.PlaceholderText = "Task title"; _title.Padding = new Thickness(6, 4, 6, 4);
        AutomationProperties.SetAutomationId(_title, "task-sheet-title");
        AutomationProperties.SetName(_title, "Title");
        Grid.SetColumn(_title, 1);
        tr.Children.Add(_title);
        body.Children.Add(tr);
        _title.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) { e.Handled = true; CommitTitle(); _title.Focus(FocusState.Programmatic); } };
        _title.LostFocus += (_, _) => CommitTitle();

        body.Children.Add(Prop("user-round", "Assignee", _assignee, "task-sheet-assignee"));
        var dueRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        _due.PlaceholderText = "No date"; _due.Height = 30; _due.MinWidth = 140; _due.CornerRadius = new CornerRadius(6);
        AutomationProperties.SetAutomationId(_due, "task-sheet-due");
        AutomationProperties.SetName(_due, "Due date");
        dueRow.Children.Add(_due);
        _clearDue.Style = Ui.Style("GhostButtonStyle"); _clearDue.Width = 28; _clearDue.Height = 28; _clearDue.CornerRadius = new CornerRadius(6);
        _clearDue.Content = new Icon("x", 13, B("TextMuted"));
        AutomationProperties.SetAutomationId(_clearDue, "task-sheet-due-clear");
        AutomationProperties.SetName(_clearDue, "Clear due date");
        ToolTipService.SetToolTip(_clearDue, "Clear due date");
        _clearDue.Click += (_, _) => _h.Source.UpdateTask(_id, new TaskPatch(ClearDue: true));
        dueRow.Children.Add(_clearDue);
        body.Children.Add(Prop("calendar-days", "Due date", dueRow, null));
        _due.DateChanged += (_, e) =>
        {
            if (_syncing || e.NewDate is not { } nd) return;
            _h.Source.UpdateTask(_id, new TaskPatch(DueDate: nd.ToString("yyyy-MM-dd")));
        };
        body.Children.Add(Prop("flag", "Priority", _priority, "task-sheet-priority"));

        _assignee.Click += (_, _) => AssigneeMenu();
        _priority.Click += (_, _) => PriorityMenu();
        foreach (var b in new[] { _assignee, _priority })
        {
            b.Style = Ui.Style("GhostButtonStyle"); b.Height = 30; b.Padding = new Thickness(0, 0, 8, 0); b.CornerRadius = new CornerRadius(6); b.HorizontalAlignment = HorizontalAlignment.Left;
        }

        _desc.AcceptsReturn = true; _desc.TextWrapping = TextWrapping.Wrap; _desc.MinHeight = 120; _desc.PlaceholderText = "Add details…"; _desc.CornerRadius = new CornerRadius(8);
        _desc.Background = B("BgSubtle"); _desc.BorderBrush = B("Border"); _desc.FontSize = 14; _desc.Padding = new Thickness(12, 10, 12, 10);
        _desc.Margin = new Thickness(0, 12, 0, 0);
        AutomationProperties.SetAutomationId(_desc, "task-sheet-description");
        AutomationProperties.SetName(_desc, "Description");
        _desc.LostFocus += (_, _) => CommitDescription();
        body.Children.Add(_desc);

        _created.FontSize = 12.5; _created.Foreground = B("TextMuted"); _created.Margin = new Thickness(0, 18, 0, 0); _created.FontFamily = Ui.Font;
        body.Children.Add(_created);

        // head: crumb, open page, delete, close
        var head = new Grid { Padding = new Thickness(12, 10, 12, 10), BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1), ColumnSpacing = 4 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _crumb.FontSize = 13; _crumb.Foreground = B("TextMuted"); _crumb.FontFamily = Ui.Font; _crumb.VerticalAlignment = VerticalAlignment.Center; _crumb.TextTrimming = TextTrimming.CharacterEllipsis;
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
    }

    private UIElement Prop(string icon, string label, UIElement value, string? id)
    {
        var g = new Grid { MinHeight = 36 };
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
            _crumb.Text = d.PageTitle is null ? "Standalone task" : d.PageTitle;
            _created.Text = d.CreatedLine;
            _assignee.Content = Chip(d.AssigneeName is { } n ? Ui.Avatar(Initials(n), 18) : new Icon("user-round", 15, B("TextMuted")), d.AssigneeName ?? "Unassigned", d.AssigneeName is null);
            var p = d.Priority is >= 1 and <= 3 ? d.Priority : 0;
            _priority.Content = Chip(new Icon("flag", 15, p > 0 ? TaskParts.PriorityBrush(B, p) : B("TextMuted")) { Fill = p > 0 ? TaskParts.PriorityBrush(B, p) : null }, p > 0 ? "Priority " + p : "No priority", p == 0);
            AutomationProperties.SetItemStatus(_priority, "priority=" + p);
            if (d.DueDate is not null && DateOnly.TryParseExact(d.DueDate, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var due))
            {
                if (_due.Date is not { } cur || cur.Year != due.Year || cur.Month != due.Month || cur.Day != due.Day)
                    _due.Date = new DateTimeOffset(due.Year, due.Month, due.Day, 12, 0, 0, TimeZoneInfo.Local.GetUtcOffset(new DateTime(due.Year, due.Month, due.Day, 12, 0, 0)));
            }
            else if (_due.Date is not null) _due.Date = null;
            _clearDue.Visibility = d.DueDate is not null || d.DueLabel is not null ? Visibility.Visible : Visibility.Collapsed;
        }
        finally { _syncing = false; }
    }

    private UIElement Chip(UIElement icon, string text, bool muted)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        sp.Children.Add(icon);
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
        if (_d is { } d && t.Length > 0 && t != d.Title) _h.Source.UpdateTask(_id, new TaskPatch(Title: t));
    }

    private void CommitDescription()
    {
        if (_d is { } d && _desc.Text != d.Description) _h.Source.UpdateTask(_id, new TaskPatch(Description: _desc.Text));
    }

    private void AssigneeMenu()
    {
        var items = new List<MenuEntry> { new("Unassigned", "user-round", () => _h.Source.UpdateTask(_id, new TaskPatch(ClearAssignee: true)), Hint: _d?.AssigneeId is null ? "✓" : null) };
        foreach (var (id, label, _, _) in _h.Source.People(""))
        {
            var who = id;
            items.Add(new MenuEntry(label, "user", () => _h.Source.UpdateTask(_id, new TaskPatch(AssigneeId: who)), Hint: _d?.AssigneeId == id ? "✓" : null));
        }
        PopupMenu.Show(_o, items, _assignee);
    }

    private void PriorityMenu()
    {
        var cur = _d?.Priority is >= 1 and <= 3 ? _d.Priority : 4;
        var names = new[] { "", "Priority 1 (urgent)", "Priority 2 (high)", "Priority 3 (medium)", "No priority" };
        var items = new List<MenuEntry>();
        for (var p = 1; p <= 4; p++)
        {
            var pp = p;
            items.Add(new MenuEntry(names[p], "flag", () => _h.Source.UpdateTask(_id, new TaskPatch(Priority: pp)), Hint: cur == p ? "✓" : null));
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
