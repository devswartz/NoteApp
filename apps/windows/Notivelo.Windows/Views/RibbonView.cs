using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

public enum RibbonMode { Smallest, Compact, Full }

/// <summary>Ribbon (LOOK 4.1): one per route, no tabs, buttons are placeholders. Smallest (&lt;= 1023), compact (&lt;= 1279) and full (&gt;= 1280, with group names and words).</summary>
internal sealed class RibbonView : ThemedControl
{
    public RibbonView() { BoxTextView.FocusedStateChanged += RefreshStates; PageView.UndoStateChanged += RefreshStates; Loaded += (_, _) => InkTool.Shared.Changed += OnInkChanged; Unloaded += (_, _) => InkTool.Shared.Changed -= OnInkChanged; }

    private bool _drawShown;
    /// <summary>The Draw button shows pressed while the pen row is open.</summary>
    private void OnInkChanged() { if (_drawShown != InkTool.Shared.BarOpen) { _drawShown = InkTool.Shared.BarOpen; Rebuild(); } }

    /// <summary>What an editing button does: the engine command and arguments, how its pressed state is read from the active marks, and whether it needs a focused box.</summary>
    private sealed record Spec(string Command, string Args = "{}", Func<Notivelo.Native.ViewActive, bool>? Active = null);

    private static bool Mark(Notivelo.Native.ViewActive a, Notivelo.Native.ViewMarkKind k) => a.Marks.Any(m => m.Kind == k);

    private static readonly Dictionary<string, Spec> Specs = new()
    {
        ["Bold"] = new("toggleMark", "{\"mark\":\"bold\"}", a => Mark(a, Notivelo.Native.ViewMarkKind.Bold)),
        ["Italic"] = new("toggleMark", "{\"mark\":\"italic\"}", a => Mark(a, Notivelo.Native.ViewMarkKind.Italic)),
        ["Underline"] = new("toggleMark", "{\"mark\":\"underline\"}", a => Mark(a, Notivelo.Native.ViewMarkKind.Underline)),
        ["Strikethrough"] = new("toggleMark", "{\"mark\":\"strike\"}", a => Mark(a, Notivelo.Native.ViewMarkKind.Strike)),
        ["Bulleted list"] = new("toggleBulletList", "{}", a => a.List == "bulletList"),
        ["Numbered list"] = new("toggleOrderedList", "{}", a => a.List == "orderedList"),
        ["Decrease indent"] = new("outdent"),
        ["Increase indent"] = new("indent"),
        ["Task"] = new("convertToTask"),
        ["Table"] = new("insertTable", "{\"rows\":3,\"cols\":3,\"header\":true}"),
        ["Add row"] = new("addRowAfter"),
        ["Add column"] = new("addColumnAfter"),
    };

    private readonly List<(ButtonBase Button, string Tip, Spec? Spec)> _bound = new();
    private Button? _blockButton;
    private TextBlock? _blockLabel;

    /// <summary>Enabled and pressed states from the focused box's active marks and undo state (no box focused: the editing buttons are off).</summary>
    private void RefreshStates()
    {
        if (Route != AppRoute.Notes) return;
        var box = BoxTextView.Focused;
        var act = box?.Active;
        foreach (var (b, tip, spec) in _bound)
        {
            // a live page undoes through the core's page undo (boxes, ink, text); an offline page through the focused box
            if (tip == "Undo") { b.IsEnabled = PageView.Current?.CanUndo(true) ?? box?.CanUndo ?? false; continue; }
            if (tip == "Redo") { b.IsEnabled = PageView.Current?.CanUndo(false) ?? box?.CanRedo ?? false; continue; }
            b.IsEnabled = box is not null;
            if (b is ToggleButton t && spec?.Active is { } f) t.IsChecked = act is not null && f(act);
        }
        if (_blockButton is not null) _blockButton.IsEnabled = box is not null;
        if (_blockLabel is not null)
            _blockLabel.Text = act is null ? "Normal" : act.Block switch
            {
                "heading" => "Heading " + act.HeadingLevel, "codeBlock" => "Code", "blockquote" => "Quote", _ => act.InQuote ? "Quote" : "Normal",
            };
    }

    /// <summary>The text colours (the engine's setColor with a colour name; "Default" takes the colour off).</summary>
    private MenuFlyout TextColourMenu(bool highlight = false)
    {
        var f = new MenuFlyout();
        var dark = ActualTheme == ElementTheme.Dark;
        var kind = highlight ? "highlight" : "text";
        void Add(string label, string? name)
        {
            var it = new MenuFlyoutItem { Text = label };
            if (highlight)
            {
                // a swatch square in the highlight colour; Default has none
                if (name is not null)
                    it.Icon = new FontIcon { Glyph = "■", FontSize = 14, Foreground = Ui.Hex(Notivelo.Windows.Text.TextColors.Highlight(name, dark)) };
            }
            else if (Notivelo.Windows.Text.TextColors.Text(name, dark) is { } hex)
                it.Icon = new FontIcon { Glyph = "A", FontWeight = new FontWeight(700), FontSize = 14, Foreground = Ui.Hex(hex) };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(it, "colour-" + kind + "-" + (name ?? "default"));
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(it, label);
            it.Click += (_, _) =>
            {
                var box = BoxTextView.Target;
                var (cmd, args) = Notivelo.Windows.Text.TextColors.Command(highlight, name);
                box?.RunCommand(cmd, args);
                box?.Focus(FocusState.Programmatic);
            };
            f.Items.Add(it);
        }
        Add("Default", null);
        foreach (var n in Notivelo.Windows.Text.TextColors.Names) Add(char.ToUpperInvariant(n[0]) + n[1..], n);
        return f;
    }

    /// <summary>The table commands of the engine (nv-editor command.rs) that act on the table around the caret.</summary>
    private MenuFlyout TableToolsMenu()
    {
        var f = new MenuFlyout();
        foreach (var (text, cmd, args) in Notivelo.Windows.Text.TableTools.Menu)
        {
            if (cmd.Length == 0) { f.Items.Add(new MenuFlyoutSeparator()); continue; }
            var it = new MenuFlyoutItem { Text = text };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(it, "table-" + PopupMenu.Slug(text));
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(it, text);
            it.Click += (_, _) =>
            {
                var box = BoxTextView.Target;
                if (cmd == "pickSlash") box?.RibbonInsert(System.Text.Json.JsonDocument.Parse(args).RootElement.GetProperty("title").GetString() ?? "");
                else if (cmd == "mergeRight") box?.MergeCells();
                else if (cmd == "mergeDown") box?.MergeCells(down: true);
                else box?.RunCommand(cmd, args);
                box?.Focus(FocusState.Programmatic);
            };
            f.Items.Add(it);
        }
        // Split is offered only on a merged cell, as the engine says (TableState)
        f.Opening += (_, _) =>
        {
            var st = BoxTextView.Target?.TableStateNow();
            foreach (var i in f.Items.OfType<MenuFlyoutItem>()) if (i.Text == "Split cell") i.IsEnabled = st?.CanSplit ?? false;
        };
        return f;
    }

    private MenuFlyout PageMenu(string tip)
    {
        var f = new MenuFlyout();
        var colour = tip == "Page colour";
        foreach (var v in colour ? new[] { "none", "yellow", "green", "blue", "purple", "pink", "grey" } : new[] { "none", "lines", "grid" })
        {
            var value = v;
            var it = new MenuFlyoutItem { Text = char.ToUpperInvariant(v[0]) + v[1..] };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(it, (colour ? "page-colour-" : "rule-lines-") + v);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(it, it.Text);
            it.Click += (_, _) => PageSettingChosen?.Invoke(colour ? "colour" : "rules", value);
            f.Items.Add(it);
        }
        return f;
    }

    private void BlockTypeMenu(Button b)
    {
        var f = new MenuFlyout();
        void Add(string text, string cmd, string args = "{}")
        {
            var it = new MenuFlyoutItem { Text = text };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(it, "block-" + PopupMenu.Slug(text));
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(it, text);
            it.Click += (_, _) => { var box = BoxTextView.Target; if (cmd == "pickSlash") box?.RibbonInsert(System.Text.Json.JsonDocument.Parse(args).RootElement.GetProperty("title").GetString() ?? ""); else box?.RunCommand(cmd, args); box?.Focus(FocusState.Programmatic); };
            f.Items.Add(it);
        }
        Add("Normal", "setParagraph");
        Add("Heading 1", "setHeading", "{\"level\":1}");
        Add("Heading 2", "setHeading", "{\"level\":2}");
        Add("Heading 3", "setHeading", "{\"level\":3}");
        Add("Quote", "toggleQuote");
        Add("Code block", "toggleCodeBlock");
        Add("Callout", "pickSlash", "{\"title\":\"Callout\"}");
        Add("Toggle", "pickSlash", "{\"title\":\"Toggle\"}");
        b.Flyout = f;
    }

    /// <summary>A button outside the page editor was pressed (its tooltip text): New task, the Calendar's Today / Previous / Next, Back.</summary>
    public event Action<string>? Invoked;

    public AppRoute Route { get; private set; } = AppRoute.Notes;
    public RibbonMode Mode { get; private set; } = RibbonMode.Compact;
    public TaskViewKind TaskView { get; private set; } = TaskViewKind.Today;
    public bool Collapsed { get; private set; }

    /// <summary>Draw the buttons again (the Calendar's Week / Month and Mine / Everyone changed).</summary>
    public void Refresh() => Rebuild();

    public void Update(AppRoute route, RibbonMode mode, TaskViewKind view)
    {
        if (route == Route && mode == Mode && view == TaskView) return;
        Route = route; Mode = mode; TaskView = view; Rebuild();
    }

    private sealed record Item(string Icon, string Tip, bool Disabled = false, string? Word = null, bool Menu = false, bool Pressed = false, string? Bar = null, bool BlockType = false);
    private sealed record Group(string Name, IReadOnlyList<Item> Items);

    private IReadOnlyList<Group> Left() => Route switch
    {
        AppRoute.Tasks => TasksGroups(),
        AppRoute.Calendar => new Group[]
        {
            new("New", new Item[] { new("plus", "New task", Word: "New task") }),
            new("Navigate", new Item[] { new("calendar-days", "Today"), new("chevron-left", "Previous"), new("chevron-right", "Next") }),
            new("View", new Item[] { new("calendar-range", "Week", Pressed: CalendarMonthView.Week), new("calendar-days", "Month", Pressed: !CalendarMonthView.Week) }),
            new("Filter", new Item[] { new("user", "Mine", Pressed: !CalendarMonthView.Everyone), new("users", "Everyone", Pressed: CalendarMonthView.Everyone), new("tag", "Tags", Menu: true), new("users-round", "Team", Menu: true) }),
        },
        AppRoute.Settings => new Group[] { new("Settings", new Item[] { new("arrow-left", "Back", Word: "Back") }) },
        _ => new Group[]
        {
            new("Text", new Item[]
            {
                new("pilcrow", "Normal", true, Menu: true, BlockType: true), new("letter-b", "Bold", true), new("italic", "Italic", true), new("underline", "Underline", true),
                new("strikethrough", "Strikethrough", true), new("baseline", "Text colour", true, Bar: "text"), new("highlighter", "Highlight", true, Bar: "hl"),
                new("remove-formatting", "Clear formatting", true),
            }),
            new("Lists", new Item[]
            {
                new("list", "Bulleted list", true), new("list-ordered", "Numbered list", true), new("list-indent-decrease", "Decrease indent", true),
                new("list-indent-increase", "Increase indent", true), new("circle-check", "Task", true, Word: "Task", Menu: true),
            }),
            new("Insert", new Item[]
            {
                new("table", "Table", true, Word: "Table"), new("image-plus", "Picture", true, Word: "Picture"), new("paperclip", "File", true, Word: "File"), new("link-2", "Link", true),
                new("file-symlink", "Link to page", true), new("minus", "Divider", true),
            }),
            new("Table", new Item[] { new("between-horizontal-end", "Add row", true), new("between-vertical-end", "Add column", true), new("table", "Table tools", true, Menu: true) }),
            new("Page", new Item[] { new("paint-bucket", "Page colour", Menu: false), new("rows-3", "Rule lines"), new("layout-template", "Templates"), new("printer", "Print") }),
            new("View", new Item[] { new("list-tree", "Outline", Word: "Outline") }),
        },
    };

    /// <summary>The Tasks view's filters and groups as pressed buttons (the choices live in the Tasks view, per view on the device).</summary>
    public Func<TaskViewState?>? TaskState { get; set; }

    /// <summary>A Tasks ribbon button with a menu was pressed (its tooltip text and the button to open the menu under).</summary>
    public event Action<string, FrameworkElement>? MenuRequested;

    /// <summary>Page colour or Rule lines was picked (the setting and its value: none/yellow/..., none/lines/grid).</summary>
    public event Action<string, string>? PageSettingChosen;

    /// <summary>The Outline button was pressed (the button, to open the heading list under).</summary>
    public event Action<FrameworkElement>? OutlineRequested;

    private Group[] TasksGroups()
    {
        var st = TaskState?.Invoke();
        bool On(string k) => st is not null && st.IsOn(k);
        return new Group[]
        {
            new("New", new Item[] { new("plus", "New task", Word: "New task") }),
            new("Show", new Item[]
            {
                new("sun", "Today", Pressed: TaskView == TaskViewKind.Today), new("calendar-range", "Upcoming", Pressed: TaskView == TaskViewKind.Upcoming),
                new("inbox", "My Tasks", Pressed: TaskView == TaskViewKind.MyTasks), new("list-checks", "All tasks", Pressed: TaskView == TaskViewKind.All),
            }),
            new("Organise", new Item[]
            {
                new("layers", "Group", Menu: true, Pressed: st is not null && st.Group != TaskGrouping.Due),
                new("arrow-up-down", "Sort", Menu: true, Pressed: st is not null && st.Sort != TaskSort.Due),
            }),
            new("Filter", new Item[]
            {
                new("eye", "Status", TaskView != TaskViewKind.All, Menu: true, Pressed: On("status")), new("user", "Assignee", Menu: true, Pressed: On("assignee")),
                new("tag", "Tags", Menu: true, Pressed: On("tags")), new("users-round", "Team", Menu: true, Pressed: On("team")),
                new("flag", "Priority", Menu: true, Pressed: On("priority")), new("sliders-horizontal", "More filters", Menu: true, Pressed: On("due") || On("source")),
                new("funnel-x", "Clear filters", st is null || !st.AnyFilter),
            }),
            new("Views", new Item[] { new("bookmark", "Saved views", Menu: true), new("bookmark-plus", "Save view", !(TaskView == TaskViewKind.All && st is { IsDefault: false }), Word: "Save view") }),
            new("Print", new Item[] { new("printer", "Print") }),
        };
    }

    private IReadOnlyList<Item> Right() => Route == AppRoute.Notes
        ? new Item[] { new("pen", "Draw", Pressed: InkTool.Shared.BarOpen), new("undo-2", "Undo", true), new("redo-2", "Redo", true) }
        : Array.Empty<Item>();

    protected override UIElement Build()
    {
        _bound.Clear(); _blockButton = null; _blockLabel = null; _drawShown = InkTool.Shared.BarOpen;
        var host = BuildCore();
        RefreshStates();
        return host;
    }

    private UIElement BuildCore()
    {
        var full = Mode == RibbonMode.Full;
        var small = Mode == RibbonMode.Smallest;
        var host = new Grid { Padding = Collapsed ? new Thickness(16, 0, 10, 0) : full ? new Thickness(12, 6, 10, 3) : small ? new Thickness(6, 5, 4, 5) : new Thickness(12, 5, 10, 5) };
        if (Collapsed) return BuildCollapsed(host);

        var left = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Stretch };
        var groups = Left();
        for (var i = 0; i < groups.Count; i++)
        {
            if (i > 0) left.Children.Add(Separator(full));
            left.Children.Add(BuildGroup(groups[i], full));
        }
        host.Children.Add(left);

        var right = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top };
        var rItems = Right();
        if (rItems.Count > 0) right.Children.Add(BuildGroup(new Group("History", rItems), full));
        var chev = Ui.IconButton("chevron-up", 16, 28, 28, "Hide ribbon");
        chev.Margin = new Thickness(small ? 2 : 8, full ? 4 : 4, 0, 0);
        chev.Click += (_, _) => { Collapsed = true; Rebuild(); };
        right.Children.Add(chev);
        host.Children.Add(right);
        return host;
    }

    private UIElement BuildCollapsed(Grid host)
    {
        host.Height = 30;
        var names = string.Join(" · ", Left().Select(g => g.Name));
        host.Children.Add(Ui.Text(names, 11.5, B("TextMuted")).With(t => t.HorizontalAlignment = HorizontalAlignment.Left));
        var show = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 26, Padding = new Thickness(8, 0, 6, 0), HorizontalAlignment = HorizontalAlignment.Right, FontSize = 12.5 };
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        sp.Children.Add(new TextBlock { Text = "Show ribbon", FontSize = 12.5, FontWeight = new FontWeight(500), VerticalAlignment = VerticalAlignment.Center });
        sp.Children.Add(new Icon("chevron-down", 14));
        show.Content = sp;
        show.Click += (_, _) => { Collapsed = false; Rebuild(); };
        host.Children.Add(show);
        return host;
    }

    private UIElement Separator(bool full)
    {
        var s = new Border
        {
            Width = 1, Background = B("Border"), Margin = new Thickness(full ? 6 : 5, 0, full ? 6 : 5, 0),
            Height = full ? 50 : 22, VerticalAlignment = full ? VerticalAlignment.Top : VerticalAlignment.Center,
        };
        if (full) s.Margin = new Thickness(6, 2, 6, 0);
        return s;
    }

    private UIElement BuildGroup(Group g, bool full)
    {
        var col = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Top };
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = Mode == RibbonMode.Smallest ? 0 : 2 };
        foreach (var it in g.Items) row.Children.Add(MakeButton(it));
        col.Children.Add(row);
        if (full)
        {
            var name = Ui.Text(g.Name, 10.5, B("TextMuted"), lineHeight: 14);
            name.HorizontalAlignment = HorizontalAlignment.Center;
            col.Children.Add(name);
        }
        return col;
    }

    private UIElement MakeButton(Item it)
    {
        var small = Mode == RibbonMode.Smallest;
        var full = Mode == RibbonMode.Full;
        var iconSize = small ? 16 : 18;
        var h = small ? 30 : 36;
        var minW = small ? 25 : 36;
        var pad = small ? new Thickness(3, 0, 3, 0) : new Thickness(8, 0, 8, 0);

        if (it.BlockType)
        {
            var sp0 = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center };
            _blockLabel = new TextBlock { Text = "Normal", FontSize = 13, FontWeight = new FontWeight(500), VerticalAlignment = VerticalAlignment.Center, FontFamily = Ui.Font };
            sp0.Children.Add(_blockLabel);
            sp0.Children.Add(new Icon("chevron-down", 14));
            var bt = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), Height = h, MinWidth = small ? 84 : 124, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6),
                Background = B("Bg"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), Foreground = B("Text"), Content = sp0,
                IsEnabled = !it.Disabled, Margin = new Thickness(0, 0, small ? 2 : 4, 0),
            };
            ToolTipService.SetToolTip(bt, it.Tip);
            if (Route == AppRoute.Notes) { bt.AllowFocusOnInteraction = false; bt.IsTabStop = false; _blockButton = bt; BlockTypeMenu(bt); Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(bt, "ribbon-block-type"); Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(bt, "Text style"); }
            return bt;
        }

        var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = full ? 6 : 0, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        UIElement icon = new Icon(it.Icon, iconSize);
        if (it.Bar is not null)
        {
            var g = new Grid { Width = 16, Height = 22 };
            g.Children.Add(new Icon(it.Icon, 16) { VerticalAlignment = VerticalAlignment.Top, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 1, 0, 0) });
            g.Children.Add(new Border
            {
                Height = 3, VerticalAlignment = VerticalAlignment.Bottom, CornerRadius = new CornerRadius(1),
                Background = it.Bar == "hl" ? Ui.Hex("#facc15") : B("Text"),
            });
            icon = g;
        }
        content.Children.Add(icon);
        if (full && it.Word is not null)
            content.Children.Add(new TextBlock { Text = it.Word, FontSize = 13, FontWeight = new FontWeight(500), VerticalAlignment = VerticalAlignment.Center, FontFamily = Ui.Font });
        if (it.Menu)
            content.Children.Add(new Icon("chevron-down", it.Word is not null && !full ? 14 : 12) { Opacity = 0.7, Margin = new Thickness(it.Word is not null ? 0 : -2, 0, 0, 0) });

        ButtonBase b;
        Specs.TryGetValue(it.Tip, out var spec);
        var custom = it.Tip is "Clear formatting" or "Link to page" or "Divider" or "Text colour" or "Highlight" or "Table tools";
        var editing = Route == AppRoute.Notes && (spec is not null || custom || it.Tip is "Undo" or "Redo" or "Picture" or "File");
        if (it.Pressed || spec?.Active is not null)
            b = new ToggleButton { Style = Ui.Style("RibbonToggleStyle"), IsChecked = it.Pressed };
        else
            b = new Button { Style = Ui.Style("GhostButtonStyle") };
        b.Height = h; b.MinWidth = minW; b.Padding = pad; b.CornerRadius = new CornerRadius(6);
        b.Content = content;
        b.IsEnabled = !it.Disabled;
        ToolTipService.SetToolTip(b, it.Tip);
        if (editing)
        {
            // the box keeps the keyboard (and the IME): these buttons never take the focus
            b.AllowFocusOnInteraction = false; b.IsTabStop = false;
            _bound.Add((b, it.Tip, spec));
            if (it.Tip == "Undo") b.Click += (_, _) => { if (PageView.Current?.Undo(true) is null) BoxTextView.Focused?.DoUndo(); };
            else if (it.Tip == "Redo") b.Click += (_, _) => { if (PageView.Current?.Undo(false) is null) BoxTextView.Focused?.DoRedo(); };
            else if (it.Tip is "Picture" or "File")
            {
                // the dialog opens at the focused box's caret; the box is held now because the dialog takes the window's focus
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(b, "ribbon-" + PopupMenu.Slug(it.Tip));
                var picture = it.Tip == "Picture";
                b.Click += (_, _) => { if (BoxTextView.Focused is { } box) _ = box.PickMediaAsync(picture); };
            }
            else if (spec is not null)
            {
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(b, "ribbon-" + PopupMenu.Slug(it.Tip));
                b.Click += (_, _) => { BoxTextView.Focused?.RunCommand(spec.Command, spec.Args); BoxTextView.Focused?.Focus(FocusState.Programmatic); };
            }
            else if (custom)
            {
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(b, "ribbon-" + PopupMenu.Slug(it.Tip));
                var tip = it.Tip;
                if (tip == "Text colour") ((Button)b).Flyout = TextColourMenu();
                else if (tip == "Highlight") ((Button)b).Flyout = TextColourMenu(highlight: true);
                else if (tip == "Table tools") ((Button)b).Flyout = TableToolsMenu();
                else b.Click += (_, _) =>
                {
                    var box = BoxTextView.Focused;
                    if (tip == "Clear formatting") box?.ClearFormatting(); else box?.RibbonInsert(tip == "Divider" ? "divider" : "page-link");
                    box?.Focus(FocusState.Programmatic);
                };
            }
        }
        else if (!it.Disabled)
        {
            var tip = it.Tip;
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(b, "ribbon-" + PopupMenu.Slug(tip));
            if (tip == "Draw") { b.AllowFocusOnInteraction = false; b.IsTabStop = false; b.Click += (_, _) => InkTool.Shared.ToggleBar(); }
            else if (tip == "Outline" && Route == AppRoute.Notes) { b.AllowFocusOnInteraction = false; b.IsTabStop = false; b.Click += (_, _) => OutlineRequested?.Invoke(b); }
            else if (Route == AppRoute.Notes && tip is "Page colour" or "Rule lines") ((Button)b).Flyout = PageMenu(tip);
            else if (it.Menu && Route == AppRoute.Tasks) b.Click += (_, _) => MenuRequested?.Invoke(tip, b);
            else b.Click += (_, _) => Invoked?.Invoke(tip);
        }
        return b;
    }
}
