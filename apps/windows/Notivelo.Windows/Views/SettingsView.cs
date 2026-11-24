using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>Settings (Apple's SettingsScreen.swift, settings.png): Profile, Password, Notifications and Connected apps (the core's account calls, in
/// SettingsView.Account.cs), Appearance (Light / Dark / Hybrid) and About (server, version).</summary>
internal sealed partial class SettingsView : ThemedControl
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
        var root = new Grid { Padding = new Thickness(40, 37, 32, 24), ColumnSpacing = 40 };
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(200) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        AutomationProperties.SetAutomationId(root, "settings-root");
        AutomationProperties.SetName(root, "Settings");

        var nav = new StackPanel { Spacing = 2 };
        nav.Children.Add(Ui.Text("Settings", 20, B("Text"), 700, lineHeight: 28).With(t => t.Margin = new Thickness(0, 0, 0, 20)));
        nav.Children.Add(Ui.Text("Account", 12, B("TextMuted"), 600).With(t => t.Margin = new Thickness(0, 0, 0, 7)));
        nav.Children.Add(NavRow("profile", "user", "Profile"));
        nav.Children.Add(NavRow("appearance", "palette", "Appearance"));
        nav.Children.Add(NavRow("password", "lock", "Security"));
        nav.Children.Add(NavRow("notifications", "bell", "Notifications"));
        nav.Children.Add(NavRow("apps", "plug", "Connected apps"));
        nav.Children.Add(Ui.Text("App", 12, B("TextMuted"), 600).With(t => t.Margin = new Thickness(0, 18, 0, 7)));
        nav.Children.Add(NavRow("about", "info", "About"));
        root.Children.Add(nav);

        var content = _section switch { "notifications" => Notifications(), "apps" => Apps(), "appearance" => Appearance(), "about" => About(), _ => Profile(_section == "password") };
        content.HorizontalAlignment = HorizontalAlignment.Stretch;
        Grid.SetColumn(content, 1);
        root.Children.Add(content);
        return new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    private UIElement NavRow(string key, string icon, string label)
    {
        var active = _section == key;
        var g = new Grid { ColumnSpacing = 9 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(15) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(new Icon(icon, 15, active ? B("Accent") : B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        g.Children.Add(Ui.Text(label, 14, active ? B("Accent") : B("Text2"), active ? 500 : 400).With(t => Grid.SetColumn(t, 1)));
        var b = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 32, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(7), HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch, Content = g, Margin = new Thickness(-8, 0, 8, 0), Background = active ? B("AccentSoft") : null,
        };
        AutomationProperties.SetAutomationId(b, "settings-section-" + key);
        AutomationProperties.SetName(b, label);
        b.Click += (_, _) => Show(key);
        return b;
    }

    private StackPanel Page(string title, string sub)
    {
        var p = new StackPanel { Spacing = 0 };
        p.Children.Add(Ui.Text(title, 19, B("Text"), 700, lineHeight: 28).With(t => t.Margin = new Thickness(0, 3, 0, 0)));
        p.Children.Add(Ui.Text(sub, 13.5, B("TextMuted"), lineHeight: 20).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.Margin = new Thickness(0, 5, 0, 23); }));
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

    private OverlayHost _h() => Host!.Overlay;
    internal ShellHost? Host { get; set; }

    private FrameworkElement Appearance()
    {
        var p = Page("Appearance", "Light, Dark, Hybrid (dark chrome around a light page) or System, which follows Windows.");
        var now = _theme();
        var track = new Grid { ColumnSpacing = 8 };
        var modes = new[] { (ThemeMode.Light, "Light", "sun"), (ThemeMode.Dark, "Dark", "moon"), (ThemeMode.Hybrid, "Hybrid", "contrast"), (ThemeMode.System, "System", "monitor") };
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
        p.Children.Add(Ui.Text("Accent colour", 14, B("Text"), 600).With(t => t.Margin = new Thickness(0, 28, 0, 4)));
        p.Children.Add(Ui.Text("The colour of links, selected rows and buttons. Kept on this device.", 13, B("TextMuted")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.Margin = new Thickness(0, 0, 0, 12); }));
        var swatches = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
        AutomationProperties.SetAutomationId(swatches, "settings-accents");
        AutomationProperties.SetName(swatches, "Accent colour");
        var current = ShellRules.AccentOf(AppSettings.Accent).Key;
        foreach (var a in ShellRules.Accents)
        {
            var choice = a;
            var on = choice.Key == current;
            var dot = new Grid { Width = 28, Height = 28 };
            dot.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse { Fill = Ui.Hex("#" + choice.Swatch.ToString("X6")) });
            if (on) dot.Children.Add(new Icon("check", 14, new SolidColorBrush(Colors.White)) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
            var b = new Button
            {
                Style = Ui.Style("GhostButtonStyle"), Width = 38, Height = 38, Padding = new Thickness(0), CornerRadius = new CornerRadius(19), Content = dot,
                BorderBrush = on ? B("Text") : null, BorderThickness = new Thickness(on ? 2 : 0),
            };
            AutomationProperties.SetAutomationId(b, "settings-accent-" + choice.Key);
            AutomationProperties.SetName(b, choice.Label + (on ? " (selected)" : ""));
            b.Click += (_, _) => { AppSettings.Accent = choice.Key; ThemeBrushes.ApplyAccent(choice.Key); Rebuild(); };
            swatches.Children.Add(b);
        }
        p.Children.Add(swatches);
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
