using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The Settings sections that use the core's account calls (profile, password, notifications, connected apps). All online only: offline each shows a
/// quiet "Offline" and changes nothing; a wrong current password is a message under the field.</summary>
internal sealed partial class SettingsView
{
    private TextBlock Note(string id) => Ui.Text("", 12.5, B("TextMuted"), lineHeight: 18).With(t =>
    {
        t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.Margin = new Thickness(0, 10, 0, 0);
        AutomationProperties.SetAutomationId(t, id);
    });

    private static void Say(TextBlock t, string text, Brush brush) { t.Text = text; t.Foreground = brush; AutomationProperties.SetName(t, text); }

    private void SayFail(TextBlock t, bool offline, string? error) =>
        Say(t, offline ? AccountRules.OfflineDetail : error ?? "Something went wrong.", offline ? B("TextMuted") : B("Danger"));

    private StackPanel Labeled(string label, FrameworkElement input, string id)
    {
        var sp = new StackPanel { Spacing = 6 };
        sp.Children.Add(Ui.Text(label, 13, B("Text"), 600));
        AutomationProperties.SetAutomationId(input, id);
        AutomationProperties.SetName(input, label);
        sp.Children.Add(input);
        return sp;
    }

    private static TextBox Box(string value) => new() { Text = value, Height = 36, FontSize = 14, Padding = new Thickness(10, 7, 10, 7), CornerRadius = new CornerRadius(8) };
    private static PasswordBox Secret() => new() { Height = 36, FontSize = 14, Padding = new Thickness(10, 7, 10, 7), CornerRadius = new CornerRadius(8) };

    private FrameworkElement Profile()
    {
        var w = _source.Workspace;
        var p = Page("Profile", "How you appear to your team, and how you sign in.");
        Action? _dirty = null;
        var name = Box(w.UserName);
        var color = "#f59e0b";
        var avatar = new ContentControl { VerticalAlignment = VerticalAlignment.Top };
        void DrawAvatar() => avatar.Content = Ui.Avatar(AccountRules.Initials(name.Text, w.UserEmail), 56, color);
        var swatches = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 0 };
        void DrawSwatches()
        {
            swatches.Children.Clear();
            foreach (var hex in AccountRules.Swatches)
            {
                var chosen = string.Equals(hex, color, StringComparison.OrdinalIgnoreCase);
                var dot = new Border
                {
                    Width = 20, Height = 20, CornerRadius = new CornerRadius(10), Background = Ui.Hex(hex), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
                    
                };
                var ring = new Border
                {
                    Width = 28, Height = 28, CornerRadius = new CornerRadius(14), BorderThickness = new Thickness(2),
                    BorderBrush = chosen ? B("Text") : new SolidColorBrush(Colors.Transparent), Child = dot,
                };
                var b = new Button { Style = Ui.Style("GhostButtonStyle"), Padding = new Thickness(0), CornerRadius = new CornerRadius(14), Content = ring };
                AutomationProperties.SetAutomationId(b, "settings-color-" + hex.TrimStart('#'));
                AutomationProperties.SetName(b, "Avatar colour " + hex + (chosen ? " (selected)" : ""));
                b.Click += (_, _) => { color = hex; DrawSwatches(); DrawAvatar(); _dirty?.Invoke(); };
                swatches.Children.Add(b);
            }
        }
        DrawAvatar(); DrawSwatches();
        name.TextChanged += (_, _) => DrawAvatar();

        var fields = new StackPanel { Spacing = 14 };
        fields.Children.Add(Labeled("Name", name, "settings-name"));
        fields.Children.Add(Field("Email", w.UserEmail, "settings-email"));
        fields.Children.Add(Ui.Text("Your sign-in email can’t be changed yet.", 12, B("TextMuted")).With(t => t.Margin = new Thickness(0, -8, 0, 0)));
        var sw = new StackPanel { Spacing = 6 };
        sw.Children.Add(Ui.Text("Avatar colour", 13, B("Text"), 600));
        sw.Children.Add(swatches);
        fields.Children.Add(sw);
        var row = new Grid { ColumnSpacing = 20 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.Children.Add(avatar);
        Grid.SetColumn(fields, 1);
        row.Children.Add(fields);

        var status = Note("settings-profile-status");
        var save = Dialogs.Btn(_h(), "Save changes", true, id: "settings-profile-save");
        save.HorizontalAlignment = HorizontalAlignment.Right;
        // settings.png: the card's body, then a footer under a 1 pt line with "Save changes" at the right (dim until something changed)
        string savedName = w.UserName, savedColor = color;
        void Dirty() => save.IsEnabled = name.Text != savedName || !string.Equals(color, savedColor, StringComparison.OrdinalIgnoreCase);
        var body = new StackPanel { Padding = new Thickness(20) };
        body.Children.Add(row); body.Children.Add(status);
        var footer = new Grid { Padding = new Thickness(20, 12, 20, 12) };
        footer.Children.Add(save);
        var inner = new StackPanel();
        inner.Children.Add(body); inner.Children.Add(Ui.HLine(B("Border"))); inner.Children.Add(footer);
        p.Children.Add(new Border { Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), Child = inner });
        name.TextChanged += (_, _) => Dirty();
        _dirty = Dirty;
        Dirty();

        // the server's copy of the name and colour; offline keeps what is shown
        _ = Fill();
        async Task Fill()
        {
            var r = await _source.LoadProfile();
            if (r is { Ok: true, Value: { } v }) { name.Text = v.Name; color = v.Color; savedName = v.Name; savedColor = v.Color; DrawSwatches(); DrawAvatar(); Dirty(); }
            else if (r.Offline) Say(status, AccountRules.OfflineText, B("TextMuted"));
        }
        save.Click += async (_, _) =>
        {
            if (AccountRules.NameProblem(name.Text) is { } bad) { Say(status, bad, B("Danger")); return; }
            save.IsEnabled = false; Say(status, "Saving...", B("TextMuted"));
            var r = await _source.UpdateProfile(name.Text.Trim(), color);
            if (r.Ok) { savedName = name.Text.Trim(); savedColor = color; Say(status, "Saved.", B("TextMuted")); }
            else SayFail(status, r.Offline, r.Error);
            Dirty();
        };

        if (_signOut is not null)
        {
            var out_ = Dialogs.Btn(_h(), "Sign out", false, id: "settings-signout");
            out_.Margin = new Thickness(0, 16, 0, 0);
            out_.Click += (_, _) => _signOut();
            p.Children.Add(out_);
        }
        return p;
    }

    private FrameworkElement PasswordSection()
    {
        var p = Page("Password", "Changing it signs you out everywhere else and disconnects your connected apps.");
        var cur = Secret(); var next = Secret();
        var sp = new StackPanel { Spacing = 14 };
        sp.Children.Add(Labeled("Current password", cur, "settings-password-current"));
        sp.Children.Add(Labeled("New password (at least 8 characters)", next, "settings-password-new"));
        var status = Note("settings-password-status");
        var go = Dialogs.Btn(_h(), "Change password", true, id: "settings-password-change");
        go.HorizontalAlignment = HorizontalAlignment.Left;
        sp.Children.Add(go); sp.Children.Add(status);
        p.Children.Add(Card(sp));
        go.Click += async (_, _) =>
        {
            if (AccountRules.PasswordProblem(cur.Password, next.Password) is { } bad) { Say(status, bad, B("Danger")); return; }
            go.IsEnabled = false; Say(status, "Changing...", B("TextMuted"));
            var r = await _source.ChangePassword(cur.Password, next.Password);
            go.IsEnabled = true;
            if (r.Ok) { cur.Password = ""; next.Password = ""; Say(status, "Password changed. Other devices are signed out.", B("TextMuted")); }
            else SayFail(status, r.Offline, r.Error);   // a wrong current password arrives as its own sentence
        };
        return p;
    }

    private FrameworkElement Notifications()
    {
        var p = Page("Notifications", "When Notivelo reminds you about tasks, and the daily email.");
        var body = new StackPanel { Spacing = 14 };
        var status = Note("settings-notifications-status");
        p.Children.Add(Card(body));
        _ = Load();
        async Task Load()
        {
            var r = await _source.LoadNotifications();
            if (r is not { Ok: true, Value: { } now })
            {
                body.Children.Add(Ui.Text(r.Offline ? AccountRules.OfflineText : r.Error ?? "Could not load.", 13.5, B("TextMuted"))
                    .With(t => AutomationProperties.SetAutomationId(t, "settings-notifications-offline")));
                if (r.Offline) body.Children.Add(Ui.Text("These settings need a connection.", 12.5, B("TextMuted")));
                return;
            }
            var settled = now;
            var quiet = true;   // filling the controls is not a change
            var zone = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch, Height = 36 };
            foreach (var z in AccountRules.ZonesWith(now.TimeZone)) zone.Items.Add(z);
            var email = new ToggleSwitch { OnContent = "On", OffContent = "Off" };
            var remind = Box(now.DefaultReminderTime);
            var digest = new ToggleSwitch { OnContent = "On", OffContent = "Off" };
            var digestAt = Box(now.DigestTime);
            void Show(NotificationPrefs n)
            {
                quiet = true;
                zone.SelectedItem = n.TimeZone; email.IsOn = n.EmailEnabled; remind.Text = n.DefaultReminderTime; digest.IsOn = n.DigestEnabled; digestAt.Text = n.DigestTime;
                digestAt.IsEnabled = n.DigestEnabled;
                quiet = false;
            }
            async Task Apply(NotificationChange ch)
            {
                Say(status, "Saving...", B("TextMuted"));
                var res = await _source.UpdateNotifications(ch);
                if (res is { Ok: true, Value: { } v }) { settled = v; Show(v); Say(status, "Saved.", B("TextMuted")); }
                else { Show(settled); SayFail(status, res.Offline, res.Error); }
            }
            string? Time(TextBox box, string field)
            {
                var t = AccountRules.NormalizeTime(box.Text);
                if (t is null) { Say(status, field + " must be a time like 09:00.", B("Danger")); box.Text = field == "Reminder time" ? settled.DefaultReminderTime : settled.DigestTime; }
                return t;
            }
            zone.SelectionChanged += async (_, _) => { if (!quiet && zone.SelectedItem is string z && z != settled.TimeZone) await Apply(new NotificationChange(TimeZone: z)); };
            email.Toggled += async (_, _) => { if (!quiet) await Apply(new NotificationChange(EmailEnabled: email.IsOn)); };
            digest.Toggled += async (_, _) => { if (!quiet) await Apply(new NotificationChange(DigestEnabled: digest.IsOn)); };
            async void CommitRemind() { if (!quiet && Time(remind, "Reminder time") is { } t && t != settled.DefaultReminderTime) await Apply(new NotificationChange(DefaultReminderTime: t)); }
            async void CommitDigest() { if (!quiet && Time(digestAt, "Digest time") is { } t && t != settled.DigestTime) await Apply(new NotificationChange(DigestTime: t)); }
            remind.LostFocus += (_, _) => CommitRemind();
            remind.KeyDown += (_, e) => { if (e.Key == global::Windows.System.VirtualKey.Enter) { e.Handled = true; CommitRemind(); } };
            digestAt.LostFocus += (_, _) => CommitDigest();
            digestAt.KeyDown += (_, e) => { if (e.Key == global::Windows.System.VirtualKey.Enter) { e.Handled = true; CommitDigest(); } };

            body.Children.Add(Labeled("Time zone", zone, "settings-timezone"));
            body.Children.Add(Labeled("Email reminders", email, "settings-email-reminders"));
            body.Children.Add(Labeled("Reminder time (tasks due on a day, with no time)", remind, "settings-reminder-time"));
            body.Children.Add(Labeled("Daily digest email", digest, "settings-digest"));
            body.Children.Add(Labeled("Digest time", digestAt, "settings-digest-time"));
            body.Children.Add(status);
            Show(now);
        }
        return p;
    }

    private FrameworkElement Apps()
    {
        var p = Page("Connected apps", "AI apps you allowed to read or write your notes.");
        var list = new StackPanel { Spacing = 0 };
        var status = Note("settings-apps-status");
        var card = new StackPanel();
        card.Children.Add(list); card.Children.Add(status);
        p.Children.Add(Card(card));
        _ = Load();
        async Task Load()
        {
            var r = await _source.LoadConnectedApps();
            list.Children.Clear();
            if (r is not { Ok: true, Value: { } apps })
            {
                list.Children.Add(Ui.Text(r.Offline ? AccountRules.OfflineText : r.Error ?? "Could not load.", 13.5, B("TextMuted"))
                    .With(t => AutomationProperties.SetAutomationId(t, "settings-apps-offline")));
                return;
            }
            if (apps.Count == 0) list.Children.Add(Ui.Text("No apps are connected.", 13.5, B("TextMuted")));
            var first = true;
            foreach (var app in apps)
            {
                if (!first) list.Children.Add(Ui.HLine(B("Border")).With(h => h.Margin = new Thickness(0, 12, 0, 12)));
                first = false;
                var g = new Grid { ColumnSpacing = 12 };
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                var info = new StackPanel { Spacing = 2 };
                info.Children.Add(Ui.Text(app.Name, 14, B("Text"), 600));
                info.Children.Add(Ui.Text(app.Access, 12.5, B("Text2")));
                info.Children.Add(Ui.Text("Connected " + AccountRules.DateLabel(app.ConnectedAt) + (app.LastUsed is { } u ? ", last used " + AccountRules.DateLabel(u) : ", never used"), 12.5, B("TextMuted")));
                g.Children.Add(info);
                var off = Dialogs.Btn(_h(), "Disconnect", false, id: "settings-disconnect-" + app.ClientId);
                AutomationProperties.SetName(off, "Disconnect " + app.Name);
                Grid.SetColumn(off, 1);
                var one = app;
                off.Click += (_, _) => Dialogs.Confirm(_h(), "Disconnect " + one.Name + "?", "It stops working at once. You can connect it again later.", "Disconnect", true, async () =>
                {
                    var res = await _source.DisconnectApp(one.ClientId);
                    if (!res.Ok) return res.Offline ? AccountRules.OfflineDetail : res.Error ?? "Could not disconnect.";
                    await Load();
                    return null;
                });
                g.Children.Add(off);
                list.Children.Add(g);
            }
        }
        return p;
    }
}
