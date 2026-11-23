using N = Notivelo.Native;

namespace Notivelo.Windows.Text;

/// <summary>Type metrics of a line (LOOK 2.3): size and pitch in points, weight, tracking in em.</summary>
public readonly record struct LineMetrics(double Size, double Pitch, int Weight, double Tracking, bool Mono)
{
    public const double Base = 16;
    public const double BasePitch = 27.2;
}

/// <summary>Where a line's text starts and how far it sits from the box edges, from the nodes it is in.</summary>
public readonly record struct LineIndent(double TextX, double RightInset, double TopPad, double BottomPad);

/// <summary>The line table turned into the numbers the layout needs: type scale, indentation, gaps. No UI types, so it is unit tested.</summary>
public static class Metrics
{
    public const double Em = 16;
    /// <summary>Space between top-level blocks (0.4 em).</summary>
    public const double BlockGap = 6.4;
    public const double ListIndent = 25.6;
    public const double CheckIndent = 26.2; // 0.2 em padding + 15 box + 8 gap
    public const double QuoteIndent = 19;   // 3 bar + 1 em padding
    public const double CalloutLeft = 12, CalloutBody = 38, CalloutRight = 14;
    public const double CodePadTop = 34, CodePadSide = 14, CodePadBottom = 12;
    public const double TaskNotesIndent = 38; // 26 hanging + 10 padding + 2 guide
    public const double ToggleIndent = 24;
    public const double CellPadX = 10, CellPadY = 6;

    /// <summary>Size, line pitch, weight and tracking of a line by its kind.</summary>
    public static LineMetrics Of(N.ViewLine l)
    {
        if (l.Kind == "heading")
            return l.Level switch
            {
                1 => new LineMetrics(28, 36.4, 700, -0.02, false),
                2 => new LineMetrics(21.6, 29.16, 700, -0.01, false),
                _ => new LineMetrics(17.92, 27.2, 700, 0, false),
            };
        if (l.Kind == "codeBlock") return new LineMetrics(13.5, 21, 400, 0, true);
        var w = InTableHeader(l) ? 600 : InSummary(l) ? 500 : 400;
        return new LineMetrics(Em, LineMetrics.BasePitch, w, 0, false);
    }

    /// <summary>Margins (top, bottom) the block's own element asks for, collapsing CSS-style with its neighbours.</summary>
    public static (double Top, double Bottom) Margins(N.ViewLine l)
    {
        var outer = l.Containers.Length > 0 ? l.Containers[0] : l.Kind;
        if (l.Containers.Length == 0 && l.Kind == "heading")
            return l.Level switch { 1 => (33.6, 8.4), 2 => (23.76, 5.4), _ => (17.92, 3.584) };
        return outer switch
        {
            "blockquote" or "callout" or "image" => (9.6, 9.6),
            "table" => (12.8, 12.8),
            "horizontalRule" => (22.4, 22.4),
            "bulletList" or "orderedList" => (4.8, 4.8),
            _ => (0, 0),
        };
    }

    public static bool IsListContainer(string c) => c is "bulletList" or "orderedList" or "taskList";

    public static int ListDepth(N.ViewLine l) => l.Containers.Count(IsListContainer);

    /// <summary>True when the two lines are in the same innermost container and the second is not a new list item or task.</summary>
    private static bool Continues(N.ViewLine prev, N.ViewLine cur) =>
        cur.Containers.Length > 0 && cur.Marker is null && cur.Checked is null && cur.Kind != "taskRef"
        && prev.Containers.SequenceEqual(cur.Containers);

    /// <summary>Vertical gap above <paramref name="cur"/> given the line before it (null for the first line: no margin).</summary>
    public static double GapAbove(N.ViewLine? prev, N.ViewLine cur)
    {
        if (prev is null) return Margins(cur).Top; // the box has padding, so the first block's margin doesn't collapse away
        if (cur.Kind == "taskRef" || prev.Kind == "taskRef") return cur.Containers.Length > 0 && prev.Containers.Length > 0 && cur.Containers.SequenceEqual(prev.Containers) && cur.Kind != "taskRef" ? 0 : 4;
        var inner = cur.Containers.Length > 0 ? cur.Containers[^1] : "";
        if (cur.Checked is not null && prev.Checked is not null && prev.Containers.SequenceEqual(cur.Containers)) return 3.2;
        if (cur.Checked is not null && prev.Checked is null && prev.Containers.Length > 0 && prev.Containers[0] == "taskRef" && cur.Containers[0] == "taskRef") return 4.8;
        if (Continues(prev, cur))
            return inner is "listItem" or "taskItem" or "taskRef" or "tableCell" or "tableHeader" ? 0 : BlockGap;
        // inside the same list: items touch, a nested list is 0.3 em off
        if (ListDepth(prev) > 0 && ListDepth(cur) > 0 && prev.Containers[0] == cur.Containers[0] && IsListContainer(cur.Containers[0]))
            return ListDepth(prev) == ListDepth(cur) ? (StartsNewList(prev, cur) ? 4.8 : 0) : 4.8;
        if (prev.Containers.Length > 0 && cur.Containers.Length > 0 && prev.Containers[0] == cur.Containers[0])
        {
            var c0 = cur.Containers[0];
            if (c0 is "table" or "details") return 0; // laid out by their own grids
            if (c0 == "taskRef") return cur.Kind == "taskRef" ? BlockGap : 0;
            if (c0 is "blockquote" or "callout") return BlockGap;
        }
        var (pt, pb) = Margins(prev);
        var (ct, cb) = Margins(cur);
        // lists carry their own 0.3 em margins; the 0.4 em gap is between plain blocks
        if (IsTopList(prev) || IsTopList(cur)) return Math.Max(pb, ct);
        return Math.Max(BlockGap, Math.Max(pb, ct));
    }

    private static bool IsTopList(N.ViewLine l) => l.Containers.Length > 0 && IsListContainer(l.Containers[0]);

    /// <summary>Two adjacent numbered items at one depth are in different lists when the marker style changes (<c>5.</c> then <c>7)</c>) or the number skips.</summary>
    public static bool StartsNewList(N.ViewLine prev, N.ViewLine cur)
    {
        if (cur.Marker is null || prev.Marker is null) return false;
        if (cur.Marker == "•" || prev.Marker == "•") return false;
        var pm = prev.Marker; var cm = cur.Marker;
        if (pm[^1] != cm[^1]) return true;
        if (int.TryParse(pm[..^1], out var a) && int.TryParse(cm[..^1], out var b)) return b != a + 1;
        return false;
    }

    /// <summary>Indentation from the containers: lists 1.6 em, checklists, quote bars, callout, toggle, a task's notes.</summary>
    public static LineIndent Indent(N.ViewLine l)
    {
        double x = 0, right = 0, top = 0, bottom = 0;
        foreach (var c in l.Containers)
        {
            switch (c)
            {
                case "bulletList": case "orderedList": x += ListIndent; break;
                case "blockquote": x += QuoteIndent; break;
                case "callout": x += CalloutLeft + CalloutBody; right += CalloutRight; break;
                case "taskRef": x += TaskNotesIndent; break;
                case "detailsSummary": x += ToggleIndent; break;
                case "detailsContent": x += ToggleIndent + 2; break;
            }
        }
        if (l.Kind == "detailsSummary") x += ToggleIndent;
        if (l.Checked is not null) x += CheckIndent;
        if (l.Kind == "codeBlock") { x += CodePadSide; right += CodePadSide; top = CodePadTop; bottom = CodePadBottom; }
        return new LineIndent(x, right, top, bottom);
    }

    /// <summary>Indentation of the containers before the first one named <paramref name="stop"/>.</summary>
    public static double IndentBefore(N.ViewLine l, string stop)
    {
        double x = 0;
        foreach (var c in l.Containers)
        {
            if (c == stop) break;
            x += c switch { "bulletList" or "orderedList" => ListIndent, "blockquote" => QuoteIndent, "callout" => CalloutLeft + CalloutBody, "taskRef" => TaskNotesIndent, _ => 0 };
        }
        return x;
    }

    public static bool InCallout(N.ViewLine l) => l.Containers.Contains("callout");
    public static bool InQuote(N.ViewLine l) => l.Containers.Contains("blockquote");
    public static bool InTable(N.ViewLine l) => l.Containers.Contains("table");
    public static bool InDetails(N.ViewLine l) => l.Containers.Contains("details");
    public static bool InSummary(N.ViewLine l) => l.Kind == "detailsSummary" || l.Containers.Contains("detailsSummary");
    public static bool InDetailsContent(N.ViewLine l) => l.Containers.Contains("detailsContent");
    public static bool InTableHeader(N.ViewLine l) => l.Containers.Contains("tableHeader");
}
