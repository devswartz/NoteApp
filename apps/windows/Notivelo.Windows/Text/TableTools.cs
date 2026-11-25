namespace Notivelo.Windows.Text;

/// <summary>The table commands the editor engine has (<c>nv-editor</c> command.rs): what the ribbon's Table tools menu and the slash menu run. Merge and split cells came
/// with apple-left3; column widths, a header column and cell colours have no engine command (the document keeps and draws <c>colwidth</c> and <c>background</c>, nothing sets them).</summary>
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
        ("Merge cells", "mergeRight", "{}"),
        ("Merge with cell below", "mergeDown", "{}"),
        ("Split cell", "splitCell", "{}"),
        ("", "", ""),
        ("Delete row", "deleteRow", "{}"),
        ("Delete column", "deleteColumn", "{}"),
        ("Delete table", "deleteTable", "{}"),
    };

    /// <summary>How many merged cells (a colspan or rowspan above 1) the tables hold.</summary>
    public static int Merged(IReadOnlyList<List<List<CellSpan>>> spans) => spans.Sum(t => t.Sum(r => r.Count(c => c.ColSpan > 1 || c.RowSpan > 1)));

    /// <summary>"3x4" per table of a document, from <see cref="DocInfo.Tables"/> (rows by the widest row), for the UI tests' readout.</summary>
    public static string Shapes(IReadOnlyList<List<List<int>>> tables) =>
        string.Join(",", tables.Select(t => t.Count + "x" + (t.Count == 0 ? 0 : t.Max(r => r.Count))));
}
