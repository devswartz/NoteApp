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
    internal ShellHost? Host { get; set; }
    private Notebook? _nb;

    public SidebarView(INotesSource source) { _source = source; SelectedPageId = source.InitialPageId; }

    public void Refresh() => Rebuild();

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

    // ---- drag to reorder / move (the web's treeDnd.ts): drag a page or a section; the row under the pointer shows where it lands ----------------------
    // The top quarter of a row drops before it, the bottom quarter after it, the middle into it (a section row only). Pages go into sections; sections go next to
    // sections or into one (the core refuses past three levels and says so). Move up / Move down in the menus do the same without a pointer.

    private (TreeKind Kind, string Id)? _drag;
    private Border? _hot;
    private Brush? _hotBg;

    private void ClearHot()
    {
        if (_hot is null) return;
        _hot.BorderThickness = new Thickness(0);
        if (_hotBg is not null) _hot.Background = _hotBg;
        _hot = null; _hotBg = null;
    }

    private void ShowHot(Border row, ShellRules.Zone zone)
    {
        if (!ReferenceEquals(_hot, row)) { ClearHot(); _hot = row; _hotBg = row.Background; }
        row.BorderBrush = B("Accent");
        switch (zone)
        {
            case ShellRules.Zone.Before: row.BorderThickness = new Thickness(0, 2, 0, 0); row.Background = _hotBg; break;
            case ShellRules.Zone.After: row.BorderThickness = new Thickness(0, 0, 0, 2); row.Background = _hotBg; break;
            default: row.BorderThickness = new Thickness(1); row.Background = B("AccentSoft"); break;
        }
    }

    private void Draggable(Border row, TreeKind kind, string id)
    {
        if (!_source.CanEditTree || Host is null) return;
        row.CanDrag = true;
        row.DragStarting += (_, e) =>
        {
            _drag = (kind, id);
            e.Data.SetText("notivelo:" + kind.ToString().ToLowerInvariant() + ":" + id);
            e.Data.RequestedOperation = global::Windows.ApplicationModel.DataTransfer.DataPackageOperation.Move;
        };
        row.DropCompleted += (_, _) => { _drag = null; ClearHot(); };
    }

    private void DropTarget(Border row, TreeKind kind, string id)
    {
        if (!_source.CanEditTree || Host is null) return;
        row.AllowDrop = true;
        (string, string?, int?)? Plan(Microsoft.UI.Xaml.DragEventArgs e, out ShellRules.Zone zone)
        {
            zone = ShellRules.Zone.After;
            if (_drag is not { } d || Host is null) return null;
            var nest = kind == TreeKind.Section;
            zone = ShellRules.DropZone(e.GetPosition(row).Y, row.ActualHeight, nest);
            if (d.Kind == TreeKind.Page && kind == TreeKind.Section) zone = ShellRules.Zone.Into;   // a page can only go into a section
            return Host.Tree.DropPlan(d.Kind, d.Id, kind, id, zone) is { } p ? (p.NotebookId, p.ParentId, p.Index) : null;
        }
        row.DragOver += (_, e) =>
        {
            var plan = Plan(e, out var zone);
            if (plan is null) { e.AcceptedOperation = global::Windows.ApplicationModel.DataTransfer.DataPackageOperation.None; if (ReferenceEquals(_hot, row)) ClearHot(); return; }
            e.AcceptedOperation = global::Windows.ApplicationModel.DataTransfer.DataPackageOperation.Move;
            e.DragUIOverride.IsCaptionVisible = false;
            ShowHot(row, zone);
            e.Handled = true;
        };
        row.DragLeave += (_, _) => { if (ReferenceEquals(_hot, row)) ClearHot(); };
        row.Drop += (_, e) =>
        {
            var plan = Plan(e, out ShellRules.Zone _);
            var d = _drag;
            ClearHot(); _drag = null;
            e.Handled = true;
            if (plan is { } p && d is { } dd) Host!.Tree.Drop(dd.Kind, dd.Id, p.Item1, p.Item2, p.Item3);
        };
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
        var nb = _source.Notebooks.FirstOrDefault(n => n.Id == _source.CurrentNotebookId) ?? _source.Notebooks.FirstOrDefault();
        if (nb is null) return NoNotebooks();
        _nb = nb;
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
        // LOOK 4.9 notebook picker: "My notebooks" with each notebook's tile, a check on the open one and a lock on private ones, then New notebook
        picker.Click += (_, _) =>
        {
            if (Host is null) return;
            var items = new List<MenuEntry> { MenuEntry.Label("My notebooks") };
            foreach (var n in _source.Notebooks)
            {
                var id = n.Id;
                items.Add(new MenuEntry(n.Name, Click: () => { _source.SelectNotebook(id); Rebuild(); }, TileColor: n.ColorHex, Check: id == nb.Id, Lock: n.IsPrivate, Id: "notebook-" + PopupMenu.Slug(n.Name),
                    DragId: _source.CanEditTree ? id : null, DropOn: (from, after) => Host?.Tree.DropNotebook(from, id, after)));
            }
            if (_source.CanEditTree)
            {
                items.Add(MenuEntry.Sep());
                items.Add(new MenuEntry("New notebook", "book-plus", () => Host?.Tree.NewNotebook(), Id: "new-notebook"));
            }
            PopupMenu.Show(Host.Overlay, items, picker, id: "menu-notebook-picker", width: 272);
        };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(picker, "notebook-picker");
        head.Children.Add(picker);
        var more = Ui.IconButton("ellipsis", 15, 24, 24, "Notebook options");
        more.Margin = new Thickness(4, 0, 0, 0);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(more, "notebook-more");
        more.Click += (_, _) => Host?.Tree.NotebookMenu(more, nb);
        Grid.SetColumn(more, 1);
        head.Children.Add(more);
        root.Children.Add(head);

        // scroll area: SECTIONS
        var list = new StackPanel { Padding = new Thickness(8, 3, 8, 16) };
        list.Children.Add(RecentGroup());
        list.Children.Add(GroupHeading("Sections", true, () => Host?.Tree.NewSection(nb.Id, null)));
        foreach (var s in nb.Sections) AddSection(list, s, 0);
        if (nb.Sections.Count == 0) list.Children.Add(Ui.Text("No sections yet.", 12.5, B("TextMuted")).With(t => t.Margin = new Thickness(10, 6, 0, 0)));
        if (_source.SharedWithMe.Count > 0) list.Children.Add(SharedGroup());
        var sv =new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollMode = ScrollMode.Disabled, Content = list };
        Grid.SetRow(sv, 1);
        root.Children.Add(sv);
        return root;
    }

    private bool _recentOpen;

    /// <summary>RECENT (LOOK 4.3): a folded group with a clock, up to 5 recently edited pages when opened.</summary>
    private UIElement RecentGroup()
    {
        var box = new StackPanel { Margin = new Thickness(0, 0, 0, 12) };
        var g = Cols(Px(12), Star, Px(12));
        g.ColumnSpacing = 6;
        g.Children.Add(new Icon("clock", 12, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        var t = Ui.Text("RECENT", 11.5, B("TextMuted"), 600, tracking: 0.04);
        Grid.SetColumn(t, 1);
        g.Children.Add(t);
        var chev = new Icon(_recentOpen ? "chevron-down" : "chevron-right", 12, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(chev, 2);
        g.Children.Add(chev);
        var btn = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 22, Padding = new Thickness(6, 0, 6, 0), CornerRadius = new CornerRadius(4), HorizontalAlignment = HorizontalAlignment.Left, Content = g,
        };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(btn, "sidebar-recent");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(btn, "Recent");
        btn.Click += (_, _) => { _recentOpen = !_recentOpen; Rebuild(); };
        box.Children.Add(new Grid { MinHeight = 26, Children = { btn } });
        if (_recentOpen)
            foreach (var (p, _, _) in _source.RecentPages(5)) box.Children.Add(PageRow(p, -1));
        return box;
    }

    /// <summary>No notebook to show: still loading, a load error, or an empty workspace (LOOK 4.14).</summary>
    private UIElement NoNotebooks()
    {
        var root = new StackPanel { Padding = new Thickness(18, 20, 18, 16), Spacing = 6 };
        if (_source.LoadError is { } err)
        {
            root.Children.Add(Ui.Text("Couldn't load", 14, B("Text"), 650));
            root.Children.Add(Ui.Text(err, 12.5, B("Danger")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; }));
        }
        else if (_source.Loading) root.Children.Add(Ui.Text("Loading…", 12.5, B("TextMuted")));
        else
        {
            root.Children.Add(Ui.Text("Notebooks", 14, B("Text"), 650));
            root.Children.Add(Ui.Text("No notebooks yet. Create one in the web app.", 12.5, B("TextMuted")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; }));
        }
        return root;
    }

    private UIElement GroupHeading(string text, bool plus, Action? onPlus = null)
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
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(b, "new-section");
            b.Click += (_, _) => onPlus?.Invoke();
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
        var canEdit = _source.CanEditTree && Host is not null;
        var chevron = new Icon(open ? "chevron-down" : "chevron-right", 13, B("TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        g.Children.Add(chevron);
        var tab = new Border { Width = 4, Height = 14, CornerRadius = new CornerRadius(2), Background = Ui.Hex(s.ColorHex), VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(tab, 1);
        g.Children.Add(tab);
        var nameTb = Ui.Text(s.Name, 14, selectedHere ? B("Accent") : B("Text2"), selectedHere ? 600 : 400);
        Grid.SetColumn(nameTb, 2);
        g.Children.Add(nameTb);
        var row = Row(30, 6, selectedHere, () => { if (open) _collapsed.Add(s.Id); else _collapsed.Remove(s.Id); Rebuild(); }, g, new Thickness(6 + 14 * depth, 0, 4, 0));
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(row, "section-row-" + s.Id);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(row, s.Name);
        if (canEdit)
        {
            Draggable(row, TreeKind.Section, s.Id);
            DropTarget(row, TreeKind.Section, s.Id);
            // hover actions: "+" New page, "..." Section options (always there for the UI tests, drawn on hover)
            var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 0, Opacity = 0 };
            var add = Ui.IconButton("plus", 15, 24, 24, "New page");
            var more = Ui.IconButton("ellipsis", 15, 24, 24, "Section options");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(add, "section-add-" + s.Id);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(more, "section-more-" + s.Id);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(more, "Section options: " + s.Name);
            add.Tapped += (_, e) => e.Handled = true; more.Tapped += (_, e) => e.Handled = true;
            add.Click += (_, _) => Host!.Tree.NewPage(s.Id);
            more.Click += (_, _) => Host!.Tree.SectionMenu(more, _nb, s);
            actions.Children.Add(add); actions.Children.Add(more);
            Grid.SetColumn(actions, 3);
            g.Children.Add(actions);
            row.PointerEntered += (_, _) => actions.Opacity = 1;
            row.PointerExited += (_, _) => actions.Opacity = 0;
            row.RightTapped += (_, e) => { e.Handled = true; Host!.Tree.SectionMenu(null, _nb, s, e.GetPosition(null)); };
        }
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
            var emptyRow = Row(28, 6, false, canEdit ? () => Host!.Tree.NewPage(s.Id) : null, g2, new Thickness(6 + 14 * (depth + 1) + 20, 0, 6, 0));
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(emptyRow, "new-page-" + s.Id);
            kids.Children.Add(emptyRow);
        }
        parent.Children.Add(kids);
    }

    /// <summary>A page's icon in the tree: its emoji, or the plain page glyph.</summary>
    private UIElement PageGlyph(string? emoji, bool selected)
    {
        if (string.IsNullOrEmpty(emoji)) return new Icon("file-text", 14, selected ? B("Text2") : B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center };
        return new TextBlock { Text = emoji, FontSize = 13, FontFamily = new FontFamily("Segoe UI Emoji"), VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
    }

    private bool _sharedClosed;

    /// <summary>SHARED WITH ME (the web's SharedWithMe, Apple's SharedWithMeGroup): pages other people shared one by one, from any workspace, each with an x
    /// that removes it from the list.</summary>
    private UIElement SharedGroup()
    {
        var box = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
        var g = Cols(Px(12), Star, Px(12));
        g.ColumnSpacing = 6;
        g.Children.Add(new Icon("users", 12, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        var t = Ui.Text("SHARED WITH ME", 11.5, B("TextMuted"), 600, tracking: 0.04);
        Grid.SetColumn(t, 1);
        g.Children.Add(t);
        var chev = new Icon(_sharedClosed ? "chevron-right" : "chevron-down", 12, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(chev, 2);
        g.Children.Add(chev);
        var btn = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 22, Padding = new Thickness(6, 0, 6, 0), CornerRadius = new CornerRadius(4), HorizontalAlignment = HorizontalAlignment.Left, Content = g };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(btn, "sidebar-shared");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(btn, "Shared with me");
        btn.Click += (_, _) => { _sharedClosed = !_sharedClosed; Rebuild(); };
        box.Children.Add(new Grid { MinHeight = 26, Children = { btn } });
        if (_sharedClosed) return box;
        foreach (var e in _source.SharedWithMe)
        {
            var entry = e;
            var selected = entry.Id == SelectedPageId;
            var row = Cols(Px(14), Star, Auto, Auto);
            row.ColumnSpacing = 6;
            row.Children.Add(PageGlyph(entry.Icon, selected));
            var title = Ui.Text(entry.Title.Length == 0 ? "Untitled" : entry.Title, 14, selected ? B("Accent") : B("Text2"), selected ? 500 : 400);
            Grid.SetColumn(title, 1);
            row.Children.Add(title);
            var ws = Ui.Text(entry.WorkspaceName, 11.5, B("TextMuted"));
            Grid.SetColumn(ws, 2);
            row.Children.Add(ws);
            var x = Ui.IconButton("x", 13, 22, 22, "Remove from Shared with me");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(x, "shared-remove-" + entry.Id);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(x, "Remove from Shared with me: " + entry.Title);
            x.Tapped += (_, ev) => ev.Handled = true;
            x.Click += async (_, _) =>
            {
                var err = await _source.LeaveShare(entry.Id);
                if (err is not null) Host?.Toast(err, true);
            };
            Grid.SetColumn(x, 3);
            row.Children.Add(x);
            var r = Row(28, 6, selected, () => PageSelected?.Invoke(entry.Id), row, new Thickness(6 + 14 + 20, 0, 4, 0));
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(r, "shared-row-" + entry.Id);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(r, entry.Title);
            box.Children.Add(r);
        }
        return box;
    }

    private UIElement PageRow(PageSummary p, int depth)
    {
        var selected = p.Id == SelectedPageId;
        var g = Cols(Px(14), Star, Auto, Auto);
        g.ColumnSpacing = 6;
        g.Children.Add(PageGlyph(p.Emoji, selected));
        var t = Ui.Text(p.Title, 14, selected ? B("Accent") : B("Text2"), selected ? 500 : 400);
        Grid.SetColumn(t, 1);
        g.Children.Add(t);
        if (p.Locked)
        {
            var lk = new Icon("lock", 12, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(lk, 2);
            g.Children.Add(lk);
        }
        else if (p.OpenTasks > 0)
        {
            var c = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 3, Opacity = 0.8, VerticalAlignment = VerticalAlignment.Center };
            c.Children.Add(new Icon("circle-check", 11, B("TextMuted")));
            c.Children.Add(Ui.Text(p.OpenTasks.ToString(), 11, B("TextMuted")));
            Grid.SetColumn(c, 2);
            g.Children.Add(c);
        }
        var row = Row(28, 6, selected, () => PageSelected?.Invoke(p.Id), g, new Thickness(6 + 14 * (depth + 1) + 20 - 6 * 0, 0, 4, 0));
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(row, "page-row-" + p.Id);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(row, p.Title);
        if (_source.CanEditTree && Host is not null)
        {
            Draggable(row, TreeKind.Page, p.Id);
            DropTarget(row, TreeKind.Page, p.Id);
            var more = Ui.IconButton("ellipsis", 15, 24, 24, "Page options");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(more, "page-more-" + p.Id);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(more, "Page options: " + p.Title);
            more.Opacity = selected ? 1 : 0;
            more.Tapped += (_, e) => e.Handled = true;
            more.Click += (_, _) => Host!.Tree.PageMenu(more, p);
            Grid.SetColumn(more, 3);
            g.Children.Add(more);
            row.PointerEntered += (_, _) => more.Opacity = 1;
            row.PointerExited += (_, _) => more.Opacity = selected ? 1 : 0;
            row.RightTapped += (_, e) => { e.Handled = true; Host!.Tree.PageMenu(null, p, e.GetPosition(null)); };
        }
        return row;
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
        var addRow = Row(32, 7, false, () => Host?.OpenQuickAdd(null), add, new Thickness(10, 0, 10, 0));
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(addRow, "sidebar-add-task");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(addRow, "Add task");
        root.Children.Add(addRow);
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

    private DateOnly _mini = new(DateTime.Now.Year, DateTime.Now.Month, 1);

    /// <summary>Calendar panel (LOOK 4.3): "Calendar" title and a mini month: Monday-first, today accent-solid, a dot under days that have open tasks.</summary>
    private UIElement BuildCalendar()
    {
        var root = new StackPanel { Padding = new Thickness(8, 0, 8, 16) };
        var title = Ui.Text("Calendar", 15, B("Text"), 650);
        title.Margin = new Thickness(8, 18, 0, 12);
        title.Height = 24;
        root.Children.Add(title);

        var today = DateOnly.FromDateTime(DateTime.Now);
        var due = new HashSet<string>(_source.CalendarTasks().Where(t => t.Due is not null).Select(t => t.Due!));
        var head = Cols(Star, Auto, Auto);
        head.Margin = new Thickness(10, 0, 6, 6);
        head.Children.Add(Ui.Text(_mini.ToString("MMMM yyyy", System.Globalization.CultureInfo.CurrentCulture), 12.5, B("Text"), 600));
        var prev = Ui.IconButton("chevron-left", 14, 24, 24, "Previous month", 6);
        var next = Ui.IconButton("chevron-right", 14, 24, 24, "Next month", 6);
        prev.Click += (_, _) => { _mini = _mini.AddMonths(-1); Rebuild(); };
        next.Click += (_, _) => { _mini = _mini.AddMonths(1); Rebuild(); };
        Grid.SetColumn(prev, 1); Grid.SetColumn(next, 2);
        head.Children.Add(prev); head.Children.Add(next);
        root.Children.Add(head);

        var grid = new Grid { Margin = new Thickness(5, 0, 4, 0) };
        for (var c = 0; c < 7; c++) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var lead = ((int)_mini.DayOfWeek + 6) % 7;
        var start = _mini.AddDays(-lead);
        var weeks = (_mini.AddMonths(1).AddDays(-1).DayNumber - start.DayNumber) / 7 + 1;
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(24) });
        for (var r = 0; r < weeks; r++) grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(27) });
        for (var c = 0; c < 7; c++)
            grid.Children.Add(Ui.Text("MTWTFSS"[c].ToString(), 11, B("TextMuted"), 600).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; Grid.SetColumn(t, c); }));
        for (var i = 0; i < weeks * 7; i++)
        {
            var d = start.AddDays(i);
            var isToday = d == today;
            var cell = new Grid { Width = 24, Height = 24, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            if (isToday) cell.Children.Add(new Border { CornerRadius = new CornerRadius(12), Background = B("AccentSolid") });
            var fg = isToday ? new SolidColorBrush(Colors.White) : d.Month == _mini.Month ? B("Text2") : B("TextMuted");
            cell.Children.Add(Ui.Text(d.Day.ToString(), 11.5, fg, isToday ? 700 : 400).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; t.VerticalAlignment = VerticalAlignment.Center; }));
            if (due.Contains(d.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture)) && !isToday)
                cell.Children.Add(new Border { Width = 3, Height = 3, CornerRadius = new CornerRadius(1.5), Background = B("TextMuted"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, -1) });
            Grid.SetRow(cell, 1 + i / 7); Grid.SetColumn(cell, i % 7);
            grid.Children.Add(cell);
        }
        root.Children.Add(grid);
        return root;
    }
}
