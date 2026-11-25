using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>Settings > Workspace (Apple's WorkspaceSettings.swift, the web's Settings "Workspace" scope): General (rename, role, new workspace, delete or leave), Teams (create, rename,
/// subteams, members, delete), Tags (rename, colour, delete) and Activity. Everything goes through the source off the UI thread; the server's refusals show as one sentence.
/// Owners and admins change things; everyone else reads.</summary>
internal sealed partial class SettingsView
{
    private bool IsAdmin => _source.WorkspaceRole is "owner" or "admin";

    private static string Slug(string s) => PopupMenu.Slug(s);

    private Button Act(string text, string id, bool danger = false, bool primary = false, bool enabled = true)
    {
        var b = Dialogs.Btn(_h(), text, primary, danger, id);
        b.Height = 30; b.IsEnabled = enabled;
        return b;
    }

    private Button Small(string icon, string tip, string id)
    {
        var b = Ui.IconButton(icon, 15, 30, 30, tip);
        AutomationProperties.SetAutomationId(b, id);
        AutomationProperties.SetName(b, tip);
        return b;
    }

    private static Microsoft.UI.Xaml.Shapes.Ellipse Dot(Brush fill, double size = 10) => new() { Width = size, Height = size, Fill = fill, VerticalAlignment = VerticalAlignment.Center };

    private TextBlock Sentence(string text, string? id = null, bool danger = false)
    {
        var t = Ui.Text(text, 13, B(danger ? "Danger" : "TextMuted"), lineHeight: 19).With(x => { x.TextWrapping = TextWrapping.Wrap; x.TextTrimming = TextTrimming.None; });
        if (id is not null) { AutomationProperties.SetAutomationId(t, id); AutomationProperties.SetName(t, text); }
        return t;
    }

    private void Toast(string text) => Host?.Toast(text);

    // ---------------------------------------------------------------- General

    private FrameworkElement WsGeneral()
    {
        var p = Page("Workspace", "The name everyone in it sees, and what you can do here.");
        var role = _source.WorkspaceRole ?? "member";
        var admin = IsAdmin;
        var ws = _source.Workspace;
        var card = new StackPanel { Spacing = 12 };
        card.Children.Add(Ui.Text("Workspace name", 13, B("Text"), 600));
        var row = new Grid { ColumnSpacing = 10 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(new Border
        {
            Width = 36, Height = 36, CornerRadius = new CornerRadius(9), Background = B("AccentSolid"),
            Child = Ui.Text(ws.Initial, 16, B("TextOnAccent"), 700).With(t => { t.HorizontalAlignment = HorizontalAlignment.Center; t.VerticalAlignment = VerticalAlignment.Center; }),
        });
        var name = Box(ws.Name);
        name.IsEnabled = admin;
        AutomationProperties.SetAutomationId(name, "ws-name");
        AutomationProperties.SetName(name, "Workspace name");
        Grid.SetColumn(name, 1); row.Children.Add(name);
        var rename = Act("Rename", "ws-rename", primary: true, enabled: false);
        rename.Visibility = admin ? Visibility.Visible : Visibility.Collapsed;
        Grid.SetColumn(rename, 2); row.Children.Add(rename);
        card.Children.Add(row);
        var status = Note("ws-status");
        card.Children.Add(status);
        name.TextChanged += (_, _) => rename.IsEnabled = admin && name.Text.Trim().Length > 0 && name.Text.Trim() != ws.Name;
        async void Go()
        {
            if (!rename.IsEnabled) return;
            rename.IsEnabled = false;
            var err = await _source.RenameWorkspace(name.Text);
            if (err is null) { Toast("Workspace renamed"); Rebuild(); }
            else { Say(status, err, B("Danger")); rename.IsEnabled = true; }
        }
        rename.Click += (_, _) => Go();
        name.KeyDown += (_, e) => { if (e.Key == global::Windows.System.VirtualKey.Enter) { e.Handled = true; Go(); } };
        card.Children.Add(Ui.Text("Your role: " + role + " — " + RoleHelp(role), 13, B("TextMuted"), lineHeight: 19).With(t =>
        {
            t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None;
            AutomationProperties.SetAutomationId(t, "ws-role"); AutomationProperties.SetName(t, "Your role: " + role);
        }));
        p.Children.Add(Card(card));

        var more = new StackPanel { Spacing = 10 };
        more.Children.Add(Ui.Text("Another workspace", 14, B("Text"), 600));
        more.Children.Add(Sentence("A workspace has its own notebooks, tasks, people and teams. You become its owner."));
        var create = Act("New workspace", "ws-new");
        create.HorizontalAlignment = HorizontalAlignment.Left;
        create.Click += (_, _) => NewWorkspace();
        more.Children.Add(create);
        p.Children.Add(Card(more).With(c => c.Margin = new Thickness(0, 16, 0, 0)));

        var danger = new StackPanel { Spacing = 10 };
        if (role == "owner")
        {
            danger.Children.Add(Ui.Text("Danger zone", 14, B("Text"), 600));
            danger.Children.Add(Sentence("Deleting a workspace removes every notebook, page and task in it for everyone. This can’t be undone."));
            var del = Act("Delete workspace", "ws-delete", danger: true);
            del.HorizontalAlignment = HorizontalAlignment.Left;
            del.Click += (_, _) => Dialogs.Confirm(_h(), $"Delete “{ws.Name}”?", "This removes every notebook, page, task and file in it for everyone, and cannot be undone.", "Delete workspace", true, async () =>
            {
                var err = await _source.DeleteWorkspace();
                if (err is null) { Toast("Workspace deleted"); Rebuild(); }
                return err;
            });
            danger.Children.Add(del);
        }
        else
        {
            danger.Children.Add(Ui.Text("Leave workspace", 14, B("Text"), 600));
            danger.Children.Add(Sentence("You lose access to its notebooks, pages and tasks until someone invites you again."));
            var leave = Act("Leave workspace", "ws-leave");
            leave.HorizontalAlignment = HorizontalAlignment.Left;
            leave.Click += (_, _) => Dialogs.Confirm(_h(), $"Leave “{ws.Name}”?", "You can only come back if someone invites you again.", "Leave", true, async () =>
            {
                var r = await _source.LeaveWorkspace();
                if (r.Ok) Rebuild();
                return r.Ok ? null : r.Error;
            });
            danger.Children.Add(leave);
        }
        p.Children.Add(Card(danger).With(c => c.Margin = new Thickness(0, 16, 0, 0)));
        return p;
    }

    private static string RoleHelp(string role) => role switch
    {
        "owner" => "full control, including deleting the workspace",
        "admin" => "manage members and all content",
        "viewer" => "read-only access to shared notebooks",
        _ => "create and edit pages and tasks",
    };

    /// <summary>The "New workspace" form (the workspace menu and Settings share it).</summary>
    internal static void NewWorkspace(ShellHost host, Action? done = null) =>
        Dialogs.Prompt(host.Overlay, "New workspace", "Workspace name", "", "Create", async name =>
        {
            var err = await host.Source.CreateWorkspace(name);
            if (err is null) { host.Toast("Workspace created"); done?.Invoke(); }
            return err;
        });

    private void NewWorkspace() { if (Host is { } h) NewWorkspace(h, Rebuild); }

    // ---------------------------------------------------------------- Teams

    private FrameworkElement WsTeams()
    {
        var admin = IsAdmin;
        var p = Page("Teams", "A task can belong to a team, whoever it’s assigned to. Filter by team in All Tasks, group by team in Team, and type +team in quick add." + (admin ? "" : " Owners and admins manage teams."));
        var list = new StackPanel { Spacing = 0 };
        AutomationProperties.SetAutomationId(list, "ws-teams-list");
        AutomationProperties.SetName(list, "Teams");
        var status = Note("ws-teams-status");
        var bar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 0, 0, 12), Visibility = admin ? Visibility.Visible : Visibility.Collapsed };
        var create = Act("New team", "team-new");
        create.Click += (_, _) => Dialogs.Prompt(_h(), "New team", "Team name", "", "Create", async n => { var e = await _source.CreateTeam(n, null); if (e is null) await Load(); return e; });
        bar.Children.Add(create);
        p.Children.Add(bar);
        p.Children.Add(Card(list));
        p.Children.Add(status);
        _ = Load();

        async Task Load()
        {
            var r = await _source.LoadTeams();
            list.Children.Clear();
            if (!r.Ok || r.Value is null) { list.Children.Add(Sentence(r.Error ?? "Could not load the teams.", "ws-teams-error", true)); return; }
            if (r.Value.Count == 0) { list.Children.Add(Sentence(admin ? "No teams yet. Make teams like “Elders” or “Staff”, with subteams one level deep." : "No teams yet. Owners and admins can create teams.", "ws-teams-empty")); return; }
            foreach (var (t, depth) in AdminRules.OrderTeams(r.Value)) list.Children.Add(TeamRow(t, depth, admin, Load, status));
        }
        return p;
    }

    private UIElement TeamRow(TeamDetail t, int depth, bool admin, Func<Task> reload, TextBlock status)
    {
        var slug = Slug(t.Name);
        var g = new Grid { ColumnSpacing = 8, Padding = new Thickness(depth * 26, 6, 0, 6), MinHeight = 44 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.Children.Add(Dot(Ui.Hex(t.Color), 12));
        var members = _source.Members();
        var who = t.MemberIds.Select(id => members.FirstOrDefault(m => m.Id == id)?.Name).Where(n => n is not null).ToList();
        var names = new StackPanel { Spacing = 1, VerticalAlignment = VerticalAlignment.Center };
        names.Children.Add(Ui.Text(t.Name, 14, B("Text"), 600));
        names.Children.Add(Ui.Text(who.Count == 0 ? "No members" : who.Count + (who.Count == 1 ? " member: " : " members: ") + string.Join(", ", who), 12.5, B("TextMuted")));
        Grid.SetColumn(names, 1); g.Children.Add(names);
        AutomationProperties.SetAutomationId(g, "team-row-" + slug);
        AutomationProperties.SetName(g, "Team " + t.Name + ", " + (who.Count == 0 ? "no members" : string.Join(", ", who)));
        if (admin)
        {
            var acts = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2 };
            var mem = Small("users", "Members of " + t.Name, "team-members-" + slug);
            mem.Flyout = TeamMembersMenu(t, slug, members, reload, status);
            acts.Children.Add(mem);
            var ren = Small("pencil", "Rename " + t.Name, "team-rename-" + slug);
            ren.Click += (_, _) => Dialogs.Prompt(_h(), "Rename team", "Team name", t.Name, "Rename", async n => { var e = await _source.RenameTeam(t.Id, n); if (e is null) await reload(); return e; });
            acts.Children.Add(ren);
            if (depth == 0)
            {
                var sub = Small("plus", "Add a subteam to " + t.Name, "team-sub-" + slug);
                sub.Click += (_, _) => Dialogs.Prompt(_h(), "New subteam of " + t.Name, "Team name", "", "Create", async n => { var e = await _source.CreateTeam(n, t.Id); if (e is null) await reload(); return e; });
                acts.Children.Add(sub);
            }
            var del = Small("trash", "Delete " + t.Name, "team-delete-" + slug);
            del.Click += (_, _) => Dialogs.Confirm(_h(), $"Delete the team “{t.Name}”?", depth == 0 ? "Its subteams go with it, and their tasks lose the team." : "Its tasks lose the team.", "Delete team", true, async () => { var e = await _source.DeleteTeam(t.Id); if (e is null) await reload(); return e; });
            acts.Children.Add(del);
            Grid.SetColumn(acts, 2); g.Children.Add(acts);
        }
        return new Border { BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1), Child = g };
    }

    private MenuFlyout TeamMembersMenu(TeamDetail t, string slug, IReadOnlyList<MemberInfo> members, Func<Task> reload, TextBlock status)
    {
        var f = new MenuFlyout();
        var items = new List<(ToggleMenuFlyoutItem Item, string Id)>();
        foreach (var m in members)
        {
            var it = new ToggleMenuFlyoutItem { Text = m.Name.Length > 0 ? m.Name : m.Email, IsChecked = t.MemberIds.Contains(m.Id) };
            AutomationProperties.SetAutomationId(it, "team-member-" + slug + "-" + Slug(m.Name));
            AutomationProperties.SetName(it, it.Text);
            items.Add((it, m.Id));
            it.Click += async (_, _) =>
            {
                var err = await _source.SetTeamMembers(t.Id, items.Where(x => x.Item.IsChecked).Select(x => x.Id).ToList());
                if (err is not null) Say(status, err, B("Danger"));
                await reload();
            };
            f.Items.Add(it);
        }
        if (members.Count == 0) f.Items.Add(new MenuFlyoutItem { Text = "No members yet", IsEnabled = false });
        return f;
    }

    // ---------------------------------------------------------------- Tags

    private FrameworkElement WsTags()
    {
        var admin = IsAdmin;
        var p = Page("Tags", "Tags label tasks. Rename or recolour one and every task that has it follows; deleting one takes it off every task." + (admin ? "" : " Owners and admins manage tags."));
        var list = new StackPanel { Spacing = 0 };
        AutomationProperties.SetAutomationId(list, "ws-tags-list");
        AutomationProperties.SetName(list, "Tags");
        var status = Note("ws-tags-status");
        var bar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 0, 0, 12), Visibility = admin ? Visibility.Visible : Visibility.Collapsed };
        var create = Act("New tag", "tag-new");
        create.Click += (_, _) => Dialogs.Prompt(_h(), "New tag", "Tag name", "", "Create", async n =>
        {
            var made = await _source.CreateTag(n.TrimStart('#'));
            if (made is null) return "That tag couldn't be made.";
            await Load();
            return null;
        });
        bar.Children.Add(create);
        p.Children.Add(bar);
        p.Children.Add(Card(list));
        p.Children.Add(status);
        _ = Load();

        async Task Load()
        {
            var r = await _source.LoadTags();
            list.Children.Clear();
            if (!r.Ok || r.Value is null) { list.Children.Add(Sentence(r.Error ?? "Could not load the tags.", "ws-tags-error", true)); return; }
            if (r.Value.Count == 0) { list.Children.Add(Sentence("No tags yet. Type #tag in quick add, or make one here.", "ws-tags-empty")); return; }
            foreach (var t in r.Value) list.Children.Add(TagRow(t, admin, Load, status));
        }
        return p;
    }

    private UIElement TagRow(TagInfo t, bool admin, Func<Task> reload, TextBlock status)
    {
        var slug = Slug(t.Name);
        var g = new Grid { ColumnSpacing = 10, Padding = new Thickness(0, 6, 0, 6), MinHeight = 44 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var swatch = new Button { Style = Ui.Style("GhostButtonStyle"), Width = 30, Height = 30, Padding = new Thickness(0), CornerRadius = new CornerRadius(15), Content = Dot(Ui.Hex(t.Color), 16), IsEnabled = admin };
        AutomationProperties.SetAutomationId(swatch, "tag-color-" + slug);
        AutomationProperties.SetName(swatch, "Colour of " + t.Name + ", " + t.Color);
        var menu = new MenuFlyout();
        foreach (var hex in AdminRules.Colors)
        {
            var c = hex;
            var it = new MenuFlyoutItem { Text = c };
            it.Icon = new FontIcon { Glyph = "", Foreground = Ui.Hex(c) };
            AutomationProperties.SetAutomationId(it, "tag-color-" + slug + "-" + c.TrimStart('#'));
            AutomationProperties.SetName(it, c);
            it.Click += async (_, _) => { var e = await _source.RecolorTag(t.Id, c); if (e is not null) Say(status, e, B("Danger")); await reload(); };
            menu.Items.Add(it);
        }
        swatch.Flyout = menu;
        g.Children.Add(swatch);
        var nm = Ui.Text("#" + t.Name, 14, B("Text"), 600).With(x => x.VerticalAlignment = VerticalAlignment.Center);
        Grid.SetColumn(nm, 1); g.Children.Add(nm);
        AutomationProperties.SetAutomationId(g, "tag-row-" + slug);
        AutomationProperties.SetName(g, "Tag " + t.Name + ", " + t.Color);
        if (admin)
        {
            var acts = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2 };
            var ren = Small("pencil", "Rename " + t.Name, "tag-rename-" + slug);
            ren.Click += (_, _) => Dialogs.Prompt(_h(), "Rename tag", "Tag name", t.Name, "Rename", async n => { var e = await _source.RenameTag(t.Id, n); if (e is null) await reload(); return e; });
            acts.Children.Add(ren);
            var del = Small("trash", "Delete " + t.Name, "tag-delete-" + slug);
            del.Click += (_, _) => Dialogs.Confirm(_h(), $"Delete the tag “{t.Name}”?", "It comes off every task that has it. This can’t be undone.", "Delete tag", true, async () => { var e = await _source.DeleteTag(t.Id); if (e is null) await reload(); return e; });
            acts.Children.Add(del);
            Grid.SetColumn(acts, 2); g.Children.Add(acts);
        }
        return new Border { BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1), Child = g };
    }

    // ---------------------------------------------------------------- Activity

    private FrameworkElement WsActivity()
    {
        var p = Page("Activity", "What people did in this workspace lately: pages, tasks and people. Entries appear a moment after the change.");
        var list = new StackPanel { Spacing = 0 };
        AutomationProperties.SetAutomationId(list, "activity-list");
        AutomationProperties.SetName(list, "Activity");
        var more = Act("Show older", "activity-more");
        more.HorizontalAlignment = HorizontalAlignment.Left; more.Margin = new Thickness(0, 12, 0, 0); more.Visibility = Visibility.Collapsed;
        var status = Sentence("Loading…", "activity-status");
        long? last = null;
        p.Children.Add(Card(list));
        p.Children.Add(status);
        p.Children.Add(more);
        more.Click += async (_, _) => await Load(false);
        _ = Load(true);

        async Task Load(bool first)
        {
            var r = await _source.LoadActivity(first ? null : last);
            if (!r.Ok || r.Value is null) { Say(status, r.Error ?? "Could not load the activity.", B("Danger")); return; }
            if (first) list.Children.Clear();
            foreach (var a in r.Value) list.Children.Add(ActivityRow(a));
            if (r.Value.Count > 0) last = r.Value[^1].Id;
            more.Visibility = r.Value.Count >= 50 ? Visibility.Visible : Visibility.Collapsed;
            Say(status, list.Children.Count == 0 ? "Nothing has happened yet." : "", B("TextMuted"));
            AutomationProperties.SetItemStatus(list, "entries=" + list.Children.Count);
        }
        return p;
    }

    private UIElement ActivityRow(ActivityItem a)
    {
        var when = AdminRules.When(a.CreatedAt, DateTimeOffset.UtcNow);
        var g = new Grid { ColumnSpacing = 10, Padding = new Thickness(0, 8, 0, 8) };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(Ui.Avatar(AccountRules.Initials(a.Actor, ""), 28, a.ActorColor ?? "#888888"));
        var text = new TextBlock { TextWrapping = TextWrapping.Wrap, FontSize = 13.5, Foreground = B("Text2"), LineHeight = 20 };
        text.Inlines.Add(new Run { Text = a.Actor, FontWeight = FontWeights.SemiBold, Foreground = B("Text") });
        text.Inlines.Add(new Run { Text = " " + a.Summary });
        var col = new StackPanel { Spacing = 1 };
        col.Children.Add(text);
        col.Children.Add(Ui.Text(when, 12, B("TextMuted")));
        Grid.SetColumn(col, 1); g.Children.Add(col);
        var line = a.Actor + " " + a.Summary + ", " + when;
        if (!AdminRules.CanOpen(a.TargetType)) { AutomationProperties.SetAutomationId(g, "activity-" + a.Id); AutomationProperties.SetName(g, line); return Wrap(g); }
        var b = new Button { Style = Ui.Style("GhostButtonStyle"), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Padding = new Thickness(0), CornerRadius = new CornerRadius(6), Content = g };
        AutomationProperties.SetAutomationId(b, "activity-" + a.Id);
        AutomationProperties.SetName(b, line);
        b.Click += (_, _) => { if (a.TargetType == "page") Host?.OpenPage(a.TargetId); else Host?.OpenTask(a.TargetId); };
        return Wrap(b);

        UIElement Wrap(UIElement e) => new Border { BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1), Child = e };
    }
}
