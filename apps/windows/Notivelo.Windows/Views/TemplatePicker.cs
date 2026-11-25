using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Notivelo.Windows.Text;

namespace Notivelo.Windows.Views;

/// <summary>"New page from template" (Apple's template picker) and "Save as template": the built-in templates first, then the workspace's saved ones that are offered in
/// the section. A pick makes the page in the section and opens it; the template's content is written into it once it is live.</summary>
internal static class TemplatePicker
{
    public static void Show(ShellHost host, string sectionId, string sectionName) =>
        Open(host, sectionId, sectionName, "New page from template", async t =>
        {
            var r = await host.Source.CreatePageFromTemplate(sectionId, t);
            if (r.Ok && r.Id is not null) host.OpenPage(r.Id);
            return r.Error is null ? null : (r.Error.Length == 0 ? "Couldn't make the page." : r.Error);
        });

    /// <summary>"Templates" on the ribbon and the page menu: pick one and it goes onto the open page (one undo step), with "Start blank" to take it back.</summary>
    public static void ShowForPage(ShellHost host, string pageId, string sectionId, string sectionName) =>
        Open(host, sectionId, sectionName, "Use a template", async t =>
        {
            var a = await host.Source.ApplyTemplate(pageId, t);
            if (!a.Ok) return a.Error;
            PageView.Current?.NoteTemplateApplied(pageId, a);
            return null;
        });

    private static async void Open(ShellHost host, string sectionId, string sectionName, string title, Func<TemplateItem, Task<string?>> pick)
    {
        var O = host.Overlay;
        Brush B(string k) => ThemeBrushes.Get(k, O);
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(Ui.Text(title, 16, B("Text"), 650));
        panel.Children.Add(Ui.Text("In " + sectionName, 12.5, B("TextMuted")));
        var list = new StackPanel();
        var error = Ui.Text("", 12.5, B("Danger"));
        error.TextWrapping = TextWrapping.Wrap; error.TextTrimming = TextTrimming.None; error.Visibility = Visibility.Collapsed;
        panel.Children.Add(new ScrollViewer { MaxHeight = 380, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        panel.Children.Add(error);
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 4, 0, 0) };
        var cancel = Dialogs.Btn(O, "Cancel", false, id: "template-cancel");
        row.Children.Add(cancel);
        panel.Children.Add(row);
        var layer = O.Show(Dialogs.Card(O, 440, panel), HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, 100, 0, 0));
        cancel.Click += (_, _) => layer.Close();

        void Fill(IReadOnlyList<TemplateItem> items)
        {
            list.Children.Clear();
            var saved = false;
            list.Children.Add(Heading("Built in", true));
            foreach (var t in items)
            {
                if (!t.Builtin && !saved) { saved = true; list.Children.Add(Heading("Saved in this workspace", false)); }
                list.Children.Add(Row(t));
            }
        }
        TextBlock Heading(string text, bool first) => Ui.Text(text.ToUpperInvariant(), 11.5, B("TextMuted"), 600, tracking: 0.04).With(t => t.Margin = new Thickness(10, first ? 2 : 12, 0, 4));
        Button Row(TemplateItem t)
        {
            var g = new Grid { ColumnSpacing = 10 };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(26) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var icon = string.IsNullOrEmpty(t.Icon) ? (UIElement)new Icon("layout-template", 16, B("TextMuted")) : Ui.Text(t.Icon, 18, B("Text"));
            ((FrameworkElement)icon).VerticalAlignment = VerticalAlignment.Center;
            g.Children.Add(icon);
            var text = new StackPanel { Spacing = 1, VerticalAlignment = VerticalAlignment.Center };
            text.Children.Add(Ui.Text(t.Name + (t.Private ? "  ·  private" : ""), 14, B("Text"), 500));
            text.Children.Add(Ui.Text(t.Description, 12, B("TextMuted")));
            Grid.SetColumn(text, 1);
            g.Children.Add(text);
            var b = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), MinHeight = 46, Padding = new Thickness(10, 4, 10, 4), CornerRadius = new CornerRadius(6),
                HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g,
            };
            AutomationProperties.SetAutomationId(b, "template-" + PopupMenu.Slug(t.Name));
            AutomationProperties.SetName(b, t.Name);
            b.Click += async (_, _) =>
            {
                b.IsEnabled = false;
                var err = await pick(t);
                b.IsEnabled = true;
                if (err is not null) { error.Text = err; error.Visibility = Visibility.Visible; return; }
                layer.Close();
            };
            return b;
        }

        // the built-in templates show at once; the saved ones follow when the server answers
        Fill(TemplateRules.Builtins);
        var loaded = await host.Source.LoadTemplates(sectionId);
        if (loaded.Ok && loaded.Value is { } all) Fill(all);
        else if (loaded.Error is not null) { error.Text = loaded.Error; error.Visibility = Visibility.Visible; }
    }

    /// <summary>"Save as template…": a name (the page's title to start with), then the open page's boxes are saved for the whole workspace.</summary>
    public static void Save(ShellHost host, string pageId, string title) =>
        Dialogs.Prompt(host.Overlay, "Save as template", "Template name", title, "Save", async name =>
        {
            var err = await host.Source.SaveAsTemplate(pageId, name);
            if (err is null) host.Toast("Saved as a template");
            return err;
        });
}
