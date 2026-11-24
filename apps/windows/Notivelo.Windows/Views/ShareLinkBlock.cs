using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>"Anyone with the link can view" in the page's Share dialog (the web's public link; Apple's share-link row): create the link and copy it, open it, turn it off
/// (after a confirm). Calls go through the source (off the UI thread); a refusal (a locked page, no right to share) is one sentence under the row.</summary>
internal static class ShareLinkBlock
{
    public static UIElement Build(ShellHost h, string pageId)
    {
        var o = h.Overlay; var src = h.Source;
        Brush B(string k) => ThemeBrushes.Get(k, o);
        var box = new StackPanel { Spacing = 8, Padding = new Thickness(12), Margin = new Thickness(0, 6, 0, 0) };
        var card = new Border { Background = B("BgSubtle"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Child = box };
        AutomationProperties.SetAutomationId(box, "share-link-block");
        AutomationProperties.SetName(box, "Anyone with the link can view");
        string? url = null; var loaded = false; var busy = false; string? error = null;

        void Draw()
        {
            box.Children.Clear();
            AutomationProperties.SetItemStatus(box, loaded ? (url is null ? "link=off" : "link=on") : "link=loading");
            var head = new Grid { ColumnSpacing = 8 };
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            head.Children.Add(new Icon("globe", 16, B("Text2")) { VerticalAlignment = VerticalAlignment.Center });
            var title = Ui.Text("Anyone with the link can view", 13.5, B("Text"), 600);
            Grid.SetColumn(title, 1); head.Children.Add(title);
            if (loaded && url is null)
            {
                var create = Dialogs.Btn(o, busy ? "Creating…" : "Create link", true, id: "share-link-create");
                create.IsEnabled = !busy;
                create.Click += async (_, _) =>
                {
                    busy = true; error = null; Draw();
                    var r = await src.CreateShareLink(pageId);
                    busy = false;
                    if (r.Ok) url = r.Value; else error = r.Error;
                    Draw();
                };
                Grid.SetColumn(create, 2); head.Children.Add(create);
            }
            box.Children.Add(head);
            if (!loaded) box.Children.Add(Ui.Text("Loading…", 12.5, B("TextMuted")));
            else if (url is null) box.Children.Add(Ui.Text("The link is off. Create one to share this page with people outside the workspace, read-only.", 12.5, B("TextMuted")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; }));
            else
            {
                var link = Ui.Text(url, 12, B("Text2"));
                link.FontFamily = Ui.Mono; link.IsTextSelectionEnabled = true; link.TextWrapping = TextWrapping.Wrap; link.TextTrimming = TextTrimming.None;
                AutomationProperties.SetAutomationId(link, "share-link-url");
                AutomationProperties.SetName(link, url);
                box.Children.Add(new Border { Background = B("Bg"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 8, 10, 8), Child = link });
                var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
                var copy = Small("copy", "Copy link", "share-link-copy");
                copy.Click += (_, _) =>
                {
                    try { var dp = new global::Windows.ApplicationModel.DataTransfer.DataPackage(); dp.SetText(url); global::Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(dp); } catch (Exception) { }
                    copy.Content = Label("check", "Copied");
                };
                var open = Small("external-link", "Open", "share-link-open");
                open.Click += async (_, _) => { try { await global::Windows.System.Launcher.LaunchUriAsync(new Uri(url)); } catch (Exception) { } };
                var off = Small("link-2-off", "Turn off", "share-link-off");
                off.Click += (_, _) => Dialogs.Confirm(o, "Turn off the link?", "Anyone who has the link loses access at once. Turning it on again makes a new link.", "Turn off", true, async () =>
                {
                    var r = await src.DeleteShareLink(pageId);
                    if (!r.Ok) return r.Error;
                    url = null; error = null; Draw(); h.Toast("Link turned off");
                    return null;
                });
                row.Children.Add(copy); row.Children.Add(open); row.Children.Add(off);
                box.Children.Add(row);
            }
            if (error is not null)
                box.Children.Add(Ui.Text(error, 12.5, B("Danger")).With(t =>
                {
                    t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None;
                    AutomationProperties.SetAutomationId(t, "share-link-error"); AutomationProperties.SetName(t, error);
                }));
        }
        StackPanel Label(string icon, string text)
        {
            var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            sp.Children.Add(new Icon(icon, 14, B("Text"))); sp.Children.Add(Ui.Text(text, 12.5, B("Text"), 500));
            return sp;
        }
        Button Small(string icon, string text, string id)
        {
            var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6), BorderBrush = B("Border"), BorderThickness = new Thickness(1), Content = Label(icon, text) };
            AutomationProperties.SetAutomationId(b, id); AutomationProperties.SetName(b, text);
            return b;
        }
        Draw();
        _ = Load();
        async Task Load()
        {
            var r = await src.LoadShareLink(pageId);
            loaded = true;
            if (r.Ok) url = r.Value; else error = r.Error;
            Draw();
        }
        return card;
    }
}
