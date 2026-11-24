using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;

namespace Notivelo.Windows.Views;

/// <summary>The pieces the sign-in, sign-up and check-email cards share (LOOK 4.13): the logo row, the accent button, links and the card frame.</summary>
internal static class AuthParts
{
    public static UIElement Logo(Func<string, Brush> b)
    {
        var logo = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        logo.Children.Add(new Border
        {
            Width = 34, Height = 34, CornerRadius = new CornerRadius(9), Background = Ui.Hex("#5B5BD6"),
            Child = new Border
            {
                Width = 16, Height = 16, CornerRadius = new CornerRadius(3), Background = new SolidColorBrush(Colors.White),
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
                Child = new Icon("check", 12, Ui.Hex("#5B5BD6")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center },
            },
        });
        logo.Children.Add(Ui.Text("Notivelo", 17, b("Text"), 700));
        return logo;
    }

    public static Button Accent(Func<string, Brush> b, string text, bool enabled, string id)
    {
        var go = new Button
        {
            Content = text, Height = 40, HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Center, CornerRadius = new CornerRadius(8), FontSize = 15, FontWeight = new global::Windows.UI.Text.FontWeight(500),
            FontFamily = Ui.Font, Foreground = b("TextOnAccent"), Background = b("AccentSolid"), BorderThickness = new Thickness(0), IsEnabled = enabled,
        };
        foreach (var k in new[] { "ButtonBackgroundPointerOver", "ButtonBackgroundPressed" }) go.Resources[k] = b("AccentSolidHover");
        go.Resources["ButtonBackgroundDisabled"] = b("AccentSolid");
        go.Resources["ButtonForegroundDisabled"] = b("TextOnAccent");
        foreach (var k in new[] { "ButtonForegroundPointerOver", "ButtonForegroundPressed" }) go.Resources[k] = b("TextOnAccent");
        go.Resources["ButtonBorderBrushPointerOver"] = new SolidColorBrush(Colors.Transparent);
        go.Resources["ButtonBorderBrushPressed"] = new SolidColorBrush(Colors.Transparent);
        AutomationProperties.SetAutomationId(go, id);
        AutomationProperties.SetName(go, text);
        return go;
    }

    /// <summary>A text-only link button (accent or muted).</summary>
    public static HyperlinkButton Link(Func<string, Brush> b, string text, double size, string id, bool muted = false)
    {
        var l = new HyperlinkButton
        {
            Content = Ui.Text(text, size, muted ? b("TextMuted") : b("Accent"), muted ? 400 : 500),
            Padding = new Thickness(0), MinHeight = 0, MinWidth = 0, HorizontalAlignment = HorizontalAlignment.Left,
        };
        foreach (var k in new[] { "HyperlinkButtonBackground", "HyperlinkButtonBackgroundPointerOver", "HyperlinkButtonBackgroundPressed" }) l.Resources[k] = new SolidColorBrush(Colors.Transparent);
        AutomationProperties.SetAutomationId(l, id);
        AutomationProperties.SetName(l, text);
        return l;
    }

    public static Border Frame(Func<string, Brush> b, UIElement child) => new()
    {
        Padding = new Thickness(32), MaxWidth = 400, Background = b("BgElevated"), BorderBrush = b("Border"), BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(16), Child = child,
    };
}
