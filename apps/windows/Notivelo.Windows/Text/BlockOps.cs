using N = Notivelo.Native;

namespace Notivelo.Windows.Text;

/// <summary>A heading of a box as the outline lists it: the box's field, the level (1-3), the words and the view offset of the line.</summary>
public sealed record OutlineEntry(string Field, int Level, string Text, int Offset);

/// <summary>The page's outline (the web's Outline.tsx, Apple's Outline.swift): headings in reading order. The core has the same list for a live page
/// (<c>LivePage.Outline</c>); this reads the boxes' own editor sessions, so it works offline and for the sample page too.</summary>
public static class OutlineRules
{
    /// <summary>The non-empty headings of one box's lines.</summary>
    public static IReadOnlyList<OutlineEntry> Of(string field, string viewText, IReadOnlyList<N.ViewLine> lines)
    {
        var res = new List<OutlineEntry>();
        foreach (var l in lines)
        {
            if (!l.IsText || l.Kind != "heading" || l.Len == 0) continue;
            var text = RunMap.TextOf(viewText, l).Trim();
            if (text.Length == 0) continue;
            res.Add(new OutlineEntry(field, Math.Clamp((int)l.Level, 1, 6), text, (int)l.Offset));
        }
        return res;
    }

    /// <summary>The headings of all boxes: boxes top to bottom (then left to right), each box's own order inside.</summary>
    public static IReadOnlyList<OutlineEntry> Page(IEnumerable<(double X, double Y, IReadOnlyList<OutlineEntry> Items)> boxes) =>
        boxes.OrderBy(b => Math.Round(b.Y)).ThenBy(b => b.X).SelectMany(b => b.Items).ToList();

    /// <summary>The heading the caret is under: the last one at or before it in its own box (-1: none).</summary>
    public static int Active(IReadOnlyList<OutlineEntry> entries, string? field, int caret)
    {
        var at = -1;
        for (var i = 0; i < entries.Count; i++)
            if (entries[i].Field == field && entries[i].Offset <= caret) at = i;
        return at;
    }

    /// <summary>How far a level is indented in the list (level 1 flush, one step per level below the shallowest).</summary>
    public static int Indent(IReadOnlyList<OutlineEntry> entries, OutlineEntry e) => Math.Max(0, e.Level - entries.Min(x => x.Level));

    /// <summary>The right-edge bars: one per heading (at most <paramref name="max"/>, spread over the list), a bar's width by level.</summary>
    public static IReadOnlyList<int> Bars(IReadOnlyList<OutlineEntry> entries, int max)
    {
        if (entries.Count == 0) return Array.Empty<int>();
        if (entries.Count <= max) return Enumerable.Range(0, entries.Count).ToList();
        return Enumerable.Range(0, max).Select(i => (int)Math.Round(i * (entries.Count - 1.0) / (max - 1))).Distinct().ToList();
    }
}

/// <summary>Blocks of a box: the line range one block covers and what the block menu does with it (the engine's <c>moveBlockUp/Down</c> and the same edits the keyboard makes).
/// A block is a list item with its sub-points, a table, a quote or callout, or a single line; a task line goes with its notes.</summary>
public sealed record BlockSpan(int FirstLine, int LastLine, int From, int To);

public static class BlockOps
{
    private static int Items(N.ViewLine l) => l.Containers.Count(c => c == "listItem");

    /// <summary>The lines of the block holding <paramref name="line"/> and their view range (no trailing line feed).</summary>
    public static BlockSpan? Of(IReadOnlyList<N.ViewLine> lines, int line)
    {
        if (line < 0 || line >= lines.Count) return null;
        var l = lines[line];
        int first = line, last = line;
        var depth = Items(l);
        if (depth > 0)
        {
            // the item's own line carries the marker; its further paragraphs and deeper items follow it
            while (first > 0 && !(lines[first].Marker is not null && Items(lines[first]) == depth) && Items(lines[first - 1]) >= depth) first--;
            while (last + 1 < lines.Count && Items(lines[last + 1]) > depth || last + 1 < lines.Count && Items(lines[last + 1]) == depth && lines[last + 1].Marker is null) last++;
        }
        else if (l.Containers.Length > 0)
        {
            var top = l.Containers[0];
            while (first > 0 && lines[first - 1].Containers.Length > 0 && lines[first - 1].Containers[0] == top && Items(lines[first - 1]) == 0) first--;
            while (last + 1 < lines.Count && lines[last + 1].Containers.Length > 0 && lines[last + 1].Containers[0] == top && Items(lines[last + 1]) == 0) last++;
        }
        var from = (int)lines[first].Offset;
        var to = (int)(lines[last].Offset + lines[last].Len);
        return new BlockSpan(first, last, from, to);
    }

    /// <summary>The line the caret is on.</summary>
    public static int CaretLine(N.ViewState v) => RunMap.LineAt(v.Lines, (int)v.Selection.Head);

    /// <summary>Put the caret at the start of a line (what a block menu acts from).</summary>
    public static void Place(N.EditorSession s, int line)
    {
        var lines = s.ViewState().Lines;
        if (line < 0 || line >= lines.Length) return;
        var at = (uint)lines[line].Offset;
        s.SetViewSelection(at, at);
    }

    /// <summary>Move the block up or down (the engine's moveBlockUp / moveBlockDown, one undo step). False: it can't move (first or last).</summary>
    public static bool Move(N.EditorSession s, int line, bool up)
    {
        Place(s, line);
        return s.Command(up ? "moveBlockUp" : "moveBlockDown", "{}");
    }

    /// <summary>Remove the block: its lines, and the line feed that joined it to its neighbour. The last block left in a box is emptied, not removed.</summary>
    public static bool Delete(N.EditorSession s, int line)
    {
        var v = s.ViewState();
        if (BlockOps.Of(v.Lines, line) is not { } span) return false;
        var onlyBlock = span.FirstLine == 0 && span.LastLine == v.Lines.Length - 1;
        if (onlyBlock)
        {
            Place(s, line);
            return s.Command("setParagraph", "{}") & s.ReplaceViewRange((uint)span.From, (uint)span.To, "");
        }
        if (span.FirstLine == 0)
        {
            // the first block: joining its end to the next block would give the next one this block's kind, so it first swaps places with the next, then goes as a later block does
            if (!Move(s, line, up: false)) return false;
            var now = s.ViewState();
            var moved = RunMap.LineAt(now.Lines, (int)now.Selection.Head);
            return moved > 0 && DeleteLater(s, moved);
        }
        return DeleteLater(s, line);
    }

    /// <summary>Delete a block that has a block above: from the end of that block to the end of this one, so the block below keeps its own kind.</summary>
    private static bool DeleteLater(N.EditorSession s, int line)
    {
        var v = s.ViewState();
        if (BlockOps.Of(v.Lines, line) is not { } span || span.FirstLine == 0) return false;
        var above = v.Lines[span.FirstLine - 1];
        return s.ReplaceViewRange((uint)(above.Offset + above.Len), (uint)span.To, "");
    }

    /// <summary>Copy the block under itself: it is copied with the engine's own clipboard (marks and block kind kept) and pasted in a new line after it.</summary>
    public static bool Duplicate(N.EditorSession s, int line)
    {
        var v = s.ViewState();
        if (BlockOps.Of(v.Lines, line) is not { } span || !v.Lines[line].IsText || v.Lines[line].TaskId is not null) return false;
        var src = v.Lines[line];
        s.SetViewSelection((uint)span.From, (uint)span.To);
        var clip = s.Copy();
        var end = (uint)span.To;
        s.SetViewSelection(end, end);
        if (!s.Key("Enter")) return false;
        // an item of a list: Enter made a new item; after a heading or a code block it starts a paragraph, which takes the kind back below
        // the engine's html for a list item holds the whole list, so an item goes in as its text (the new item is already in the list); other blocks keep their marks
        if (!s.Paste(src.Marker is not null ? "" : clip.Html, clip.Text)) return false;
        var now = s.ViewState();
        var at = RunMap.LineAt(now.Lines, (int)now.Selection.Head);
        if (at >= 0 && now.Lines[at].Kind != src.Kind)
        {
            if (src.Kind == "heading") s.Command("setHeading", "{\"level\":" + src.Level + "}");
            else if (src.Kind == "codeBlock") s.Command("toggleCodeBlock", "{}");
        }
        return true;
    }

    /// <summary>The kinds the block menu turns a block into: the label, the engine command and its arguments (the ribbon's Text style menu runs the same ones).</summary>
    public static readonly IReadOnlyList<(string Label, string Command, string Args)> TurnInto = new (string, string, string)[]
    {
        ("Text", "setParagraph", "{}"), ("Heading 1", "setHeading", "{\"level\":1}"), ("Heading 2", "setHeading", "{\"level\":2}"), ("Heading 3", "setHeading", "{\"level\":3}"),
        ("Bulleted list", "toggleBulletList", "{}"), ("Numbered list", "toggleOrderedList", "{}"), ("Quote", "toggleQuote", "{}"), ("Code block", "toggleCodeBlock", "{}"),
    };

    /// <summary>Turn the block into another kind (one undo step); a list kind the block already is toggles off, as in the ribbon.</summary>
    public static bool Turn(N.EditorSession s, int line, string command, string args)
    {
        Place(s, line);
        return s.Command(command, args);
    }
}
