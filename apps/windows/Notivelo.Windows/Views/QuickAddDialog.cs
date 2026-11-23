using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Windows.Foundation;
using Windows.System;
using N = Notivelo.Native;

namespace Notivelo.Windows.Views;

/// <summary>Quick add (Apple's QuickAdd.swift, LOOK 4.12): one line of natural language ("Review proposal tomorrow 3pm p1 @alex every week"), read by the core's
/// <c>parse_quick_add</c>, with the words it found shown as chips. Due date and priority can be set from their chips (they win over the line). Enter adds the
/// task and closes, Ctrl+Enter adds it and keeps the dialog for the next one. The task is made by <see cref="INotesSource.AddTask"/>.</summary>
internal sealed class QuickAddDialog
{
    /// <summary>Where it was opened from: the page whose Task button was used, a day to start from (the Calendar), or words to start with.</summary>
    public sealed record Seed(string? PageId = null, string? DueDate = null, string Text = "");

    private readonly ShellHost _h;
    private readonly OverlayHost _o;
    private readonly Seed _seed;
    private readonly TextBox _text = new();
    private readonly TextBox _desc = new();
    private readonly WrapPanel _chips = new() { HorizontalSpacing = 6, VerticalSpacing = 6 };
    private readonly TextBlock _error = new();
    private Button _ok = null!;
    private OverlayHost.Layer? _layer;
    private string? _dueOverride;
    private bool _dueCleared;
    private byte? _priorityOverride;
    private bool _busy;
    private N.QuickAddResult _q = Empty("");

    public static void Show(ShellHost host, Seed? seed = null)
    {
        if (host.Overlay.IsOpen) return;
        new QuickAddDialog(host, seed ?? new Seed()).Open();
    }

    private QuickAddDialog(ShellHost h, Seed seed) { _h = h; _o = h.Overlay; _seed = seed; }

    private Brush B(string k) => ThemeBrushes.Get(k, _o);

    private static N.QuickAddResult Empty(string text) => new(text.Trim(), null, null, null, null, null, Array.Empty<string>(), null, Array.Empty<N.QuickAddToken>());

    private static string TodayString => DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd");

    private static N.QuickAddResult Parse(string text)
    {
        try { return N.NvCore.ParseQuickAdd(text, TodayString); }
        catch (Exception) { return Empty(text); }   // the core library isn't loaded (a unit-test host): the line is the title
    }

    private string? Due => _dueCleared ? null : _dueOverride ?? _q.DueDate ?? _seed.DueDate;
    private byte Priority => _priorityOverride ?? _q.Priority ?? 4;
    private bool Ready => _q.Title.Trim().Length > 0 && !_busy;

    private void Open()
    {
        _text.Style = Ui.Style("PlainTextBoxStyle"); _desc.Style = Ui.Style("PlainTextBoxStyle");
        _text.PlaceholderText = "e.g. Review proposal tomorrow 3pm p1 @alex every week";
        _text.FontSize = 17; _text.FontWeight = new global::Windows.UI.Text.FontWeight(500);
        _text.BorderThickness = new Thickness(0); _text.Background = new SolidColorBrush(Colors.Transparent); _text.CornerRadius = new CornerRadius(0);
        _text.Padding = new Thickness(0, 5, 0, 5); _text.Text = _seed.Text;
        AutomationProperties.SetAutomationId(_text, "quickadd-input");
        AutomationProperties.SetName(_text, "Task");
        _desc.PlaceholderText = "Description"; _desc.FontSize = 14; _desc.AcceptsReturn = true; _desc.TextWrapping = TextWrapping.Wrap; _desc.MaxHeight = 110;
        _desc.BorderThickness = new Thickness(0); _desc.Background = new SolidColorBrush(Colors.Transparent); _desc.CornerRadius = new CornerRadius(0);
        _desc.Padding = new Thickness(0, 4, 0, 6);
        AutomationProperties.SetAutomationId(_desc, "quickadd-desc");
        AutomationProperties.SetName(_desc, "Description");

        _error.FontSize = 12.5; _error.Foreground = B("Danger"); _error.TextWrapping = TextWrapping.Wrap; _error.Visibility = Visibility.Collapsed;
        var cancel = Dialogs.Btn(_o, "Cancel", false, id: "quickadd-cancel");
        _ok = Dialogs.Btn(_o, "Add task", true, id: "quickadd-ok");
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Padding = new Thickness(0, 12, 0, 0) };
        row.Children.Add(cancel); row.Children.Add(_ok);
        var footer = new Border { BorderBrush = B("Border"), BorderThickness = new Thickness(0, 1, 0, 0), Margin = new Thickness(0, 12, 0, 0), Child = row };

        var panel = new StackPanel();
        panel.Children.Add(_text);
        panel.Children.Add(_desc);
        panel.Children.Add(_chips);
        panel.Children.Add(_error);
        panel.Children.Add(footer);
        var card = Dialogs.Card(_o, 560, panel);
        card.Padding = new Thickness(16, 12, 16, 12);
        AutomationProperties.SetAutomationId(panel, "quickadd-card");
        AutomationProperties.SetName(panel, "Quick add");
        _layer = _o.Show(card, HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, 100, 0, 0));

        cancel.Click += (_, _) => _layer?.Close();
        _ok.Click += (_, _) => Submit(false);
        _text.TextChanged += (_, _) => Refresh();
        _text.KeyDown += (_, e) => Key(e);
        _desc.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter && Ctrl()) { e.Handled = true; Submit(true); } };
        _text.Loaded += (_, _) => _text.Focus(FocusState.Programmatic);
        Refresh();
    }

    private static bool Ctrl() => InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control).HasFlag(global::Windows.UI.Core.CoreVirtualKeyStates.Down);

    private void Key(Microsoft.UI.Xaml.Input.KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        e.Handled = true;
        Submit(Ctrl());
    }

    /// <summary>Read the line again and draw the chips for what it says.</summary>
    private void Refresh()
    {
        _q = Parse(_text.Text);
        _ok.IsEnabled = Ready;
        _ok.Opacity = Ready ? 1 : 0.5;
        _chips.Children.Clear();
        var due = Due;
        Chip("quickadd-due", "calendar-days", due is null ? "Due date" : DueWords(due, _q.DueTime), due is not null, DueMenu);
        var pr = Priority;
        Chip("quickadd-priority", "flag", pr < 4 ? "P" + pr : "Priority", pr < 4, PriorityMenu, pr < 4 ? TaskParts.PriorityBrush(B, pr) : null);
        if (_q.Assignee is { } m) Chip("quickadd-assignee", "user-round", "@" + m, true, null);
        else AssigneeChip();
        Chip("quickadd-team", "users", _q.Team is { } t ? "+" + t : "Team", _q.Team is not null, null);
        Chip("quickadd-tags", "tag", _q.Tags.Length == 0 ? "Tags" : string.Join(", ", _q.Tags.Select(x => "#" + x)), _q.Tags.Length > 0, null);
        if (_q.Recurrence is { } rule)
        {
            string label;
            try { label = N.NvCore.DescribeRecurrence(rule, due); } catch (Exception) { label = "Repeats " + rule.Freq; }
            Chip("quickadd-repeat", "repeat", label, true, null);
        }
        if (_seed.PageId is { } pid) Chip("quickadd-page", "file-text", _h.Source.PageTitleOf(pid) is { Length: > 0 } title ? title : "Untitled", false, null);
    }

    private static string DueWords(string day, string? time)
    {
        var s = day;
        if (DateOnly.TryParseExact(day, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var d))
        {
            var diff = d.DayNumber - DateOnly.FromDateTime(DateTime.Now).DayNumber;
            s = diff == 0 ? "Today" : diff == 1 ? "Tomorrow" : diff == -1 ? "Yesterday" : d.ToString("ddd d MMM");
        }
        return time is { Length: > 0 } ? s + " " + time : s;
    }

    private void Chip(string id, string icon, string label, bool active, Action<Button>? menu, Brush? iconBrush = null)
    {
        var fg = active ? B("Accent") : B("Text2");
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        sp.Children.Add(new Icon(icon, 13, iconBrush ?? fg) { VerticalAlignment = VerticalAlignment.Center });
        sp.Children.Add(Ui.Text(label, 12.5, fg, 500));
        sp.MaxWidth = 220;
        var b = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(9, 0, 9, 0), CornerRadius = new CornerRadius(8), Content = sp,
            Background = active ? B("AccentSoft") : B("Bg"), BorderBrush = B("Border"), BorderThickness = new Thickness(active ? 0 : 1),
        };
        AutomationProperties.SetAutomationId(b, id);
        AutomationProperties.SetName(b, label);
        if (menu is not null) b.Click += (_, _) => menu(b);
        _chips.Children.Add(b);
    }

    private void AssigneeChip()
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        sp.Children.Add(Ui.Avatar(_h.Source.Workspace.UserInitials, 14));
        sp.Children.Add(Ui.Text("Me", 12.5, B("Text2"), 500));
        var b = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(9, 0, 9, 0), CornerRadius = new CornerRadius(8), Content = sp,
            Background = B("Bg"), BorderBrush = B("Border"), BorderThickness = new Thickness(1),
        };
        AutomationProperties.SetAutomationId(b, "quickadd-assignee");
        AutomationProperties.SetName(b, "Me");
        _chips.Children.Add(b);
    }

    private void DueMenu(Button anchor)
    {
        var today = DateOnly.FromDateTime(DateTime.Now);
        var add = ((int)DayOfWeek.Monday - (int)today.DayOfWeek + 7) % 7;
        var nextMonday = today.AddDays(add == 0 ? 7 : add);
        void Set(DateOnly d) { _dueCleared = false; _dueOverride = d.ToString("yyyy-MM-dd"); Refresh(); _text.Focus(FocusState.Programmatic); }
        PopupMenu.Show(_o, new[]
        {
            new MenuEntry("Today", "sun", () => Set(today), Id: "quickadd-due-today"),
            new MenuEntry("Tomorrow", "calendar-days", () => Set(today.AddDays(1)), Id: "quickadd-due-tomorrow"),
            new MenuEntry("Next week", "calendar-range", () => Set(nextMonday), Id: "quickadd-due-nextweek"),
            new MenuEntry("No date", "x", () => { _dueCleared = true; _dueOverride = null; Refresh(); }, Id: "quickadd-due-none"),
        }, anchor, id: "menu-quickadd-due", width: 200);
    }

    private void PriorityMenu(Button anchor)
    {
        MenuEntry P(byte n) => new(n == 4 ? "No priority" : "Priority " + n, "flag", () => { _priorityOverride = n; Refresh(); _text.Focus(FocusState.Programmatic); }, Check: Priority == n, Id: "quickadd-priority-" + n);
        PopupMenu.Show(_o, new[] { P(1), P(2), P(3), P(4) }, anchor, id: "menu-quickadd-priority", width: 200);
    }

    private async void Submit(bool keepOpen)
    {
        if (!Ready) return;
        var q = _q;
        var due = Due;
        if (due is null && q.DueTime is not null) due = TodayString;   // the web's convenience: a time with no day is today
        var task = new NewTask(q.Title.Trim(), _desc.Text.Trim(), Priority, due, _dueCleared ? null : q.DueTime, q.Recurrence, q.Assignee, q.Team, q.Tags, _seed.PageId);
        _busy = true; Refresh();
        var err = await _h.Source.AddTask(task);
        _busy = false;
        if (err is not null) { _error.Text = err; _error.Visibility = Visibility.Visible; Refresh(); return; }
        _h.Toast("Task added");
        if (keepOpen)
        {
            _error.Visibility = Visibility.Collapsed;
            _desc.Text = ""; _dueOverride = null; _dueCleared = false; _priorityOverride = null;
            _text.Text = "";
            Refresh();
            _text.Focus(FocusState.Programmatic);
        }
        else _layer?.Close();
    }
}

/// <summary>Children left to right, wrapping to the next line when the width runs out.</summary>
internal sealed class WrapPanel : Panel
{
    public double HorizontalSpacing { get; set; }
    public double VerticalSpacing { get; set; }

    protected override Size MeasureOverride(Size available)
    {
        double x = 0, y = 0, rowH = 0, maxW = 0;
        foreach (var c in Children)
        {
            c.Measure(new Size(available.Width, double.PositiveInfinity));
            var s = c.DesiredSize;
            if (x > 0 && x + s.Width > available.Width) { y += rowH + VerticalSpacing; x = 0; rowH = 0; }
            x += s.Width + HorizontalSpacing; rowH = Math.Max(rowH, s.Height); maxW = Math.Max(maxW, x - HorizontalSpacing);
        }
        return new Size(maxW, y + rowH);
    }

    protected override Size ArrangeOverride(Size final)
    {
        double x = 0, y = 0, rowH = 0;
        foreach (var c in Children)
        {
            var s = c.DesiredSize;
            if (x > 0 && x + s.Width > final.Width) { y += rowH + VerticalSpacing; x = 0; rowH = 0; }
            c.Arrange(new Rect(x, y, s.Width, s.Height));
            x += s.Width + HorizontalSpacing; rowH = Math.Max(rowH, s.Height);
        }
        return final;
    }
}
