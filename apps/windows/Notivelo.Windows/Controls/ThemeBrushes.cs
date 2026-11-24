using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Controls;

/// <summary>Looks up a token brush (Themes/Tokens.xaml) for the theme an element is actually shown in.
/// XAML uses {ThemeResource}; code-built elements use this because Hybrid mixes Dark chrome and a Light page.</summary>
internal static class ThemeBrushes
{
    private static ResourceDictionary? _light, _dark;

    public static Brush Get(string key, FrameworkElement scope) => Get(key, scope.ActualTheme);

    public static Brush Get(string key, ElementTheme theme)
    {
        if (_light is null) Load();
        var dict = theme == ElementTheme.Dark ? _dark! : _light!;
        return (Brush)dict[key];
    }

    private static void Load()
    {
        foreach (var d in Application.Current.Resources.MergedDictionaries)
        {
            if (!d.ThemeDictionaries.ContainsKey("Dark") || !d.ThemeDictionaries.ContainsKey("Light")) continue;
            _light = (ResourceDictionary)d.ThemeDictionaries["Light"];
            _dark = (ResourceDictionary)d.ThemeDictionaries["Dark"];
            if (_light.ContainsKey("Bg")) return;
        }
    }

    private static global::Windows.UI.Color Rgb(uint v, byte a = 0xFF) => global::Windows.UI.Color.FromArgb(a, (byte)(v >> 16), (byte)(v >> 8), (byte)v);

    /// <summary>The accent colour (Settings → Appearance, per device): the Accent tokens of the light and the dark palette take the choice's sets
    /// (the web's accents.css), in place, so everything drawn from them (XAML ThemeResource and code lookups) changes at once.</summary>
    public static void ApplyAccent(string? key)
    {
        if (_light is null) Load();
        if (_light is null || _dark is null) return;
        var a = ShellRules.AccentOf(key);
        void Set(ResourceDictionary dict, AccentSet s, bool dark)
        {
            void P(string name, uint rgb, byte alpha = 0xFF) { if (dict[name] is SolidColorBrush b) b.Color = Rgb(rgb, alpha); }
            P("Accent", s.Accent);
            P("AccentHover", s.Hover);
            P("AccentSoft", s.Accent, ShellRules.SoftAlpha(dark));
            P("AccentSolid", s.Solid);
            P("AccentSolidHover", s.SolidHover);
            P("AccentSolidDisabled", ShellRules.DisabledSolid(s.Solid, dark));
            P("BgActive", s.Accent, (byte)(dark ? 0x26 : 0x17));
        }
        Set(_light, a.Light, false);
        Set(_dark, a.Dark, true);
    }
}
