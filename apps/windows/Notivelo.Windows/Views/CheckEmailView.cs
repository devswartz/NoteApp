using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>"Check your email" (Apple's CheckEmail.swift, src/pages/CheckEmail.tsx): shown instead of the app to a signed-in person whose address isn't confirmed yet.
/// "I've verified, continue" asks the server again; "Sign out" is for a wrong address. There is no Resend: the core has no resend-verification call yet.</summary>
internal sealed class CheckEmailView : UserControl
{
    private readonly AppSession _session;
    private bool _checking;
    private string? _info;

    public CheckEmailView(AppSession session)
    {
        _session = session;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        VerticalContentAlignment = VerticalAlignment.Stretch;
        IsTabStop = false;
        Loaded += (_, _) => Render();
        ActualThemeChanged += (_, _) => Render();
    }

    private Brush B(string key) => ThemeBrushes.Get(key, this);

    private void Render()
    {
        var root = new Grid { Background = B("BgSubtle") };
        var col = new StackPanel { Spacing = 16, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Padding = new Thickness(16, 24, 16, 24), MaxWidth = 432 };
        var card = new StackPanel { Spacing = 0 };
        AutomationProperties.SetAutomationId(card, "check-email");
        AutomationProperties.SetName(card, "Check your email");
        card.Children.Add(AuthParts.Logo(B));
        card.Children.Add(Ui.Text("Check your email", 22, B("Text"), 700, tracking: -0.02).With(t => t.Margin = new Thickness(0, 20, 0, 0)));

        var email = _session.User?.Email ?? "";
        var body = new TextBlock { TextWrapping = TextWrapping.Wrap, FontSize = 13.5, FontFamily = Ui.Font, Foreground = B("TextMuted"), LineHeight = 20, Margin = new Thickness(0, 4, 0, 0) };
        body.Inlines.Add(new Run { Text = "We sent a confirmation link to " });
        body.Inlines.Add(new Run { Text = email, FontWeight = new global::Windows.UI.Text.FontWeight(600) });
        body.Inlines.Add(new Run { Text = ". Open it to start using Notivelo. The link works once, for 24 hours." });
        AutomationProperties.SetAutomationId(body, "check-email-text");
        AutomationProperties.SetName(body, $"We sent a confirmation link to {email}. Open it to start using Notivelo. The link works once, for 24 hours.");
        card.Children.Add(body);

        if (_info is not null)
        {
            var info = Ui.Text(_info, 12.5, B("TextMuted"));
            info.TextWrapping = TextWrapping.Wrap; info.TextTrimming = TextTrimming.None; info.Margin = new Thickness(0, 14, 0, 0);
            AutomationProperties.SetAutomationId(info, "check-email-info");
            AutomationProperties.SetName(info, _info);
            card.Children.Add(info);
        }

        var go = AuthParts.Accent(B, _checking ? "Checking…" : "I’ve verified, continue", !_checking, "check-email-continue");
        go.Margin = new Thickness(0, 20, 0, 0);
        go.Click += (_, _) =>
        {
            if (_checking) return;
            _checking = true; _info = null; Render();
            _session.RecheckEmail(message => { _checking = false; _info = message; if (IsLoaded) Render(); });
        };
        card.Children.Add(go);

        var wrong = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 20, 0, 0) };
        wrong.Children.Add(Ui.Text("Wrong address?", 12.5, B("TextMuted")));
        var so = AuthParts.Link(B, "Sign out", 12.5, "check-email-signout");
        so.Click += (_, _) => _session.SignOut();
        wrong.Children.Add(so);
        card.Children.Add(wrong);

        col.Children.Add(AuthParts.Frame(B, card));
        root.Children.Add(col);
        Content = root;
    }
}
