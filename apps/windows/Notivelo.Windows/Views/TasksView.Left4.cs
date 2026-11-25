using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Windows.System;

namespace Notivelo.Windows.Views;

/// <summary>left4 on the Tasks view: saved views (open one, start a new one, save the filters) and bulk selection (a Select button, Ctrl and Shift clicks, the keyboard, and the bar
/// of Complete, Date, Priority, Assign, Delete). Apple's Bulk.swift and SavedViews.swift, the web's BulkBar.tsx and selection.ts.</summary>
internal sealed partial class TasksView
{
    private readonly TaskSelection _sel = new();
    private List<string> _order = new();
    private Dictionary<string, TaskItem> _byId = new();
    private Border? _bulkHost;
    private ScrollViewer? _scrollView;
    private bool _reveal;
    private readonly Dictionary<string, FrameworkElement> _rows = new();

    /// <summary>Tasks are being selected (the ribbon and the tests read it).</summary>
    public int Selected => _sel.Count;

    // ---- saved views ----

    /// <summary>Open a saved view: its conditions replace All tasks' (kept on this device like the other view choices). The shell then shows All tasks.</summary>
    public void OpenSavedView(SavedView v)
    {
        SavedViewRules.Apply(SavedViewRules.FromQueryJson(v.QueryJson), StateOf(TaskViewKind.All));
        AppSettings.SetTaskView(TaskViewKind.All.ToString(), StateOf(TaskViewKind.All).ToJson());
        _sel.Clear();
        StateChanged?.Invoke();
    }

    /// <summary>"New view": All tasks from a clean slate.</summary>
    public void NewView()
    {
        var all = StateOf(TaskViewKind.All);
        all.ClearAll();
        all.Sort = TaskSort.Due; all.Group = TaskGrouping.Due;
        AppSettings.SetTaskView(TaskViewKind.All.ToString(), all.ToJson());
        _sel.Clear();
        StateChanged?.Invoke();
    }

    /// <summary>"Save view": name the conditions of All tasks.</summary>
    public void SaveView()
    {
        if (Host is null) return;
        SavedViewsUi.Save(Host, StateOf(TaskViewKind.All));
    }

    public void ShowSavedViews(FrameworkElement anchor)
    {
        if (Host is null) return;
        SavedViewsUi.RibbonMenu(Host, anchor, StateOf(TaskViewKind.All), View == TaskViewKind.All);
    }

    /// <summary>The saved view All tasks is showing (its conditions are exactly the view's); null when none.</summary>
    public SavedView? ShownView => View == TaskViewKind.All ? SavedViewRules.Matching(_source.SavedViews, State) : null;

    private UIElement? ViewChip()
    {
        if (ShownView is not { } v) return null;
        var t = Ui.Text("Saved view: " + v.Name, 13, B("Accent"), 600);
        AutomationProperties.SetAutomationId(t, "tasks-view-name");
        AutomationProperties.SetName(t, "Saved view: " + v.Name);
        return t;
    }

    // ---- selecting ----

    private UIElement CheckBox(bool on)
    {
        var box = new Border
        {
            Width = 18, Height = 18, CornerRadius = new CornerRadius(5), BorderThickness = new Thickness(1.6), BorderBrush = on ? B("Accent") : B("TextMuted"),
            Background = on ? B("AccentSolid") : new SolidColorBrush(Colors.Transparent), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
        };
        if (on) box.Child = new Icon("check", 12, new SolidColorBrush(Colors.White)) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, StrokeUnits = 3 };
        return box;
    }

    private Button SelectButton()
    {
        var on = _sel.Active;
        var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        content.Children.Add(new Icon("square-check-big", 15, on ? B("Accent") : B("Text2")));
        content.Children.Add(Ui.Text(on ? "Done" : "Select", 13, on ? B("Accent") : B("Text2"), 500));
        var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 34, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(8), Content = content };
        AutomationProperties.SetAutomationId(b, "tasks-select");
        AutomationProperties.SetName(b, on ? "Done selecting" : "Select tasks");
        AutomationProperties.SetItemStatus(b, on ? "selecting=1" : "selecting=0");
        b.Click += (_, _) =>
        {
            if (_sel.Active) _sel.Clear(); else _sel.Begin();
            RebuildKeepScroll();
            Focus(FocusState.Programmatic);   // the keys (Down, Space ...) then go to the list
        };
        return b;
    }

    private void RebuildKeepScroll()
    {
        var offset = _scrollView?.VerticalOffset ?? 0;
        Rebuild();
        if (offset > 0 && _scrollView is { } sv) { sv.Loaded += (_, _) => sv.ChangeView(null, offset, null, true); }
    }

    /// <summary>A pick changed: the rows and the bar are drawn again (the controls row is left alone, so the scroll position stays).</summary>
    private void RefreshSelection()
    {
        FillList();
        if (_reveal && _sel.Cursor is { } c && _rows.TryGetValue(c, out var el)) el.StartBringIntoView();
        _reveal = false;
        Focus(FocusState.Programmatic);
    }

    private static bool KeyDownNow(VirtualKey k) => Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(k).HasFlag(global::Windows.UI.Core.CoreVirtualKeyStates.Down);

    /// <summary>A click on a task row: with Shift it picks the range from the last pick, with Ctrl (or while selecting) it picks or unpicks the row, else it opens the task.</summary>
    private void RowTapped(string id)
    {
        var shift = KeyDownNow(VirtualKey.Shift); var ctrl = KeyDownNow(VirtualKey.Control);
        if (shift) { var was = _sel.Active; _sel.ExtendTo(id, _order); if (!was) RebuildKeepScroll(); else RefreshSelection(); Focus(FocusState.Programmatic); return; }
        if (ctrl || _sel.Active)
        {
            var was = _sel.Active;
            _sel.Toggle(id);
            if (!was) RebuildKeepScroll(); else RefreshSelection();
            Focus(FocusState.Programmatic);
            return;
        }
        Host?.OpenTask(id);
    }

    /// <summary>The list's keys (the web's task keyboard): J / K or Down / Up move the row (Shift extends the pick), X or Space picks it, 1-4 set the priority and D opens the date
    /// menu for the picked rows (or the row the keyboard is on), Enter opens the task, Ctrl+A picks all, Delete asks to delete, Esc leaves selecting. They work once the list has the
    /// keyboard (Tab, or the Select button); the first move or pick starts selecting.</summary>
    private void OnTasksKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Handled) return;
        if (FocusManager.GetFocusedElement(XamlRoot) is TextBox or PasswordBox or RichEditBox) return;
        var ctrl = KeyDownNow(VirtualKey.Control); var shift = KeyDownNow(VirtualKey.Shift);
        var key = e.Key switch { VirtualKey.J => VirtualKey.Down, VirtualKey.K => VirtualKey.Up, VirtualKey.X => VirtualKey.Space, _ => e.Key };
        if (ctrl && key != VirtualKey.A) return;
        var starts = key is VirtualKey.Down or VirtualKey.Up or VirtualKey.Space && !ctrl;
        if (!_sel.Active && !starts) return;
        if (View == TaskViewKind.Team) return;
        var was = _sel.Active;
        _sel.Begin();
        void Redraw() { if (!was) RebuildKeepScroll(); else RefreshSelection(); Focus(FocusState.Programmatic); }
        switch (key)
        {
            case VirtualKey.Down or VirtualKey.Up:
                _sel.Step(_order, key == VirtualKey.Down ? 1 : -1, shift);
                _reveal = true; Redraw(); e.Handled = true; break;
            case VirtualKey.Space:
                if (_sel.Cursor is null) _sel.Step(_order, 1, false);
                if (_sel.Cursor is { } c) _sel.Toggle(c);
                _reveal = true; Redraw(); e.Handled = true; break;
            case VirtualKey.Enter:
                if (_sel.Cursor is { } open) { Host?.OpenTask(open); e.Handled = true; }
                break;
            case VirtualKey.A when ctrl:
                _sel.SelectAll(_order); Redraw(); e.Handled = true; break;
            case VirtualKey.Delete:
                if (PickCursorIfNone()) { BulkDelete(); e.Handled = true; }
                break;
            case VirtualKey.Number1 or VirtualKey.Number2 or VirtualKey.Number3 or VirtualKey.Number4 or VirtualKey.NumberPad1 or VirtualKey.NumberPad2 or VirtualKey.NumberPad3 or VirtualKey.NumberPad4:
            {
                var p = key is >= VirtualKey.NumberPad1 and <= VirtualKey.NumberPad4 ? key - VirtualKey.NumberPad1 + 1 : key - VirtualKey.Number1 + 1;
                if (PickCursorIfNone()) { BulkPatch(new TaskPatch(Priority: p), "Priority set"); e.Handled = true; }
                break;
            }
            case VirtualKey.D:
                if (PickCursorIfNone()) { RefreshSelection(); if (_dateButton is { } d) BarMenu(d, "bulk-date-menu", DateMenu()); e.Handled = true; }
                break;
            case VirtualKey.Escape:
                _sel.Clear(); RebuildKeepScroll(); Focus(FocusState.Programmatic); e.Handled = true; break;
            default:
                if (!was) { _sel.Clear(); }   // a key that is not ours must not leave the list selecting
                break;
        }
    }

    /// <summary>Something to act on: the picked rows, or else the row the keyboard is on (it gets picked).</summary>
    private bool PickCursorIfNone()
    {
        if (_sel.Count > 0) return true;
        if (_sel.Cursor is not { } c) return false;
        _sel.Toggle(c);
        return true;
    }

    private Button? _dateButton;

    private List<MenuEntry> DateMenu() => new()
    {
        new("Today", "sun", () => BulkDate(0, "Moved to today"), Id: "bulk-date-today"),
        new("Tomorrow", "calendar-clock", () => BulkDate(1, "Moved to tomorrow"), Id: "bulk-date-tomorrow"),
        new("Next week", "calendar-range", () => BulkDate(7, "Moved to next week"), Id: "bulk-date-nextweek"),
        new("No date", "x", () => BulkPatch(new TaskPatch(ClearDue: true), "Date removed"), Id: "bulk-date-none"),
    };

    // ---- the bar ----

    private void UpdateBulkBar()
    {
        if (_bulkHost is null) return;
        if (!_sel.Active) { _bulkHost.Child = null; _bulkHost.Visibility = Visibility.Collapsed; return; }
        _bulkHost.Visibility = Visibility.Visible;
        _bulkHost.Child = BulkBar();
    }

    private Button BarButton(string icon, string label, string id, Action<Button> click, bool enabled, bool danger = false)
    {
        var fg = danger ? B("Danger") : B("Text2");
        var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        content.Children.Add(new Icon(icon, 15, fg));
        content.Children.Add(Ui.Text(label, 13, fg, 500));
        var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 34, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(8), Content = content, IsEnabled = enabled };
        AutomationProperties.SetAutomationId(b, id);
        AutomationProperties.SetName(b, label);
        b.Click += (_, _) => click(b);
        return b;
    }

    private UIElement BulkBar()
    {
        var n = _sel.Count;
        var picked = _sel.Ids.Select(i => _byId.GetValueOrDefault(i)).Where(t => t is not null).Select(t => t!).ToList();
        var allDone = BulkRules.AllDone(picked);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, Padding = new Thickness(8, 6, 8, 6) };
        var count = Ui.Text(n == 0 ? "Select tasks" : n + " selected", 13.5, B("Text"), 600);
        count.Margin = new Thickness(6, 0, 10, 0); count.VerticalAlignment = VerticalAlignment.Center;
        AutomationProperties.SetAutomationId(count, "bulk-count");
        AutomationProperties.SetName(count, n == 0 ? "Select tasks" : n + " selected");
        AutomationProperties.SetItemStatus(count, "count=" + n);
        row.Children.Add(count);
        row.Children.Add(BarButton(allDone ? "rotate-ccw" : "circle-check", allDone ? "Reopen" : "Complete", "bulk-complete", _ => BulkPatch(new TaskPatch(Done: !allDone), allDone ? "Reopened" : "Completed"), n > 0));
        var dateBtn = BarButton("calendar-days", "Date", "bulk-date", b => BarMenu(b, "bulk-date-menu", DateMenu()), n > 0);
        _dateButton = dateBtn;
        row.Children.Add(dateBtn);
        row.Children.Add(BarButton("flag", "Priority", "bulk-priority", b =>
        {
            var items = new List<MenuEntry>();
            for (var p = 1; p <= 4; p++) { var v = p; items.Add(new(TaskViewState.PriorityLabel(v), "flag", () => BulkPatch(new TaskPatch(Priority: v), "Priority set"), Id: "bulk-priority-" + v)); }
            BarMenu(b, "bulk-priority-menu", items);
        }, n > 0));
        row.Children.Add(BarButton("user", "Assign", "bulk-assign", b =>
        {
            var items = new List<MenuEntry>();
            if (_source.UserId is { } me) items.Add(new("Me", "user", () => BulkPatch(new TaskPatch(AssigneeId: me), "Reassigned"), Id: "bulk-assign-me"));
            items.Add(new("Unassigned", "user-minus", () => BulkPatch(new TaskPatch(ClearAssignee: true), "Reassigned"), Id: "bulk-assign-none"));
            foreach (var m in _source.Members().Where(m => m.Id != _source.UserId && m.Role != "viewer"))
            {
                var id = m.Id;
                items.Add(new(m.Name.Length > 0 ? m.Name : m.Email, null, () => BulkPatch(new TaskPatch(AssigneeId: id), "Reassigned"), Id: "bulk-assign-" + id));
            }
            BarMenu(b, "bulk-assign-menu", items);
        }, n > 0));
        row.Children.Add(BarButton("trash", "Delete", "bulk-delete", _ => BulkDelete(), n > 0, danger: true));
        row.Children.Add(BarButton("x", "Done", "bulk-done", _ => { _sel.Clear(); RebuildKeepScroll(); Focus(FocusState.Programmatic); }, true));
        var bar = new Border
        {
            Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14), Child = row,
            Shadow = null,
        };
        // the id sits on a StackPanel (a Border has no UI Automation peer)
        var tagged = new StackPanel { Children = { bar } };
        AutomationProperties.SetAutomationId(tagged, "bulk-bar");
        AutomationProperties.SetName(tagged, "Selected tasks");
        AutomationProperties.SetItemStatus(tagged, "selected=" + n);
        return tagged;
    }

    /// <summary>A menu opened above its bar button (the bar sits at the bottom edge).</summary>
    private void BarMenu(FrameworkElement anchor, string id, List<MenuEntry> items)
    {
        if (Host is null) return;
        var h = items.Sum(i => i.Height) + 14;
        var tl = anchor.TransformToVisual(null).TransformPoint(new global::Windows.Foundation.Point(0, 0));
        PopupMenu.Show(Host.Overlay, items, null, at: new global::Windows.Foundation.Point(tl.X, Math.Max(8, tl.Y - h - 6)), id: id, width: 220);
    }

    // ---- the actions ----

    private void BulkDate(int addDays, string said) => BulkPatch(new TaskPatch(DueDate: BulkRules.Day(DateOnly.FromDateTime(DateTime.Now), addDays)), said);

    /// <summary>The same change on every picked task, a toast with Undo, and the selection ends (the web's BulkBar).</summary>
    private void BulkPatch(TaskPatch patch, string said)
    {
        var ids = _sel.Ids.ToList();
        if (ids.Count == 0) return;
        var was = _source.BulkUpdateTasks(ids, patch);
        Host?.Toast(BulkRules.Said(said, ids.Count), false, was.Count == 0 ? null : () => { foreach (var (id, undo) in was) _source.UpdateTask(id, undo); });
        _sel.Clear();
        RebuildKeepScroll();
    }

    private void BulkDelete()
    {
        var ids = _sel.Ids.ToList();
        if (ids.Count == 0 || Host is null) return;
        Dialogs.Confirm(Host.Overlay, $"Delete {ids.Count} task{(ids.Count == 1 ? "" : "s")}?", "Their subtasks go too. This can't be undone.", "Delete", true, () =>
        {
            _source.BulkDeleteTasks(ids);
            Host?.Toast("Deleted " + ids.Count + " task" + (ids.Count == 1 ? "" : "s"));
            _sel.Clear();
            RebuildKeepScroll();
            return System.Threading.Tasks.Task.FromResult<string?>(null);
        });
    }
}
