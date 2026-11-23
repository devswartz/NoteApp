using N = Notivelo.Native;

namespace Notivelo.Windows.Text;

/// <summary>The marks on one stretch of a line, resolved from the core's <c>ViewMark</c>s (R1).</summary>
public sealed record RunStyle
{
    public static readonly RunStyle Plain = new();
    public bool Bold { get; init; }
    public bool Italic { get; init; }
    public bool Underline { get; init; }
    public bool Strike { get; init; }
    public bool Code { get; init; }
    public string? Href { get; init; }
    /// <summary>Palette colour name (LOOK 1.5); null: the default text colour.</summary>
    public string? Color { get; init; }
    public bool Highlighted { get; init; }
    /// <summary>Palette name of the highlight; null with <see cref="Highlighted"/>: the default yellow.</summary>
    public string? Highlight { get; init; }
    public bool Comment { get; init; }

    public static RunStyle Of(IEnumerable<N.ViewMark> marks)
    {
        var s = Plain;
        foreach (var m in marks)
        {
            s = m.Kind switch
            {
                N.ViewMarkKind.Bold => s with { Bold = true },
                N.ViewMarkKind.Italic => s with { Italic = true },
                N.ViewMarkKind.Underline => s with { Underline = true },
                N.ViewMarkKind.Strike => s with { Strike = true },
                N.ViewMarkKind.Code => s with { Code = true },
                N.ViewMarkKind.Link => s with { Href = m.Value ?? "" },
                N.ViewMarkKind.TextColor => s with { Color = m.Value },
                N.ViewMarkKind.Highlight => s with { Highlighted = true, Highlight = m.Value },
                N.ViewMarkKind.Comment => s with { Comment = true },
                _ => s,
            };
        }
        return s;
    }
}

/// <summary>A stretch of a line with one style; <see cref="Start"/> is relative to the line.</summary>
public readonly record struct StyledRange(int Start, int Len, RunStyle Style)
{
    public int End => Start + Len;
}

/// <summary>Maps the core's view offsets, line table and runs to what a text layout needs (all UTF-16 units).</summary>
public static class RunMap
{
    /// <summary>The line's runs clamped to its length, in order, with gaps and an empty table filled by plain ranges.</summary>
    public static List<StyledRange> Resolve(N.ViewLine line)
    {
        var len = (int)line.Len;
        var res = new List<StyledRange>();
        var at = 0;
        foreach (var r in line.Runs.OrderBy(r => r.From))
        {
            var from = Math.Max(at, (int)r.From);
            var to = Math.Min(len, (int)r.From + (int)r.Len);
            if (to <= from) continue;
            if (from > at) res.Add(new StyledRange(at, from - at, RunStyle.Plain));
            res.Add(new StyledRange(from, to - from, RunStyle.Of(r.Marks)));
            at = to;
        }
        if (at < len) res.Add(new StyledRange(at, len - at, RunStyle.Plain));
        return res;
    }

    /// <summary>Index of the line holding a view offset: the last line starting at or before it (a line feed belongs to the line before it).</summary>
    public static int LineAt(IReadOnlyList<N.ViewLine> lines, int offset)
    {
        if (lines.Count == 0) return -1;
        int lo = 0, hi = lines.Count - 1;
        while (lo < hi)
        {
            var mid = (lo + hi + 1) / 2;
            if (lines[mid].Offset <= offset) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    /// <summary>A view offset as (line index, offset in the line, clamped to the line's length).</summary>
    public static (int Line, int Col) ToLine(IReadOnlyList<N.ViewLine> lines, int offset)
    {
        var i = LineAt(lines, offset);
        if (i < 0) return (-1, 0);
        return (i, Math.Clamp(offset - (int)lines[i].Offset, 0, (int)lines[i].Len));
    }

    public static int ToView(N.ViewLine line, int col) => (int)line.Offset + col;

    /// <summary>The text of a line out of the view's string.</summary>
    public static string TextOf(string view, N.ViewLine line)
    {
        var s = Math.Clamp((int)line.Offset, 0, view.Length);
        var n = Math.Clamp((int)line.Len, 0, view.Length - s);
        return view.Substring(s, n);
    }

    /// <summary>The style at a line-relative offset (the style of the character after it, or before it at the end).</summary>
    public static RunStyle StyleAt(IReadOnlyList<StyledRange> runs, int col)
    {
        foreach (var r in runs) if (col >= r.Start && col < r.End) return r.Style;
        return runs.Count > 0 && col == runs[^1].End ? runs[^1].Style : RunStyle.Plain;
    }

    /// <summary>The part of a view selection (anchor, head in any order) that falls inside a line, line-relative, or null.</summary>
    public static (int From, int To)? SelectionIn(N.ViewLine line, int anchor, int head)
    {
        int a = Math.Min(anchor, head), b = Math.Max(anchor, head);
        int s = (int)line.Offset, e = s + (int)line.Len;
        if (b <= s || a > e) return null;
        return (Math.Max(a, s) - s, Math.Min(b, e) - s);
    }
}
