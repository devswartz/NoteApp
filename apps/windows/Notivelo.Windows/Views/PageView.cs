using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The page (LOOK 4.4 top bar, 4.5 surface): sticky 48 pt bar, scrolling article with title, sub-line and the canvas.
/// Boxes are static TextBlocks for now; the editor session's text view replaces them later.</summary>
internal sealed class PageView : ThemedControl
{
    private readonly INotesSource _source;
    public string? PageId { get; private set; }

    public PageView(INotesSource source) => _source = source;

    private ScrollViewer? _scroll;
    private double _offset;

    // One session-backed text view per box of the live page being shown; kept across rebuilds (live updates) so sessions aren't reopened.
    private readonly Dictionary<string, BoxTextView> _views = new();
    private object? _viewsFor;
    private CanvasBox? _firstBox;
    /// <summary>Set NOTIVELO_TEXTVIEW=0 to fall back to the static TextBlock path.</summary>
    private static readonly bool UseTextView = Environment.GetEnvironmentVariable("NOTIVELO_TEXTVIEW") != "0";
    /// <summary>Dev hook: NOTIVELO_SELECT=anchor,head selects that view range in the first box and draws the caret/selection.</summary>
    private static readonly (int A, int H)? SelectHook = ParseSelect(Environment.GetEnvironmentVariable("NOTIVELO_SELECT"));

    /// <summary>Dev hook: NOTIVELO_SEED=<script file> fills the first box of the first live page shown (loopback servers only).</summary>
    private static readonly string? SeedScript = Environment.GetEnvironmentVariable("NOTIVELO_SEED") is { } sf && File.Exists(sf)
        && (Environment.GetEnvironmentVariable("NOTIVELO_SERVER") ?? "").Contains("127.0.0.1") ? sf : null;
    private bool _seeded;

    private static (int, int)? ParseSelect(string? s) =>
        s?.Split(',') is { Length: 2 } p && int.TryParse(p[0], out var a) && int.TryParse(p[1], out var h) ? (a, h) : null;

    private void DisposeViews()
    {
        foreach (var v in _views.Values) { try { v.Release(); } catch { } }
        _views.Clear();
        _viewsFor = null;
    }

    public void SetPage(string? id)
    {
        if (id != PageId) { _offset = 0; DisposeViews(); }
        PageId = id;
        Rebuild();
    }

    /// <summary>Rebuild for new data, keeping the scroll position (live pages change under the reader).</summary>
    public void Refresh()
    {
        if (_scroll is not null && PageId is not null)
        {
            _offset = _scroll.VerticalOffset;
            // A live page whose boxes are session views: a remote edit only needs those views to read their sessions again.
            if (_views.Count > 0 && _source.GetPage(PageId) is { } page && Signature(page) == _sig)
            {
                foreach (var v in _views.Values) v.OnPageChanged();
                return;
            }
        }
        Rebuild();
    }

    private string _sig = "";

    /// <summary>What a full rebuild shows besides the text inside session-backed boxes.</summary>
    private static string Signature(NotePage p) =>
        string.Join("|", p.Title, p.EditedLine, p.State, p.StateMessage, p.Colour, p.Rules, p.OpenTasks, p.Comments, p.Locked,
            string.Join(";", p.Boxes.Select(b => $"{b.Field}@{b.X},{b.Y},{b.Width},{b.Wide}")));

    protected override UIElement Build()
    {
        _scroll = null;
        var page = PageId is null ? null : _source.GetPage(PageId);
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        if (page is null)
        {
            var e = PageId is null || _source.Loading || _source.LoadError is not null ? Overview() : Missing();
            Grid.SetRowSpan((FrameworkElement)e, 2);
            root.Children.Add(e);
            return root;
        }

        root.Children.Add(TopBar(page));

        var article = new Grid { Padding = new Thickness(0, 37, 40, 0) };
        article.RowDefinitions.Add(new RowDefinition { Height = new GridLength(28) });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var title = Ui.Text(page.Title, 36, B("Text"), 700, lineHeight: 43.2, tracking: -0.025);
        title.Margin = new Thickness(51, 0, 0, 0);
        Grid.SetRow(title, 1);
        article.Children.Add(title);

        var sub = Ui.Text(page.EditedLine, 12.5, B("PageTextMuted"), lineHeight: 18.75);
        sub.Margin = new Thickness(51, 4, 0, 22);
        Grid.SetRow(sub, 2);
        if (page.State != PageState.Live)
        {
            var (text, brush) = page.State switch
            {
                PageState.Connecting => ("Opening the page…", B("PageTextMuted")),
                PageState.Offline => ((page.StateMessage ?? "Offline") + " Trying again…", B("Warn")),
                _ => (page.StateMessage ?? "This page can't be shown.", B("Danger")),
            };
            var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(51, 4, 0, 22) };
            line.Children.Add(Ui.Text(page.EditedLine + " · ", 12.5, B("PageTextMuted"), lineHeight: 18.75));
            line.Children.Add(Ui.Text(text, 12.5, brush, 600, lineHeight: 18.75));
            Grid.SetRow(line, 2);
            article.Children.Add(line);
        }
        else article.Children.Add(sub);

        _sig = Signature(page);
        DisposeViews();
        SyncViews(page);
        var surfaceH = Math.Max(320, (page.Boxes.Count == 0 ? 0 : page.Boxes.Max(b => b.Y)) + 320);
        var canvas = new Canvas { Height = surfaceH, Margin = new Thickness(40, 15, 0, 0) };
        _firstBox = page.Boxes.FirstOrDefault();
        foreach (var box in page.Boxes) canvas.Children.Add(Box(box));
        Grid.SetRow(canvas, 3);
        article.Children.Add(canvas);

        var sv = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Content = article };
        _scroll = sv;
        if (_offset > 0)
        {
            var target = _offset;
            RoutedEventHandler? once = null;
            once = (_, _) => { sv.Loaded -= once; sv.UpdateLayout(); sv.ChangeView(null, target, null, true); };
            sv.Loaded += once;
        }
        Grid.SetRow(sv, 1);
        root.Children.Add(sv);

        // outline rail: 16x2 bars, 12 apart, current in accent (LOOK 4.5.4)
        var outline = new StackPanel { Spacing = 10, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 72, 20, 0), IsHitTestVisible = false };
        for (var i = 0; i < 3; i++)
            outline.Children.Add(new Border { Width = 16, Height = 2, Background = i == 0 ? B("Accent") : B("BorderStrong"), HorizontalAlignment = HorizontalAlignment.Right });
        Grid.SetRow(outline, 1);
        root.Children.Add(outline);
        return root;
    }

    private UIElement Missing()
    {
        var sp = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Spacing = 6 };
        sp.Children.Add(Ui.Text("Page not found", 20, B("Text"), 700));
        sp.Children.Add(Ui.Text("It may have been moved or deleted.", 14, B("TextMuted")));
        Grid.SetRowSpan(sp, 2);
        return sp;
    }

    /// <summary>No page selected (LOOK 4.14): "Notes", then Recently edited cards; or the loading / error / no notebooks states.</summary>
    private UIElement Overview()
    {
        var root = new StackPanel { Padding = new Thickness(40, 36, 40, 60) };
        root.Children.Add(Ui.Text("Notes", 26, B("Text"), 700, lineHeight: 34, tracking: -0.02));
        if (_source.LoadError is { } err)
        {
            var msg = Ui.Text(err, 14, B("Danger"), lineHeight: 21);
            msg.TextWrapping = TextWrapping.Wrap; msg.Margin = new Thickness(0, 12, 0, 12);
            root.Children.Add(msg);
            var retry = new Button { Content = "Try again", Style = Ui.Style("GhostButtonStyle"), Padding = new Thickness(12, 0, 12, 0), Height = 32, Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Foreground = B("Text") };
            retry.Click += (_, _) => { if (_source.CurrentWorkspaceId is { } w) _source.SelectWorkspace(w); };
            root.Children.Add(retry);
        }
        else if (_source.Loading) root.Children.Add(Ui.Text("Loading your notes…", 14, B("TextMuted")).With(t => t.Margin = new Thickness(0, 12, 0, 0)));
        else if (_source.Notebooks.Count == 0) root.Children.Add(Ui.Text("No notebooks yet. Create one in the web app.", 14, B("TextMuted")).With(t => t.Margin = new Thickness(0, 12, 0, 0)));
        else
        {
            var recent = _source.RecentPages(8);
            if (recent.Count > 0)
            {
                root.Children.Add(Ui.Text("Recently edited", 15, B("Text"), 650).With(t => t.Margin = new Thickness(0, 24, 0, 10)));
                var grid = new Microsoft.UI.Xaml.Controls.VariableSizedWrapGrid { Orientation = Orientation.Horizontal, ItemWidth = 200, ItemHeight = 84 };
                foreach (var (p, where, edited) in recent)
                {
                    var card = new Border { Width = 188, Height = 72, Padding = new Thickness(14, 10, 14, 10), CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1), BorderBrush = B("Border"), Background = B("BgElevated") };
                    var sp = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
                    sp.Children.Add(Ui.Text(p.Title, 14, B("Text"), 600));
                    sp.Children.Add(Ui.Text(where, 12, B("TextMuted")));
                    sp.Children.Add(Ui.Text(edited, 11.5, B("TextMuted")));
                    card.Child = sp;
                    var id = p.Id;
                    card.Tapped += (_, _) => PageOpened?.Invoke(id);
                    grid.Children.Add(card);
                }
                root.Children.Add(grid);
            }
        }
        return new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    public event Action<string>? PageOpened;

    // ---- top bar ----------------------------------------------------------------------------------------------

    private UIElement TopBar(NotePage page)
    {
        var bar = new Grid { Height = 48, Padding = new Thickness(20, 0, 16, 0), ColumnSpacing = 12 };
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var crumbs = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        crumbs.Children.Add(new Border { Width = 8, Height = 8, CornerRadius = new CornerRadius(4), Background = Ui.Hex(page.NotebookColorHex), VerticalAlignment = VerticalAlignment.Center });
        crumbs.Children.Add(Ui.Text(page.NotebookName, 13, B("Text2"), lineHeight: 19.5));
        foreach (var s in page.SectionPath)
        {
            crumbs.Children.Add(new Icon("chevron-right", 14, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
            crumbs.Children.Add(Ui.Text(s, 13, B("Text2"), lineHeight: 19.5));
        }
        bar.Children.Add(crumbs);

        var right = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        var saved = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center };
        saved.Children.Add(new Icon("check", 14, B("Text2")));
        saved.Children.Add(Ui.Text("Saved", 12, B("Text2")));
        right.Children.Add(saved);
        right.Children.Add(WithBadge(Ui.IconButton("list-todo", 18, 32, 32, "Tasks on this page", 8), page.OpenTasks));
        right.Children.Add(Ui.IconButton("message-square", 18, 32, 32, "Comments", 8));

        var share = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(8),
            Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), Foreground = B("Text"),
        };
        var ss = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        ss.Children.Add(new Icon("user-plus", 14));
        ss.Children.Add(new TextBlock { Text = "Share", FontSize = 13, FontWeight = new FontWeight(500), VerticalAlignment = VerticalAlignment.Center, FontFamily = Ui.Font });
        share.Content = ss;
        right.Children.Add(share);
        right.Children.Add(Ui.IconButton("ellipsis", 18, 32, 32, "Page options", 8));
        Grid.SetColumn(right, 1);
        bar.Children.Add(right);
        return bar;
    }

    private UIElement WithBadge(Button b, int count)
    {
        var g = new Grid();
        g.Children.Add(b);
        if (count > 0)
        {
            g.Children.Add(new Border
            {
                Height = 16, MinWidth = 16, Padding = new Thickness(4, 0, 4, 0), CornerRadius = new CornerRadius(8), Background = B("AccentSolid"),
                HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, -2, -4, 0), IsHitTestVisible = false,
                Child = Ui.Text(count.ToString(), 10, B("TextOnAccent"), 600).With(t => t.HorizontalAlignment = HorizontalAlignment.Center),
            });
        }
        return g;
    }

    // ---- canvas boxes -----------------------------------------------------------------------------------------

    /// <summary>Open (or keep) a session-backed view for each box of a live page; drop them when the page's connection changes.</summary>
    private void SyncViews(NotePage page)
    {
        if (!UseTextView || PageId is null) { DisposeViews(); return; }
        var live = _source.LivePageOf(PageId);
        if (!ReferenceEquals(live, _viewsFor)) DisposeViews();
        if (live is null) return;
        _viewsFor = live;
        var wanted = new HashSet<string>();
        foreach (var box in page.Boxes)
        {
            if (box.Field is null) continue;
            wanted.Add(box.Field);
            if (_views.ContainsKey(box.Field)) continue;
            try
            {
                var session = Notivelo.Native.EditorSession.OpenLive(live, box.Field, new BoxTasks(_source));
                _views[box.Field] = new BoxTextView(session, _source);
            }
            catch (Exception e) { BoxTextView.Log("open " + box.Field, e); }
        }
        if (SeedScript is { } seed && _views.Count > 0 && !_seeded)
        {
            _seeded = true;
            _views.Values.First().RunScript(File.ReadAllLines(seed));
        }
        foreach (var gone in _views.Keys.Where(k => !wanted.Contains(k)).ToList()) { _views[gone].Release(); _views.Remove(gone); }
    }

    /// <summary>The session's view of the task list. Titles come from the source; the box is read-only for now, so nothing is written.</summary>
    private sealed class BoxTasks : Notivelo.Native.TaskCallbacks
    {
        private readonly INotesSource _src;
        public BoxTasks(INotesSource src) => _src = src;
        public string NewId() => Guid.NewGuid().ToString();
        public void Create(string id, string title, bool done) { }
        public void Delete(string id) { }
        public bool Restore(string id) => false;
        public string? Title(string id) => _src.FindTask(id)?.Title;
        public void SetTitle(string id, string title) { }
    }

    private UIElement Box(CanvasBox box)
    {
        var width = box.Wide ? 819 : box.Width;
        Border b;
        if (box.Field is not null && _views.TryGetValue(box.Field, out var view))
        {
            // the view lives in its own host border, which moves into each rebuilt canvas
            b = view.Host;
            view.SetWidth(Math.Max(40, width - 22));
            view.OnPageChanged();
            if (SelectHook is { } sh && ReferenceEquals(box, _firstBox)) { view.ShowSelection = true; view.SetSelection(sh.A, sh.H); }
            b.Width = width;
        }
        else
        {
            var sp = new StackPanel();
            var first = true;
            foreach (var blk in box.Blocks)
            {
                sp.Children.Add(Block(blk, first));
                first = false;
            }
            b = new Border
            {
                Width = width, Padding = new Thickness(10, 6, 10, 6), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(6),
                BorderBrush = new SolidColorBrush(Colors.Transparent), Child = sp,
            };
        }
        Canvas.SetLeft(b, box.X);
        Canvas.SetTop(b, box.Y);
        return b;
    }

    private UIElement Block(BoxBlock blk, bool first)
    {
        // 0.4 em block gap (6.4 at 16); headings carry their own margins (LOOK 2.3).
        switch (blk.Kind)
        {
            case BlockKind.Heading1:
                return Rich(blk, 28, 700, 36.4, -0.02).With(t => t.Margin = new Thickness(0, first ? 0 : 33.6, 0, 8.4));
            case BlockKind.Heading2:
                return Rich(blk, 21.6, 700, 29.16, -0.01).With(t => t.Margin = new Thickness(0, first ? 0 : 23.76, 0, 5.4));
            case BlockKind.Heading3:
                return Rich(blk, 17.6, 700, 25, 0).With(t => t.Margin = new Thickness(0, first ? 0 : 19.2, 0, 4));
            case BlockKind.Task:
                return TaskLine(blk.Task!);
            case BlockKind.ListItem:
            case BlockKind.CheckItem:
                return ListLine(blk, first);
            case BlockKind.Quote:
            {
                var tb = Rich(blk, 16, 400, 27.2, 0, B("Text2"));
                return new Border { BorderBrush = B("BorderStrong"), BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(12, 0, 0, 0), Margin = new Thickness(0, first ? 0 : 6.4, 0, 0), Child = tb };
            }
            case BlockKind.Code:
            {
                var tb = Ui.Text(blk.Text, 13.5, B("Text"), lineHeight: 21).With(t => { t.FontFamily = Ui.Mono; t.TextWrapping = TextWrapping.Wrap; });
                return new Border { Background = B("BgHover"), CornerRadius = new CornerRadius(6), Padding = new Thickness(12, 8, 12, 8), Margin = new Thickness(0, first ? 0 : 6.4, 0, 0), Child = tb };
            }
            case BlockKind.Rule:
                return new Border { Height = 1, Background = B("BorderStrong"), Margin = new Thickness(0, 12, 0, 12) };
            default:
                return Rich(blk, 16, 400, 27.2, 0).With(t => t.Margin = new Thickness(0, first ? 0 : 6.4, 0, 0));
        }
    }

    /// <summary>Bullet, number or check box in a 24 pt column, indented 24 pt per level, then the line's text.</summary>
    private UIElement ListLine(BoxBlock blk, bool first)
    {
        var g = new Grid { Margin = new Thickness(24 * blk.Indent, first ? 0 : 3, 0, 0) };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(24) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var mark = blk.Kind == BlockKind.CheckItem ? (blk.Checked ? "☑" : "☐") : blk.Marker ?? "•";
        var m = Ui.Text(mark, 16, blk.Kind == BlockKind.CheckItem && blk.Checked ? B("Accent") : B("Text2"), lineHeight: 27.2);
        m.FontFamily = blk.Kind == BlockKind.CheckItem ? new FontFamily("Segoe UI Symbol") : Ui.Font;
        m.HorizontalAlignment = HorizontalAlignment.Left;
        g.Children.Add(m);
        var t = Rich(blk, 16, 400, 27.2, 0, blk.Kind == BlockKind.CheckItem && blk.Checked ? B("TextMuted") : null);
        Grid.SetColumn(t, 1);
        g.Children.Add(t);
        return g;
    }

    /// <summary>The block's text with its marks (bold, italic, underline, strike, code, link and mention colours, highlights): read-only.</summary>
    private TextBlock Rich(BoxBlock blk, double size, int weight, double lineHeight, double tracking, Brush? fg = null)
    {
        var tb = Ui.Text("", size, fg ?? B("Text"), weight, lineHeight, tracking);
        tb.TextWrapping = TextWrapping.Wrap;
        tb.TextTrimming = TextTrimming.None;
        tb.VerticalAlignment = VerticalAlignment.Top;
        if (blk.Spans is not { Count: > 0 }) { tb.Text = blk.Text; return tb; }
        var at = 0;
        foreach (var sp in blk.Spans)
        {
            var parts = sp.Text.Split((char)10);
            for (var i = 0; i < parts.Length; i++)
            {
                if (i > 0) { tb.Inlines.Add(new LineBreak()); at++; }
                if (parts[i].Length == 0) continue;
                var run = new Run { Text = parts[i] };
                if (sp.Bold) run.FontWeight = new FontWeight((ushort)Math.Max(weight, 700));
                if (sp.Italic) run.FontStyle = global::Windows.UI.Text.FontStyle.Italic;
                var deco = TextDecorations.None;
                if (sp.Underline) deco |= TextDecorations.Underline;
                if (sp.Strike) deco |= TextDecorations.Strikethrough;
                if (deco != TextDecorations.None) run.TextDecorations = deco;
                if (sp.Code) { run.FontFamily = Ui.Mono; run.FontSize = size * 0.9; }
                if (sp.ColorHex is { } c) run.Foreground = Ui.Hex(c);
                tb.Inlines.Add(run);
                if (sp.HighlightHex is { } h)
                {
                    var hl = new TextHighlighter { Background = new SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb(0x99, Ui.ColorOf(h).R, Ui.ColorOf(h).G, Ui.ColorOf(h).B)) };
                    hl.Ranges.Add(new TextRange { StartIndex = at, Length = parts[i].Length });
                    tb.TextHighlighters.Add(hl);
                }
                at += parts[i].Length;
            }
        }
        return tb;
    }

    /// <summary>A task line inside a box (LOOK 2.4): circle, empty-state chips, avatar, "Add checklist", open.</summary>
    private UIElement TaskLine(TaskItem t)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Padding = new Thickness(4, 3, 6, 3), MinHeight = 36, Margin = new Thickness(0) };
        var circle = TaskParts.Circle(B, t.Priority, t.Done);
        ((FrameworkElement)circle).VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(circle);
        if (t.Title.Length > 0)
        {
            // a real task: its title (struck through when done) and due date; the empty chips below are the sample's new-task line
            var title = Ui.Text(t.Title, 16, t.Done ? B("TextMuted") : B("Text"), lineHeight: 24);
            if (t.Done) title.TextDecorations = TextDecorations.Strikethrough;
            title.MaxWidth = 460;
            row.Children.Add(title);
            if (t.DueLabel is { } due)
                row.Children.Add(Ui.Text(due, 12, t.Tone == DueTone.Overdue ? B("Danger") : t.Tone == DueTone.Today ? B("Accent") : B("TextMuted"), 600).With(x => x.Margin = new Thickness(4, 2, 0, 0)));
            return row;
        }
        UIElement Chip(string icon) => new Border
        {
            Height = 22, Width = 26, CornerRadius = new CornerRadius(6), Background = B("BgHover"), VerticalAlignment = VerticalAlignment.Center,
            Child = new Icon(icon, 13, B("TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center },
        };
        var meta = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 2, 0, 0) };
        meta.Children.Add(Chip("flag"));
        meta.Children.Add(Chip("calendar-days"));
        meta.Children.Add(Ui.Avatar(t.Assignee ?? "DU", 20));
        var add = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(4, 0, 0, 0) };
        add.Children.Add(new Icon("list-plus", 13, B("Text2")));
        add.Children.Add(Ui.Text("Add checklist", 11.5, B("Text2"), 600));
        meta.Children.Add(add);
        meta.Children.Add(new Icon("maximize-2", 13, B("Text2")) { Margin = new Thickness(6, 0, 0, 0) });
        row.Children.Add(meta);
        return row;
    }
}
