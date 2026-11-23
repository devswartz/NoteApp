using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Notivelo.Windows.Text;
using N = Notivelo.Native;

namespace Notivelo.Windows.Controls;

/// <summary>Links in a box: Ctrl+K opens the link editor (Text, Address; LOOK 4.6 Link, Apple's MacLinkEditor) that applies through the
/// engine's <c>editLink</c> command; Ctrl+click (or a click in a box that is not being edited) opens a link; a page link atom opens its page.</summary>
internal sealed partial class BoxTextView
{
    /// <summary>A page link in the text was clicked: the shell shows that page.</summary>
    public event Action<string>? PageLinkOpened;

    private Popup? _linkPopup;
    private TextBox? _linkText, _linkAddress;
    private static BoxTextView? _linkOwner;

    /// <summary>The link editor is open (for the tests' readout and to close it from the page).</summary>
    public bool LinkEditorOpen => _linkPopup is { IsOpen: true };

    /// <summary>Some box has its link editor open.</summary>
    public static bool AnyLinkEditorOpen => _linkOwner?.LinkEditorOpen == true;

    /// <summary>The box holds nothing but an empty line (what the page removes on leaving it; the core refuses a box with anything in it).</summary>
    public bool IsEmptyBox => _r is { } r && r.View.Lines.Length <= 1 && r.View.Text.Trim().Length == 0 && !r.View.Text.Contains('￼');

    /// <summary>Close the link editor of whichever box has it open (a click on the page).</summary>
    public static void CloseLinkEditor() => _linkOwner?.HideLinkEditor(false);

    /// <summary>The address of the link at a view offset, if the character there is linked.</summary>
    private string? HrefAt(int offset)
    {
        if (_r is not { } r || r.View.Lines.Length == 0) return null;
        var li = RunMap.LineAt(r.View.Lines, offset);
        if (li < 0) return null;
        var line = r.View.Lines[li];
        var col = offset - (int)line.Offset;
        foreach (var run in RunMap.Resolve(line))
            if (col >= run.Start && col < run.End) return run.Style.Href;
        return null;
    }

    /// <summary>The linked stretch (view offsets) around an offset, over the line's runs with the same address.</summary>
    private (int From, int To)? LinkSpanAt(int offset, string href)
    {
        if (_r is not { } r) return null;
        var li = RunMap.LineAt(r.View.Lines, offset);
        if (li < 0) return null;
        var line = r.View.Lines[li];
        var from = -1; var to = -1;
        foreach (var run in RunMap.Resolve(line))
        {
            if (run.Style.Href != href) { if (from >= 0 && to >= (int)line.Offset + run.Start) break; continue; }
            if (from < 0) from = (int)line.Offset + run.Start;
            to = (int)line.Offset + run.End;
        }
        return from < 0 ? null : (from, to);
    }

    /// <summary>Show the link editor under the selection (Ctrl+K): prefilled when the selection is in a link, the address first.</summary>
    public void ShowLinkEditor()
    {
        if (_r is not { } r || _composing) return;
        try
        {
            HideMenu();
            var text = r.View.Text;
            var from = SelFrom(r.View); var to = SelTo(r.View);
            var href = "";
            if (from == to)
            {
                var h = HrefAt(from - 1) ?? HrefAt(from);
                if (h is not null && (LinkSpanAt(HrefAt(from - 1) is not null ? from - 1 : from, h) is { } span))
                {
                    href = h; from = span.From; to = span.To;
                    _session.SetViewSelection((uint)from, (uint)to);
                    Render();
                }
            }
            else href = HrefAt(from) ?? "";
            var shown = to > from && to <= text.Length ? text[from..to].Replace("\n", " ") : "";
            var rects = to > from ? RectsForRange(from, to) : new List<Rect>();
            var anchor = rects.Count > 0 ? rects[^1] : CaretRect(from) ?? new Rect(0, 0, 0, 27);
            OpenLinkEditor(shown, href, anchor);
        }
        catch (Exception e) { Log("link editor", e); }
    }

    private void OpenLinkEditor(string text, string href, Rect anchor)
    {
        var hasLink = href.Length > 0;
        TextBox Field(string prompt, string value, string id)
        {
            var t = new TextBox
            {
                Text = value, PlaceholderText = prompt, FontSize = 14, FontFamily = Ui.Font, Height = 34, MinHeight = 34, Padding = new Thickness(10, 6, 10, 6),
                CornerRadius = new CornerRadius(8), Background = C2("Bg"), Foreground = C2("Text"), BorderBrush = C2("Border"), BorderThickness = new Thickness(1),
                VerticalContentAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Stretch,
            };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(t, id);
            // the focused field: accent border (the 3 pt soft ring is the template's)
            t.GotFocus += (_, _) => t.BorderBrush = C2("Accent");
            t.LostFocus += (_, _) => t.BorderBrush = C2("Border");
            t.KeyDown += (_, e) =>
            {
                if (e.Key == global::Windows.System.VirtualKey.Enter) { e.Handled = true; ApplyLink(); }
                else if (e.Key == global::Windows.System.VirtualKey.Escape) { e.Handled = true; HideLinkEditor(true); }
            };
            return t;
        }
        TextBlock Label(string s) => new() { Text = s, FontSize = 12, FontFamily = Ui.Font, Foreground = C2("Text"), Opacity = 0.7, Width = 56, VerticalAlignment = VerticalAlignment.Center };

        _linkText = Field("Text to display", text, "link-text");
        _linkAddress = Field("Paste or type a link…", href, "link-address");
        var grid = new Grid { RowSpacing = 4, ColumnSpacing = 4, Width = 348 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var l1 = Label("Text"); var l2 = Label("Address");
        Grid.SetRow(l2, 1);
        Grid.SetColumn(_linkText, 1); Grid.SetColumnSpan(_linkText, 3);
        Grid.SetRow(_linkAddress, 1); Grid.SetColumn(_linkAddress, 1);
        if (!hasLink) Grid.SetColumnSpan(_linkAddress, 3);
        grid.Children.Add(l1); grid.Children.Add(_linkText); grid.Children.Add(l2); grid.Children.Add(_linkAddress);
        if (hasLink)
        {
            var open = Ui.IconButton("external-link", 15, 32, 32, "Open link", 6);
            open.Click += (_, _) => OpenAddress(_linkAddress.Text);
            var remove = Ui.IconButton("link-2-off", 15, 32, 32, "Remove link", 6);
            remove.Click += (_, _) => RemoveLink();
            Grid.SetRow(open, 1); Grid.SetColumn(open, 2); Grid.SetRow(remove, 1); Grid.SetColumn(remove, 3);
            grid.Children.Add(open); grid.Children.Add(remove);
        }
        var card = new Border
        {
            Padding = new Thickness(6), CornerRadius = new CornerRadius(12), Background = C2("BgElevated"), BorderBrush = C2("Border"), BorderThickness = new Thickness(1), Child = grid,
        };
        card.Tag = "link-editor";
        try { card.Shadow = new ThemeShadow(); card.Translation = new System.Numerics.Vector3(0, 0, 24); } catch { }
        card.Measure(new Size(400, 200));
        var h = card.DesiredSize.Height;
        var below = anchor.Bottom + 8;
        var winY = TransformToVisual(null).TransformPoint(new Point(0, below)).Y;
        var room = (XamlRoot?.Size.Height ?? 800) - winY;
        var top = room >= h + 8 ? below : anchor.Y - 8 - h;
        var winX = TransformToVisual(null).TransformPoint(new Point(0, 0)).X;
        var left = Math.Max(-winX + 8, Math.Min(anchor.X, (XamlRoot?.Size.Width ?? 1000) - 372 - winX));
        if (_linkPopup is null)
        {
            _linkPopup = new Popup { IsLightDismissEnabled = false, IsTabStop = false };
            _root.Children.Add(_linkPopup);
        }
        _linkPopup.XamlRoot = XamlRoot;
        _linkPopup.Child = card;
        _linkPopup.HorizontalOffset = left;
        _linkPopup.VerticalOffset = top;
        _linkPopup.IsOpen = true;
        _linkOwner = this;
        var first = hasLink || text.Length > 0 ? _linkAddress : _linkText;
        DispatcherQueue.TryEnqueue(() => { first.Focus(FocusState.Programmatic); first.SelectAll(); });
        FocusedStateChanged?.Invoke();
    }

    private void HideLinkEditor(bool refocus)
    {
        if (_linkPopup is { IsOpen: true }) _linkPopup.IsOpen = false;
        if (ReferenceEquals(_linkOwner, this)) _linkOwner = null;
        if (refocus) Focus(FocusState.Programmatic);
    }

    private void ApplyLink()
    {
        var text = _linkText?.Text ?? ""; var href = (_linkAddress?.Text ?? "").Trim();
        HideLinkEditor(false);
        Focus(FocusState.Programmatic);
        if (href.Length == 0 && text.Length == 0) return;
        RunCommand("editLink", System.Text.Json.JsonSerializer.Serialize(new { text, href }));
    }

    private void RemoveLink()
    {
        HideLinkEditor(false);
        Focus(FocusState.Programmatic);
        RunCommand("unsetLink");
    }

    /// <summary>Only http, https and mailto addresses open (as the web's read-only text does); a bare "example.com" is taken as https.</summary>
    internal static Uri? Openable(string href)
    {
        var t = href.Trim();
        if (t.Length == 0) return null;
        if (!t.Contains(':') && t.Contains('.') && !t.Contains(' ')) t = "https://" + t;
        return Uri.TryCreate(t, UriKind.Absolute, out var u) && u.Scheme is "http" or "https" or "mailto" ? u : null;
    }

    private static async void OpenAddress(string href)
    {
        if (Openable(href) is { } u) { try { await global::Windows.System.Launcher.LaunchUriAsync(u); } catch { } }
    }

    /// <summary>A click on a page link atom or a linked word: opens it (a page link always; an address with Ctrl, or when the box was not being edited). True when handled.</summary>
    private bool TryOpenAt(Point p, int offset, bool ctrl, bool wasFocused)
    {
        if (_r is not { } r) return false;
        // a page link atom: the page it names (the click is on the atom's chip)
        var li = RunMap.LineAt(r.View.Lines, offset);
        if (li >= 0 && li < _boxes.Count)
            foreach (var a in _boxes[li].Atoms)
                if (a.Kind == "pageLink" && !a.Missing && new Rect(_boxes[li].X + a.Rect.X, _boxes[li].Y + a.Rect.Y, a.Rect.Width, a.Rect.Height).Contains(p))
                {
                    if (a.PageId is { Length: > 0 } pid) { PageLinkOpened?.Invoke(pid); return true; }
                }
        if (!ctrl && wasFocused) return false;
        var href = HrefAt(offset);
        if (href is null || !LinkHit(p, offset)) return false;
        if (Openable(href) is null) return false;
        OpenAddress(href);
        return true;
    }

    /// <summary>The pointer is on the linked text itself (not on the blank after the line's end).</summary>
    private bool LinkHit(Point p, int offset)
    {
        foreach (var rc in RectsForRange(offset, Math.Min(offset + 1, _r?.View.Text.Length ?? 0)))
            if (p.X >= rc.X - 1 && p.X <= rc.Right + 1 && p.Y >= rc.Y && p.Y <= rc.Bottom) return true;
        return false;
    }
}
