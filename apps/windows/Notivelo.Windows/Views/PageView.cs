using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Windows.Foundation;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The page (LOOK 4.4 top bar, 4.5 surface): sticky 48 pt bar, scrolling article with title, sub-line and the canvas.
/// Boxes are static TextBlocks for now; the editor session's text view replaces them later.</summary>
internal sealed partial class PageView : ThemedControl
{
    private readonly INotesSource _source;
    public string? PageId { get; private set; }

    public PageView(INotesSource source)
    {
        _source = source;
        _saveTimer.Tick += (_, _) => PollSave();
        KeyDown += OnPageKey;
        source.SetBoxTextProbe(field => _views.TryGetValue(field, out var v) ? v.AutomationText : "");
        Loaded += (_, _) => { _saveTimer.Start(); BoxTextView.Escaped += OnBoxEscaped; BoxTextView.FocusedStateChanged += FocusChanged; InkTool.Shared.Changed += OnInkTool; _source.CaretsChanged += OnCaretsChanged; Current = this; ShowCarets(); };
        Unloaded += (_, _) => { _saveTimer.Stop(); BoxTextView.Escaped -= OnBoxEscaped; BoxTextView.FocusedStateChanged -= FocusChanged; InkTool.Shared.Changed -= OnInkTool; _source.CaretsChanged -= OnCaretsChanged; if (ReferenceEquals(Current, this)) Current = null; };
    }

    /// <summary>The page on screen, for the ribbon and the page-level undo keys.</summary>
    public static PageView? Current { get; private set; }

    /// <summary>Raised when the page's undo/redo availability may have changed (a page edit, an undo, a rebuild).</summary>
    public static event Action? UndoStateChanged;

    /// <summary>Undo or redo through the live page (core page undo: boxes, ink and the text of boxes whose sessions are open). Null when the page
    /// isn't live, so the caller uses the box's own undo. The core notifies nothing, so every open view and the ink are read again.</summary>
    public bool? Undo(bool undo)
    {
        if (PageId is null || _source.PageUndo(PageId, undo) is not { } changed) return null;
        // the source raised Changed (boxes made, removed or moved are already shown); the text of every view and the ink are read again
        if (changed && PageId is not null && _source.GetPage(PageId) is { } page)
        {
            foreach (var v in _views.Values) v.OnPageChanged(true);
            UpdateInk(page);
        }
        UndoStateChanged?.Invoke();
        return changed;
    }

    /// <summary>Undo/redo availability of the live page; null when it isn't live.</summary>
    public bool? CanUndo(bool undo) => PageId is null ? null : _source.CanPageUndo(PageId, undo);

    // Box frames (chrome) per field, the canvas surface and the ink layers of the page shown.
    private readonly Dictionary<string, BoxFrame> _frames = new();
    private Canvas? _surface;
    private InkLayer? _inkUnder, _inkOver;
    private InkOverlay? _inkOverlay;
    private BoxFrame? _dragging;

    private void FocusChanged()
    {
        if (BoxTextView.Focused is not null) Select(null);
        foreach (var f in _frames.Values) f.SetEditing(ReferenceEquals(BoxTextView.Focused, f.View) || f.View.LinkEditorOpen);
    }

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
        MediaCache.Clear();
        foreach (var f in _frames.Values) if (f.Parent is Panel fp) fp.Children.Remove(f);
        _frames.Clear();
        _selectedBox = null;
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
        var tasksChanged = _source.TasksVersion != _tasksSeen;
        _tasksSeen = _source.TasksVersion;
        if (_scroll is not null && PageId is not null)
        {
            _offset = _scroll.VerticalOffset;
            // A live page whose boxes are session views: a remote edit only needs those views to read their sessions again.
            if (_dragging is not null) return;
            if (_views.Count > 0 && _source.GetPage(PageId) is { } page && Signature(page) == _sig)
            {
                // boxes made or removed show in place (the views keep their sessions and focus); moved ones too
                SyncViews(page);
                if (_surface is not null)
                    foreach (var box in page.Boxes)
                        if (box.Field is not null && _views.ContainsKey(box.Field) && !_frames.ContainsKey(box.Field)) _surface.Children.Add(Box(box));
                foreach (var v in _views.Values) v.OnPageChanged(tasksChanged);   // task lines are drawn again when a task changed
                DrawPresence(); UpdateStrip(page);
                ApplyGeometry(page);
                UpdateInk(page);
                UndoStateChanged?.Invoke();
                return;
            }
        }
        Rebuild();
        if (tasksChanged) foreach (var v in _views.Values) v.OnPageChanged(true);
        UndoStateChanged?.Invoke();
    }

    private string _sig = "";
    private StackPanel? _saved;
    private SaveState _savedState = (SaveState)(-1);
    private readonly global::Microsoft.UI.Xaml.DispatcherTimer _saveTimer = new() { Interval = TimeSpan.FromSeconds(2) };

    private SaveState ShownSave => AuditRules.Combine(_source.IsOffline, _source.SaveState);

    /// <summary>The bar's save state, drawn in place (only its own little panel changes).</summary>
    private void DrawSave()
    {
        if (_saved is not { } p) return;
        var st = ShownSave;
        _savedState = st;
        var off = st is SaveState.Offline or SaveState.OfflineKept;
        var text = AuditRules.SaveText(st);
        p.Children.Clear();
        p.Children.Add(new Icon(off ? "cloud-off" : st == SaveState.Saving ? "loader-circle" : "check", 14, off ? B("Warn") : B("Text2")));
        p.Children.Add(Ui.Text(text, 12, off ? B("Warn") : B("Text2")));
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(p, text);
    }

    private async void PollSave()
    {
        if (PageId is null) return;
        try { await _source.RefreshSaveState(); } catch (Exception) { }
        if (IsLoaded && ShownSave != _savedState) DrawSave();
    }

    /// <summary>What a full rebuild shows besides the text inside session-backed boxes.</summary>
    private string Signature(NotePage p) =>
        string.Join("|", _source.IsOffline, p.Title, p.EditedLine, p.State, p.StateMessage, p.Colour, p.Rules, p.OpenTasks, p.Comments, p.Locked, p.Emoji,
            string.Join(";", p.Boxes.Where(b => b.Field is null).Select(b => $"@{b.X},{b.Y},{b.Width},{b.Wide}")));

    protected override UIElement Build()
    {
        _scroll = null;
        var page = PageId is null ? null : _source.GetPage(PageId);
        var root = new Grid { Background = new SolidColorBrush(Colors.Transparent) };
        // page colour (LOOK 1.3) replaces the page background, top bar included
        if (page is not null && PageTint(page.Colour, ActualTheme) is { } tint) root.Background = new SolidColorBrush(tint);
        // a click on the page outside any box gives the keyboard back to the page
        root.PointerPressed += (_, _) => { BoxTextView.CloseLinkEditor(); BoxTextView.Focused?.Unfocus(); BoxTextView.LeaveEditing(); };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        // "Tasks on this page" docks at the right of the page (and its top bar)
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        if (page is null)
        {
            var e = PageId is null || _source.Loading || _source.LoadError is not null ? Overview() : Missing();
            Grid.SetRowSpan((FrameworkElement)e, 2);
            root.Children.Add(e);
            return root;
        }

        root.Children.Add(TopBar(page));

        if (page.State == PageState.Locked)
        {
            // a locked page stays shut until the locked pages' password is given (Apple's UnlockPrompt)
            DisposeViews();
            _sig = Signature(page);
            var prompt = UnlockPrompt(page);
            Grid.SetRow(prompt, 1);
            root.Children.Add(prompt);
            return root;
        }

        var article =new Grid { Padding = new Thickness(0, 37, 40, 0) };
        article.RowDefinitions.Add(new RowDefinition { Height = new GridLength(28) });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var title = TitleHost(page);
        title.Margin = new Thickness(51, 0, 0, 0);
        Grid.SetRow(title, 1);
        if (!string.IsNullOrEmpty(page.Emoji))
        {
            // the page icon sits before the title; a click changes it
            var icon = new Button { Style = Ui.Style("GhostButtonStyle"), Padding = new Thickness(4, 0, 4, 0), Height = 48, CornerRadius = new CornerRadius(8), VerticalAlignment = VerticalAlignment.Center };
            icon.Content = new TextBlock { Text = page.Emoji, FontSize = 32, FontFamily = new FontFamily("Segoe UI Emoji"), VerticalAlignment = VerticalAlignment.Center };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(icon, "page-icon");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(icon, "Page icon " + page.Emoji);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetItemStatus(icon, "icon=" + page.Emoji);
            icon.Click += (_, _) => { if (PageId is not null && Host is not null) PageDialogs.IconPicker(Host, PageId, true); };
            title.Margin = new Thickness(8, 0, 0, 0);
            var line = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(47, 0, 0, 0) };
            line.Children.Add(icon); line.Children.Add(title);
            Grid.SetRow(line, 1);
            article.Children.Add(line);
        }
        else article.Children.Add(title);

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
        SyncViews(page);
        var ink = PageId is null ? Array.Empty<InkStroke>() : _source.InkOf(PageId);
        var surfaceH = Math.Max(320, Math.Max((page.Boxes.Count == 0 ? 0 : page.Boxes.Max(b => b.Y)) + 320, ink.Count == 0 ? 0 : ink.Max(i => i.MaxY) + 40));
        // the canvas surface: clicks on it make a box (the web's click-to-create); highlighters sit under the boxes, pens over them
        var canvas = new Canvas { Height = surfaceH, Margin = new Thickness(40, 15, 0, 0), Background = new SolidColorBrush(Colors.Transparent) };
        _surface = canvas;
        canvas.PointerPressed += OnSurfacePressed;
        canvas.RightTapped += OnSurfaceRightTapped;
        // the ink layers are made when the page has ink (a canvas control per layer)
        _inkUnder = null; _inkOver = null; _inkOverlay = null;
        canvas.SizeChanged += (_, e) => { if (_inkUnder is not null) _inkUnder.Width = e.NewSize.Width; if (_inkOver is not null) _inkOver.Width = e.NewSize.Width; if (_inkOverlay is not null) _inkOverlay.Width = e.NewSize.Width; };
        UpdateInk(page);
        _firstBox = page.Boxes.FirstOrDefault();
        var rank = page.Boxes.OrderBy(b => b.Z).Select((b, i) => (b, i)).ToDictionary(x => x.b, x => x.i);
        foreach (var box in page.Boxes) { var el = Box(box); Canvas.SetZIndex(el, rank[box]); canvas.Children.Add(el); }
        Grid.SetRow(canvas, 4);
        if (page.Rules != RuleLines.None) article.Children.Add(RuleLayer(page.Rules, surfaceH));
        var strip = TemplateStrip(page);
        Grid.SetRow(strip, 3);
        article.Children.Add(strip);
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
        if (_tasksOpen && PageId is { } tasksPage)
        {
            var panel = new PageTasksPanel(_source, tasksPage, () => { _comments?.Cancel(false); _tasksOpen = false; Rebuild(); }) { Host = Host };
            if (_commentsTab) panel.Comments = CommentsFor(tasksPage);
            panel.SwitchTab = comments => { if (!comments) _comments?.Cancel(false); _commentsTab = comments; Rebuild(); };
            panel.VerticalAlignment = VerticalAlignment.Stretch; Grid.SetColumn(panel, 1); Grid.SetRowSpan(panel, 2);
            root.Children.Add(panel);
        }
        return root;
    }

    // ---- comments (the Comments tab of the page panel) and the lock screen ----

    private bool _commentsTab;
    private CommentsModel? _comments;

    private CommentsModel CommentsFor(string pageId)
    {
        if (_comments is null || _comments.PageId != pageId)
        {
            _comments = new CommentsModel(_source, pageId, RemoveCommentMark);
            _comments.Reload();
        }
        return _comments;
    }

    /// <summary>Open the Comments tab for a thread just started on the selection (its mark is already in the text).</summary>
    public void BeginComment(string threadId, string quote)
    {
        if (PageId is not { } id) return;
        _tasksOpen = true; _commentsTab = true;
        CommentsFor(id).Begin(threadId, quote);
        Rebuild();
    }

    /// <summary>Take a thread's comment mark off the text (a cancelled or deleted thread).</summary>
    public void RemoveCommentMark(string threadId)
    {
        var args = System.Text.Json.JsonSerializer.Serialize(new { threadId });
        foreach (var v in _views.Values) { try { v.RunCommand("unsetComment", args); } catch { } }
    }

    private void ToggleComments()
    {
        if (_tasksOpen && _commentsTab) { _comments?.Cancel(false); _tasksOpen = false; }
        else { _tasksOpen = true; _commentsTab = true; if (PageId is { } id) CommentsFor(id).Reload(); }
        Rebuild();
    }

    /// <summary>The locked page's screen: the password (Apple's UnlockPrompt). The source reopens the page once it is unlocked.</summary>
    private FrameworkElement UnlockPrompt(NotePage page)
    {
        var col = new StackPanel { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Width = 300 };
        col.Children.Add(new Icon("lock", 28, B("TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center });
        col.Children.Add(Ui.Text("Locked page", 22, B("Text"), 700).With(t => t.HorizontalAlignment = HorizontalAlignment.Center));
        col.Children.Add(Ui.Text("Enter your locked pages password to open it.", 14, B("TextMuted")).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.TextAlignment = TextAlignment.Center; }));
        var pw = new PasswordBox { PlaceholderText = "Password", Height = 36, FontSize = 14, Padding = new Thickness(10, 7, 10, 7), CornerRadius = new CornerRadius(8), Margin = new Thickness(0, 8, 0, 0) };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(pw, "unlock-password");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(pw, "Locked pages password");
        col.Children.Add(pw);
        var err = Ui.Text("", 12.5, B("Danger")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.TextAlignment = TextAlignment.Center; t.Visibility = Visibility.Collapsed; });
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(err, "unlock-error");
        col.Children.Add(err);
        var ok = new Button { Style = Ui.Style("SolidButtonStyle"), Height = 32, Padding = new Thickness(18, 0, 18, 0), CornerRadius = new CornerRadius(8), HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 4, 0, 0), Background = B("AccentSolid"), Content = Ui.Text("Unlock", 14, B("TextOnAccent"), 600) };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(ok, "unlock-ok");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(ok, "Unlock");
        col.Children.Add(ok);
        var busy = false;
        async void Go()
        {
            if (busy || pw.Password.Length == 0) return;
            busy = true; ok.IsEnabled = false; err.Visibility = Visibility.Collapsed;
            var e = await _source.UnlockLocked(pw.Password);
            busy = false; ok.IsEnabled = true;
            if (e is not null) { pw.Password = ""; err.Text = e; err.Visibility = Visibility.Visible; }
        }
        ok.Click += (_, _) => Go();
        pw.KeyDown += (_, e) => { if (e.Key == global::Windows.System.VirtualKey.Enter) { e.Handled = true; Go(); } };
        pw.Loaded += (_, _) => pw.Focus(FocusState.Programmatic);
        var wrap = new StackPanel { VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Stretch, Children = { col } };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(wrap, "locked-page");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(wrap, "Locked page");
        return wrap;
    }

    /// <summary>Page colours (LOOK 1.3), light / dark.</summary>
    private static global::Windows.UI.Color? PageTint(PageColour c, ElementTheme theme)
    {
        var dark = theme == ElementTheme.Dark;
        var hex = c switch
        {
            PageColour.Yellow => dark ? "#221f1a" : "#fdf8e3",
            PageColour.Green => dark ? "#1a1f1c" : "#eff7f0",
            PageColour.Blue => dark ? "#1a1d24" : "#eef4fb",
            PageColour.Purple => dark ? "#1e1b24" : "#f5f1fb",
            PageColour.Pink => dark ? "#221b1f" : "#fcf1f5",
            PageColour.Grey => dark ? "#1f1f22" : "#f4f4f5",
            _ => null,
        };
        return hex is null ? null : Ui.ColorOf(hex);
    }

    /// <summary>Rule lines (LOOK 1.3 / 4.5.3): a 1 pt <c>--page-rule</c> line at the bottom of every 28 pt band, starting 7 pt below the surface top; Grid adds
    /// vertical lines every 28 pt. Spans the page width from the note area's left edge. Drawn under the boxes; boxes' text is not snapped to the lines yet.</summary>
    private UIElement RuleLayer(RuleLines rules, double height)
    {
        var layer = new Canvas { Height = height, Margin = new Thickness(0, 15, 0, 0), IsHitTestVisible = false };
        Grid.SetRow(layer, 4);
        var brush = B("PageRule");
        void Fill(double w)
        {
            layer.Children.Clear();
            for (var y = 7.0 + 27; y < height; y += 28) layer.Children.Add(Line(0, y, w, 1));
            if (rules == RuleLines.Grid) for (var x = 27.0; x < w; x += 28) layer.Children.Add(Line(x, 7, 1, height - 7));
        }
        Microsoft.UI.Xaml.Shapes.Rectangle Line(double x, double y, double w, double h)
        {
            var r = new Microsoft.UI.Xaml.Shapes.Rectangle { Width = w, Height = h, Fill = brush };
            Canvas.SetLeft(r, x); Canvas.SetTop(r, y);
            return r;
        }
        layer.SizeChanged += (_, e) => Fill(e.NewSize.Width);
        return layer;
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
    public event Action<string>? TaskOpened;
    internal ShellHost? Host { get; set; }
    private long _tasksSeen;
    private bool _tasksOpen;

    // ---- the title: a click turns it into a text box in place; Enter or leaving it renames the page (the core's rename_page), Esc keeps the old title ----

    private Border TitleHost(NotePage page)
    {
        var host = new Border();
        var shown = page.Title;
        var canRename = page.CanEdit && !page.Locked && PageId is not null && _source.CanEditTree;
        var id = PageId;

        void ShowLabel()
        {
            var t = Ui.Text(shown, 36, B("Text"), 700, lineHeight: 43.2, tracking: -0.025);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(t, "page-title");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(t, shown);
            if (canRename) t.Tapped += (_, _) => Edit();
            host.Child = t;
        }

        void Edit()
        {
            var box = new TextBox
            {
                Style = Ui.Style("PlainTextBoxStyle"), Text = shown == "Untitled" ? "" : shown, PlaceholderText = "Untitled", FontSize = 36, FontWeight = new global::Windows.UI.Text.FontWeight(700),
                Padding = new Thickness(0), MinHeight = 43, Foreground = B("Text"), Background = new SolidColorBrush(Colors.Transparent), BorderThickness = new Thickness(0),
                AcceptsReturn = false, TextWrapping = TextWrapping.NoWrap, FontFamily = Ui.Font,
            };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(box, "page-title-edit");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, "Page title");
            var done = false;
            async void Finish(bool save)
            {
                if (done) return;
                done = true;
                var change = save ? ShellRules.TitleChange(shown, box.Text) : null;
                if (change is null) { ShowLabel(); return; }
                var old = shown;
                shown = change.Length == 0 ? "Untitled" : change;
                ShowLabel();
                var r = await _source.Rename(TreeKind.Page, id!, change);
                if (!r.Ok) { shown = old; ShowLabel(); Host?.Toast(r.Error ?? "Couldn't rename the page.", true); }
            }
            box.KeyDown += (_, e) =>
            {
                if (e.Key == global::Windows.System.VirtualKey.Enter) { e.Handled = true; Finish(true); }
                else if (e.Key == global::Windows.System.VirtualKey.Escape) { e.Handled = true; Finish(false); }
            };
            box.LostFocus += (_, _) => Finish(true);
            host.Child = box;
            box.Loaded += (_, _) => { box.Focus(FocusState.Programmatic); box.SelectAll(); };
        }

        ShowLabel();
        return host;
    }

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
        right.Children.Add(PresenceHost());
        var saved = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center };
        // the save state: Saved, Saving… (edits the server has not confirmed), Offline (a page that cannot connect, a lost network) or Offline — changes kept; drawn again as it is polled
        _saved = saved;
        DrawSave();
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(saved, "page-status");
        right.Children.Add(saved);
        var tasksBtn = Ui.IconButton("list-todo", 18, 32, 32, "Tasks on this page", 8);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(tasksBtn, "page-tasks-button");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetItemStatus(tasksBtn, _tasksOpen && !_commentsTab ? "panel=open" : "panel=closed");

        if (_tasksOpen && !_commentsTab) tasksBtn.Background = B("AccentSoft");
        tasksBtn.Click += (_, _) => { if (_tasksOpen && !_commentsTab) { _tasksOpen = false; } else { _comments?.Cancel(false); _tasksOpen = true; _commentsTab = false; } Rebuild(); };
        right.Children.Add(WithBadge(tasksBtn, page.OpenTasks));
        var commentsBtn = Ui.IconButton("message-square", 18, 32, 32, "Comments", 8);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(commentsBtn, "page-comments-button");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetItemStatus(commentsBtn, (_tasksOpen && _commentsTab ? "panel=open" : "panel=closed") + ";open=" + page.Comments);
        if (_tasksOpen && _commentsTab) commentsBtn.Background = B("AccentSoft");
        commentsBtn.Click += (_, _) => ToggleComments();
        right.Children.Add(WithBadge(commentsBtn, page.Comments));

        var share = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(8),
            Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), Foreground = B("Text"),
        };
        var ss = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        ss.Children.Add(new Icon("user-plus", 14));
        ss.Children.Add(new TextBlock { Text = "Share", FontSize = 13, FontWeight = new FontWeight(500), VerticalAlignment = VerticalAlignment.Center, FontFamily = Ui.Font });
        share.Content = ss;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(share, "page-share");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(share, "Share");
        share.Click += (_, _) => { if (PageId is not null && Host is not null) PageDialogs.Share(Host, PageId, page.Title == "Untitled" ? "" : page.Title); };
        right.Children.Add(share);
        var options = Ui.IconButton("ellipsis", 18, 32, 32, "Page options", 8);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(options, "page-options");
        options.Click += (_, _) => { if (PageId is not null) Host?.Tree.PageMenuFor(options, PageId); };
        right.Children.Add(options);
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
        var offline = live is null && _source.OffersOfflineBoxes;
        if (!ReferenceEquals(live, _viewsFor)) DisposeViews();
        if (live is null && !offline) return;
        _viewsFor = live;
        var wanted = new HashSet<string>();
        foreach (var box in page.Boxes)
        {
            if (box.Field is null) continue;
            wanted.Add(box.Field);
            if (_views.ContainsKey(box.Field)) continue;
            try
            {
                var tasks = new BoxTasks(_source, DispatcherQueue, () => PageId);
                var session = live is not null ? Notivelo.Native.EditorSession.OpenLive(live, box.Field, tasks) : _source.OpenOfflineBox(PageId, box.Field, tasks);
                if (session is null) continue;
                _views[box.Field] = new BoxTextView(session, _source) { PageId = PageId, BoxId = box.Field.StartsWith("box:") ? box.Field["box:".Length..] : box.Field };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(_views[box.Field], "box-" + box.Field.Replace(':', '-'));
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(_views[box.Field], "Text box");
            }
            catch (Exception e) { BoxTextView.Log("open " + box.Field, e); }
        }
        if (SeedScript is { } seed && _views.Count > 0 && !_seeded)
        {
            _seeded = true;
            _views.Values.First().RunScript(File.ReadAllLines(seed));
        }
        // dev hook: NOTIVELO_FOCUS=1 gives the first box the keyboard (loopback servers only), to exercise the text services without a pointer
        if (Environment.GetEnvironmentVariable("NOTIVELO_FOCUS") is not null && (Environment.GetEnvironmentVariable("NOTIVELO_SERVER") ?? "").Contains("127.0.0.1") && _views.Count > 0)
            _ = Task.Delay(6000).ContinueWith(_ => DispatcherQueue.TryEnqueue(() => { var v = _views.Values.First(); var ok = v.Focus(Microsoft.UI.Xaml.FocusState.Programmatic); if (SelectHook is { } sh2) v.SetSelection(sh2.A, sh2.H); if (Environment.GetEnvironmentVariable("NOTIVELO_LINKEDITOR") is not null) v.ShowLinkEditor(); BoxTextView.Trace("focus hook " + ok); }));
        ShowCarets();
        foreach (var gone in _views.Keys.Where(k => !wanted.Contains(k)).ToList()) { if (gone == _selectedBox) _selectedBox = null; _views[gone].Release(); _views.Remove(gone); if (_frames.Remove(gone, out var fr) && fr.Parent is Panel gp) gp.Children.Remove(fr); }
    }

    /// <summary>The session's view of the task list. The core calls these on the session's thread with the session locked: they only note
    /// the change and hand the real work to the UI thread (never back into the session).</summary>
    private sealed class BoxTasks : Notivelo.Native.TaskCallbacks
    {
        private readonly INotesSource _src;
        private readonly Microsoft.UI.Dispatching.DispatcherQueue _ui;
        private readonly Func<string?> _page;
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> _titles = new();
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, bool> _gone = new();
        public BoxTasks(INotesSource src, Microsoft.UI.Dispatching.DispatcherQueue ui, Func<string?> page) { _src = src; _ui = ui; _page = page; }
        public string NewId() => Guid.NewGuid().ToString();
        public void Create(string id, string title, bool done)
        {
            _titles[id] = title; _gone.TryRemove(id, out _);
            var page = _page();
            _ui.TryEnqueue(() => _src.CreateTask(id, title, done, page));
        }
        public void Delete(string id)
        {
            _gone[id] = true;
            _ui.TryEnqueue(() => _src.DeleteTask(id));
        }
        public bool Restore(string id) { _gone.TryRemove(id, out _); return _titles.ContainsKey(id) || _src.FindTask(id) is not null; }
        public string? Title(string id) => _gone.ContainsKey(id) ? null : _titles.TryGetValue(id, out var t) ? t : _src.FindTask(id)?.Title;
        public void SetTitle(string id, string title) => _titles[id] = title;
    }

    private UIElement Box(CanvasBox box)
    {
        var width = box.Wide ? 819 : box.Width;
        if (box.Field is not null && _views.TryGetValue(box.Field, out var view))
        {
            // the view lives in its own host border inside a frame (chrome: hover border, move bar, width handle), which moves into each rebuilt canvas
            if (!_frames.TryGetValue(box.Field, out var frame))
            {
                frame = new BoxFrame(view, box.Id is not null && _source.CanEditBoxes(PageId ?? ""), B);
                WireFrame(frame);
                _frames[box.Field] = frame;
            }
            if (frame.Parent is Panel old) old.Children.Remove(frame);
            frame.Box = box;
            view.OnPageChanged();
            if (SelectHook is { } sh && ReferenceEquals(box, _firstBox)) { view.ShowSelection = true; view.SetSelection(sh.A, sh.H); }
            frame.SetGeometry(box.X, box.Y, width);
            frame.SetEditing(ReferenceEquals(BoxTextView.Focused, view));
            return frame;
        }
        var sp = new StackPanel();
        var first = true;
        foreach (var blk in box.Blocks)
        {
            sp.Children.Add(Block(blk, first));
            first = false;
        }
        var b = new Border
        {
            Width = width, Padding = new Thickness(10, 6, 10, 6), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(6),
            BorderBrush = new SolidColorBrush(Colors.Transparent), Child = sp,
        };
        Canvas.SetLeft(b, box.X);
        Canvas.SetTop(b, box.Y);
        return b;
    }

    // ---- canvas boxes: make, move, resize, remove -----------------------------------------------------------------------

    /// <summary>Boxes moved, resized or reordered by someone (or by us) show in place; the views keep their sessions and focus.</summary>
    private void ApplyGeometry(NotePage page)
    {
        var rank = page.Boxes.OrderBy(b => b.Z).Select((b, i) => (b, i)).ToDictionary(x => x.b, x => x.i);
        foreach (var box in page.Boxes)
            if (box.Field is not null && _frames.TryGetValue(box.Field, out var f))
            {
                f.Box = box;
                f.SetGeometry(box.X, box.Y, box.Wide ? 819 : box.Width);
                Canvas.SetZIndex(f, rank[box]);
            }
        if (_surface is not null)
        {
            var ink = PageId is null ? Array.Empty<InkStroke>() : _source.InkOf(PageId);
            var h = Math.Max(320, Math.Max((page.Boxes.Count == 0 ? 0 : page.Boxes.Max(b => b.Y)) + 320, ink.Count == 0 ? 0 : ink.Max(i => i.MaxY) + 40));
            _surface.Height = h;
            if (_inkUnder is not null) _inkUnder.Height = h;
            if (_inkOver is not null) _inkOver.Height = h;
            if (_inkOverlay is not null) _inkOverlay.Height = h;
        }
    }

    private void UpdateInk(NotePage page)
    {
        var strokes = PageId is null ? Array.Empty<InkStroke>() : _source.InkOf(PageId);
        var dark = ActualTheme == ElementTheme.Dark;
        var canInk = PageId is not null && _source.CanInk(PageId);
        if ((strokes.Count > 0 || (canInk && InkTool.Shared.BarOpen)) && _surface is not null && _inkUnder is null)
        {
            var h = _surface.Height; var w = _surface.ActualWidth;
            _inkUnder = new InkLayer(true) { Height = h, Width = w };
            _inkOver = new InkLayer(false) { Height = h, Width = w };
            Canvas.SetZIndex(_inkUnder, -1);
            Canvas.SetZIndex(_inkOver, 10_000);
            _surface.Children.Add(_inkUnder);
            _surface.Children.Add(_inkOver);
        }
        // the pen row is open on a page that takes ink: the overlay takes the pointer while a pen tool is chosen
        if (canInk && InkTool.Shared.BarOpen && _surface is not null && _inkOverlay is null && _inkUnder is not null && _inkOver is not null)
        {
            _inkOverlay = new InkOverlay(_source, PageId!, _inkUnder, _inkOver, () =>
            {
                if (PageId is not null && _source.GetPage(PageId) is { } p) UpdateInk(p);
                UndoStateChanged?.Invoke();
            }) { Height = _surface.Height, Width = _surface.ActualWidth };
            // a plain Grid carries the z-index (an attached property set directly on the UserControl threw E_INVALIDARG)
            var host = new Grid { HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top };
            host.Children.Add(_inkOverlay);
            Canvas.SetZIndex(host, 20_000);
            _surface.Children.Add(host);
        }
        // strokes drawn below the old end of the page make it longer
        if (_surface is not null && strokes.Count > 0 && strokes.Max(s => s.MaxY) + 40 > _surface.Height)
        {
            var h = strokes.Max(s => s.MaxY) + 40;
            _surface.Height = h;
            if (_inkUnder is not null) _inkUnder.Height = h;
            if (_inkOver is not null) _inkOver.Height = h;
            if (_inkOverlay is not null) _inkOverlay.Height = h;
        }
        _inkUnder?.Set(strokes, dark);
        _inkOver?.Set(strokes, dark);
        _inkOverlay?.SetStrokes(strokes, dark);
    }

    /// <summary>The pen row opened: the overlay is made on the page on screen.</summary>
    private void OnInkTool()
    {
        if (_inkOverlay is null && InkTool.Shared.BarOpen && PageId is not null && _source.GetPage(PageId) is { } page) UpdateInk(page);
    }

    /// <summary>A click on empty canvas: while a box is being edited it only stops that (and removes the box if it was left empty);
    /// else it makes a box 360 wide, 12 pt above the click, in front, and opens it for typing (LOOK 4.5.1, Apple's createBox).</summary>
    private void OnSurfacePressed(object sender, PointerRoutedEventArgs e)
    {
        if (!ReferenceEquals(e.OriginalSource, sender) || PageId is null) return;
        var pt = e.GetCurrentPoint((UIElement)sender);
        if (!pt.Properties.IsLeftButtonPressed) return;
        Select(null);
        e.Handled = true;
        var wasEditing = BoxTextView.Focused is not null || BoxTextView.AnyLinkEditorOpen;
        BoxTextView.CloseLinkEditor();
        BoxTextView.Focused?.Unfocus();
        BoxTextView.LeaveEditing();
        if (wasEditing || !_source.CanEditBoxes(PageId)) return;
        var front = (_source.GetPage(PageId)?.Boxes.Select(b => b.Z).DefaultIfEmpty(0).Max() ?? 0) + 1;
        var id = _source.CreateBox(PageId, Math.Max(pt.Position.X, 0), Math.Max(pt.Position.Y - 12, 0), 360, front);
        if (id is not null) FocusBox("box:" + id);
    }

    /// <summary>A box just made by a click takes the keyboard once it is on the page.</summary>
    private void FocusBox(string field)
    {
        if (!_frames.TryGetValue(field, out var f)) return;
        var v = f.View;
        void Go() { try { v.Focus(FocusState.Programmatic); } catch { } }
        if (v.IsLoaded) DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, Go);
        else { RoutedEventHandler? once = null; once = (_, _) => { v.Loaded -= once; DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, Go); }; v.Loaded += once; }
    }

    /// <summary>A box left empty goes away (the web removes an empty box on leaving it); the core refuses one that holds anything.</summary>
    private void RemoveIfEmpty(string field)
    {
        if (PageId is null || !field.StartsWith("box:") || !_views.TryGetValue(field, out var v) || !v.IsEmptyBox) return;
        if (_dragging is not null) return;
        _source.DeleteBox(PageId, field["box:".Length..]);
    }

    private void WireFrame(BoxFrame f)
    {
        f.View.PageLinkOpened += id => PageOpened?.Invoke(id);
        f.View.TaskOpened = id => TaskOpened?.Invoke(id);
        // left empty: gone (after the event that left it is over)
        f.View.Left += () => DispatcherQueue.TryEnqueue(() => RemoveIfEmpty(f.Box?.Field ?? ""));
        if (!f.CanDrag) return;
        // the move bar and the width handle: drag, then send the geometry once at the end (and bring the box to the front)
        Point start = default; (double X, double Y, double W) orig = default; var moved = false;
        void Hook(UIElement el, bool resize)
        {
            el.PointerPressed += (_, e) =>
            {
                if (_surface is null || !e.GetCurrentPoint(el).Properties.IsLeftButtonPressed) return;
                BoxTextView.CloseLinkEditor();
                if (f.Box?.Field is { } sel) Select(sel);
                start = e.GetCurrentPoint(_surface).Position; orig = (f.X, f.Y, f.BoxWidth); moved = false;
                el.CapturePointer(e.Pointer); _dragging = f; e.Handled = true;
            };
            el.PointerMoved += (_, e) =>
            {
                if (!ReferenceEquals(_dragging, f) || _surface is null) return;
                var p = e.GetCurrentPoint(_surface).Position;
                var dx = p.X - start.X; var dy = p.Y - start.Y;
                if (Math.Abs(dx) + Math.Abs(dy) >= 1) moved = true;
                if (resize) f.SetGeometry(f.X, f.Y, Math.Min(Math.Max(orig.W + dx, 120), 2400));
                else f.SetGeometry(Math.Max(orig.X + dx, 0), Math.Max(orig.Y + dy, 0), f.BoxWidth);
                e.Handled = true;
            };
            void End(PointerRoutedEventArgs e)
            {
                if (!ReferenceEquals(_dragging, f)) return;
                _dragging = null;
                try { el.ReleasePointerCapture(e.Pointer); } catch { }
                if (PageId is null || f.Box?.Id is not { } id) return;
                if (moved)
                {
                    if (resize) _source.ResizeBox(PageId, id, Math.Round(f.BoxWidth)); else _source.MoveBox(PageId, id, Math.Round(f.X), Math.Round(f.Y));
                    _source.BringBoxToFront(PageId, id);
                }
            }
            el.PointerReleased += (_, e) => { End(e); e.Handled = true; };
            el.PointerCaptureLost += (_, _) => { if (ReferenceEquals(_dragging, f)) _dragging = null; };
        }
        f.Bar.RightTapped += (_, e) => { e.Handled = true; if (f.Box?.Field is { } sel) { Select(sel); ShowBoxMenu(e.GetPosition(null)); } };
        f.Handle.RightTapped += (_, e) => { e.Handled = true; if (f.Box?.Field is { } sel) { Select(sel); ShowBoxMenu(e.GetPosition(null)); } };
        Hook(f.Bar, false);
        Hook(f.Handle, true);
    }

    /// <summary>A box on the canvas with its chrome (LOOK 4.5.2): the host border (idle transparent; hover --border; editing opaque --bg with
    /// --border-strong), the move bar (12 high from 9 above the box, --bg-pressed) and the width handle (3 x 24 bar on the right edge, 9 wide hit strip).</summary>
    private sealed class BoxFrame : Grid
    {
        private readonly Func<string, Brush> _b;
        public readonly BoxTextView View;
        public readonly Grid Bar, Handle;
        private readonly Border _bar3;
        public CanvasBox? Box;
        public bool CanDrag { get; }
        public double X { get; private set; }
        public double Y { get; private set; }
        public double BoxWidth { get; private set; }
        private bool _hover, _editing, _selected;
        public bool Selected => _selected;
        public void SetSelected(bool on) { if (on == _selected) return; _selected = on; View.BoxSelected = on; Apply(); }

        private sealed class CursorBorder : Grid
        {
            public CursorBorder(Microsoft.UI.Input.InputSystemCursorShape shape) => ProtectedCursor = Microsoft.UI.Input.InputSystemCursor.Create(shape);
        }

        public BoxFrame(BoxTextView view, bool canDrag, Func<string, Brush> b)
        {
            View = view; _b = b; CanDrag = canDrag;
            RowDefinitions.Add(new RowDefinition { Height = new GridLength(9) });
            RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            HorizontalAlignment = HorizontalAlignment.Left; VerticalAlignment = VerticalAlignment.Top;
            var host = view.Host;
            host.HorizontalAlignment = HorizontalAlignment.Left;
            host.Background = new SolidColorBrush(Colors.Transparent);
            SetRow(host, 1);
            Children.Add(host);
            Bar = new CursorBorder(Microsoft.UI.Input.InputSystemCursorShape.SizeAll)
            {
                Height = 12, VerticalAlignment = VerticalAlignment.Top, HorizontalAlignment = HorizontalAlignment.Left,
                CornerRadius = new CornerRadius(6, 6, 0, 0), Visibility = Visibility.Collapsed,
            };
            SetRowSpan(Bar, 2);
            Handle = new CursorBorder(Microsoft.UI.Input.InputSystemCursorShape.SizeWestEast)
            {
                Width = 9, Height = 40, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center, Background = new SolidColorBrush(Colors.Transparent),
                Visibility = Visibility.Collapsed,
            };
            _bar3 = new Border { Width = 3, Height = 24, CornerRadius = new CornerRadius(2), HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(3, 0, 0, 0) };
            Handle.Children.Add(_bar3);
            SetRow(Handle, 1);
            if (canDrag) { Children.Add(Bar); Children.Add(Handle); }
            PointerEntered += (_, _) => { _hover = true; Apply(); };
            PointerExited += (_, _) => { _hover = false; Apply(); };
            // a press in the padding of the box (outside the text) puts the caret in it
            PointerPressed += (_, e) => { if (!e.Handled && e.GetCurrentPoint(this).Properties.IsLeftButtonPressed) { view.Focus(FocusState.Pointer); e.Handled = true; } };
            ActualThemeChanged += (_, _) => Apply();
            Apply();
        }

        public void SetEditing(bool on) { if (on == _editing) return; _editing = on; Apply(); }

        public void SetGeometry(double x, double y, double w)
        {
            X = x; Y = y; BoxWidth = w;
            Canvas.SetLeft(this, x);
            Canvas.SetTop(this, y - 9);
            Width = w + 4;
            View.Host.Width = w;
            Bar.Width = w;
            View.SetWidth(Math.Max(40, w - 22));
        }

        private void Apply()
        {
            var show = _hover || _editing || _selected;
            var host = View.Host;
            host.BorderBrush = _selected ? _b("Accent") : _editing ? _b("BorderStrong") : _hover ? _b("Border") : new SolidColorBrush(Colors.Transparent);
            host.Background = _editing ? _b("Bg") : new SolidColorBrush(Colors.Transparent);
            if (!CanDrag) return;
            Bar.Background = _b("BgPressed");
            _bar3.Background = _b("BorderStrong");
            Bar.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
            Handle.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        }
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
