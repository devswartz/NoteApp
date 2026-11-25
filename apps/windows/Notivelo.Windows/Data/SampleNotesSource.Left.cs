using System.Text.Json.Nodes;
using Notivelo.Windows.Text;
using Tsk = System.Threading.Tasks.Task;

namespace Notivelo.Windows.Data;

// The left batch on the sample data (offline test mode and screenshots): the box clipboard over the offline test page's boxes, templates in memory, and two demo
// reminders. The offline boxes are editor sessions over local documents, so their text is read through the probe the page gives (SetBoxTextProbe).
public sealed partial class SampleNotesSource
{
    private Func<string, string>? _boxText;
    private readonly Dictionary<string, string> _seedText = new();

    public void SetBoxTextProbe(Func<string, string>? probe) => _boxText = probe;

    private static JsonNode Paragraphs(string text)
    {
        var arr = new JsonArray();
        foreach (var line in text.Split('\n'))
            arr.Add(line.Length == 0 ? new JsonObject { ["type"] = "paragraph" } : new JsonObject { ["type"] = "paragraph", ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = line }) });
        return arr;
    }

    public PageToolResult<string> BoxClip(string pageId, IReadOnlyList<string> boxIds)
    {
        if (!CanEditBoxes(pageId) || !_pages.TryGetValue(pageId, out var p)) return PageToolResult<string>.Fail("Not available.");
        var boxes = new JsonArray();
        var texts = new List<string>();
        foreach (var id in boxIds)
        {
            var b = p.Boxes.FirstOrDefault(x => x.Id == id);
            if (b is null) return PageToolResult<string>.Fail("That box is gone.");
            var text = _boxText?.Invoke("box:" + id) ?? _seedText.GetValueOrDefault(id, "");
            texts.Add(text);
            boxes.Add(new JsonObject { ["x"] = b.X, ["y"] = b.Y, ["w"] = b.Width, ["content"] = Paragraphs(text) });
        }
        return new PageToolResult<string>(new JsonObject { ["boxes"] = boxes, ["text"] = string.Join("\n\n", texts), ["cut"] = false }.ToJsonString());
    }

    public PageToolResult<IReadOnlyList<string>> PasteBoxes(string pageId, string clipJson, double? x, double? y)
    {
        if (!CanEditBoxes(pageId) || !_pages.TryGetValue(pageId, out var p)) return PageToolResult<IReadOnlyList<string>>.Fail("Not available.");
        JsonArray? boxes;
        try
        {
            var root = JsonNode.Parse(clipJson);
            boxes = (root as JsonObject)?["boxes"] as JsonArray ?? root as JsonArray;
        }
        catch (Exception) { boxes = null; }
        if (boxes is null || boxes.Count == 0) return PageToolResult<IReadOnlyList<string>>.Fail("That isn't a box.");
        var made = new List<string>();
        var list = p.Boxes.ToList();
        var front = list.Select(b => b.Z).DefaultIfEmpty(0).Max();
        var minX = boxes.Min(b => b!["x"]!.GetValue<double>()); var minY = boxes.Min(b => b!["y"]!.GetValue<double>());
        double ox, oy;
        if (x is { } ax && y is { } ay) { ox = ax - minX; oy = ay - minY; }
        else { var n = BoxClipboardRules.Nudge(minX, minY, list.Select(b => (b.X, b.Y))); ox = n.X - minX; oy = n.Y - minY; }
        foreach (var b in boxes)
        {
            var id = "n" + Guid.NewGuid().ToString("N")[..8];
            var text = string.Join("\n", (b!["content"] as JsonArray ?? new JsonArray()).Select(pp => string.Concat((pp?["content"] as JsonArray ?? new JsonArray()).Select(t => t?["text"]?.GetValue<string>() ?? ""))));
            _seedText[id] = text;
            list.Add(new CanvasBox(Math.Max(0, Math.Round(b!["x"]!.GetValue<double>() + ox)), Math.Max(0, Math.Round(b["y"]!.GetValue<double>() + oy)),
                Math.Clamp(Math.Round(b["w"]!.GetValue<double>()), 120, 2400), false, new BoxBlock[] { new(BlockKind.Paragraph, text) }, "box:" + id, id, ++front));
            made.Add(id);
        }
        _pages[pageId] = p with { Boxes = list };
        Log("box paste " + string.Join(",", made));
        Raise();
        return new PageToolResult<IReadOnlyList<string>>(made);
    }

    public PageToolResult<IReadOnlyList<string>> DuplicateBoxes(string pageId, IReadOnlyList<string> boxIds)
    {
        var clip = BoxClip(pageId, boxIds);
        return clip.Ok ? PasteBoxes(pageId, clip.Value!, null, null) : PageToolResult<IReadOnlyList<string>>.Fail(clip.Error!);
    }

    public PageToolResult<bool> DeleteBoxesWithContent(string pageId, IReadOnlyList<string> boxIds)
    {
        if (!CanEditBoxes(pageId)) return PageToolResult<bool>.Fail("Not available.");
        foreach (var id in boxIds) EditBoxes(pageId, l => l.RemoveAll(b => b.Id == id) > 0);
        Log("box delete-with-content " + string.Join(",", boxIds));
        return new PageToolResult<bool>(true);
    }

    // ---- templates ----

    private readonly List<TemplateItem> _savedTemplates = new()
    {
        new("t-weekly", "Weekly review", "🗓️", "Saved template", false),
        new("t-one", "1:1 notes", "💬", "Saved template", false, true),
    };

    public Task<PageToolResult<IReadOnlyList<TemplateItem>>> LoadTemplates(string sectionId) =>
        Tsk.FromResult(new PageToolResult<IReadOnlyList<TemplateItem>>(TemplateRules.Builtins.Concat(SavedNow().Where(t => !t.Scoped || TemplateRules.Offered(true, t.Scopes ?? new List<(string, bool)>(), ChainOf(sectionId)))).ToList()));

    public Task<TreeResult> CreatePageFromTemplate(string sectionId, TemplateItem template)
    {
        var title = template.Builtin ? TemplateRules.TitleOf(template.Id, DateTime.Now) : template.Name;
        var p = new PageSummary(NewId("page"), title.Length == 0 ? "Untitled" : title, 0, template.Icon);
        AddPage(sectionId, p); EnsurePage(p);
        _pages[p.Id] = _pages[p.Id] with { Boxes = new CanvasBox[] { new(20, 20, 560, true, new BoxBlock[] { new(BlockKind.Heading1, template.Name), new(BlockKind.Paragraph, "Started from the " + template.Name + " template.") }) } };
        Log("page from template " + template.Id);
        Raise();
        return Done(p.Id);
    }

    public Task<string?> SaveAsTemplate(string pageId, string name)
    {
        _savedTemplates.Add(new TemplateItem("t-" + NewId("saved"), name, null, "Saved template", false));
        Log("save as template " + name);
        return Tsk.FromResult<string?>(null);
    }

    // ---- reminders: two demo ones so the toasts can be scheduled (and read back) without a server ----

    public bool SchedulesReminders => Offline;

    public Task<IReadOnlyList<ReminderEntry>> UpcomingReminders()
    {
        if (!Offline) return Tsk.FromResult<IReadOnlyList<ReminderEntry>>(Array.Empty<ReminderEntry>());
        var now = DateTime.UtcNow;
        IReadOnlyList<ReminderEntry> list = new[]
        {
            new ReminderEntry("r-1", "t-welcome", "Try checking off this task", now.AddMinutes(30), now.ToString("yyyy-MM-dd"), "09:00", null, "sample"),
            new ReminderEntry("r-2", "t-launch", "Review the launch checklist", now.AddHours(26), now.AddDays(1).ToString("yyyy-MM-dd"), null, null, "sample"),
        };
        return Tsk.FromResult(list);
    }

    public Task<string?> SnoozeReminder(string snoozeToken, string option)
    {
        Log("snooze " + option);
        return Tsk.FromResult<string?>(null);
    }
}
