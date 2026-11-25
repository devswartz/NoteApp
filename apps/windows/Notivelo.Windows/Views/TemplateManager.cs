using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Notivelo.Windows.Text;

namespace Notivelo.Windows.Views;

/// <summary>The saved templates of the workspace (rename, delete, where each is offered) and a section's default template (Apple's TemplatesModel and DefaultTemplateCard).
/// Built-in templates are the app's own: they can't be renamed, deleted or made a default (the core stores only saved ones).</summary>
internal static class TemplateManager
{
    /// <summary>"Manage templates…": every saved template with Rename, Delete and a button that cycles where it is offered relative to <paramref name="sectionId"/>.</summary>
    public static async void Manage(ShellHost host, string sectionId, string sectionName)
    {
        var O = host.Overlay;
        Brush B(string k) => ThemeBrushes.Get(k, O);
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(Ui.Text("Templates", 16, B("Text"), 650));
        panel.Children.Add(Ui.Text("Saved in this workspace. Offered here: " + sectionName, 12.5, B("TextMuted")));
        var list = new StackPanel { Spacing = 2 };
        var error = Ui.Text("", 12.5, B("Danger"));
        error.TextWrapping = TextWrapping.Wrap; error.TextTrimming = TextTrimming.None; error.Visibility = Visibility.Collapsed;
        panel.Children.Add(new ScrollViewer { MaxHeight = 380, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        panel.Children.Add(error);
        var close = Dialogs.Btn(O, "Done", true, id: "templates-done");
        panel.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 4, 0, 0), Children = { close } });
        var layer = O.Show(Dialogs.Card(O, 520, panel), HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, 100, 0, 0));
        close.Click += (_, _) => layer.Close();

        void Fail(string? e) { error.Text = e ?? ""; error.Visibility = e is null ? Visibility.Collapsed : Visibility.Visible; }
        async Task Reload()
        {
            var r = await host.Source.LoadSavedTemplates();
            list.Children.Clear();
            if (!r.Ok) { Fail(r.Error); return; }
            if (r.Value is not { Count: > 0 } all) { list.Children.Add(Ui.Text("No saved templates yet. Use Save as template… on a page.", 13, B("TextMuted")).With(t => t.Margin = new Thickness(0, 6, 0, 6))); return; }
            foreach (var t in all) list.Children.Add(Row(t));
        }

        Grid Row(TemplateItem t)
        {
            var slug = PopupMenu.Slug(t.Name);
            var g = new Grid { ColumnSpacing = 8, MinHeight = 44, Padding = new Thickness(6, 4, 6, 4) };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 1 };
            text.Children.Add(Ui.Text((string.IsNullOrEmpty(t.Icon) ? "" : t.Icon + "  ") + t.Name + (t.Private ? "  ·  private" : ""), 14, B("Text"), 500));
            var inSection = t.Scoped && (t.Scopes ?? Array.Empty<(string, bool)>()).Any(s => s.SectionId == sectionId);
            text.Children.Add(Ui.Text(TemplateRules.ScopeText(t.Scoped, t.Scopes, id => host.Source.Notebooks.SelectMany(n => Flatten(n.Sections)).FirstOrDefault(s => s.Id == id)?.Name), 12, B("TextMuted")));
            g.Children.Add(text);
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
            var scope = Small(t.Scoped ? (inSection ? "Offered here" : "Not offered here") : "Offered everywhere", "template-scope-" + slug);
            var rename = Small("Rename", "template-rename-" + slug);
            var delete = Small("Delete", "template-delete-" + slug, true);
            scope.Click += async (_, _) =>
            {
                // everywhere -> only this section -> (here) taken off again -> everywhere; a template tied to other sections gains this one
                var next = !t.Scoped ? TemplateRules.WithScope(null, sectionId, true)
                    : inSection ? TemplateRules.WithScope(t.Scopes, sectionId, false) : TemplateRules.WithScope(t.Scopes, sectionId, true);
                var err = await host.Source.SetTemplateScope(t.Id, next);
                Fail(err);
                if (err is null) await Reload();
            };
            rename.Click += (_, _) => Dialogs.Prompt(O, "Rename template", "Template name", t.Name, "Rename", async name =>
            {
                var err = await host.Source.RenameTemplate(t.Id, name);
                if (err is null) await Reload();
                return err;
            });
            delete.Click += (_, _) => Dialogs.Confirm(O, "Delete “" + t.Name + "”?", "Pages already made from it stay as they are.", "Delete", true, async () =>
            {
                var err = await host.Source.DeleteTemplate(t.Id);
                if (err is null) await Reload();
                return err;
            });
            if (t.CanManage) { buttons.Children.Add(scope); buttons.Children.Add(rename); buttons.Children.Add(delete); }
            else buttons.Children.Add(Ui.Text("Only its creator or an admin can change it", 12, B("TextMuted")));
            Grid.SetColumn(buttons, 1);
            g.Children.Add(buttons);
            return g;
        }

        Button Small(string text, string id, bool danger = false)
        {
            var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6), Content = Ui.Text(text, 12.5, danger ? B("Danger") : B("Text2"), 500) };
            AutomationProperties.SetAutomationId(b, id);
            AutomationProperties.SetName(b, text);
            return b;
        }

        await Reload();
    }

    internal static IEnumerable<Section> Flatten(IEnumerable<Section> sections)
    {
        foreach (var s in sections) { yield return s; foreach (var c in Flatten(s.Children)) yield return c; }
    }

    private static IEnumerable<(Section S, string? Parent)> WithParents(IEnumerable<Section> sections, string? parent)
    {
        foreach (var s in sections)
        {
            yield return (s, parent);
            foreach (var c in WithParents(s.Children, s.Id)) yield return c;
        }
    }

    /// <summary>"Default template…": what a new page in this section starts from: its parent's choice, nothing, or one of the saved templates.</summary>
    public static async void Default(ShellHost host, string sectionId, string sectionName)
    {
        var O = host.Overlay;
        Brush B(string k) => ThemeBrushes.Get(k, O);
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(Ui.Text("Default template", 16, B("Text"), 650));
        panel.Children.Add(Ui.Text("New pages in " + sectionName + " start from…", 12.5, B("TextMuted")));
        var list = new StackPanel { Spacing = 2 };
        var error = Ui.Text("", 12.5, B("Danger"));
        error.TextWrapping = TextWrapping.Wrap; error.TextTrimming = TextTrimming.None; error.Visibility = Visibility.Collapsed;
        panel.Children.Add(new ScrollViewer { MaxHeight = 380, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        panel.Children.Add(error);
        var cancel = Dialogs.Btn(O, "Close", false, id: "default-template-close");
        panel.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 4, 0, 0), Children = { cancel } });
        var layer = O.Show(Dialogs.Card(O, 440, panel), HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, 100, 0, 0));
        cancel.Click += (_, _) => layer.Close();

        IReadOnlyList<string> ChainOf(string id)
        {
            var chain = new List<string>();
            var all = host.Source.Notebooks.SelectMany(n => WithParents(n.Sections, null)).ToList();
            for (var cur = (string?)id; cur is not null && chain.Count < 24;) { chain.Add(cur); cur = all.FirstOrDefault(x => x.S.Id == cur).Parent; }
            return chain;
        }

        async Task Reload()
        {
            var cur = await host.Source.LoadSectionDefault(sectionId);
            var saved = await host.Source.LoadSavedTemplates();
            list.Children.Clear();
            if (!cur.Ok || cur.Value is not { } d) { error.Text = cur.Error ?? "Couldn't read the default."; error.Visibility = Visibility.Visible; return; }
            var effectiveName = saved.Value?.FirstOrDefault(t => t.Id == d.EffectiveId)?.Name;
            list.Children.Add(Choice("Same as the parent", d.Own == DefaultChoice.Inherit, "default-template-inherit",
                d.Own == DefaultChoice.Inherit ? (effectiveName is null ? "Currently: blank pages" : "Currently: " + effectiveName) : "Uses what the section above has", () => Set(DefaultChoice.Inherit, null)));
            list.Children.Add(Choice("None (blank pages)", d.Own == DefaultChoice.None, "default-template-none", "No template here, even if a parent has one", () => Set(DefaultChoice.None, null)));
            // the core takes only templates everyone in the workspace can see and that are offered in this section
            foreach (var t in saved.Value ?? Array.Empty<TemplateItem>())
            {
                if (t.Private) continue;
                if (t.Scoped && !TemplateRules.Offered(true, t.Scopes ?? new List<(string, bool)>(), ChainOf(sectionId))) continue;
                var tt = t;
                list.Children.Add(Choice((string.IsNullOrEmpty(t.Icon) ? "" : t.Icon + "  ") + t.Name, d.Own == DefaultChoice.Template && d.OwnTemplateId == t.Id, "default-template-" + PopupMenu.Slug(t.Name), t.Description, () => Set(DefaultChoice.Template, tt.Id)));
            }
        }

        async void Set(DefaultChoice choice, string? templateId)
        {
            var err = await host.Source.SetSectionDefault(sectionId, choice, templateId);
            if (err is not null) { error.Text = err; error.Visibility = Visibility.Visible; return; }
            host.Toast(choice switch { DefaultChoice.None => "New pages here start blank", DefaultChoice.Inherit => "New pages here follow the section above", _ => "Default template set" });
            await Reload();
        }

        Button Choice(string label, bool on, string id, string sub, Action click)
        {
            var g = new Grid { ColumnSpacing = 10 };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            if (on) g.Children.Add(new Icon("check", 15, B("Accent")) { VerticalAlignment = VerticalAlignment.Center });
            var text = new StackPanel { Spacing = 1, VerticalAlignment = VerticalAlignment.Center };
            text.Children.Add(Ui.Text(label, 14, B("Text"), 500));
            text.Children.Add(Ui.Text(sub, 12, B("TextMuted")));
            Grid.SetColumn(text, 1);
            g.Children.Add(text);
            var b = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), MinHeight = 46, Padding = new Thickness(10, 4, 10, 4), CornerRadius = new CornerRadius(6),
                HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g,
            };
            AutomationProperties.SetAutomationId(b, id);
            AutomationProperties.SetName(b, label);
            AutomationProperties.SetItemStatus(b, on ? "selected" : "");
            b.Click += (_, _) => click();
            return b;
        }

        await Reload();
    }
}
