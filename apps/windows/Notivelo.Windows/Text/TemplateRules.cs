using System.Globalization;
using System.Text.Json.Nodes;

namespace Notivelo.Windows.Text;

/// <summary>A page template the picker offers: one of the app's built-in three, or one the workspace saved.</summary>
public sealed record TemplateItem(string Id, string Name, string? Icon, string Description, bool Builtin, bool Private = false);

/// <summary>The XAML-free rules of templates (Apple's Templates.swift; the web's <c>defaultTemplates.ts</c>): the built-in templates as editor JSON, where a saved
/// template is offered, and the {date} / {time} words.</summary>
internal static class TemplateRules
{
    public static readonly IReadOnlyList<TemplateItem> Builtins = new[]
    {
        new TemplateItem("builtin:meeting", "Meeting notes", "🤝", "Attendees, agenda, notes and action items", true),
        new TemplateItem("builtin:project", "Project", "🎯", "Goal, scope, milestones and open questions", true),
        new TemplateItem("builtin:journal", "Daily journal", "📓", "Focus, notes and a short review", true),
    };

    public static bool IsBuiltin(string id) => id.StartsWith("builtin:", StringComparison.Ordinal);

    /// <summary>The page's title when a built-in template starts it.</summary>
    public static string TitleOf(string id, DateTime now) => id switch
    {
        "builtin:meeting" => "Meeting · " + now.ToString("MMM d, yyyy", CultureInfo.CurrentCulture),
        "builtin:project" => "New project",
        "builtin:journal" => LongDate(now),
        _ => "",
    };

    public static string LongDate(DateTime d) => d.ToString("D", CultureInfo.CurrentCulture);
    public static string ShortTime(DateTime d) => d.ToString("t", CultureInfo.CurrentCulture);

    /// <summary>Whether a saved template shows in a section: offered everywhere, or tied to this section (or, with its subsections flag, to one above it).
    /// <paramref name="chain"/> is the section's id first, then its parent, up to the top.</summary>
    public static bool Offered(bool scoped, IEnumerable<(string SectionId, bool IncludeSub)> scopes, IReadOnlyList<string> chain)
    {
        if (!scoped) return true;
        var list = scopes.ToList();
        for (var i = 0; i < chain.Count; i++)
            if (list.Any(s => s.SectionId == chain[i] && (i == 0 || s.IncludeSub))) return true;
        return false;
    }

    /// <summary>The editor JSON (a doc of canvasBox nodes) of a built-in template.</summary>
    public static string ContentJson(string id, DateTime now)
    {
        var boxes = BoxesOf(id, now);
        var content = new JsonArray();
        for (var i = 0; i < boxes.Count; i++)
        {
            var b = boxes[i];
            content.Add(new JsonObject
            {
                ["type"] = "canvasBox",
                ["attrs"] = new JsonObject { ["x"] = b.X, ["y"] = b.Y, ["w"] = b.W, ["z"] = i + 1 },
                ["content"] = new JsonArray(b.Content.ToArray()),
            });
        }
        return new JsonObject { ["type"] = "doc", ["content"] = content }.ToJsonString();
    }

    private sealed record TBox(double X, double Y, double W, List<JsonNode> Content);

    private static List<TBox> BoxesOf(string id, DateTime now)
    {
        TBox Box(double x, double y, double w, params JsonNode[] c) => new(x, y, w, c.ToList());
        switch (id)
        {
            case "builtin:meeting":
                return new()
                {
                    Box(0, 0, 340, P(T("Date: ", "bold"), T(LongDate(now))), H(3, "Attendees"), Bullets(""), H(3, "Agenda"), Numbered("")),
                    Box(380, 0, 460, H(3, "Notes"), P(), H(3, "Decisions"), Bullets("")),
                    Box(0, 360, 840, H(3, "Action items"), Callout("✅", P(T("Type "), T("/task", "code"), T(" for a task. Action items land on everyone’s dashboard."))), P()),
                };
            case "builtin:project":
                return new()
                {
                    Box(0, 0, 840, Callout("🎯", P(T("Goal: ", "bold"), T("what does success look like?"))), Muted("Why are we doing this, and for whom?")),
                    Box(0, 180, 400, H(3, "Scope"), Table(new[] { new[] { "In scope", "Out of scope" }, new[] { "", "" } })),
                    Box(440, 180, 400, H(3, "Milestones"), Table(new[] { new[] { "Milestone", "Target date" }, new[] { "", "" }, new[] { "", "" } })),
                    Box(0, 480, 400, H(3, "Tasks"), Muted("Type /task to add a task: “Draft spec friday p2 @sam”."), P()),
                    Box(440, 480, 400, H(3, "Open questions"), Bullets(""), H(3, "Links"), Bullets("")),
                };
            case "builtin:journal":
                return new()
                {
                    Box(0, 0, 320, H(3, "Top 3 today"), Checklist("", "", "")),
                    Box(360, 0, 480, H(3, "Notes"), P()),
                    Box(0, 240, 320, H(3, "Grateful for"), Bullets("")),
                    Box(0, 440, 320, Toggle("End-of-day review", P(T("What went well? What would I change?", "italic")))),
                };
            default: return new();
        }
    }

    private static JsonNode T(string s, params string[] marks)
    {
        var o = new JsonObject { ["type"] = "text", ["text"] = s };
        if (marks.Length > 0) o["marks"] = new JsonArray(marks.Select(m => (JsonNode)new JsonObject { ["type"] = m }).ToArray());
        return o;
    }
    private static JsonNode P(params JsonNode[] c) => c.Length == 0 ? new JsonObject { ["type"] = "paragraph" } : new JsonObject { ["type"] = "paragraph", ["content"] = new JsonArray(c) };
    private static JsonNode H(int level, string s) => new JsonObject { ["type"] = "heading", ["attrs"] = new JsonObject { ["level"] = level }, ["content"] = new JsonArray(T(s)) };
    private static JsonNode Item(string kind, string s, bool? check = null)
    {
        var o = new JsonObject { ["type"] = kind, ["content"] = new JsonArray(s.Length == 0 ? P() : P(T(s))) };
        if (check is { } c) o["attrs"] = new JsonObject { ["checked"] = c };
        return o;
    }
    private static JsonNode Bullets(params string[] items) => new JsonObject { ["type"] = "bulletList", ["content"] = new JsonArray(items.Select(i => Item("listItem", i)).ToArray()) };
    private static JsonNode Numbered(params string[] items) => new JsonObject { ["type"] = "orderedList", ["content"] = new JsonArray(items.Select(i => Item("listItem", i)).ToArray()) };
    private static JsonNode Checklist(params string[] items) => new JsonObject { ["type"] = "taskList", ["content"] = new JsonArray(items.Select(i => Item("taskItem", i, false)).ToArray()) };
    private static JsonNode Callout(string emoji, params JsonNode[] c) => new JsonObject { ["type"] = "callout", ["attrs"] = new JsonObject { ["emoji"] = emoji }, ["content"] = new JsonArray(c) };
    private static JsonNode Table(string[][] rows)
    {
        var out_ = new JsonArray();
        for (var i = 0; i < rows.Length; i++)
        {
            var cells = new JsonArray();
            foreach (var c in rows[i])
                cells.Add(new JsonObject { ["type"] = i == 0 ? "tableHeader" : "tableCell", ["content"] = new JsonArray(c.Length == 0 ? P() : P(T(c))) });
            out_.Add(new JsonObject { ["type"] = "tableRow", ["content"] = cells });
        }
        return new JsonObject { ["type"] = "table", ["content"] = out_ };
    }
    private static JsonNode Toggle(string summary, params JsonNode[] c) => new JsonObject
    {
        ["type"] = "details",
        ["content"] = new JsonArray(
            new JsonObject { ["type"] = "detailsSummary", ["content"] = new JsonArray(T(summary)) },
            new JsonObject { ["type"] = "detailsContent", ["content"] = new JsonArray(c.Length == 0 ? new JsonNode[] { P() } : c) }),
    };
    private static JsonNode Muted(string s) => P(T(s, "italic"));
}
