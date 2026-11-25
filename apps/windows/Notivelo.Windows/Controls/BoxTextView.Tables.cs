using Notivelo.Windows.Text;
using N = Notivelo.Native;

namespace Notivelo.Windows.Controls;

/// <summary>Table cells in a box (apple-left3): the ribbon's merge and split read <c>TableState</c> from the session; merging runs the engine's <c>mergeCells</c> over the
/// selected cells (a text selection that starts and ends in different cells), or, when the selection stays in one cell, over the caret's cell and its neighbour, so merging
/// has a keyboard and menu path that needs no drag.</summary>
internal sealed partial class BoxTextView
{
    /// <summary>The engine's view of the table at the caret (null when the caret is not in a table).</summary>
    public N.TableState? TableStateNow()
    {
        try { return _session.TableState(); } catch (Exception) { return null; }
    }

    /// <summary>Merge: the selected cells; failing that (the selection is inside one cell) the caret's cell with the one to its right, or below with <paramref name="down"/>.</summary>
    public bool MergeCells(bool down = false)
    {
        if (!down && RunCommand("mergeCells")) return true;
        if (CaretCell() is not { } c) return false;
        var bottom = c.Row + c.RowSpan - 1 + (down ? 1 : 0);
        var right = c.Col + c.ColSpan - 1 + (down ? 0 : 1);
        return RunCommand("mergeCells", System.Text.Json.JsonSerializer.Serialize(new { top = c.Row, left = c.Col, bottom, right }));
    }

    /// <summary>The cell of the caret (grid slot and spans), from the document's table shapes.</summary>
    internal TableCell? CaretCell()
    {
        var r = _r;
        if (r is null) return null;
        try
        {
            var doc = DocInfo.Parse(SafeDoc());
            var (li, _) = RunMap.ToLine(r.View.Lines, (int)r.View.Selection.Head);
            foreach (var t in TableMap.Find(r.View.Lines, doc.Tables, doc.TableSpans))
                foreach (var c in t.Cells) if (c.Line == li) return c;
        }
        catch (Exception) { }
        return null;
    }

    /// <summary>"merged=N;tstate=MS" for the UI tests: how many merged cells the box's tables hold, and whether merge (M) and split (S) are offered at the caret.</summary>
    private string TableReadout()
    {
        try
        {
            var n = TableTools.Merged(DocInfo.Parse(SafeDoc()).TableSpans);
            var s = _focused || ReferenceEquals(Target, this) ? TableStateNow() : null;
            return $"merged={n};tstate={(s is null ? "-" : (s.CanMerge ? "M" : "") + (s.CanSplit ? "S" : "") + (s.HeaderRow ? "H" : ""))}";
        }
        catch (Exception) { return "merged=0;tstate=-"; }
    }
}
