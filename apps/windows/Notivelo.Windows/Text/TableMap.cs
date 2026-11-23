using N = Notivelo.Native;

namespace Notivelo.Windows.Text;

/// <summary>Which cell of which table each table line belongs to. The line table has no coordinates yet (request R4), so the shape
/// comes from <see cref="DocInfo.Tables"/> and the lines are dealt out cell by cell in document order.</summary>
public sealed record TableCell(int Line, int Row, int Col, bool Header);

public sealed record TableLayoutInfo(int FirstLine, int LineCount, int Rows, int Cols, IReadOnlyList<TableCell> Cells);

public static class TableMap
{
    /// <summary>Find every table in the line table. <paramref name="shapes"/> are the tables of the document in order.</summary>
    public static List<TableLayoutInfo> Find(IReadOnlyList<N.ViewLine> lines, IReadOnlyList<List<List<int>>> shapes)
    {
        var res = new List<TableLayoutInfo>();
        var next = 0;
        for (var i = 0; i < lines.Count;)
        {
            if (!Metrics.InTable(lines[i])) { i++; continue; }
            var end = i;
            while (end < lines.Count && Metrics.InTable(lines[end])) end++;
            // a run of table lines may hold several adjacent tables: deal them out by their shapes
            var at = i;
            while (at < end)
            {
                var shape = next < shapes.Count ? shapes[next++] : null;
                var cells = new List<TableCell>();
                var line = at;
                int rows = 0, cols = 0;
                if (shape is null)
                {
                    // no shape known: one cell per line, one row
                    for (; line < end; line++) cells.Add(new TableCell(line, 0, line - at, Metrics.InTableHeader(lines[line])));
                    rows = 1; cols = end - at;
                }
                else
                {
                    for (var r = 0; r < shape.Count && line < end; r++)
                    {
                        cols = Math.Max(cols, shape[r].Count);
                        for (var c = 0; c < shape[r].Count && line < end; c++)
                            for (var k = 0; k < shape[r][c] && line < end; k++, line++)
                                cells.Add(new TableCell(line, r, c, Metrics.InTableHeader(lines[line])));
                        rows = r + 1;
                    }
                }
                res.Add(new TableLayoutInfo(at, line - at, Math.Max(rows, 1), Math.Max(cols, 1), cells));
                at = Math.Max(line, at + 1);
            }
            i = end;
        }
        return res;
    }
}
