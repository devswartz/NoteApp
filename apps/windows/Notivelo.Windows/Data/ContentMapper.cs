using System.Text;
using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

/// <summary>Box content from the core (typed <c>ContentNode</c>s, as the Apple app's PageText reads them) as read-only blocks with marked text spans.</summary>
internal sealed class ContentMapper
{
    private readonly Func<string, TaskItem?> _task;
    private readonly Func<string, string> _pageTitle;

    public ContentMapper(Func<string, TaskItem?> task, Func<string, string> pageTitle) { _task = task; _pageTitle = pageTitle; }

    public List<BoxBlock> Blocks(IEnumerable<N.ContentNode> nodes)
    {
        var list = new List<BoxBlock>();
        foreach (var n in nodes) Walk(n, list, 0, false);
        if (list.Count == 0) list.Add(new BoxBlock(BlockKind.Paragraph, ""));
        return list;
    }

    private void Walk(N.ContentNode node, List<BoxBlock> o, int depth, bool quote)
    {
        switch (node.Kind)
        {
            case N.NodeKind.Paragraph or N.NodeKind.DetailsSummary:
                Add(o, quote ? BlockKind.Quote : BlockKind.Paragraph, node, depth);
                break;
            case N.NodeKind.Heading:
                var level = (int)Math.Clamp(Number(node, "level") ?? 1, 1, 3);
                Add(o, level == 1 ? BlockKind.Heading1 : level == 2 ? BlockKind.Heading2 : BlockKind.Heading3, node, depth);
                break;
            case N.NodeKind.CodeBlock:
                o.Add(new BoxBlock(BlockKind.Code, PlainText(node)));
                break;
            case N.NodeKind.HorizontalRule:
                o.Add(new BoxBlock(BlockKind.Rule, ""));
                break;
            case N.NodeKind.BulletList or N.NodeKind.OrderedList:
                var ordered = node.Kind is N.NodeKind.OrderedList;
                for (var i = 0; i < node.Children.Length; i++)
                {
                    var marker = ordered && i < node.Markers.Length ? node.Markers[i] : ordered ? $"{i + 1}." : depth % 2 == 0 ? "•" : "◦";
                    Item(node.Children[i], o, depth, marker, null);
                }
                break;
            case N.NodeKind.TaskList:
                foreach (var it in node.Children) Item(it, o, depth, null, Bool(it, "checked") ?? false);
                break;
            case N.NodeKind.TaskRef:
                var id = Text(node, "taskId") ?? "";
                var t = _task(id);
                if (t is null) o.Add(new BoxBlock(BlockKind.Paragraph, "Task not shown", Spans: new[] { new TextSpan("Task not shown", Italic: true) }));
                else o.Add(new BoxBlock(BlockKind.Task, t.Title, t));
                foreach (var c in node.Children) Walk(c, o, depth + 1, quote);
                break;
            case N.NodeKind.Blockquote or N.NodeKind.Callout:
                foreach (var c in node.Children) Walk(c, o, depth, true);
                break;
            case N.NodeKind.TableRow:
                var cells = node.Children.Select(PlainText);
                o.Add(new BoxBlock(BlockKind.Paragraph, string.Join("  │  ", cells)));
                break;
            case N.NodeKind.Image:
                var alt = "[Image] " + Text(node, "alt");
                o.Add(new BoxBlock(BlockKind.Paragraph, alt, Spans: new[] { new TextSpan(alt, Italic: true) }));
                break;
            case N.NodeKind.FileAttachment:
                o.Add(new BoxBlock(BlockKind.Paragraph, "\U0001F4CE " + (Text(node, "name") ?? "File")));
                break;
            case N.NodeKind.Text or N.NodeKind.Mention or N.NodeKind.PageLink or N.NodeKind.HardBreak:
                var spans = Spans(new[] { node });
                o.Add(new BoxBlock(BlockKind.Paragraph, string.Concat(spans.Select(s => s.Text)), Spans: spans));
                break;
            default: // details, details content, table, cells, unknown: their children in order
                foreach (var c in node.Children) Walk(c, o, depth, quote);
                break;
        }
    }

    /// <summary>A list or task item: its first paragraph carries the marker, later blocks and nested lists follow indented.</summary>
    private void Item(N.ContentNode item, List<BoxBlock> o, int depth, string? marker, bool? check)
    {
        var kind = check is null ? BlockKind.ListItem : BlockKind.CheckItem;
        var first = true;
        foreach (var c in item.Children)
        {
            if (first && c.Kind is N.NodeKind.Paragraph)
            {
                var spans = Spans(c.Children);
                o.Add(new BoxBlock(kind, string.Concat(spans.Select(s => s.Text)), Spans: spans, Marker: marker, Indent: depth, Checked: check ?? false));
            }
            else
            {
                if (first) o.Add(new BoxBlock(kind, "", Marker: marker, Indent: depth, Checked: check ?? false));
                Walk(c, o, depth + 1, false);
            }
            first = false;
        }
        if (first) o.Add(new BoxBlock(kind, "", Marker: marker, Indent: depth, Checked: check ?? false));
    }

    private void Add(List<BoxBlock> o, BlockKind kind, N.ContentNode node, int depth)
    {
        var spans = Spans(node.Children);
        o.Add(new BoxBlock(kind, string.Concat(spans.Select(s => s.Text)), Spans: spans, Indent: depth));
    }

    private List<TextSpan> Spans(IEnumerable<N.ContentNode> nodes)
    {
        var o = new List<TextSpan>();
        foreach (var n in nodes)
        {
            switch (n.Kind)
            {
                case N.NodeKind.Text:
                    foreach (var r in n.Runs) o.Add(Span(r));
                    break;
                case N.NodeKind.HardBreak:
                    o.Add(new TextSpan("\n"));
                    break;
                case N.NodeKind.Mention:
                    o.Add(new TextSpan("@" + (Text(n, "label") ?? ""), Bold: true, ColorHex: "#3b82f6"));
                    break;
                case N.NodeKind.PageLink:
                    o.Add(new TextSpan(_pageTitle(Text(n, "pageId") ?? ""), Underline: true, ColorHex: "#3b82f6"));
                    break;
                default:
                    o.AddRange(Spans(n.Children));
                    break;
            }
        }
        return o;
    }

    private static TextSpan Span(N.TextRun run)
    {
        var s = new TextSpan(run.Text);
        foreach (var m in run.Marks)
        {
            s = m switch
            {
                N.Mark.Bold => s with { Bold = true },
                N.Mark.Italic => s with { Italic = true },
                N.Mark.Underline => s with { Underline = true },
                N.Mark.Strike => s with { Strike = true },
                N.Mark.Code => s with { Code = true },
                N.Mark.Link l => s with { Href = l.Href, Underline = true, ColorHex = "#3b82f6" },
                N.Mark.TextColor c => s with { ColorHex = Named(c.Color) },
                N.Mark.Highlight h => s with { HighlightHex = Named(h.Color ?? "yellow") ?? "#fcf0b0" },
                _ => s,
            };
        }
        return s;
    }

    /// <summary>The editor's named colours, or a literal #hex.</summary>
    private static string? Named(string c) => c.StartsWith('#') ? c : c switch
    {
        "red" => "#dc2626", "orange" => "#ea580c", "yellow" => "#fcf0b0", "green" => "#16a34a", "blue" => "#2563eb",
        "purple" => "#7c3aed", "pink" => "#db2777", "grey" or "gray" => "#6b7280", _ => null,
    };

    private static string PlainText(N.ContentNode n)
    {
        var sb = new StringBuilder();
        void Go(N.ContentNode x)
        {
            foreach (var r in x.Runs) sb.Append(r.Text);
            if (x.Kind is N.NodeKind.HardBreak) sb.Append('\n');
            for (var i = 0; i < x.Children.Length; i++)
            {
                Go(x.Children[i]);
                if (x.Children[i].Kind is N.NodeKind.Paragraph && i < x.Children.Length - 1) sb.Append('\n');
            }
        }
        Go(n);
        return sb.ToString();
    }

    private static string? Text(N.ContentNode n, string name) => n.Attrs.FirstOrDefault(a => a.Name == name)?.Value switch
    {
        N.AttrValue.Text t => t.Value,
        N.AttrValue.Number x => x.Value.ToString(),
        _ => null,
    };

    private static double? Number(N.ContentNode n, string name) => n.Attrs.FirstOrDefault(a => a.Name == name)?.Value switch
    {
        N.AttrValue.Number x => x.Value,
        N.AttrValue.Text t when double.TryParse(t.Value, out var d) => d,
        _ => null,
    };

    private static bool? Bool(N.ContentNode n, string name) => n.Attrs.FirstOrDefault(a => a.Name == name)?.Value switch
    {
        N.AttrValue.Bool b => b.Value,
        _ => null,
    };
}
