using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using global::Windows.System;

namespace Notivelo.Windows.Views;

/// <summary>Sign-in (LOOK 4.13, <c>sign-in.png</c>): a 400 pt card on <c>--bg-subtle</c>; below it the version line (press and hold 1.5 s
/// to switch between production and staging). Built once; the text fields keep what was typed across state changes and theme changes.</summary>
internal sealed class SignInView : UserControl
{
    private readonly AppSession _session;
    private readonly TextBox _email = new();
    private readonly PasswordBox _password = new();
    private readonly DispatcherTimer _hold = new() { Interval = TimeSpan.FromMilliseconds(1500) };

    public SignInView(AppSession session)
    {
        _session = session;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        VerticalContentAlignment = VerticalAlignment.Stretch;
        IsTabStop = false;
        _hold.Tick += (_, _) => { _hold.Stop(); _session.ToggleStaging(); };
        _email.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) _password.Focus(FocusState.Keyboard); };
        _password.KeyDown += (_, e) => { if (e.Key == VirtualKey.Enter) Submit(); };
        Loaded += (_, _) => Render();
        ActualThemeChanged += (_, _) => Render();
        _session.Changed += OnChanged;
        Unloaded += (_, _) => _session.Changed -= OnChanged;
    }

    private void OnChanged() { if (IsLoaded) Render(); }

    private Brush B(string key) => ThemeBrushes.Get(key, this);

    private void Submit()
    {
        if (_session.Busy) return;
        _session.SignIn(_email.Text, _password.Password);
    }

    private void Render()
    {
        foreach (var f in new FrameworkElement[] { _email, _password }) (f.Parent as Panel)?.Children.Remove(f);
        var root = new Grid { Background = B("BgSubtle") };
        var col = new StackPanel { Spacing = 16, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Padding = new Thickness(16, 24, 16, 24), Width = 432 };
        col.Children.Add(Card());
        col.Children.Add(Footer());
        root.Children.Add(new ScrollViewer { Content = col, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalContentAlignment = VerticalAlignment.Center });
        Content = root;
    }

    private UIElement Card()
    {
        var restoring = _session.Phase == SessionPhase.Restoring;
        var card = new StackPanel { Spacing = 0 };

        // logo row: 34x34 app icon (radius 9) + "Notivelo" 17/700
        var logo = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        var badge = new Border
        {
            Width = 34, Height = 34, CornerRadius = new CornerRadius(9), Background = Ui.Hex("#5B5BD6"),
            Child = new Border
            {
                Width = 16, Height = 16, CornerRadius = new CornerRadius(3), Background = new SolidColorBrush(Colors.White),
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
                Child = new Icon("check", 12, Ui.Hex("#5B5BD6")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center },
            },
        };
        logo.Children.Add(badge);
        logo.Children.Add(Ui.Text("Notivelo", 17, B("Text"), 700));
        card.Children.Add(logo);
        card.Children.Add(Ui.Text("Welcome back", 22, B("Text"), 700, tracking: -0.02).With(t => t.Margin = new Thickness(0, 20, 0, 0)));
        card.Children.Add(Ui.Text("Notes and tasks, connected — for you and your team.", 13.5, B("TextMuted")).With(t => t.Margin = new Thickness(0, 4, 0, 0)));

        if (restoring)
        {
            card.Children.Add(Ui.Text("Signing in…", 14, B("TextMuted")).With(t => { t.Margin = new Thickness(0, 40, 0, 40); t.HorizontalAlignment = HorizontalAlignment.Center; }));
        }
        else
        {
            var form = new StackPanel { Spacing = 14, Margin = new Thickness(0, 24, 0, 18), IsHitTestVisible = !_session.Busy };
            Style(_email, "you@example.com");
            Style(_password, "");
            form.Children.Add(Field("Email", _email));
            form.Children.Add(Field("Password", _password));
            form.Children.Add(Link("Forgot password?", 12.5, "/forgot"));
            card.Children.Add(form);

            if (_session.Error is { } err)
                card.Children.Add(Ui.Text(err, 13, B("Danger")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.Margin = new Thickness(0, 0, 0, 12); }));

            var go = new Button
            {
                Content = _session.Busy ? "Signing in…" : "Sign in", Height = 40, HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Center, CornerRadius = new CornerRadius(8), FontSize = 15, FontWeight = new FontWeight(500),
                FontFamily = Ui.Font, Foreground = B("TextOnAccent"), Background = B("AccentSolid"), BorderThickness = new Thickness(0), IsEnabled = !_session.Busy,
            };
            foreach (var k in new[] { "ButtonBackgroundPointerOver", "ButtonBackgroundPressed" }) go.Resources[k] = B("AccentSolidHover");
            go.Resources["ButtonBackgroundDisabled"] = B("AccentSolid");
            go.Resources["ButtonForegroundDisabled"] = B("TextOnAccent");
            foreach (var k in new[] { "ButtonForegroundPointerOver", "ButtonForegroundPressed" }) go.Resources[k] = B("TextOnAccent");
            go.Resources["ButtonBorderBrushPointerOver"] = new SolidColorBrush(Colors.Transparent);
            go.Resources["ButtonBorderBrushPressed"] = new SolidColorBrush(Colors.Transparent);
            go.Click += (_, _) => Submit();
            card.Children.Add(go);

            if (_session.CanRetryRestore)
            {
                var retry = new Button
                {
                    Content = "Try again", Height = 32, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Center,
                    CornerRadius = new CornerRadius(8), FontSize = 14, FontWeight = new FontWeight(500), FontFamily = Ui.Font, Foreground = B("Text"),
                    Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), Margin = new Thickness(0, 8, 0, 0),
                };
                retry.Click += (_, _) => _session.Restore();
                card.Children.Add(retry);
            }

            var newHere = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 20, 0, 0) };
            newHere.Children.Add(Ui.Text("New here?", 12.5, B("TextMuted")));
            newHere.Children.Add(Link("Create an account", 12.5, "/signup"));
            card.Children.Add(newHere);

            var legal = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 14, 0, 0) };
            legal.Children.Add(Link("Privacy", 12.5, "/privacy", true));
            legal.Children.Add(Ui.Text(" · ", 12.5, B("TextMuted")));
            legal.Children.Add(Link("Terms", 12.5, "/terms", true));
            legal.Children.Add(Ui.Text(" · ", 12.5, B("TextMuted")));
            legal.Children.Add(Link("Support", 12.5, "/support", true));
            card.Children.Add(legal);
        }

        return new Border
        {
            Padding = new Thickness(32), MaxWidth = 400, Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(16), Child = card,
        };
    }

    private void Style(Control box, string placeholder)
    {
        box.Height = 40; box.Padding = new Thickness(10, 9, 10, 0); box.CornerRadius = new CornerRadius(8); box.FontSize = 14; box.FontFamily = Ui.Font;
        box.Background = B("Bg"); box.BorderBrush = B("Border"); box.BorderThickness = new Thickness(1); box.Foreground = B("Text");
        foreach (var k in new[] { "TextControlBackground", "TextControlBackgroundPointerOver", "TextControlBackgroundFocused" }) box.Resources[k] = B("Bg");
        foreach (var k in new[] { "TextControlForeground", "TextControlForegroundPointerOver", "TextControlForegroundFocused" }) box.Resources[k] = B("Text");
        foreach (var k in new[] { "TextControlBorderBrush", "TextControlBorderBrushPointerOver" }) box.Resources[k] = B("Border");
        box.Resources["TextControlBorderBrushFocused"] = B("Accent");
        box.Resources["TextControlPlaceholderForeground"] = B("TextPlaceholder");
        box.Resources["TextControlPlaceholderForegroundFocused"] = B("TextPlaceholder");
        if (box is TextBox t) t.PlaceholderText = placeholder;
        if (box is PasswordBox p) p.PasswordRevealMode = PasswordRevealMode.Hidden;
    }

    private UIElement Field(string label, UIElement input)
    {
        var sp = new StackPanel { Spacing = 6 };
        sp.Children.Add(Ui.Text(label, 13, B("Text"), 500));
        sp.Children.Add(input);
        return sp;
    }

    private UIElement Link(string text, double size, string path, bool muted = false)
    {
        var b = new HyperlinkButton
        {
            Content = Ui.Text(text, size, muted ? B("TextMuted") : B("Accent"), muted ? 400 : 500),
            Padding = new Thickness(0), MinHeight = 0, MinWidth = 0, HorizontalAlignment = HorizontalAlignment.Left,
        };
        foreach (var k in new[] { "HyperlinkButtonBackground", "HyperlinkButtonBackgroundPointerOver", "HyperlinkButtonBackgroundPressed" }) b.Resources[k] = new SolidColorBrush(Colors.Transparent);
        b.Click += async (_, _) => { try { await Launcher.LaunchUriAsync(new Uri(_session.ServerUrl + path)); } catch { } };
        return b;
    }

    private UIElement Footer()
    {
        var sp = new StackPanel { Spacing = 6, HorizontalAlignment = HorizontalAlignment.Center };
        if (!_session.IsProduction)
            sp.Children.Add(Ui.Text("Server: " + _session.Host, 12, Ui.Hex("#f59e0b"), 600).With(t => t.HorizontalAlignment = HorizontalAlignment.Center));
        string core;
        try { core = "core " + Notivelo.Native.NvCore.CoreVersion(); } catch { core = "core unavailable"; }
        var ver = Ui.Text($"Native preview · {typeof(SignInView).Assembly.GetName().Version?.ToString(3) ?? "0.0.1"} · {core}", 11.5, B("TextMuted"));
        ver.HorizontalAlignment = HorizontalAlignment.Center;
        ver.PointerPressed += (_, _) => { if (!_session.ServerFixedByEnv) _hold.Start(); };
        ver.PointerReleased += (_, _) => _hold.Stop();
        ver.PointerExited += (_, _) => _hold.Stop();
        sp.Children.Add(ver);
        return sp;
    }
}
