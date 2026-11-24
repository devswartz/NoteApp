using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Windows.ApplicationModel.DataTransfer;
using Windows.System;
using static Notivelo.Windows.Views.PageDialogs;

namespace Notivelo.Windows.Views;

/// <summary>The workspace's people on the overlay (PARITY batch 3; Apple's Shell/Members.swift): the Members dialog (members and roles, pending email invites, an invite
/// field, Leave workspace) and "Join with an invite link". Reached from the workspace menu. Calls go through the source off the UI thread; the server's refusals
/// (403 role, 404 gone, 409 already a member, 410 expired) come back as one sentence.</summary>
internal static class PeopleDialogs
{
    private static string Slug(string s) => PopupMenu.Slug(s);

    private static Button Ghost(OverlayHost o, string text, string id, string name, bool chevron = false, bool bordered = false, bool enabled = true)
    {
        var b = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6), IsEnabled = enabled };
        if (bordered) { b.BorderBrush = Br(o, "Border"); b.BorderThickness = new Thickness(1); }
        var s = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        s.Children.Add(Ui.Text(text, 12.5, Br(o, bordered ? "Text2" : "Text2"), 500));
        if (chevron) s.Children.Add(new Icon("chevron-down", 12, Br(o, "TextMuted")));
        b.Content = s;
        AutomationProperties.SetAutomationId(b, id);
        AutomationProperties.SetName(b, name);
        return b;
    }

    // ---------------------------------------------------------------- Members

    public static void Members(ShellHost h)
    {
        var o = h.Overlay; var src = h.Source;
        var myRole = src.WorkspaceRole ?? "member";
        var canManage = PeopleRules.CanManage(myRole);
        var wsName = src.Workspace.Name;
        var panel = Named("members-dialog", "Members");
        OverlayHost.Layer? layer = null;
        panel.Children.Add(Header(o, "Members", $"People in “{wsName}”." + (canManage ? " Invite someone by email, or change what a member can do." : ""), () => layer?.Close(), "members-x"));

        PeopleInfo? data = null; var busy = false; string? inviteUrl = null; var inviteRole = "member"; var confirmLeave = false;
        var inviteRow = new Grid { ColumnSpacing = 8, Visibility = canManage ? Visibility.Visible : Visibility.Collapsed };
        inviteRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        inviteRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        inviteRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var email = Field(o, "members-invite-email", "Email address");
        inviteRow.Children.Add(email);
        var roleBtn = Ghost(o, "Member", "members-invite-role", "Role for the invite", chevron: true, bordered: true);
        roleBtn.Height = 36;
        Grid.SetColumn(roleBtn, 1); inviteRow.Children.Add(roleBtn);
        var invite = Dialogs.Btn(o, "Invite", true, id: "members-invite-submit");
        Grid.SetColumn(invite, 2); inviteRow.Children.Add(invite);
        panel.Children.Add(inviteRow);

        var linkBox = new StackPanel(); var error = Note(o, "", true, "members-error"); error.Visibility = Visibility.Collapsed; var list = new StackPanel();
        panel.Children.Add(linkBox); panel.Children.Add(error);
        panel.Children.Add(new ScrollViewer { MaxHeight = 320, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        var foot = new Grid(); foot.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        foot.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var footL = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 }; var footR = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        foot.Children.Add(footL); Grid.SetColumn(footR, 1); foot.Children.Add(footR);
        foot.Margin = new Thickness(0, 6, 0, 0);
        panel.Children.Add(foot);
        layer = Open(o, 520, panel, 80);

        void Fail(string e) { busy = false; error.Text = e; error.Visibility = Visibility.Visible; DrawAll(); }
        void ClearError() => error.Visibility = Visibility.Collapsed;
        bool CanInvite() => !busy && canManage && PageToolRules.LooksLikeEmail(email.Text.Trim());

        void DrawInvite()
        {
            ((TextBlock)((StackPanel)roleBtn.Content).Children[0]).Text = PeopleRules.RoleLabel(inviteRole);
            AutomationProperties.SetItemStatus(roleBtn, "role=" + inviteRole);
            invite.IsEnabled = CanInvite();
        }
        void DrawLink()
        {
            linkBox.Children.Clear();
            if (inviteUrl is null) return;
            var g = new Grid { ColumnSpacing = 8, Padding = new Thickness(8) };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var url = Wrap(Ui.Text(inviteUrl, 12, Br(o, "Text2")));
            url.FontFamily = Ui.Mono; url.TextTrimming = TextTrimming.CharacterEllipsis; url.MaxLines = 2;
            AutomationProperties.SetAutomationId(url, "members-invite-url"); AutomationProperties.SetName(url, inviteUrl);
            g.Children.Add(url);
            var copy = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(8, 0, 8, 0), CornerRadius = new CornerRadius(6) };
            var cs = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            cs.Children.Add(new Icon("copy", 14, Br(o, "Text"))); cs.Children.Add(Ui.Text("Copy link", 12.5, Br(o, "Text"), 500));
            copy.Content = cs;
            AutomationProperties.SetAutomationId(copy, "members-invite-copy"); AutomationProperties.SetName(copy, "Copy link");
            var copyUrl = inviteUrl;
            copy.Click += (_, _) =>
            {
                try { var dp = new DataPackage(); dp.SetText(copyUrl); Clipboard.SetContent(dp); } catch (Exception) { }
                cs.Children.Clear(); cs.Children.Add(new Icon("check", 14, Br(o, "Text"))); cs.Children.Add(Ui.Text("Copied", 12.5, Br(o, "Text"), 500));
                AutomationProperties.SetItemStatus(copy, "copied=1");
            };
            Grid.SetColumn(copy, 1); g.Children.Add(copy);
            linkBox.Children.Add(new Border { Background = Br(o, "BgSubtle"), BorderBrush = Br(o, "Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Child = g });
        }
        void DrawList()
        {
            list.Children.Clear();
            if (data is null) { list.Children.Add(Note(o, "Loading…", id: "members-loading")); return; }
            AutomationProperties.SetItemStatus(panel, $"members={data.Members.Count} invites={data.Invites.Count} role={myRole}");
            foreach (var m in data.Members)
            {
                var member = m;
                var me = m.Id == src.UserId;
                var editable = PeopleRules.CanEditMember(myRole, m.Role, me);
                var g = new Grid { ColumnSpacing = 6, Margin = new Thickness(0, 4, 0, 4) };
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                g.Children.Add(Person(o, m.Name, m.Email, m.Color, me ? "you" : null));
                var rb = Ghost(o, PeopleRules.RoleLabel(m.Role), "member-role-" + m.Id, $"{m.Name}: {PeopleRules.RoleLabel(m.Role)}", chevron: editable, bordered: true, enabled: editable);
                AutomationProperties.SetItemStatus(rb, "role=" + m.Role);
                rb.Click += (_, _) => PopupMenu.Show(o, PeopleRules.RolesFor(myRole).Select(r =>
                    new MenuEntry(PeopleRules.RoleLabel(r), Check: r == member.Role, Id: $"member-role-opt-{r}", Click: () => _ = SetRole(member, r))).ToList(), rb, endAlign: true, width: 160);
                Grid.SetColumn(rb, 1); g.Children.Add(rb);
                if (editable)
                {
                    var rm = Ui.IconButton("x", 14, 28, 28, "Remove " + m.Name);
                    AutomationProperties.SetAutomationId(rm, "member-remove-" + m.Id); AutomationProperties.SetName(rm, "Remove " + m.Name);
                    rm.Click += (_, _) => _ = Remove(member);
                    Grid.SetColumn(rm, 2); g.Children.Add(rm);
                }
                list.Children.Add(g);
            }
            if (data.Invites.Count > 0)
            {
                list.Children.Add(Ui.Text("PENDING INVITES", 11, Br(o, "TextMuted"), 600, tracking: 0.04).With(t => t.Margin = new Thickness(0, 10, 0, 2)));
                foreach (var i in data.Invites)
                {
                    var inv = i;
                    var g = new Grid { ColumnSpacing = 6, Margin = new Thickness(0, 4, 0, 4) };
                    g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                    g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    g.Children.Add(new Border { Width = 28, Height = 28, CornerRadius = new CornerRadius(14), Background = Br(o, "BgSubtle"), Child = new Icon("mail", 14, Br(o, "TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } });
                    var col = new StackPanel { Spacing = 1, Margin = new Thickness(6, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
                    col.Children.Add(Ui.Text(i.Email, 14, Br(o, "Text")));
                    col.Children.Add(Ui.Text("Invited as " + i.Role, 12, Br(o, "TextMuted")));
                    Grid.SetColumn(col, 1); g.Children.Add(col);
                    var slug = Slug(i.Email);
                    var resend = Ghost(o, "Resend", "invite-resend-" + slug, "Resend the invite for " + i.Email);
                    resend.Click += (_, _) => _ = Resend(inv);
                    Grid.SetColumn(resend, 2); g.Children.Add(resend);
                    var rv = Ui.IconButton("x", 14, 28, 28, "Cancel the invite for " + i.Email);
                    AutomationProperties.SetAutomationId(rv, "invite-revoke-" + slug); AutomationProperties.SetName(rv, "Cancel the invite for " + i.Email);
                    rv.Click += (_, _) => _ = Revoke(inv);
                    Grid.SetColumn(rv, 3); g.Children.Add(rv);
                    list.Children.Add(g);
                }
            }
        }
        void DrawFoot()
        {
            footL.Children.Clear(); footR.Children.Clear();
            if (confirmLeave)
            {
                var cancel = Dialogs.Btn(o, "Cancel", false, id: "members-leave-cancel"); cancel.Click += (_, _) => { confirmLeave = false; DrawFoot(); };
                var go = Dialogs.Btn(o, $"Leave “{wsName}”", false, true, "members-leave-confirm"); go.IsEnabled = !busy; go.Click += (_, _) => _ = Leave();
                footR.Children.Add(cancel); footR.Children.Add(go);
            }
            else
            {
                var leave = Dialogs.Btn(o, "Leave workspace", false, id: "members-leave"); leave.Click += (_, _) => { confirmLeave = true; ClearError(); DrawFoot(); };
                var done = Dialogs.Btn(o, "Done", true, id: "members-done"); done.Click += (_, _) => layer.Close();
                footL.Children.Add(leave); footR.Children.Add(done);
            }
        }
        void DrawAll() { DrawInvite(); DrawLink(); DrawList(); DrawFoot(); }

        async Task Reload()
        {
            var r = await src.LoadPeople();
            busy = false;
            if (r.Ok) { data = r.Value; DrawAll(); }
            else { data ??= new PeopleInfo(Array.Empty<MemberInfo>(), Array.Empty<PendingInviteInfo>()); Fail(r.Error!); }
        }
        async Task Invite()
        {
            if (!CanInvite()) return;
            var to = email.Text.Trim(); busy = true; ClearError(); DrawInvite();
            var r = await src.InviteToWorkspace(to, inviteRole);
            if (!r.Ok) { Fail(r.Error!); return; }
            email.Text = "";
            inviteUrl = r.Value!.Status == "invited" ? r.Value.InviteUrl : null;   // always offered, in case the email lands in spam or the server sends none
            h.Toast(PeopleRules.InvitedToast(r.Value, to));
            await Reload();
        }
        async Task Resend(PendingInviteInfo i)
        {
            ClearError();
            var r = await src.ResendWorkspaceInvite(i.Email);
            if (!r.Ok) { Fail(r.Error!); return; }
            inviteUrl = r.Value!.InviteUrl;
            h.Toast(PeopleRules.ResentToast(r.Value, i.Email));
            await Reload();
        }
        async Task Revoke(PendingInviteInfo i)
        {
            ClearError();
            var r = await src.RevokeWorkspaceInvite(i.Email);
            if (!r.Ok) { Fail(r.Error!); return; }
            await Reload();
        }
        async Task SetRole(MemberInfo m, string role)
        {
            if (role == m.Role) return;
            ClearError();
            var r = await src.SetMemberRole(m.Id, role);
            if (!r.Ok) { Fail(r.Error!); return; }
            h.Toast($"{m.Name} is {role} now");
            await Reload();
        }
        async Task Remove(MemberInfo m)
        {
            ClearError();
            var r = await src.RemoveMember(m.Id);
            if (!r.Ok) { Fail(r.Error!); return; }
            h.Toast("Removed " + m.Name);
            await Reload();
        }
        async Task Leave()
        {
            busy = true; ClearError(); DrawFoot();
            var r = await src.LeaveWorkspace();
            if (!r.Ok) { confirmLeave = false; Fail(r.Error!); return; }
            layer.Close();
            h.Toast("You left the workspace");
        }

        roleBtn.Click += (_, _) => PopupMenu.Show(o, PeopleRules.RolesFor(myRole).Select(r =>
            new MenuEntry(PeopleRules.RoleLabel(r), Check: r == inviteRole, Id: $"members-invite-role-{r}", Click: () => { inviteRole = r; DrawInvite(); })).ToList(), roleBtn, endAlign: true, width: 160);
        email.TextChanged += (_, _) => DrawInvite();
        email.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) { e.Handled = true; _ = Invite(); } };
        invite.Click += (_, _) => _ = Invite();
        email.Loaded += (_, _) => { if (canManage) email.Focus(FocusState.Programmatic); };
        DrawAll();
        _ = Reload();
    }

    // ---------------------------------------------------------------- Join with an invite link

    /// <summary>Paste a link (or its last part), see what it is for, accept. The account's email must be the invited one (the server says so otherwise).</summary>
    public static void JoinInvite(ShellHost h, string? token = null)
    {
        var o = h.Overlay; var src = h.Source;
        var panel = Named("join-dialog", "Join with an invite link");
        OverlayHost.Layer? layer = null;
        panel.Children.Add(Header(o, "Join with an invite link", null, () => layer?.Close(), "join-x"));
        var input = Field(o, "join-input", "Paste the link from your email");
        var body = new StackPanel { Spacing = 6 };
        var error = Note(o, "", true, "join-error"); error.Visibility = Visibility.Collapsed;
        var form = Labelled(o, "Invite link", input);
        panel.Children.Add(form);
        panel.Children.Add(body); panel.Children.Add(error);
        var cancel = Dialogs.Btn(o, "Cancel", false, id: "join-cancel");
        var go = Dialogs.Btn(o, "Continue", true, id: "join-continue");
        panel.Children.Add(Foot(cancel, go));
        layer = Open(o, 440, panel, 120);
        cancel.Click += (_, _) => layer.Close();

        InviteLinkInfo? info = null; string shown = ""; var busy = false;
        void Draw()
        {
            body.Children.Clear();
            form.Visibility = info is null ? Visibility.Visible : Visibility.Collapsed;
            if (info is not null)
            {
                var box = new StackPanel { Spacing = 6, Padding = new Thickness(12) };
                AutomationProperties.SetAutomationId(box, "join-info"); AutomationProperties.SetName(box, "Invite");
                if (info.PageTitle is { } pt)
                {
                    box.Children.Add(Wrap(Ui.Text($"{info.InvitedBy} shared “{(pt.Length == 0 ? "Untitled" : pt)}” with you", 14, Br(o, "Text"), 500)));
                    box.Children.Add(Wrap(Ui.Text($"In “{info.WorkspaceName}”. You can {(info.PageCanEdit ? "edit" : "view")} it.", 13, Br(o, "Text2"))));
                }
                else
                {
                    box.Children.Add(Wrap(Ui.Text($"{info.InvitedBy} invited you to “{info.WorkspaceName}”", 14, Br(o, "Text"), 500)));
                    box.Children.Add(Wrap(Ui.Text($"You join as {info.Role}.", 13, Br(o, "Text2"))));
                }
                box.Children.Add(Note(o, $"Sent to {info.Email}. Only that account can accept it."));
                if (info.Expired) box.Children.Add(Note(o, "This invite has expired. Ask for a new one.", true, "join-expired"));
                body.Children.Add(new Border { Background = Br(o, "BgSubtle"), BorderBrush = Br(o, "Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Child = box });
            }
            var label = info is null ? (busy ? "Looking…" : "Continue") : busy ? "Joining…" : info.PageTitle is not null ? "Open the page" : "Join";
            go.Content = Ui.Text(label, 13.5, Br(o, "TextOnAccent"), 600);
            AutomationProperties.SetName(go, label);
            AutomationProperties.SetItemStatus(panel, info is null ? "step=link" : "step=accept");
            go.IsEnabled = !busy && (info is null ? PeopleRules.TokenFromLink(input.Text).Length > 0 : !info.Expired);
        }
        void Fail(string e) { busy = false; error.Text = e; error.Visibility = Visibility.Visible; Draw(); }
        async Task Look()
        {
            var t = PeopleRules.TokenFromLink(input.Text);
            if (t.Length == 0 || busy) return;
            busy = true; error.Visibility = Visibility.Collapsed; Draw();
            var r = await src.LookUpInvite(t);
            if (!r.Ok) { Fail(r.Error!); return; }
            busy = false; info = r.Value; shown = t; Draw();
        }
        async Task Accept()
        {
            if (info is null || busy) return;
            busy = true; error.Visibility = Visibility.Collapsed; Draw();
            var name = info.WorkspaceName; var isPage = info.PageTitle is not null;
            var r = await src.AcceptInvite(shown);
            if (!r.Ok) { Fail(r.Error!); return; }
            layer.Close();
            if (r.Value!.PageId is { } pid) h.OpenPage(pid);
            h.Toast(isPage ? "The page is shared with you" : $"You joined “{name}”");
        }
        go.Click += (_, _) => _ = info is null ? Look() : Accept();
        input.TextChanged += (_, _) => Draw();
        input.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) { e.Handled = true; _ = Look(); } };
        input.Loaded += (_, _) => input.Focus(FocusState.Programmatic);
        Draw();
        if (!string.IsNullOrWhiteSpace(token)) { input.Text = token; _ = Look(); }
    }
}
