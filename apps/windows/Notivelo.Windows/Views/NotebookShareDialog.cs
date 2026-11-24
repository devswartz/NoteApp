using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>"Share with people…" on a notebook (Apple's NotebookShareCard, built from the page share dialog's parts): everyone in the workspace, or only the people
/// picked; only the notebook's creator can change it. Core: notebook_shares, set_notebook_visibility, set_notebook_shares.</summary>
internal static class NotebookShareDialog
{
    public static void Show(ShellHost h, string notebookId, string name)
    {
        var o = h.Overlay; var src = h.Source;
        Brush B(string k) => PageDialogs.Br(o, k);
        var panel = PageDialogs.Named("notebook-share-dialog", "Share " + name);
        OverlayHost.Layer? layer = null;
        panel.Children.Add(PageDialogs.Header(o, $"Share “{name}”", "Choose who can see this notebook.", () => layer?.Close(), "nbshare-x"));
        var choices = new StackPanel { Spacing = 8 };
        var people = new StackPanel();
        var note = PageDialogs.Note(o, "", false, "nbshare-note");
        var error = PageDialogs.Note(o, "", true, "nbshare-error");
        note.Visibility = error.Visibility = Visibility.Collapsed;
        panel.Children.Add(choices);
        panel.Children.Add(new ScrollViewer { MaxHeight = 220, Content = people, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        panel.Children.Add(note);
        panel.Children.Add(error);
        var done = Dialogs.Btn(o, "Done", true, id: "nbshare-done");
        panel.Children.Add(PageDialogs.Foot(done));
        layer = PageDialogs.Open(o, 480, panel, 80);
        done.Click += (_, _) => layer.Close();

        NotebookSharesInfo? data = null;
        var busy = false;
        bool IsCreator() => data is not null && data.CreatedBy == src.UserId;
        void Fail(string e) { error.Text = e; error.Visibility = Visibility.Visible; }

        UIElement Mark(bool on, bool round)
        {
            var g = new Grid { Width = 18, Height = 18, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 1, 0, 0) };
            g.Children.Add(new Border
            {
                CornerRadius = new CornerRadius(round ? 9 : 5), BorderThickness = new Thickness(on ? 0 : 1.5), BorderBrush = B("BorderStrong"), Background = on ? B("AccentSolid") : null,
            });
            if (on) g.Children.Add(round
                ? new Border { Width = 6, Height = 6, CornerRadius = new CornerRadius(3), Background = B("TextOnAccent"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center }
                : new Icon("check", 12, B("TextOnAccent")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
            return g;
        }

        Button Choice(string id, string title, string detail, bool on, bool isPrivate)
        {
            var g = new Grid { ColumnSpacing = 10 };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.Children.Add(Mark(on, true));
            var col = new StackPanel { Spacing = 2 };
            col.Children.Add(Ui.Text(title, 14, B("Text"), 600));
            col.Children.Add(PageDialogs.Wrap(Ui.Text(detail, 12, B("TextMuted"), lineHeight: 17)));
            Grid.SetColumn(col, 1);
            g.Children.Add(col);
            var b = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), Padding = new Thickness(12), CornerRadius = new CornerRadius(12), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch,
                Background = on ? B("AccentSoft") : B("Bg"), BorderBrush = on ? B("Accent") : B("Border"), BorderThickness = new Thickness(on ? 2 : 1), Content = g, IsEnabled = IsCreator() || data is null,
            };
            AutomationProperties.SetAutomationId(b, id);
            AutomationProperties.SetName(b, title + (on ? " (selected)" : ""));
            b.Click += async (_, _) =>
            {
                if (busy || data is null || data.IsPrivate == isPrivate) return;
                busy = true; error.Visibility = Visibility.Collapsed;
                var r = await src.SetNotebookPrivate(notebookId, isPrivate);
                busy = false;
                if (r.Ok) data = r.Value; else Fail(r.Error!);
                Draw();
            };
            return b;
        }

        void Draw()
        {
            choices.Children.Clear(); people.Children.Clear();
            var priv = data?.IsPrivate == true;
            AutomationProperties.SetItemStatus(panel, data is null ? "loading" : $"visibility={(priv ? "private" : "shared")};members={string.Join(",", data.UserIds)};creator={(IsCreator() ? 1 : 0)}");
            choices.Children.Add(Choice("nbshare-shared", "Everyone in the workspace", "Members can edit; viewers can read.", !priv, false));
            choices.Children.Add(Choice("nbshare-private", "Only people I pick", $"Only {(IsCreator() || data is null ? "you" : "its creator")} and the people you pick below.", priv, true));
            note.Visibility = Visibility.Collapsed;
            if (data is not null && !IsCreator()) { note.Text = "Only the notebook’s creator can change who sees it."; note.Visibility = Visibility.Visible; }
            if (!priv) return;
            var others = src.Members().Where(m => m.Id != data!.CreatedBy).ToList();
            if (others.Count == 0) { people.Children.Add(PageDialogs.Note(o, "No one else is in this workspace yet.", false, "nbshare-empty")); return; }
            foreach (var m in others)
            {
                var member = m;
                var on = data!.UserIds.Contains(m.Id);
                var g = new Grid { ColumnSpacing = 8 };
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                g.Children.Add(PageDialogs.Person(o, m.Name, m.Email, m.Color, m.Role == "viewer" ? "view only" : null));
                var mark = (FrameworkElement)Mark(on, false); mark.VerticalAlignment = VerticalAlignment.Center;
                Grid.SetColumn(mark, 1);
                g.Children.Add(mark);
                var b = new Button
                {
                    Style = Ui.Style("GhostButtonStyle"), Padding = new Thickness(6, 4, 6, 4), CornerRadius = new CornerRadius(6), HorizontalAlignment = HorizontalAlignment.Stretch,
                    HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g, IsEnabled = IsCreator(),
                };
                AutomationProperties.SetAutomationId(b, "nbshare-member-" + m.Id);
                AutomationProperties.SetName(b, m.Name + (on ? " (shared)" : ""));
                b.Click += async (_, _) =>
                {
                    if (busy || data is null) return;
                    busy = true; error.Visibility = Visibility.Collapsed;
                    var next = data.UserIds.ToList();
                    if (!next.Remove(member.Id)) next.Add(member.Id);
                    var r = await src.SetNotebookShares(notebookId, next);
                    busy = false;
                    if (r.Ok) data = r.Value; else Fail(r.Error!);
                    Draw();
                };
                people.Children.Add(b);
            }
        }

        Draw();
        _ = Load();
        async Task Load()
        {
            var r = await src.LoadNotebookShares(notebookId);
            if (r.Ok) data = r.Value; else Fail(r.Error!);
            Draw();
        }
    }
}
