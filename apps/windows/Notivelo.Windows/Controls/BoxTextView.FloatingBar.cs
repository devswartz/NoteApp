using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Notivelo.Windows.Text;
using N = Notivelo.Native;

namespace Notivelo.Windows.Controls;

/// <summary>The floating format bar over a text selection (LOOK 4.6; Apple's FloatingToolbar): Heading 1-3 and Quote, Bold, Italic, Underline,
/// Strikethrough, Code and Link, then Task. Padding 3, gap 1, --bg-elevated, 1 pt border, radius 10, buttons 30 x 30. The buttons run the ribbon's engine
/// commands and never take the keyboard from the box. Text colour, Highlight and Comment are not here (colour menus and comments come with the ribbon's).</summary>
internal sealed partial class BoxTextView
{
    private Popup? _bar;
    private string _barSig = "";

    private void HideFloatingBar()
    {
        if (_bar is { IsOpen: true }) _bar.IsOpen = false;
        _barSig = "";
    }

    /// <summary>Show, move or close the bar after a render: only for a range selection in the focused box (not while dragging, composing, or a menu or the link editor is open).</summary>
    private void UpdateFloatingBar()
    {
        if (_r is not { } r || !_focused || _dragging || _composing || r.View.Marked is not null || r.Suggestion is not null || LinkEditorOpen || XamlRoot is null)
        { HideFloatingBar(); return; }
        var from = SelFrom(r.View); var to = SelTo(r.View);
        if (to <= from) { HideFloatingBar(); return; }
        var act = r.Active;
        var sig = $"{from}-{to}|{act.Block}{act.HeadingLevel}{act.InQuote}|{string.Join(",", act.Marks.Select(m => (int)m.Kind))}|{ActualTheme}";
        if (sig == _barSig && _bar is { IsOpen: true }) return;
        _barSig = sig;
        var rects = RectsForRange(from, to);
        if (rects.Count == 0) { HideFloatingBar(); return; }
        var bar = BuildFloatingBar(act);
        bar.Measure(new Size(2000, 200));
        var size = bar.DesiredSize;
        var first = rects[0]; var last = rects[^1];
        var origin = TransformToVisual(null).TransformPoint(new Point(0, 0));
        var winW = XamlRoot.Size.Width; var winH = XamlRoot.Size.Height;
        // above the first line of the selection, or under the last one when there's no room above; kept 8 pt inside the window
        var topWin = origin.Y + first.Y - 8 - size.Height;
        var top = topWin >= 8 ? first.Y - 8 - size.Height : last.Bottom + 8;
        if (origin.Y + top + size.Height > winH - 8) top = winH - 8 - size.Height - origin.Y;
        var left = Math.Max(8 - origin.X, Math.Min(first.X, winW - size.Width - 8 - origin.X));
        if (_bar is null)
        {
            _bar = new Popup { IsLightDismissEnabled = false, IsTabStop = false };
            _root.Children.Add(_bar);
        }
        _bar.XamlRoot = XamlRoot;
        _bar.Child = bar;
        _bar.HorizontalOffset = left;
        _bar.VerticalOffset = top;
        _bar.IsOpen = true;
    }

    private Border BuildFloatingBar(N.ViewActive act)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 1 };
        bool Has(N.ViewMarkKind k) => act.Marks.Any(m => m.Kind == k);
        void Button(string icon, string label, string command, string args, bool pressed)
        {
            var b = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), Width = 30, Height = 30, Padding = new Thickness(0), CornerRadius = new CornerRadius(6),
                Content = new Icon(icon, 16, C2(pressed ? "Accent" : "TextMuted")), Background = pressed ? C2("BgActive") : null,
                AllowFocusOnInteraction = false, IsTabStop = false,
            };
            ToolTipService.SetToolTip(b, label);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(b, "float-" + PopupMenu.Slug(label));
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(b, label);
            b.Click += (_, _) => { RunCommand(command, args); Focus(FocusState.Programmatic); };
            row.Children.Add(b);
        }
        void Separator() => row.Children.Add(new Border { Width = 1, Height = 18, Margin = new Thickness(3, 0, 3, 0), Background = C2("Border"), VerticalAlignment = VerticalAlignment.Center });
        bool Heading(int level) => act.Block == "heading" && act.HeadingLevel == level;
        Button("heading-1", "Heading 1", "setHeading", "{\"level\":1}", Heading(1));
        Button("heading-2", "Heading 2", "setHeading", "{\"level\":2}", Heading(2));
        Button("heading-3", "Heading 3", "setHeading", "{\"level\":3}", Heading(3));
        Button("quote", "Quote", "toggleQuote", "{}", act.InQuote);
        Separator();
        Button("letter-b", "Bold", "toggleMark", "{\"mark\":\"bold\"}", Has(N.ViewMarkKind.Bold));
        Button("italic", "Italic", "toggleMark", "{\"mark\":\"italic\"}", Has(N.ViewMarkKind.Italic));
        Button("underline", "Underline", "toggleMark", "{\"mark\":\"underline\"}", Has(N.ViewMarkKind.Underline));
        Button("strikethrough", "Strikethrough", "toggleMark", "{\"mark\":\"strike\"}", Has(N.ViewMarkKind.Strike));
        Button("code-xml", "Code", "toggleMark", "{\"mark\":\"code\"}", Has(N.ViewMarkKind.Code));
        var link = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Width = 30, Height = 30, Padding = new Thickness(0), CornerRadius = new CornerRadius(6),
            Content = new Icon("link-2", 16, C2(Has(N.ViewMarkKind.Link) ? "Accent" : "TextMuted")), AllowFocusOnInteraction = false, IsTabStop = false,
        };
        ToolTipService.SetToolTip(link, "Link");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(link, "float-link");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(link, "Link");
        link.Click += (_, _) => ShowLinkEditor();
        row.Children.Add(link);
        Separator();
        var task = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 30, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6), AllowFocusOnInteraction = false, IsTabStop = false,
            Content = new StackPanel
            {
                Orientation = Orientation.Horizontal, Spacing = 4,
                Children = { new Icon("circle-check", 16, C2("TextMuted")), Ui.Text("Task", 13, C2("TextMuted"), 500) },
            },
        };
        ToolTipService.SetToolTip(task, "Turn into a task");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(task, "float-task");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(task, "Task");
        task.Click += (_, _) => { RunCommand("convertToTask"); Focus(FocusState.Programmatic); };
        row.Children.Add(task);
        var card = new Border
        {
            Padding = new Thickness(3), CornerRadius = new CornerRadius(10), Background = C2("BgElevated"), BorderBrush = C2("Border"), BorderThickness = new Thickness(1), Child = row,
        };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(row, "floating-toolbar");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(row, "Formatting");
        try { card.Shadow = new ThemeShadow(); card.Translation = new System.Numerics.Vector3(0, 0, 24); } catch { }
        return card;
    }
}
