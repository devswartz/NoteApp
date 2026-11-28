namespace Notivelo.Windows.Text;

/// <summary>Text colours and highlights by name (LOOK 1.5). Values are #RRGGBB.</summary>
public static class TextColors
{
    private static readonly Dictionary<string, (string TextLight, string TextDark, string HlLight, string HlDark)> Table = new()
    {
        ["gray"] = ("#6b6b74", "#a3a3ad", "#e9e9ec", "#3a3a41"),
        ["red"] = ("#c42b2b", "#f47c7c", "#fde0de", "#5b2727"),
        ["orange"] = ("#b4500c", "#f5a05a", "#fde6cf", "#563318"),
        ["yellow"] = ("#8c6400", "#e9c53a", "#fcf0b0", "#4f4313"),
        ["green"] = ("#22783a", "#5fcf80", "#d9f2dc", "#1f4529"),
        ["blue"] = ("#1f62c4", "#6ea8f7", "#dbe8fd", "#1e3a5c"),
        ["purple"] = ("#7a3fd6", "#b893f5", "#ebe2fc", "#3c2b5e"),
        ["pink"] = ("#bb2a75", "#f07fb6", "#fbdeec", "#552240"),
    };

    public static string? Text(string? name, bool dark) =>
        name is not null && Table.TryGetValue(name.ToLowerInvariant(), out var c) ? (dark ? c.TextDark : c.TextLight) : null;

    /// <summary>The engine command for a colour pick: setColor / setHighlight with the name, or the unset (name null = Default).</summary>
    public static (string Command, string Args) Command(bool highlight, string? name) =>
        name is null ? (highlight ? "unsetHighlight" : "unsetColor", "{}")
                     : (highlight ? "setHighlight" : "setColor", "{\"color\":\"" + name + "\"}");

    /// <summary>The names, in the web's order (shared/colors.ts).</summary>
    public static readonly string[] Names = { "gray", "red", "orange", "yellow", "green", "blue", "purple", "pink" };

    /// <summary>A highlight with no name is yellow.</summary>
    public static string Highlight(string? name, bool dark)
    {
        var c = Table[name is not null && Table.ContainsKey(name.ToLowerInvariant()) ? name.ToLowerInvariant() : "yellow"];
        return dark ? c.HlDark : c.HlLight;
    }
}
