using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>Settings (Apple's SettingsScreen.swift, settings.png), with only what the Windows app can back today: Profile (who is signed in, Sign out),
/// Appearance (Light / Dark / Hybrid) and About (server, version). Password, security, notifications, connected apps and the avatar colour need calls the
/// Windows app doesn't have yet, so they are not drawn.</summary>
internal sealed class SettingsView : ThemedControl
{
    private readonly INotesSource _source;
    private readonly Func<ThemeMode> _theme;
    private readonly Action<ThemeMode> _setTheme;
    private readonly Action? _signOut;
    private readonly string? _server;
    private string _section = "profile";

    public SettingsView(INotesSource source, Func<ThemeMode> theme, Action<ThemeMode> setTheme, Action? signOut, string? server)
    {
        _source = source; _theme = theme; _setTheme = setTheme; _signOut = signOut; _server = server;
    }

    public void Refresh() => Rebuild();
    public void Show(string section) { _section = section; Rebuild(); }

    protected override UIElement Build()
    {
        var root = new Grid { Padding = new Thickness(40, 30, 40, 24), ColumnSpacing = 40 };
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(200) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        AutomationProperties.SetAutomationId(root, "settings-root");

        var nav = new StackPanel { Spacing = 2 };
        nav.Children.Add(Ui.Text("Settings", 20, B("Text"), 700, lineHeight: 28).With(t => t.Margin = new Thickness(0, 0, 0, 14)));
        nav.Children.Add(Ui.Text("Account", 12, B("TextMuted"), 600).With(t => t.Margin = new Thickness(8, 0, 0, 4)));
        nav.Children.Add(NavRow("profile", "user", "Profile"));
        nav.Children.Add(NavRow("appearance", "palette", "Appearance"));
        nav.Children.Add(Ui.Text("App", 12, B("TextMuted"), 600).With(t => t.Margin = new Thickness(8, 14, 0, 4)));
        nav.Children.Add(NavRow("about", "info", "About"));
        root.Children.Add(nav);

        var content = _section switch { "appearance" => Appearance(), "about" => About(), _ => Profile() };
        content.MaxWidth = 590; content.HorizontalAlignment = HorizontalAlignment.Left;
        Grid.SetColumn(content, 1);
        root.Children.Add(content);
        return new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    private UIElement NavRow(string key, string icon, string label)
    {
        var active = _section == key;
        var g = new Grid { ColumnSpacing = 10 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(new Icon(icon, 15, active ? B("Accent") : B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        g.Children.Add(Ui.Text(label, 14, active ? B("Accent") : B("Text2"), active ? 500 : 400).With(t => Grid.SetColumn(t, 1)));
        var b = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 32, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(7), HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g, Background = active ? B("AccentSoft") : null,
        };
        AutomationProperties.SetAutomationId(b, "settings-section-" + key);
        AutomationProperties.SetName(b, label);
        b.Click += (_, _) => Show(key);
        return b;
    }

    private StackPanel Page(string title, string sub)
    {
        var p = new StackPanel { Spacing = 0 };
        p.Children.Add(Ui.Text(title, 20, B("Text"), 700, lineHeight: 28));
        p.Children.Add(Ui.Text(sub, 13.5, B("TextMuted"), lineHeight: 20).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.Margin = new Thickness(0, 2, 0, 18); }));
        return p;
    }

    private Border Card(UIElement content) => new()
    {
        Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), Padding = new Thickness(20), Child = content,
    };

    private UIElement Field(string label, string value, string id)
    {
        var sp = new StackPanel { Spacing = 6 };
        sp.Children.Add(Ui.Text(label, 13, B("Text"), 600));
        var box = new TextBox { Text = value, IsReadOnly = true, Height = 36, FontSize = 14, Padding = new Thickness(10, 7, 10, 7), CornerRadius = new CornerRadius(8) };
        AutomationProperties.SetAutomationId(box, id);
        AutomationProperties.SetName(box, label);
        sp.Children.Add(box);
        return sp;
    }

    private FrameworkElement Profile()
    {
        var w = _source.Workspace;
        var p = Page("Profile", "How you appear to your team, and how you sign in.");
        var row = new Grid { ColumnSpacing = 20 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.Children.Add(Ui.Avatar(w.UserInitials, 56).With(a => a.VerticalAlignment = VerticalAlignment.Top));
        var fields = new StackPanel { Spacing = 14 };
        fields.Children.Add(Field("Name", w.UserName, "settings-name"));
        fields.Children.Add(Field("Email", w.UserEmail, "settings-email"));
        Grid.SetColumn(fields, 1);
        row.Children.Add(fields);
        p.Children.Add(Card(row));
        if (_signOut is not null)
        {
            var out_ = Dialogs.Btn(_h(), "Sign out", false, id: "settings-signout");
            out_.Margin = new Thickness(0, 16, 0, 0);
            out_.Click += (_, _) => _signOut();
            p.Children.Add(out_);
        }
        return p;
    }

    private OverlayHost _h() => Host!.Overlay;
    internal ShellHost? Host { get; set; }

    private FrameworkElement Appearance()
    {
        var p = Page("Appearance", "Light, Dark, or Hybrid: dark chrome around a light page.");
        var now = _theme();
        var track = new Grid { ColumnSpacing = 8 };
        var modes = new[] { (ThemeMode.Light, "Light", "sun"), (ThemeMode.Dark, "Dark", "moon"), (ThemeMode.Hybrid, "Hybrid", "contrast") };
        for (var i = 0; i < modes.Length; i++)
        {
            var (mode, label, icon) = modes[i];
            track.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var active = mode == now;
            var col = new StackPanel { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            col.Children.Add(new Icon(icon, 22, active ? B("Accent") : B("TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center });
            col.Children.Add(Ui.Text(label, 13.5, active ? B("Accent") : B("Text"), 500).With(t => t.HorizontalAlignment = HorizontalAlignment.Center));
            var b = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), Height = 84, HorizontalAlignment = HorizontalAlignment.Stretch, CornerRadius = new CornerRadius(10), Content = col,
                Background = active ? B("AccentSoft") : B("BgElevated"), BorderBrush = active ? B("Accent") : B("Border"), BorderThickness = new Thickness(1),
            };
            AutomationProperties.SetAutomationId(b, "settings-theme-" + label.ToLowerInvariant());
            AutomationProperties.SetName(b, label + (active ? " (selected)" : ""));
            b.Click += (_, _) => { _setTheme(mode); Rebuild(); };
            Grid.SetColumn(b, i);
            track.Children.Add(b);
        }
        p.Children.Add(track);
        return p;
    }

    private FrameworkElement About()
    {
        var p = Page("About", "This app and the server it talks to.");
        string core;
        try { core = Notivelo.Native.NvCore.CoreVersion(); } catch (Exception) { core = "unavailable"; }
        var app = typeof(SettingsView).Assembly.GetName().Version?.ToString(3) ?? "0.0.1";
        var sp = new StackPanel { Spacing = 14 };
        sp.Children.Add(Line("Server", _server ?? "offline sample data", "settings-server"));
        sp.Children.Add(Line("App version", "Native preview " + app, "settings-version"));
        sp.Children.Add(Line("Core version", core, "settings-core"));
        p.Children.Add(Card(sp));
        return p;
    }

    private UIElement Line(string label, string value, string id)
    {
        var g = new Grid { ColumnSpacing = 12 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(130) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(Ui.Text(label, 13.5, B("TextMuted")));
        var v = Ui.Text(value, 13.5, B("Text"), 500);
        Grid.SetColumn(v, 1);
        g.Children.Add(v);
        AutomationProperties.SetAutomationId(g, id);
        AutomationProperties.SetName(g, label + ": " + value);
        return g;
    }
}
