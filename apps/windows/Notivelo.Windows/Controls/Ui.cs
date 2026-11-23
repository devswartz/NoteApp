using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace Notivelo.Windows.Controls;

/// <summary>Small builders so the views stay readable. Sizes are the LOOK.md numbers (DIPs == CSS px at 100%).</summary>
internal static class Ui
{
    public static readonly FontFamily Font = new("Segoe UI");
    public static readonly FontFamily Mono = new("Cascadia Mono, Consolas");

    public static Style Style(string key) => (Style)Application.Current.Resources[key];

    public static Color ColorOf(string hex)
    {
        hex = hex.TrimStart('#');
        return Color.FromArgb(255, Convert.ToByte(hex[0..2], 16), Convert.ToByte(hex[2..4], 16), Convert.ToByte(hex[4..6], 16));
    }

    public static SolidColorBrush Hex(string hex) => new(ColorOf(hex));

    public static TextBlock Text(string s, double size, Brush fg, int weight = 400, double lineHeight = 0, double tracking = 0)
    {
        var t = new TextBlock
        {
            Text = s,
            FontSize = size,
            Foreground = fg,
            FontFamily = Font,
            FontWeight = new FontWeight((ushort)weight),
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextWrapping = TextWrapping.NoWrap,
            VerticalAlignment = VerticalAlignment.Center,
            CharacterSpacing = (int)Math.Round(tracking * 1000),
        };
        if (lineHeight > 0)
        {
            t.LineHeight = lineHeight;
            t.LineStackingStrategy = LineStackingStrategy.BlockLineHeight;
        }
        return t;
    }

    public static Rectangle VSep(Brush stroke, double height) => new()
    {
        Width = 1, Height = height, Fill = stroke, VerticalAlignment = VerticalAlignment.Center,
    };

    public static Border HLine(Brush stroke) => new() { Height = 1, Background = stroke, HorizontalAlignment = HorizontalAlignment.Stretch };

    /// <summary>Initials in a circle; text is white or black, whichever contrasts more (LOOK 1.1 initialsColor).</summary>
    public static Border Avatar(string initials, double size, string colorHex = "#f59e0b")
    {
        var c = ColorOf(colorHex);
        double Lin(byte v) { var s = v / 255.0; return s <= 0.03928 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4); }
        var lum = 0.2126 * Lin(c.R) + 0.7152 * Lin(c.G) + 0.0722 * Lin(c.B);
        var dark = (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05);
        var fg = new SolidColorBrush(dark ? Colors.Black : Colors.White);
        return new Border
        {
            Width = size, Height = size, CornerRadius = new CornerRadius(size / 2), Background = new SolidColorBrush(c),
            Child = new TextBlock
            {
                Text = initials, FontSize = size * 0.42, FontWeight = new FontWeight(600), Foreground = fg, FontFamily = Font,
                CharacterSpacing = -20, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            },
        };
    }

    /// <summary>Ghost icon button (LOOK 4.8 icon button / 4.1 ribbon button): fills and colours come from Themes/Styles.xaml.</summary>
    public static Button IconButton(string kind, double iconSize, double width, double height, string? tip = null, double radius = 6)
    {
        var b = new Button
        {
            Style = Style("GhostButtonStyle"),
            Width = width, Height = height, CornerRadius = new CornerRadius(radius),
            Content = new Icon(kind, iconSize),
        };
        if (tip is not null) ToolTipService.SetToolTip(b, tip);
        return b;
    }
}

/// <summary>A Border whose pointer cursor can be set (ProtectedCursor is protected).</summary>
internal sealed class CursorBorder : Grid
{
    public CursorBorder(InputSystemCursorShape shape) => ProtectedCursor = InputSystemCursor.Create(shape);
}

/// <summary>Base for views built in code: <see cref="Build"/> runs when the control loads and whenever the theme it is shown in
/// changes, so every brush comes from <see cref="B"/> for the right theme (Hybrid shows Dark chrome beside a Light page).</summary>
internal abstract class ThemedControl : UserControl
{
    protected ThemedControl()
    {
        IsTabStop = false;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        VerticalContentAlignment = VerticalAlignment.Stretch;
        Loaded += (_, _) => Rebuild();
        ActualThemeChanged += (_, _) => Rebuild();
    }

    protected Brush B(string key) => ThemeBrushes.Get(key, this);

    protected abstract UIElement Build();

    protected void Rebuild()
    {
        if (!IsLoaded) return;
        Content = Build();
    }
}
