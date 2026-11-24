using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Windows.System;

namespace Notivelo.Windows.Views;

/// <summary>Settings > Profile > Delete account (Apple's delete-account sheet): the server's preview of what happens to each workspace, your password, a wrong-password message under
/// the field, then the sign-in screen (the core signs out and clears this device's copy; the sample never deletes anything).</summary>
internal static class DeleteAccountDialog
{
    public static void Show(ShellHost h, Action? signOut)
    {
        var o = h.Overlay; var src = h.Source;
        Brush B(string k) => ThemeBrushes.Get(k, o);
        var panel = new StackPanel { Spacing = 10 };
        AutomationProperties.SetAutomationId(panel, "delete-account-dialog");
        AutomationProperties.SetName(panel, "Delete account");
        panel.Children.Add(Ui.Text("Delete your account?", 16, B("Text"), 650));
        panel.Children.Add(Ui.Text("This can’t be undone. Here is what will happen:", 13.5, B("Text2")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; }));
        var preview = new StackPanel { Spacing = 6 };
        AutomationProperties.SetAutomationId(preview, "delete-account-preview");
        AutomationProperties.SetName(preview, "What will happen");
        panel.Children.Add(preview);
        var pw = new PasswordBox { Height = 36, FontSize = 14, Padding = new Thickness(10, 7, 10, 7), CornerRadius = new CornerRadius(8), PlaceholderText = "Your password", IsEnabled = false };
        AutomationProperties.SetAutomationId(pw, "delete-account-password");
        AutomationProperties.SetName(pw, "Your password");
        panel.Children.Add(Ui.Text("Enter your password to confirm", 12.5, B("TextMuted")));
        panel.Children.Add(pw);
        var error = Ui.Text("", 12.5, B("Danger"));
        error.TextWrapping = TextWrapping.Wrap; error.TextTrimming = TextTrimming.None; error.Visibility = Visibility.Collapsed;
        AutomationProperties.SetAutomationId(error, "delete-account-error");
        panel.Children.Add(error);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 6, 0, 0) };
        var cancel = Dialogs.Btn(o, "Cancel", false, id: "delete-account-cancel");
        var ok = Dialogs.Btn(o, "Delete account", false, danger: true, id: "delete-account-confirm");
        ok.IsEnabled = false;
        row.Children.Add(cancel); row.Children.Add(ok);
        panel.Children.Add(row);
        var layer = o.Show(Dialogs.Card(o, 460, panel), HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, 100, 0, 0));
        cancel.Click += (_, _) => layer.Close();

        var ready = false; var busy = false;
        void Fail(string text) { error.Text = text; error.Visibility = Visibility.Visible; AutomationProperties.SetName(error, text); }
        void Update() => ok.IsEnabled = ready && !busy && pw.Password.Length > 0;
        void Line(string text)
        {
            var g = new Grid { ColumnSpacing = 8 };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.Children.Add(Ui.Text("•", 13.5, B("TextMuted")));
            var t = Ui.Text(text, 13.5, B("Text")); t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None;
            Grid.SetColumn(t, 1); g.Children.Add(t);
            preview.Children.Add(g);
        }
        preview.Children.Add(Ui.Text("Checking…", 13, B("TextMuted")));
        _ = Load();
        async Task Load()
        {
            var r = await src.LoadDeletionPreview();
            preview.Children.Clear();
            if (r is { Ok: true, Value: { } p })
            {
                var lines = AuditRules.DeletionLines(p);
                if (lines.Count == 0) lines = new[] { "Your profile and sign-in will be deleted." }.ToList();
                foreach (var l in lines) Line(l);
                AutomationProperties.SetItemStatus(preview, "lines=" + lines.Count);
                ready = true; pw.IsEnabled = true; pw.Focus(FocusState.Programmatic);
            }
            else
            {
                var text = r.Offline ? AccountRules.OfflineDetail : r.Error ?? "Something went wrong.";
                preview.Children.Add(Ui.Text(text, 13, r.Offline ? B("TextMuted") : B("Danger")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; }));
                AutomationProperties.SetItemStatus(preview, "lines=0");
            }
            Update();
        }
        pw.PasswordChanged += (_, _) => { error.Visibility = Visibility.Collapsed; Update(); };
        pw.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter && ok.IsEnabled) { e.Handled = true; Go(); } };
        ok.Click += (_, _) => Go();
        async void Go()
        {
            if (!ok.IsEnabled) return;
            busy = true; Update();
            var r = await src.DeleteAccount(pw.Password);
            busy = false;
            if (r.Ok)
            {
                layer.Close();
                // the core has signed out and cleared this device's copy: back to the sign-in screen (the sample has none, it only says so)
                if (signOut is not null) signOut(); else h.Toast("Account deleted (sample data: nothing was deleted)");
                return;
            }
            Fail(r.Offline ? AccountRules.OfflineDetail : r.Code == "wrong_password" ? "That password is not right. Try again." : r.Error ?? "Something went wrong.");
            pw.Password = ""; error.Visibility = Visibility.Visible; pw.Focus(FocusState.Programmatic);
            Update();
        }
    }
}
