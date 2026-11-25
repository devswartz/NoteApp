using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Notivelo.Windows.Text;
using Windows.Foundation;

namespace Notivelo.Windows.Views;

/// <summary>left4 on the page: the outline (the ribbon's Outline button and the bars at the right edge), pages that link here (the panel's Linked tab and its top bar button)
/// and the block handle with its menu (move up and down, duplicate, delete, turn into). Apple's Outline.swift, Backlinks.swift and block handle; the web's Outline.tsx.</summary>
internal sealed partial class PageView
{
    // ---- backlinks ----

    private bool _linksTab;
    private BacklinksModel? _links;
    private Border? _linksBadge;

    private BacklinksModel LinksFor(string pageId)
    {
        if (_links is null || _links.PageId != pageId)
        {
            _links = new BacklinksModel(_source, pageId);
            var m = _links;
            m.Changed += () => { if (ReferenceEquals(_links, m)) DrawLinksBadge(); };
            m.Reload();
        }
        return _links;
    }

    private void DrawLinksBadge()
    {
        if (_linksBadge is null) return;
        var n = _links is { Loaded: true } m ? m.Items.Count : 0;
        _linksBadge.Visibility = n > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (_linksBadge.Child is TextBlock t) t.Text = n.ToString();
    }

    /// <summary>The top bar's "Linked pages" button: opens the page panel on its Linked tab (a badge says how many pages link here).</summary>
    private UIElement LinksButton()
    {
        var btn = Ui.IconButton("link-2", 18, 32, 32, "Linked pages", 8);
        AutomationProperties.SetAutomationId(btn, "page-links-button");
        var open = _tasksOpen && _linksTab;
        AutomationProperties.SetItemStatus(btn, open ? "panel=open" : "panel=closed");
        if (open) btn.Background = B("AccentSoft");
        btn.Click += (_, _) =>
        {
            if (_tasksOpen && _linksTab) _tasksOpen = false;
            else { _comments?.Cancel(false); _tasksOpen = true; _commentsTab = false; _linksTab = true; }
            Rebuild();
        };
        if (PageId is { } id) LinksFor(id);
        var g = new Grid();
        g.Children.Add(btn);
        _linksBadge = new Border
        {
            Height = 16, MinWidth = 16, Padding = new Thickness(4, 0, 4, 0), CornerRadius = new CornerRadius(8), Background = B("AccentSolid"), HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 0, -2, 0), IsHitTestVisible = false, Visibility = Visibility.Collapsed,
            Child = Ui.Text("0", 10.5, B("TextOnAccent"), 600).With(t => t.HorizontalAlignment = HorizontalAlignment.Center),
        };
        g.Children.Add(_linksBadge);
        DrawLinksBadge();
        return g;
    }

    // ---- the outline ----

    private string _railSig = "";
    private Border? _railHost;

    /// <summary>The page's headings in reading order, from the boxes' editor sessions (a page with no session boxes: the headings of its drawn blocks).</summary>
    public IReadOnlyList<OutlineEntry> OutlineNow()
    {
        if (PageId is null || _source.GetPage(PageId) is not { } page) return Array.Empty<OutlineEntry>();
        var boxes = new List<(double X, double Y, IReadOnlyList<OutlineEntry> Items)>();
        var n = 0;
        foreach (var b in page.Boxes)
        {
            if (b.Field is { } f && _views.TryGetValue(f, out var v))
            {
                if (v.Current is { } r) boxes.Add((b.X, b.Y, OutlineRules.Of(f, r.View.Text, r.View.Lines)));
            }
            else
            {
                var key = "static:" + n;
                var items = b.Blocks.Where(k => k.Kind is BlockKind.Heading1 or BlockKind.Heading2 or BlockKind.Heading3 && k.Text.Trim().Length > 0)
                    .Select(k => new OutlineEntry(key, k.Kind == BlockKind.Heading1 ? 1 : k.Kind == BlockKind.Heading2 ? 2 : 3, k.Text.Trim(), -1)).ToList();
                boxes.Add((b.X, b.Y, items));
            }
            n++;
        }
        return OutlineRules.Page(boxes);
    }

    private (string? Field, int Caret) CaretNow()
    {
        var f = BoxTextView.Focused;
        if (f is null) return (null, 0);
        foreach (var kv in _views) if (ReferenceEquals(kv.Value, f)) return (kv.Key, f.Current is { } r ? (int)r.View.Selection.Head : 0);
        return (null, 0);
    }

    /// <summary>The bars at the right edge: a bar per heading with three headings or more (the one the caret is under in accent), a click opens "On this page"; with fewer
    /// the three quiet bars of the look reference.</summary>
    private FrameworkElement OutlineRail()
    {
        _railHost = new Border { HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 64, 12, 0) };
        _railSig = "";
        RefreshRail();
        return _railHost;
    }

    private void RefreshRail()
    {
        if (_railHost is null) return;
        var entries = OutlineNow();
        var (field, caret) = CaretNow();
        var active = OutlineRules.Active(entries, field, caret);
        var sig = string.Join("|", entries.Select(e => e.Level + e.Text)) + "#" + active;
        if (sig == _railSig) return;
        _railSig = sig;
        var stack = new StackPanel { Spacing = 10, HorizontalAlignment = HorizontalAlignment.Right };
        if (entries.Count < 3)
        {
            for (var i = 0; i < 3; i++) stack.Children.Add(new Border { Width = 16, Height = 2, Background = i == 0 ? B("Accent") : B("BorderStrong"), HorizontalAlignment = HorizontalAlignment.Right });
            stack.IsHitTestVisible = false;
            _railHost.Padding = new Thickness(8, 0, 0, 0);
            _railHost.Child = stack;
            return;
        }
        var bars = OutlineRules.Bars(entries, 14);
        foreach (var i in bars)
            stack.Children.Add(new Border { Width = 16, Height = 2, Background = i == Math.Max(0, active) ? B("Accent") : B("BorderStrong"), HorizontalAlignment = HorizontalAlignment.Right });
        var btn = new Button { Style = Ui.Style("GhostButtonStyle"), Padding = new Thickness(8, 8, 8, 8), CornerRadius = new CornerRadius(6), Content = stack, AllowFocusOnInteraction = false };
        AutomationProperties.SetAutomationId(btn, "page-outline-rail");
        AutomationProperties.SetName(btn, "On this page");
        AutomationProperties.SetItemStatus(btn, "headings=" + entries.Count);
        btn.Click += (_, _) => ShowOutline(btn, true);
        _railHost.Padding = new Thickness(0);
        _railHost.Child = btn;
    }

    /// <summary>"On this page": the headings as a menu under <paramref name="anchor"/> (the ribbon's Outline button, or the bars). A pick goes to the heading.</summary>
    public void ShowOutline(FrameworkElement anchor, bool endAlign = false)
    {
        if (Host is null) return;
        var entries = OutlineNow();
        var items = new List<MenuEntry>();
        if (entries.Count == 0) items.Add(new("No headings on this page", Id: "outline-empty"));
        else
        {
            items.Add(MenuEntry.Label("On this page"));
            var (field, caret) = CaretNow();
            var active = OutlineRules.Active(entries, field, caret);
            for (var i = 0; i < Math.Min(entries.Count, 16); i++)
            {
                var e = entries[i];
                items.Add(new(new string(' ', 3 * OutlineRules.Indent(entries, e)) + e.Text, null, () => JumpTo(e), Check: i == active, Hint: "H" + e.Level, Id: "outline-item-" + i));
            }
            if (entries.Count > 16) items.Add(new("and " + (entries.Count - 16) + " more", Id: "outline-more"));
        }
        PopupMenu.Show(Host.Overlay, items, anchor, endAlign: endAlign, id: "menu-outline", width: 300);
    }

    /// <summary>Go to a heading: the caret into it (a box with an editor session) and the page scrolled to it.</summary>
    public void JumpTo(OutlineEntry e)
    {
        if (_scroll?.Content is not UIElement content) return;
        if (e.Offset >= 0 && _views.TryGetValue(e.Field, out var v))
        {
            v.Focus(FocusState.Programmatic);
            v.SetSelection(e.Offset, e.Offset);
            if (v.LineBand(v.CaretLineIndex) is { } band)
            {
                var y = v.TransformToVisual(content).TransformPoint(new Point(0, band.Top)).Y;
                _scroll.ChangeView(null, Math.Max(0, y - 96), null);
            }
            return;
        }
        // a box without an editor session (drawn blocks): scroll to the box
        if (e.Field.StartsWith("static:") && int.TryParse(e.Field[7..], out var idx) && PageId is { } id && _source.GetPage(id) is { } page && idx < page.Boxes.Count && _surface is not null)
        {
            var y = _surface.TransformToVisual(content).TransformPoint(new Point(0, page.Boxes[idx].Y)).Y;
            _scroll.ChangeView(null, Math.Max(0, y - 96), null);
        }
    }

    // ---- the block handle ----

    private Button? _handle;
    private BoxFrame? _hoverFrame;
    private int _hoverLine = -1;
    private bool _overHandle;
    private readonly global::Microsoft.UI.Xaml.DispatcherTimer _hoverTimer = MakeHoverTimer();
    private static global::Microsoft.UI.Xaml.DispatcherTimer MakeHoverTimer() => new() { Interval = TimeSpan.FromMilliseconds(450) };
    private bool _hoverTimerWired;

    /// <summary>The handle: a grip at the left of the block the caret (or the pointer) is on; a click opens the block menu. It never takes the keyboard from the box.</summary>
    private UIElement NewHandle()
    {
        var b = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Width = 22, Height = 26, Padding = new Thickness(0), CornerRadius = new CornerRadius(6), Visibility = Visibility.Collapsed,
            Content = new Icon("grip-vertical", 15, B("TextMuted")), AllowFocusOnInteraction = false, IsTabStop = false,
        };
        AutomationProperties.SetAutomationId(b, "block-handle");
        AutomationProperties.SetName(b, "Block options");
        ToolTipService.SetToolTip(b, "Block options (Ctrl+Shift+M)");
        Canvas.SetZIndex(b, 10000);
        b.PointerPressed += (_, e) => e.Handled = true;   // the page behind it would otherwise make a box
        b.PointerEntered += (_, _) => { _overHandle = true; _hoverTimer.Stop(); };
        b.PointerExited += (_, _) => { _overHandle = false; _hoverTimer.Start(); };
        b.Click += (_, _) => { if (HandleTarget() is { } t) ShowBlockMenu(t.Frame.View, t.Line, b); };
        _handle = b;
        if (!_hoverTimerWired)
        {
            _hoverTimerWired = true;
            _hoverTimer.Tick += (_, _) => { _hoverTimer.Stop(); if (_overHandle) return; _hoverFrame = null; _hoverLine = -1; PlaceHandle(); };
        }
        return b;
    }

    private void WireHandle(BoxFrame f)
    {
        f.AddHandler(UIElement.PointerMovedEvent, new PointerEventHandler((_, e) =>
        {
            if (!f.CanDrag) return;
            var p = e.GetCurrentPoint(f.View).Position;
            _hoverTimer.Stop();
            var line = f.View.LineAtY(p.Y);
            if (ReferenceEquals(_hoverFrame, f) && _hoverLine == line) return;
            _hoverFrame = f; _hoverLine = line;
            PlaceHandle();
        }), true);
        f.PointerExited += (_, _) => { if (ReferenceEquals(_hoverFrame, f)) _hoverTimer.Start(); };
    }

    /// <summary>The box and line the handle is for: the one under the pointer, else the focused box's caret line.</summary>
    private (BoxFrame Frame, int Line)? HandleTarget()
    {
        BoxFrame? focused = null;
        if (BoxTextView.Focused is { } f)
            foreach (var fr in _frames.Values)
                if (ReferenceEquals(fr.View, f) && fr.CanDrag) focused = fr;
        // the box being edited keeps the handle on the caret's block (a pointer resting over it would otherwise pull it); the pointer moves it between other boxes' blocks
        if (_hoverFrame is { } h && _hoverLine >= 0 && h.View.IsLoaded && _frames.ContainsValue(h) && !ReferenceEquals(h, focused)) return (h, _hoverLine);
        if (focused is not null) return (focused, focused.View.CaretLineIndex);
        return null;
    }

    private void PlaceHandle()
    {
        if (_handle is null || _surface is null) return;
        if (HandleTarget() is not { } t || t.Line < 0 || t.Frame.View.LineBand(t.Line) is not { } band || !t.Frame.View.IsLoaded) { _handle.Visibility = Visibility.Collapsed; return; }
        try
        {
            var p = t.Frame.View.TransformToVisual(_surface).TransformPoint(new Point(0, band.Top));
            Canvas.SetLeft(_handle, Math.Max(0, t.Frame.X - 26));
            Canvas.SetTop(_handle, p.Y + Math.Max(0, (Math.Min(band.Height, 40) - 26) / 2));
            _handle.Visibility = Visibility.Visible;
        }
        catch (Exception) { _handle.Visibility = Visibility.Collapsed; }
    }

    private void OnBlockMenu(BoxTextView view, int line)
    {
        if (view.IsLoaded && _views.ContainsValue(view)) ShowBlockMenu(view, line, null);
    }

    /// <summary>The block menu: Move up, Move down, Duplicate, Delete, and Turn into (the same kinds as the ribbon's Text style). The keyboard way in is Ctrl+Shift+M in a box;
    /// Alt+Shift+Up and Down move the block without the menu.</summary>
    private void ShowBlockMenu(BoxTextView view, int line, FrameworkElement? anchor)
    {
        if (Host is null || line < 0) return;
        var can = view.BlockCan(line);
        if (!can.Any) return;
        var items = new List<MenuEntry>();
        void After(bool ok, string? said = null) { view.Focus(FocusState.Programmatic); if (!ok && said is not null) Host?.Toast(said, true); PlaceHandle(); }
        if (can.Up) items.Add(new("Move up", "arrow-up", () => After(view.BlockMove(line, true), "That block can't move up"), Hint: "Alt+Shift+↑", Id: "block-menu-up"));
        if (can.Down) items.Add(new("Move down", "arrow-down", () => After(view.BlockMove(line, false), "That block can't move down"), Hint: "Alt+Shift+↓", Id: "block-menu-down"));
        if (can.Duplicate) items.Add(new("Duplicate", "copy", () => After(view.BlockDuplicate(line), "That block can't be duplicated"), Id: "block-menu-duplicate"));
        items.Add(new("Delete", "trash", () => After(view.BlockDelete(line), "That block can't be deleted"), Danger: true, Id: "block-menu-delete"));
        items.Add(MenuEntry.Sep());
        items.Add(MenuEntry.Label("Turn into"));
        foreach (var (label, cmd, args) in BlockOps.TurnInto)
        {
            var (l, c, a) = (label, cmd, args);
            var icon = label switch { "Heading 1" => "heading-1", "Heading 2" => "heading-2", "Heading 3" => "heading-3", "Bulleted list" => "list", "Numbered list" => "list-ordered", "Quote" => "quote", "Code block" => "code", _ => "pilcrow" };
            items.Add(new(label, icon, () => After(view.BlockTurn(line, c, a), "Couldn't turn that block into " + l.ToLowerInvariant()), Id: "block-turn-" + PopupMenu.Slug(label)));
        }
        if (anchor is not null) PopupMenu.Show(Host.Overlay, items, anchor, id: "menu-block", width: 240);
        else
        {
            var band = view.LineBand(line);
            var tl = view.TransformToVisual(null).TransformPoint(new Point(0, (band?.Top ?? 0) + (band?.Height ?? 24)));
            PopupMenu.Show(Host.Overlay, items, null, at: new Point(tl.X, tl.Y + 4), id: "menu-block", width: 240);
        }
    }
}
