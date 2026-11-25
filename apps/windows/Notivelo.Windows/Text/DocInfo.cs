using System.Text.Json;

namespace Notivelo.Windows.Text;

/// <summary>What the line table doesn't say (callout emoji, code language, toggle state, table shape), read from the box's
/// <c>doc_json</c> in document order until the editor puts it on the lines (requests R4 and R5 in status/windows.md).</summary>
/// <summary>A cell's spans and its colour (the cell's <c>background</c> attribute, null for none).</summary>
public sealed record CellSpan(int ColSpan, int RowSpan, string? Background = null);

public sealed class DocInfo
{
    public List<string> CalloutEmoji { get; } = new();
    /// <summary>Per callout: how many lines of the view table it holds (adjacent callouts look the same in the line table).</summary>
    public List<int> CalloutLines { get; } = new();
    public List<string?> CodeLanguage { get; } = new();
    public List<bool> DetailsOpen { get; } = new();
    /// <summary>Per table: its rows, each a list with the number of lines every cell holds.</summary>
    public List<List<List<int>>> Tables { get; } = new();
    /// <summary>Per table, per row, per cell: (colspan, rowspan, header fill), 1 and 1 for a plain cell. A merged cell spans several grid slots.</summary>
    public List<List<List<CellSpan>>> TableSpans { get; } = new();
    public static DocInfo Parse(string docJson)
    {
        var d = new DocInfo();
        try
        {
            using var doc = JsonDocument.Parse(docJson);
            Walk(doc.RootElement, d);
        }
        catch (JsonException) { }
        return d;
    }

    private static string Type(JsonElement e) => e.TryGetProperty("type", out var t) ? t.GetString() ?? "" : "";

    private static IEnumerable<JsonElement> Kids(JsonElement e) =>
        e.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.Array ? c.EnumerateArray() : Enumerable.Empty<JsonElement>();

    private static string? Attr(JsonElement e, string name) =>
        e.TryGetProperty("attrs", out var a) && a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v)
            ? v.ValueKind switch { JsonValueKind.String => v.GetString(), JsonValueKind.True => "true", JsonValueKind.False => "false", JsonValueKind.Null => null, _ => v.ToString() }
            : null;

    private static int Num(JsonElement e, string name) => int.TryParse(Attr(e, name), out var n) && n > 1 ? n : 1;

    private static void Walk(JsonElement e, DocInfo d)
    {
        switch (Type(e))
        {
            case "callout": d.CalloutEmoji.Add(Attr(e, "emoji") ?? "\U0001F4A1"); d.CalloutLines.Add(Kids(e).Sum(LineCount)); break;
            case "codeBlock": d.CodeLanguage.Add(Attr(e, "language")); break;
            case "details": d.DetailsOpen.Add(Attr(e, "open") == "true"); break;
            case "table":
                d.Tables.Add(Kids(e).Where(r => Type(r) == "tableRow").Select(r => Kids(r).Select(LineCount).ToList()).ToList());
                d.TableSpans.Add(Kids(e).Where(r => Type(r) == "tableRow").Select(r => Kids(r).Select(c => new CellSpan(Num(c, "colspan"), Num(c, "rowspan"), Attr(c, "background"))).ToList()).ToList());
                break;
        }
        foreach (var k in Kids(e)) Walk(k, d);
    }

    /// <summary>How many lines of the view table a node produces: a text block or an object is one, a container the sum of its children.</summary>
    public static int LineCount(JsonElement e)
    {
        var t = Type(e);
        if (t is "paragraph" or "heading" or "codeBlock" or "horizontalRule" or "image" or "fileAttachment") return 1;
        var n = Kids(e).Sum(LineCount);
        if (t == "taskRef") n += 1; // the title line, then its notes
        return t is "tableCell" or "tableHeader" ? Math.Max(1, n) : n;
    }
}
