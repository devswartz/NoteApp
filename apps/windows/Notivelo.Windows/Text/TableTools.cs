namespace Notivelo.Windows.Text;

/// <summary>The table commands the editor engine has (<c>nv-editor</c> command.rs): what the ribbon's Table tools menu and the slash menu run. Merge and split cells,
/// column widths and cell colours have no engine command yet (they wait for apple-left3).</summary>
public static class TableTools
{
    /// <summary>Menu text, command, arguments; an empty command is a separator.</summary>
    public static readonly IReadOnlyList<(string Text, string Command, string Args)> Menu = new (string, string, string)[]
    {
        ("Insert row above", "addRowBefore", "{}"),
        ("Insert row below", "addRowAfter", "{}"),
        ("Insert column left", "addColumnBefore", "{}"),
        ("Insert column right", "addColumnAfter", "{}"),
        ("", "", ""),
        ("Header row", "toggleHeaderRow", "{}"),
        ("", "", ""),
        ("Delete row", "deleteRow", "{}"),
        ("Delete column", "deleteColumn", "{}"),
        ("Delete table", "deleteTable", "{}"),
    };

    /// <summary>"3x4" per table of a document, from <see cref="DocInfo.Tables"/> (rows by the widest row), for the UI tests' readout.</summary>
    public static string Shapes(IReadOnlyList<List<List<int>>> tables) =>
        string.Join(",", tables.Select(t => t.Count + "x" + (t.Count == 0 ? 0 : t.Max(r => r.Count))));
}
