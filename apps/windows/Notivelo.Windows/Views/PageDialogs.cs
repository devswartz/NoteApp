using System.Text;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Windows.ApplicationModel.DataTransfer;
using Windows.System;

namespace Notivelo.Windows.Views;

public enum LockMode { SetPassword, ChangePassword, LockPage, RemoveLock }

/// <summary>The page-tool dialogs on the overlay (Apple's Sheets.swift / IconPicker.swift / Export.swift): version history, share, lock, page icon, Markdown export.
/// Each is a card named for UI Automation (a StackPanel with a Name, since a Border has no peer) and fetches through the source off the UI thread.</summary>
internal static class PageDialogs
{
    private static Brush Br(OverlayHost o, string k) => ThemeBrushes.Get(k, o);

    private static StackPanel Named(string id, string name, double spacing = 10)
    {
        var p = new StackPanel { Spacing = spacing };
        AutomationProperties.SetAutomationId(p, id);
        AutomationProperties.SetName(p, name);
        return p;
    }

    private static TextBlock Wrap(TextBlock t) { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; return t; }

    private static TextBlock Note(OverlayHost o, string text, bool danger = false, string? id = null)
    {
        var t = Wrap(Ui.Text(text, 12.5, Br(o, danger ? "Danger" : "TextMuted"), lineHeight: 18));
        if (id is not null) { AutomationProperties.SetAutomationId(t, id); AutomationProperties.SetName(t, text); }
        return t;
    }

    private static Grid Header(OverlayHost o, string title, string? description, Action close, string closeId)
    {
        var g = new Grid { ColumnSpacing = 8 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var col = new StackPanel { Spacing = 4 };
        col.Children.Add(Wrap(Ui.Text(title, 16, Br(o, "Text"), 650)));
        if (description is not null) col.Children.Add(Wrap(Ui.Text(description, 12.5, Br(o, "TextMuted"), lineHeight: 18)));
        g.Children.Add(col);
        var x = Ui.IconButton("x", 16, 28, 28, "Close");
        x.VerticalAlignment = VerticalAlignment.Top;
        AutomationProperties.SetAutomationId(x, closeId);
        AutomationProperties.SetName(x, "Close");
        x.Click += (_, _) => close();
        Grid.SetColumn(x, 1);
        g.Children.Add(x);
        return g;
    }

    private static StackPanel Foot(params UIElement[] buttons)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 6, 0, 0) };
        foreach (var b in buttons) row.Children.Add(b);
        return row;
    }

    private static TextBox Field(OverlayHost o, string id, string placeholder)
    {
        var t = new TextBox { PlaceholderText = placeholder, Height = 36, FontSize = 14, Padding = new Thickness(10, 7, 10, 7), CornerRadius = new CornerRadius(8) };
        AutomationProperties.SetAutomationId(t, id);
        AutomationProperties.SetName(t, placeholder);
        return t;
    }

    private static PasswordBox Pass(string id, string label)
    {
        var p = new PasswordBox { Height = 36, FontSize = 14, Padding = new Thickness(10, 7, 10, 7), CornerRadius = new CornerRadius(8), PlaceholderText = label };
        AutomationProperties.SetAutomationId(p, id);
        AutomationProperties.SetName(p, label);
        return p;
    }

    private static UIElement Labelled(OverlayHost o, string label, UIElement field)
    {
        var s = new StackPanel { Spacing = 4 };
        s.Children.Add(Ui.Text(label, 12.5, Br(o, "TextMuted")));
        s.Children.Add(field);
        return s;
    }

    private static OverlayHost.Layer Open(OverlayHost o, double width, UIElement content, double top = 90) =>
        o.Show(Dialogs.Card(o, width, content), HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, top, 0, 0));

    // ---------------------------------------------------------------- version history

    public static void VersionHistory(ShellHost h, string pageId)
    {
        var o = h.Overlay; var src = h.Source;
        var panel = Named("version-dialog", "Version history");
        OverlayHost.Layer? layer = null;
        panel.Children.Add(Header(o, "Version history", null, () => layer?.Close(), "version-x"));
        var list = new StackPanel();
        var scroll = new ScrollViewer { MaxHeight = 190, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        var previewText = Wrap(Ui.Text("", 13, Br(o, "Text"), lineHeight: 19));
        previewText.Margin = new Thickness(10);
        AutomationProperties.SetAutomationId(previewText, "version-preview");
        var previewBox = new Border
        {
            Height = 170, Background = Br(o, "Bg"), BorderBrush = Br(o, "Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8),
            Child = new ScrollViewer { Content = previewText, VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
        };
        var info = Note(o, "Loading…", id: "version-note");
        var error = Note(o, "", true); error.Visibility = Visibility.Collapsed;
        var close = Dialogs.Btn(o, "Close", false, id: "version-close");
        var restore = Dialogs.Btn(o, "Restore this version", true, id: "version-restore");
        restore.Visibility = Visibility.Collapsed;
        panel.Children.Add(info);
        panel.Children.Add(scroll);
        panel.Children.Add(previewBox);
        panel.Children.Add(error);
        panel.Children.Add(Foot(close, restore));
        scroll.Visibility = previewBox.Visibility = Visibility.Collapsed;
        layer = Open(o, 560, panel);
        close.Click += (_, _) => layer.Close();

        IReadOnlyList<VersionInfo> versions = Array.Empty<VersionInfo>();
        string? selected = null;
        void Fail(string e) { error.Text = e; error.Visibility = Visibility.Visible; }
        void Draw()
        {
            list.Children.Clear();
            foreach (var v in versions)
            {
                var ver = v;
                var col = new StackPanel { Spacing = 1 };
                col.Children.Add(Ui.Text(v.When, 14, Br(o, "Text"), 500));
                col.Children.Add(Ui.Text($"{v.Who} · {v.Detail}", 12, Br(o, "TextMuted")));
                var b = new Button
                {
                    Style = Ui.Style("GhostButtonStyle"), Padding = new Thickness(10, 6, 10, 6), CornerRadius = new CornerRadius(6), HorizontalAlignment = HorizontalAlignment.Stretch,
                    HorizontalContentAlignment = HorizontalAlignment.Left, Content = col, Background = v.Id == selected ? Br(o, "AccentSoft") : null,
                };
                AutomationProperties.SetAutomationId(b, "version-" + v.Id);
                AutomationProperties.SetName(b, v.When);
                AutomationProperties.SetItemStatus(b, v.Id == selected ? "selected=1" : "selected=0");
                b.Click += (_, _) => Select(ver.Id);
                list.Children.Add(b);
            }
        }
        async void Select(string id)
        {
            selected = id; previewText.Text = "Loading…"; error.Visibility = Visibility.Collapsed; Draw();
            restore.Visibility = src.CanRestoreVersion(pageId) ? Visibility.Visible : Visibility.Collapsed;
            restore.IsEnabled = false;
            var r = await src.VersionPreview(pageId, id);
            if (selected != id) return;
            previewText.Text = r.Ok ? r.Value! : "Can’t show this version.";
            if (!r.Ok) Fail(r.Error!);
            restore.IsEnabled = r.Ok;
        }
        restore.Click += async (_, _) =>
        {
            if (selected is not { } id) return;
            restore.IsEnabled = false; restore.Content = Ui.Text("Restoring…", 13.5, Br(o, "TextOnAccent"), 600);
            var r = await src.RestoreVersion(pageId, id);
            if (r.Ok) { layer.Close(); h.Toast("Version restored"); }
            else { restore.IsEnabled = true; restore.Content = Ui.Text("Restore this version", 13.5, Br(o, "TextOnAccent"), 600); Fail(r.Error!); }
        };
        _ = Load();
        async Task Load()
        {
            var r = await src.LoadVersions(pageId);
            if (!r.Ok) { info.Text = ""; info.Visibility = Visibility.Collapsed; Fail(r.Error!); return; }
            versions = r.Value!;
            AutomationProperties.SetItemStatus(panel, "versions=" + versions.Count);
            if (versions.Count == 0) { info.Text = "No earlier versions yet. Snapshots are taken every few minutes while a page is being edited."; return; }
            info.Visibility = Visibility.Collapsed;
            scroll.Visibility = previewBox.Visibility = Visibility.Visible;
            Select(versions[0].Id);
        }
    }

    // ---------------------------------------------------------------- share a page

    public static void Share(ShellHost h, string pageId, string title)
    {
        var o = h.Overlay; var src = h.Source;
        var canOutside = src.WorkspaceRole is "owner" or "admin";
        var panel = Named("share-dialog", "Share " + title);
        OverlayHost.Layer? layer = null;
        panel.Children.Add(Header(o, $"Share “{(title.Length == 0 ? "Untitled" : title)}”",
            canOutside ? "Only this page, not its notebook or other pages. You can also share it with people outside the workspace by email."
                       : "Only this page, not its notebook or other pages. You can share it with members of this workspace.", () => layer?.Close(), "share-x"));
        var input = Field(o, "share-input", canOutside ? "Name or email" : "Name or email of a member");
        panel.Children.Add(input);

        var canEdit = true;
        var seg = Named("share-level", "Access level", 2); seg.Orientation = Orientation.Horizontal;
        var submit = Dialogs.Btn(o, "Share", true, id: "share-submit");
        var row = new Grid(); row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(seg); Grid.SetColumn(submit, 1); row.Children.Add(submit);
        panel.Children.Add(row);

        var hint = new StackPanel(); var suggest = new StackPanel(); var invite = new StackPanel(); var people = new StackPanel();
        var error = Note(o, "", true); error.Visibility = Visibility.Collapsed;
        panel.Children.Add(hint); panel.Children.Add(suggest); panel.Children.Add(invite); panel.Children.Add(error);
        panel.Children.Add(new ScrollViewer { MaxHeight = 200, Content = people, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        var done = Dialogs.Btn(o, "Done", true, id: "share-done");
        panel.Children.Add(Foot(done));
        layer = Open(o, 520, panel, 80);
        done.Click += (_, _) => layer.Close();

        PageSharesInfo? data = null; var busy = false; string? inviteUrl = null;
        void DrawLevel()
        {
            seg.Children.Clear();
            AutomationProperties.SetItemStatus(seg, "level=" + (canEdit ? "edit" : "view"));
            foreach (var (label, edit, id) in new[] { ("Can view", false, "share-level-view"), ("Can edit", true, "share-level-edit") })
            {
                var on = edit == canEdit;
                var b = new Button
                {
                    Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6),
                    Background = on ? Br(o, "AccentSoft") : null, Content = Ui.Text(label, 13, on ? Br(o, "Accent") : Br(o, "Text2"), 500),
                };
                AutomationProperties.SetAutomationId(b, id); AutomationProperties.SetName(b, label);
                b.Click += (_, _) => { canEdit = edit; DrawLevel(); };
                seg.Children.Add(b);
            }
        }
        DrawLevel();

        List<MemberInfo> Matches(string needle)
        {
            if (needle.Length == 0) return new();
            var shared = data?.Shares.Select(s => s.UserId).ToHashSet() ?? new();
            return src.Members().Where(m => m.Id != src.UserId && !shared.Contains(m.Id) && (m.Name + " " + m.Email).Contains(needle, StringComparison.OrdinalIgnoreCase)).Take(6).ToList();
        }
        string Needle() => input.Text.Trim();
        (List<MemberInfo> Sug, MemberInfo? ByEmail, bool Outside, bool Can) State()
        {
            var needle = Needle();
            var sug = Matches(needle);
            var isEmail = PageToolRules.LooksLikeEmail(needle);
            var byEmail = src.Members().FirstOrDefault(m => m.Email.Equals(needle, StringComparison.OrdinalIgnoreCase));
            var outside = isEmail && byEmail is null;
            return (sug, byEmail, outside, !busy && (sug.Count == 1 || byEmail is not null || (outside && canOutside)));
        }
        void Fail(string e) { error.Text = e; error.Visibility = Visibility.Visible; }
        void DrawSuggest()
        {
            var (sug, _, outside, can) = State();
            submit.IsEnabled = can;
            hint.Children.Clear(); suggest.Children.Clear();
            if (outside && !canOutside) hint.Children.Add(Note(o, $"{Needle()} isn’t a member of this workspace. Ask a workspace owner or admin to share with people outside it."));
            foreach (var m in sug)
            {
                var member = m;
                var b = new Button { Style = Ui.Style("GhostButtonStyle"), Padding = new Thickness(6, 4, 6, 4), CornerRadius = new CornerRadius(6), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left, Content = Person(o, m.Name, m.Email, m.Color, m.Role == "viewer" ? "view only" : null) };
                AutomationProperties.SetAutomationId(b, "share-suggest-" + m.Id); AutomationProperties.SetName(b, m.Name);
                b.Click += (_, _) => Add(member.Id, null, member.Name);
                suggest.Children.Add(b);
            }
        }
        void DrawInvite()
        {
            invite.Children.Clear();
            if (inviteUrl is null) return;
            var g = new Grid { ColumnSpacing = 8, Padding = new Thickness(8) };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var url = Wrap(Ui.Text(inviteUrl, 12, Br(o, "Text2")));
            url.FontFamily = Ui.Mono; url.TextTrimming = TextTrimming.CharacterEllipsis; url.MaxLines = 2;
            AutomationProperties.SetAutomationId(url, "share-invite-url"); AutomationProperties.SetName(url, inviteUrl);
            g.Children.Add(url);
            var copy = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6) };
            var cs = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            cs.Children.Add(new Icon("copy", 14, Br(o, "Text"))); cs.Children.Add(Ui.Text("Copy link", 12.5, Br(o, "Text"), 500));
            copy.Content = cs;
            AutomationProperties.SetAutomationId(copy, "share-copy"); AutomationProperties.SetName(copy, "Copy link");
            copy.Click += (_, _) =>
            {
                try { var dp = new DataPackage(); dp.SetText(inviteUrl); Clipboard.SetContent(dp); } catch (Exception) { }
                cs.Children.Clear(); cs.Children.Add(new Icon("check", 14, Br(o, "Text"))); cs.Children.Add(Ui.Text("Copied", 12.5, Br(o, "Text"), 500));
            };
            Grid.SetColumn(copy, 1); g.Children.Add(copy);
            invite.Children.Add(new Border { Background = Br(o, "BgSubtle"), BorderBrush = Br(o, "Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Child = g });
        }
        void DrawPeople()
        {
            people.Children.Clear();
            if (data is null) { people.Children.Add(Note(o, "Loading…")); return; }
            AutomationProperties.SetItemStatus(panel, $"shares={data.Shares.Count} invites={data.Invites.Count}");
            if (data.Shares.Count == 0 && data.Invites.Count == 0) { people.Children.Add(Note(o, "Not shared with anyone yet.", id: "share-empty")); return; }
            foreach (var s in data.Shares)
            {
                var share = s;
                var edit = s.CanEdit && !s.ViewerOnly;
                var g = new Grid { ColumnSpacing = 6, Margin = new Thickness(0, 4, 0, 4) };
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                g.Children.Add(Person(o, s.Name, s.Email, s.Color, s.Member ? null : "outside the workspace"));
                var lvl = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6), BorderBrush = Br(o, "Border"), BorderThickness = new Thickness(1), IsEnabled = !s.ViewerOnly };
                var ls = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
                ls.Children.Add(Ui.Text(edit ? "Can edit" : "Can view", 12.5, Br(o, "Text2"), 500));
                if (!s.ViewerOnly) ls.Children.Add(new Icon("chevron-down", 12, Br(o, "TextMuted")));
                lvl.Content = ls;
                AutomationProperties.SetAutomationId(lvl, "share-access-" + s.UserId); AutomationProperties.SetName(lvl, $"{s.Name}: {(edit ? "Can edit" : "Can view")}");
                AutomationProperties.SetItemStatus(lvl, "access=" + (edit ? "edit" : "view"));
                lvl.Click += (_, _) => PopupMenu.Show(o, new[]
                {
                    new MenuEntry("Can view", Check: !edit, Id: "share-opt-view", Click: () => _ = SetEdit(share, false)),
                    new MenuEntry("Can edit", Check: edit, Id: "share-opt-edit", Click: () => _ = SetEdit(share, true)),
                }, lvl, endAlign: true, width: 160);
                Grid.SetColumn(lvl, 1); g.Children.Add(lvl);
                var rm = Ui.IconButton("x", 14, 28, 28, "Stop sharing with " + s.Name);
                AutomationProperties.SetAutomationId(rm, "share-remove-" + s.UserId); AutomationProperties.SetName(rm, "Stop sharing with " + s.Name);
                rm.Click += async (_, _) => { error.Visibility = Visibility.Collapsed; var r = await src.RemoveShare(pageId, share.UserId); if (r.Ok) { data = r.Value; h.Toast("Stopped sharing with " + share.Name); DrawAll(); } else Fail(r.Error!); };
                Grid.SetColumn(rm, 2); g.Children.Add(rm);
                people.Children.Add(g);
            }
            foreach (var i in data.Invites)
            {
                var inv = i;
                var g = new Grid { ColumnSpacing = 6, Margin = new Thickness(0, 4, 0, 4) };
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                g.Children.Add(new Border { Width = 28, Height = 28, CornerRadius = new CornerRadius(14), Background = Br(o, "BgSubtle"), Child = new Icon("mail", 14, Br(o, "TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } });
                var col = new StackPanel { Spacing = 1, Margin = new Thickness(6, 0, 0, 0) };
                col.Children.Add(Ui.Text(i.Email, 14, Br(o, "Text")));
                col.Children.Add(Ui.Text($"Invited: can {(i.CanEdit ? "edit" : "view")} once they sign up", 12, Br(o, "TextMuted")));
                Grid.SetColumn(col, 1); g.Children.Add(col);
                var rv = Ui.IconButton("x", 14, 28, 28, "Cancel the invite for " + i.Email);
                AutomationProperties.SetAutomationId(rv, "share-revoke-" + PopupMenu.Slug(i.Email)); AutomationProperties.SetName(rv, "Cancel the invite for " + i.Email);
                rv.Click += async (_, _) => { var r = await src.RevokeInvite(pageId, inv.Email); if (r.Ok) { data = r.Value; DrawAll(); } else Fail(r.Error!); };
                Grid.SetColumn(rv, 2); g.Children.Add(rv);
                people.Children.Add(g);
            }
        }
        void DrawAll() { DrawSuggest(); DrawInvite(); DrawPeople(); }
        async Task SetEdit(ShareEntry s, bool edit)
        {
            error.Visibility = Visibility.Collapsed;
            var r = await src.SetShareEdit(pageId, s.UserId, edit);
            if (r.Ok) { data = r.Value; DrawAll(); } else Fail(r.Error!);
        }
        async void Add(string? userId, string? email, string label)
        {
            busy = true; error.Visibility = Visibility.Collapsed; DrawSuggest();
            var r = await src.SharePage(pageId, userId, email, canEdit);
            busy = false;
            if (!r.Ok) { Fail(r.Error!); DrawSuggest(); return; }
            data = r.Value!.Shares; input.Text = "";
            if (r.Value.Status == "invited") { inviteUrl = r.Value.InviteUrl; h.Toast(r.Value.Emailed ? $"Invite sent to {label}. You can also copy the link." : $"Invite created for {label}: copy the link."); }
            else { inviteUrl = null; h.Toast("Shared with " + label); }
            DrawAll();
        }
        void Submit()
        {
            var (sug, byEmail, outside, can) = State();
            if (!can) return;
            if (byEmail is not null) Add(byEmail.Id, null, byEmail.Name);
            else if (sug.Count == 1 && !outside) Add(sug[0].Id, null, sug[0].Name);
            else if (outside) Add(null, Needle(), Needle());
        }
        input.TextChanged += (_, _) => DrawSuggest();
        input.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) { e.Handled = true; Submit(); } };
        submit.Click += (_, _) => Submit();
        input.Loaded += (_, _) => input.Focus(FocusState.Programmatic);
        DrawAll();
        _ = Load();
        async Task Load()
        {
            var r = await src.LoadShares(pageId);
            if (r.Ok) data = r.Value; else { data = new PageSharesInfo(Array.Empty<ShareEntry>(), Array.Empty<InviteEntry>()); Fail(r.Error!); }
            DrawAll();
        }
    }

    private static UIElement Person(OverlayHost o, string name, string email, string color, string? chip)
    {
        var g = new Grid { ColumnSpacing = 8 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(Ui.Avatar(AccountRules.Initials(name, email), 28, color.StartsWith('#') && color.Length == 7 ? color : "#6366f1"));
        var col = new StackPanel { Spacing = 1, VerticalAlignment = VerticalAlignment.Center };
        var l1 = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        l1.Children.Add(Ui.Text(name.Length == 0 ? email : name, 14, Br(o, "Text")));
        if (chip is not null) l1.Children.Add(new Border { Padding = new Thickness(6, 1, 6, 1), CornerRadius = new CornerRadius(8), Background = Br(o, "BgHover"), Child = Ui.Text(chip, 11, Br(o, "TextMuted")) });
        col.Children.Add(l1);
        if (name.Length > 0) col.Children.Add(Ui.Text(email, 12, Br(o, "TextMuted")));
        Grid.SetColumn(col, 1); g.Children.Add(col);
        return g;
    }

    // ---------------------------------------------------------------- locked pages

    public static void Lock(ShellHost h, LockMode mode, string? pageId, string? title = null)
    {
        var o = h.Overlay; var src = h.Source;
        var hasPassword = src.LockState.HasPassword;
        var withFields = mode switch { LockMode.LockPage => !hasPassword, _ => true };
        var newForm = mode is LockMode.SetPassword or LockMode.ChangePassword || (mode == LockMode.LockPage && !hasPassword);
        var withCurrent = mode == LockMode.ChangePassword;
        var heading = mode switch { LockMode.SetPassword => "Locked pages password", LockMode.ChangePassword => "Change locked pages password", LockMode.LockPage => "Lock this page", _ => "Remove the lock" };
        var detail = mode switch
        {
            LockMode.LockPage when hasPassword => "Only you will be able to open it, with your locked pages password. A locked page can’t be shared or duplicated.",
            LockMode.LockPage => "Locked pages open with one password, separate from your sign-in password. Choose it now (6 characters or more).",
            LockMode.SetPassword => "One password opens all your locked pages. It is separate from your sign-in password (6 characters or more).",
            LockMode.ChangePassword => "Changing it locks your other devices.",
            _ => "The page becomes an ordinary page again. Enter your locked pages password.",
        };
        var okText = mode switch { LockMode.SetPassword => "Set password", LockMode.ChangePassword => "Change password", LockMode.LockPage => "Lock page", _ => "Remove lock" };
        var panel = Named("lock-dialog", heading);
        OverlayHost.Layer? layer = null;
        panel.Children.Add(Header(o, heading, detail, () => layer?.Close(), "lock-x"));
        var current = Pass("lock-current", newForm ? "Current password" : "Password");
        var first = Pass("lock-new", "New password");
        var again = Pass("lock-repeat", "Repeat new password");
        if (withCurrent) panel.Children.Add(Labelled(o, "Current password", current));
        if (newForm) { panel.Children.Add(Labelled(o, "New password", first)); panel.Children.Add(Labelled(o, "Repeat new password", again)); }
        if (mode == LockMode.RemoveLock) panel.Children.Add(Labelled(o, "Password", current));
        var note = Note(o, "", true, "lock-error"); note.Visibility = Visibility.Collapsed;
        panel.Children.Add(note);
        var cancel = Dialogs.Btn(o, "Cancel", false, id: "lock-cancel");
        var ok = Dialogs.Btn(o, okText, true, id: "lock-ok");
        panel.Children.Add(Foot(cancel, ok));
        layer = Open(o, 420, panel, 130);
        cancel.Click += (_, _) => layer.Close();

        var busy = false; var mismatchShown = false;
        bool Ready()
        {
            if (busy) return false;
            if (newForm) return PageToolRules.PasswordProblem(first.Password, again.Password) is null && (!withCurrent || current.Password.Length > 0);
            if (mode == LockMode.RemoveLock) return current.Password.Length > 0;
            return true;
        }
        void Refresh()
        {
            ok.IsEnabled = Ready();
            if (newForm && again.Password.Length > 0 && PageToolRules.PasswordProblem(first.Password, again.Password) is { } p) { note.Text = p; note.Visibility = Visibility.Visible; mismatchShown = true; }
            else if (mismatchShown) { note.Visibility = Visibility.Collapsed; mismatchShown = false; }
        }
        async void Send()
        {
            if (!Ready()) return;
            busy = true; ok.IsEnabled = false; note.Visibility = Visibility.Collapsed;
            string? err;
            string done;
            switch (mode)
            {
                case LockMode.SetPassword: err = await src.SetLockPassword(first.Password, null); done = "Locked pages password set"; break;
                case LockMode.ChangePassword: err = await src.SetLockPassword(first.Password, current.Password); done = "Password changed"; break;
                case LockMode.LockPage:
                    err = hasPassword ? null : await src.SetLockPassword(first.Password, null);
                    if (err is null) err = await src.LockPage(pageId!);
                    done = "Page locked"; break;
                default: err = await src.RemovePageLock(pageId!, current.Password); done = "Lock removed"; break;
            }
            busy = false;
            if (err is null) { layer!.Close(); h.Toast(done); }
            else { note.Text = err; note.Visibility = Visibility.Visible; current.Password = ""; ok.IsEnabled = Ready(); }
        }
        first.PasswordChanged += (_, _) => Refresh(); again.PasswordChanged += (_, _) => Refresh(); current.PasswordChanged += (_, _) => Refresh();
        foreach (var pb in new[] { current, first, again }) pb.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) { e.Handled = true; Send(); } };
        ok.Click += (_, _) => Send();
        ok.IsEnabled = Ready();
        var focus = withCurrent ? current : newForm ? first : mode == LockMode.RemoveLock ? current : null;
        if (focus is not null) focus.Loaded += (_, _) => focus.Focus(FocusState.Programmatic); else cancel.Loaded += (_, _) => ok.Focus(FocusState.Programmatic);
    }

    // ---------------------------------------------------------------- page icon

    public static void IconPicker(ShellHost h, string pageId, bool hasIcon)
    {
        var o = h.Overlay; var src = h.Source;
        var panel = Named("icon-picker", "Page icon", 8);
        OverlayHost.Layer? layer = null;
        var top = new Grid { ColumnSpacing = 4 };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var search = Field(o, "icon-search", "Search icons…");
        top.Children.Add(search);
        Button Ghost(string text, string id, int col)
        {
            var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 30, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6), Content = Ui.Text(text, 13, Br(o, "Text2"), 500) };
            AutomationProperties.SetAutomationId(b, id); AutomationProperties.SetName(b, text);
            Grid.SetColumn(b, col); top.Children.Add(b);
            return b;
        }
        var random = Ghost("Random", "icon-random", 1);
        var remove = Ghost("Remove", "icon-remove", 2);
        remove.Visibility = hasIcon ? Visibility.Visible : Visibility.Collapsed;
        panel.Children.Add(top);
        var grid = new StackPanel { Spacing = 2 };
        var none = Note(o, "No match. Paste any emoji and press Enter.");
        panel.Children.Add(new ScrollViewer { Height = 240, Content = grid, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        panel.Children.Add(none);
        layer = Open(o, 352, panel, 110);

        async void Pick(string? emoji)
        {
            var err = await src.SetPageIcon(pageId, emoji);
            if (err is null) layer!.Close(); else h.Toast(err, true);
        }
        void Draw()
        {
            grid.Children.Clear();
            var list = PageToolRules.FilterIcons(search.Text);
            none.Visibility = list.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            StackPanel? row = null;
            for (var i = 0; i < list.Count; i++)
            {
                if (i % 9 == 0) { row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2 }; grid.Children.Add(row); }
                var emoji = list[i].Emoji;
                var b = new Button
                {
                    Style = Ui.Style("GhostButtonStyle"), Width = 32, Height = 32, Padding = new Thickness(0), CornerRadius = new CornerRadius(6),
                    Content = new TextBlock { Text = emoji, FontSize = 20, FontFamily = new FontFamily("Segoe UI Emoji"), HorizontalAlignment = HorizontalAlignment.Center },
                };
                AutomationProperties.SetAutomationId(b, "icon-pick-" + PageToolRules.Icons.ToList().FindIndex(x => x.Emoji == emoji));
                AutomationProperties.SetName(b, list[i].Words.Split(' ')[0]);
                b.Click += (_, _) => Pick(emoji);
                row!.Children.Add(b);
            }
        }
        search.TextChanged += (_, _) => Draw();
        search.KeyDown += (_, e) =>
        {
            if (e.Key != VirtualKey.Enter) return;
            e.Handled = true;
            var list = PageToolRules.FilterIcons(search.Text);
            if (list.Count > 0) Pick(list[0].Emoji); else if (PageToolRules.AsEmoji(search.Text) is { } typed) Pick(typed);
        };
        random.Click += (_, _) => Pick(PageToolRules.Icons[Random.Shared.Next(PageToolRules.Icons.Count)].Emoji);
        remove.Click += (_, _) => Pick(null);
        search.Loaded += (_, _) => search.Focus(FocusState.Programmatic);
        Draw();
    }

    // ---------------------------------------------------------------- export

    /// <summary>Save the page as a .md file (the core's page_markdown, then the save dialog).</summary>
    public static async void ExportMarkdown(ShellHost h, string pageId, string title)
    {
        var r = await h.Source.ExportMarkdown(pageId);
        if (!r.Ok) { h.Toast(r.Error!, true); return; }
        try
        {
            var name = PageToolRules.ExportFileName(title);
            if (await MediaPicker.SaveAsync(name, new UTF8Encoding(false).GetBytes(r.Value!))) h.Toast("Exported " + name);
        }
        catch (Exception e) { h.Toast("Couldn’t save the file: " + e.Message, true); }
    }
}
