using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;

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
}
