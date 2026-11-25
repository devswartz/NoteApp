using System.Text.Json;

namespace Notivelo.Windows.Data;

// Saved task views, backlinks and bulk selection (left4): the plain parts. A saved view is the filters, sort and group of All tasks kept on the server; its query
// is the web's JSON ({"filters": {...}, "sort": "due", "group": "none"}, src/lib/taskViews.ts, as Apple's ViewQuery writes it). Filters the app has no control for
// (assignedBy, notebook, section, "not" picks, tagsNone) are not read from a view made on the web and are written empty. The unit tests cover this file.

/// <summary>A saved task view of the open workspace: <see cref="Shared"/> ones are seen by everyone (owners and admins make them).</summary>
public sealed record SavedView(string Id, string Name, string QueryJson, bool Shared, string OwnerId, double Position);

/// <summary>A page that links to the open page with a [[link]] (newest edit first).</summary>
public sealed record BacklinkItem(string PageId, string Title, string? Icon, string Where, string Updated);

public static class SavedViewRules
{
    public const int NameMax = 60;

    /// <summary>The name a view is saved under: trimmed; null when it is empty. Longer than <see cref="NameMax"/> is cut.</summary>
    public static string? CleanName(string? raw)
    {
        var t = (raw ?? "").Trim();
        if (t.Length == 0) return null;
        return t.Length > NameMax ? t[..NameMax].TrimEnd() : t;
    }

    private static string StatusKey(TaskStatusFilter s) => s switch { TaskStatusFilter.Done => "done", TaskStatusFilter.Any => "any", _ => "open" };
    private static string DueKey(TaskDueFilter d) => d switch { TaskDueFilter.Overdue => "overdue", TaskDueFilter.Today => "today", TaskDueFilter.Week => "week", TaskDueFilter.None => "none", _ => "any" };
    private static string SortKey(TaskSort s) => s switch { TaskSort.Priority => "priority", TaskSort.Created => "created", TaskSort.Title => "title", _ => "due" };
    private static string GroupKey(TaskGrouping g) => g switch
    {
        TaskGrouping.Due => "due", TaskGrouping.Assignee => "assignee", TaskGrouping.Team => "team", TaskGrouping.Page => "note", TaskGrouping.Priority => "priority", _ => "none",
    };

    /// <summary>The web's JSON for the conditions of a task view (a fixed key order, so two equal states give the same text).</summary>
    public static string ToQueryJson(TaskViewState s)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteStartObject("filters");
            void Values(string name, IEnumerable<string> values)
            {
                w.WriteStartObject(name);
                w.WriteBoolean("not", false);
                w.WriteStartArray("values");
                foreach (var v in values.OrderBy(x => x, StringComparer.Ordinal)) w.WriteStringValue(v);
                w.WriteEndArray();
                w.WriteEndObject();
            }
            w.WriteBoolean("includeSubteams", s.IncludeSubteams);
            Values("assignedBy", Array.Empty<string>());
            Values("assignee", s.Assignee);
            Values("notebookId", Array.Empty<string>());
            Values("priority", s.Priority.Select(p => p.ToString()));
            w.WriteString("due", DueKey(s.Due));
            w.WriteString("q", s.Q.Trim());
            Values("sectionId", Array.Empty<string>());
            Values("source", s.Source);
            w.WriteString("status", StatusKey(s.Status));
            w.WriteStartArray("tagsAny");
            foreach (var t in s.Tags.OrderBy(x => x, StringComparer.Ordinal)) w.WriteStringValue(t);
            w.WriteEndArray();
            w.WriteStartArray("tagsNone"); w.WriteEndArray();
            Values("teamId", s.Teams);
            w.WriteEndObject();
            w.WriteString("group", GroupKey(s.Group));
            w.WriteString("sort", SortKey(s.Sort));
            w.WriteEndObject();
        }
        return System.Text.Encoding.UTF8.GetString(ms.ToArray());
    }

    /// <summary>The conditions a saved query holds; anything unreadable is left at the plain All tasks (no filters, sort by date, no groups).</summary>
    public static TaskViewState FromQueryJson(string? json)
    {
        var s = new TaskViewState { Group = TaskGrouping.None };
        if (string.IsNullOrWhiteSpace(json)) return s;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return s;
            if (root.TryGetProperty("filters", out var f) && f.ValueKind == JsonValueKind.Object)
            {
                List<string> Pick(string key)
                {
                    if (!f.TryGetProperty(key, out var e)) return new();
                    if (e.ValueKind == JsonValueKind.String) return e.GetString() is { } str && str != "any" ? new() { str } : new();
                    if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty("values", out var v) && v.ValueKind == JsonValueKind.Array)
                        return v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList();
                    return new();
                }
                s.Assignee = Pick("assignee").ToHashSet();
                s.Priority = Pick("priority").Select(p => int.TryParse(p, out var n) ? n : 0).Where(n => n is >= 1 and <= 4).ToHashSet();
                s.Source = Pick("source").Where(x => x is "notes" or "standalone").ToHashSet();
                s.Teams = Pick("teamId").ToHashSet();
                if (f.TryGetProperty("tagsAny", out var ta) && ta.ValueKind == JsonValueKind.Array) s.Tags = ta.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToHashSet();
                if (f.TryGetProperty("includeSubteams", out var sub) && sub.ValueKind is JsonValueKind.True or JsonValueKind.False) s.IncludeSubteams = sub.GetBoolean();
                if (f.TryGetProperty("q", out var q) && q.ValueKind == JsonValueKind.String && (q.GetString() ?? "").Length <= 200) s.Q = (q.GetString() ?? "").Trim();
                if (f.TryGetProperty("due", out var due) && due.ValueKind == JsonValueKind.String)
                    s.Due = due.GetString() switch { "overdue" => TaskDueFilter.Overdue, "today" => TaskDueFilter.Today, "week" => TaskDueFilter.Week, "none" => TaskDueFilter.None, _ => TaskDueFilter.Any };
                if (f.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String)
                    s.Status = st.GetString() switch { "done" => TaskStatusFilter.Done, "any" => TaskStatusFilter.Any, _ => TaskStatusFilter.Open };
            }
            if (root.TryGetProperty("sort", out var so) && so.ValueKind == JsonValueKind.String)
                s.Sort = so.GetString() switch { "priority" => TaskSort.Priority, "created" => TaskSort.Created, "title" => TaskSort.Title, _ => TaskSort.Due };
            if (root.TryGetProperty("group", out var g) && g.ValueKind == JsonValueKind.String)
                s.Group = g.GetString() switch
                {
                    "due" => TaskGrouping.Due, "assignee" => TaskGrouping.Assignee, "team" => TaskGrouping.Team, "note" => TaskGrouping.Page, "priority" => TaskGrouping.Priority, _ => TaskGrouping.None,
                };
        }
        catch (JsonException) { return new TaskViewState { Group = TaskGrouping.None }; }
        return s;
    }

    /// <summary>Copy the conditions of <paramref name="from"/> onto <paramref name="to"/> (opening a saved view on All tasks).</summary>
    public static void Apply(TaskViewState from, TaskViewState to)
    {
        to.Status = from.Status; to.Assignee = new(from.Assignee); to.Tags = new(from.Tags); to.Teams = new(from.Teams); to.Priority = new(from.Priority);
        to.Due = from.Due; to.Source = new(from.Source); to.IncludeSubteams = from.IncludeSubteams; to.Q = from.Q; to.Sort = from.Sort; to.Group = from.Group;
        to.UpcomingEveryone = false; to.TeamFocus = null;
    }

    /// <summary>Whether the conditions are the same as a saved query's (the saved view All tasks is showing).</summary>
    public static bool Same(TaskViewState state, string queryJson) => ToQueryJson(state) == ToQueryJson(FromQueryJson(queryJson));

    /// <summary>The saved view whose conditions are exactly <paramref name="state"/> (null: none, or the state is the plain list).</summary>
    public static SavedView? Matching(IEnumerable<SavedView> views, TaskViewState state)
    {
        var plain = ToQueryJson(new TaskViewState { Group = TaskGrouping.None });
        var now = ToQueryJson(state);
        if (now == plain) return null;
        return views.FirstOrDefault(v => ToQueryJson(FromQueryJson(v.QueryJson)) == now);
    }

    /// <summary>The views in the order the menus list them: the person's own, then shared ones, each by position then name.</summary>
    public static IReadOnlyList<SavedView> Ordered(IEnumerable<SavedView> views, string? me) =>
        views.OrderBy(v => v.OwnerId == me ? 0 : 1).ThenBy(v => v.Position).ThenBy(v => v.Name, StringComparer.CurrentCultureIgnoreCase).ToList();

    /// <summary>A name that is not taken yet: "Name", then "Name 2", "Name 3"...</summary>
    public static string FreeName(IEnumerable<SavedView> views, string wanted)
    {
        var names = views.Select(v => v.Name).ToHashSet(StringComparer.CurrentCultureIgnoreCase);
        if (!names.Contains(wanted)) return wanted;
        for (var i = 2; ; i++) { var n = wanted + " " + i; if (!names.Contains(n)) return n; }
    }

    /// <summary>A short line for a view's conditions: "2 filters · by Priority".</summary>
    public static string Describe(TaskViewState s)
    {
        var parts = new List<string>();
        var n = s.ActiveKinds.Count + (s.Q.Trim().Length > 0 ? 1 : 0);
        if (n > 0) parts.Add(n + (n == 1 ? " filter" : " filters"));
        if (s.Group != TaskGrouping.None) parts.Add("by " + TaskViewState.GroupLabel(s.Group));
        if (s.Sort != TaskSort.Due) parts.Add("sorted by " + TaskViewState.SortLabel(s.Sort).ToLowerInvariant());
        return parts.Count == 0 ? "All tasks" : string.Join(" · ", parts);
    }
}

/// <summary>Bulk selection of task rows (the web's selection.ts): ids, the anchor of a Shift range, the row the keyboard is on.</summary>
public sealed class TaskSelection
{
    private readonly HashSet<string> _ids = new();
    public IReadOnlyCollection<string> Ids => _ids;
    public int Count => _ids.Count;
    public bool Active { get; private set; }
    public string? Anchor { get; private set; }
    /// <summary>The row the keyboard is on (a task id).</summary>
    public string? Cursor { get; set; }

    public bool Contains(string id) => _ids.Contains(id);

    /// <summary>Selecting begins (the Select button, a Ctrl or Shift click): rows then toggle instead of opening.</summary>
    public void Begin() => Active = true;

    public void Toggle(string id) { if (!_ids.Remove(id)) _ids.Add(id); Anchor = id; Cursor = id; Active = true; }

    /// <summary>Select every row from the anchor to <paramref name="id"/> in <paramref name="order"/> (on-screen order), keeping what was selected.</summary>
    public void ExtendTo(string id, IReadOnlyList<string> order)
    {
        var a = Anchor is null ? -1 : IndexOf(order, Anchor);
        var b = IndexOf(order, id);
        if (a < 0 || b < 0) { Toggle(id); return; }
        for (var i = Math.Min(a, b); i <= Math.Max(a, b); i++) _ids.Add(order[i]);
        Cursor = id; Active = true;
    }

    private static int IndexOf(IReadOnlyList<string> l, string id) { for (var i = 0; i < l.Count; i++) if (l[i] == id) return i; return -1; }

    public void SelectAll(IEnumerable<string> order) { foreach (var i in order) _ids.Add(i); Active = true; }

    public void Clear() { _ids.Clear(); Anchor = null; Cursor = null; Active = false; }

    /// <summary>Forget ids that are no longer listed (a filter changed, a task was deleted).</summary>
    public void Prune(IEnumerable<string> shown)
    {
        var live = shown.ToHashSet();
        _ids.RemoveWhere(i => !live.Contains(i));
        if (Anchor is not null && !live.Contains(Anchor)) Anchor = null;
        if (Cursor is not null && !live.Contains(Cursor)) Cursor = null;
    }

    /// <summary>Move the keyboard's row by <paramref name="step"/> in <paramref name="order"/> (clamped); with <paramref name="extend"/> the rows between the anchor and the new row are selected.</summary>
    public string? Step(IReadOnlyList<string> order, int step, bool extend)
    {
        if (order.Count == 0) return null;
        var at = Cursor is null ? -1 : IndexOf(order, Cursor);
        var next = at < 0 ? (step > 0 ? 0 : order.Count - 1) : Math.Clamp(at + step, 0, order.Count - 1);
        var id = order[next];
        if (extend)
        {
            if (Anchor is null) { Anchor = Cursor ?? id; _ids.Add(Anchor); }
            ExtendTo(id, order);
        }
        else Cursor = id;
        return id;
    }
}

/// <summary>The dates the bulk bar offers (yyyy-MM-dd from <paramref name="today"/>).</summary>
public static class BulkRules
{
    public static string Day(DateOnly today, int add) => today.AddDays(add).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>All the picked tasks are done (the first button then reopens them).</summary>
    public static bool AllDone(IEnumerable<TaskItem> picked) { var l = picked.ToList(); return l.Count > 0 && l.All(t => t.Done); }

    public static string Said(string what, int count) => $"{what} · {count} task{(count == 1 ? "" : "s")}";
}

/// <summary>What changes a task back after a <see cref="TaskPatch"/> (the bulk bar's Undo): only the fields the patch touched, from the task as it was.</summary>
public static class TaskPatches
{
    public static TaskPatch Undo(TaskPatch patch, TaskDetailItem was)
    {
        var due = patch.DueDate is not null || patch.ClearDue;
        var who = patch.AssigneeId is not null || patch.ClearAssignee;
        return new TaskPatch(
            Done: patch.Done is { } d && d != was.Done ? was.Done : null,
            Priority: patch.Priority is null ? null : was.Priority,
            DueDate: due ? was.DueDate : null, ClearDue: due && was.DueDate is null,
            AssigneeId: who ? was.AssigneeId : null, ClearAssignee: who && was.AssigneeId is null);
    }
}
