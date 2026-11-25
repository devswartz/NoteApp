using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Notivelo.Windows.Text;

namespace Notivelo.Windows.Views;

// The left2 batch on the page: the template strip on an empty page (and "Started from … Start blank" after a template went on), and who else is on the page
// (the avatar stack in the page bar and its "On this page now" list). Both are drawn in place by Refresh, never by a rebuild of the page.
internal sealed partial class PageView
{
    // ---- who is on the page ----

    private StackPanel? _presence;
    private string _presenceKey = "";

    private UIElement PresenceHost()
    {
        _presence = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        _presenceKey = "";
        DrawPresence();
        return _presence;
    }

    private IReadOnlyList<PagePerson> People => PageId is null ? Array.Empty<PagePerson>() : _source.PagePeople(PageId);

    private void DrawPresence()
    {
        if (_presence is not { } host) return;
        var people = People;
        var key = string.Join("|", people.Select(p => p.Id + p.Name + p.Color + p.CanEdit + p.Sessions));
        if (key == _presenceKey) return;
        _presenceKey = key;
        host.Children.Clear();
        if (people.Count == 0) return;
        const int max = 4;
        var shown = PresenceRules.Shown(people.Count, max);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = -6, Padding = new Thickness(2, 0, 2, 0) };
        for (var i = 0; i < shown; i++)
        {
            var av = Ui.Avatar(Notivelo.Windows.Data.AccountRules.Initials(people[i].Name, ""), 24, people[i].Color);
            av.BorderBrush = B("Bg"); av.BorderThickness = new Thickness(2);
            row.Children.Add(av);
        }
        var extra = people.Count - shown;
        row.Children.Add(new Border
        {
            Width = 24, Height = 24, CornerRadius = new CornerRadius(12), Background = B("BgSubtle"), BorderBrush = B("Bg"), BorderThickness = new Thickness(2),
            Child = Ui.Text(extra > 0 ? "+" + extra : people.Count.ToString(), 10, B("Text2"), 600).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; t.VerticalAlignment = VerticalAlignment.Center; }),
        });
        var btn = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 32, Padding = new Thickness(4, 0, 4, 0), CornerRadius = new CornerRadius(8), Content = row, Margin = new Thickness(0, 0, 6, 0) };
        var label = PresenceRules.Label(people);
        AutomationProperties.SetAutomationId(btn, "page-presence");
        AutomationProperties.SetName(btn, label);
        AutomationProperties.SetItemStatus(btn, "people=" + people.Count);
        ToolTipService.SetToolTip(btn, label);
        btn.Click += (_, _) => ShowPeople(btn);
        host.Children.Add(btn);
    }

    /// <summary>"On this page now": each person, and whether they are editing or viewing.</summary>
    private void ShowPeople(FrameworkElement anchor)
    {
        if (Host is null) return;
        var items = new List<MenuEntry> { MenuEntry.Label("On this page now") };
        foreach (var p in People)
            items.Add(new MenuEntry(p.Name, TileColor: p.Color, Hint: PresenceRules.Role(p), Id: "presence-" + PopupMenu.Slug(p.Name)));
        PopupMenu.Show(Host.Overlay, items, anchor, endAlign: true, id: "menu-presence", width: 290);
    }

    // ---- templates on an empty page ----

    private Border? _strip;
    private string _stripKey = "";
    private (string PageId, TemplateApplied Applied)? _applied;
    private readonly HashSet<string> _stripDismissed = new();

    /// <summary>Where the strip sits in the article; it is always there, shown or not, so Refresh can show it in place.</summary>
    private Border TemplateStrip(NotePage page)
    {
        _strip = new Border
        {
            Margin = new Thickness(51, 0, 0, 18), HorizontalAlignment = HorizontalAlignment.Left, Visibility = Visibility.Collapsed,
            Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(12, 8, 12, 8),
        };
        _stripKey = "";
        UpdateStrip(page);
        return _strip;
    }

    private bool StripWanted(NotePage page)
    {
        if (Host is null || PageId is null || page.State != PageState.Live || page.Locked || !page.CanEdit) return false;
        if (_applied is { } a && a.PageId == PageId) return true;
        return !_stripDismissed.Contains(PageId) && TemplateRules.PageIsBlank(page.Boxes, _source.InkOf(PageId).Count);
    }

    private void UpdateStrip(NotePage page)
    {
        if (_strip is not { } strip) return;
        var want = StripWanted(page);
        var key = want ? (_applied is { } a && a.PageId == PageId ? "applied:" + a.Applied.Name : "pick") : "";
        if (key == _stripKey) return;
        _stripKey = key;
        strip.Visibility = want ? Visibility.Visible : Visibility.Collapsed;
        strip.Child = want ? (key.StartsWith("applied:") ? AppliedContent() : PickContent()) : null;
    }

    private UIElement AppliedContent()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, VerticalAlignment = VerticalAlignment.Center };
        var applied = _applied!.Value.Applied;
        row.Children.Add(new Icon("layout-template", 15, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        row.Children.Add(Ui.Text("Started from " + applied.Name, 13, B("Text2")).With(t => t.VerticalAlignment = VerticalAlignment.Center));
        var blank = Chip("Start blank", "page-start-blank");
        blank.Click += async (_, _) =>
        {
            blank.IsEnabled = false;
            var err = applied.StartBlank is null ? null : await applied.StartBlank();
            if (err is not null) { blank.IsEnabled = true; Host?.Toast(err, true); return; }
            _applied = null; if (PageId is not null) _stripDismissed.Remove(PageId);
            _stripKey = "x";
            if (PageId is not null && _source.GetPage(PageId) is { } p) UpdateStrip(p);
            Refresh();
        };
        row.Children.Add(blank);
        var ok = Chip("Keep it", "template-strip-keep");
        ok.Click += (_, _) => { _applied = null; if (PageId is not null) { _stripDismissed.Add(PageId); if (_source.GetPage(PageId) is { } p) UpdateStrip(p); } };
        row.Children.Add(ok);
        return row;
    }

    private UIElement PickContent()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(Ui.Text("Start with a template", 13, B("Text2"), 500).With(t => t.VerticalAlignment = VerticalAlignment.Center));
        foreach (var t in TemplateRules.Builtins)
        {
            var item = t;
            var chip = Chip(t.Icon + "  " + t.Name, "empty-template-" + PopupMenu.Slug(t.Name));
            chip.Click += async (_, _) =>
            {
                if (PageId is not { } pid) return;
                chip.IsEnabled = false;
                var a = await _source.ApplyTemplate(pid, item);
                chip.IsEnabled = true;
                if (!a.Ok) { Host?.Toast(a.Error ?? "Couldn't use the template.", true); return; }
                NoteTemplateApplied(pid, a);
            };
            row.Children.Add(chip);
        }
        var more = Chip("More…", "empty-template-more");
        more.Click += (_, _) => OpenTemplates();
        row.Children.Add(more);
        var blank = Chip("Start blank", "template-strip-blank");
        blank.Click += (_, _) =>
        {
            if (PageId is not { } pid) return;
            _stripDismissed.Add(pid);
            if (_source.GetPage(pid) is { } p) UpdateStrip(p);
        };
        row.Children.Add(blank);
        return row;
    }

    private Button Chip(string text, string id)
    {
        var b = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(14),
            Background = B("Bg"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), Content = Ui.Text(text, 12.5, B("Text"), 500),
        };
        AutomationProperties.SetAutomationId(b, id);
        AutomationProperties.SetName(b, text);
        return b;
    }

    /// <summary>A template went onto this page: say so, with "Start blank" to take it back.</summary>
    public void NoteTemplateApplied(string pageId, TemplateApplied applied)
    {
        _applied = (pageId, applied);
        _stripKey = "";
        if (pageId == PageId && _source.GetPage(pageId) is { } p) UpdateStrip(p);
    }

    /// <summary>The ribbon's Templates button and the page menu: the picker for the open page.</summary>
    public void OpenTemplates()
    {
        if (PageId is not { } pid || Host is null) return;
        var section = Host.Tree.SectionOfPage(pid);
        if (section is null) { Host.Toast("This page isn't in a section.", true); return; }
        var name = _source.GetPage(pid)?.SectionPath.LastOrDefault() ?? "this section";
        TemplatePicker.ShowForPage(Host, pid, section, name);
    }
}
