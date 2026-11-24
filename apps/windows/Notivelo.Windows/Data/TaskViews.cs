using System.Globalization;
using System.Text.Json;

namespace Notivelo.Windows.Data;

// How the task views are filtered, sorted and grouped (Apple's TaskViewState.swift, the web's taskViewState.ts): pure client code over the tasks the source has
// loaded. The state is kept per view on the device. The unit tests cover it.

public enum TaskStatusFilter { Open, Done, Any }
public enum TaskDueFilter { Any, Overdue, Today, Week, None }
public enum TaskSort { Due, Priority, Created, Title }
public enum TaskGrouping { None, Due, Assignee, Team, Page, Priority }

/// <summary>A task with what the filters read (the list row alone carries labels). <see cref="Priority"/> is the core's 1 urgent .. 4 none.</summary>
public sealed record TaskFact(
    TaskItem Item, int Priority, string? Due, string? DueTime, string? AssigneeId, string? TeamId, IReadOnlyList<string> TagIds, string? PageId,
    string CreatedAt, string? CompletedAt, string Description)
{
    public bool Done => Item.Done;
}

/// <summary>Who and when a task list is read for (my id, today) and the names the groups need.</summary>
public sealed record TaskContext(string? Me, DateOnly Today, IReadOnlyList<MemberInfo> Members, IReadOnlyList<TeamInfo> Teams, Func<string, string?> PageTitle);

public sealed class TaskViewState
{
    public TaskStatusFilter Status { get; set; } = TaskStatusFilter.Open;
    /// <summary>me, others, unassigned, or a user id.</summary>
    public HashSet<string> Assignee { get; set; } = new();
    public HashSet<string> Tags { get; set; } = new();
    /// <summary>Team ids, or "none".</summary>
    public HashSet<string> Teams { get; set; } = new();
    public HashSet<int> Priority { get; set; } = new();
    public TaskDueFilter Due { get; set; } = TaskDueFilter.Any;
    /// <summary>notes, standalone.</summary>
    public HashSet<string> Source { get; set; } = new();
    public bool IncludeSubteams { get; set; } = true;
    public string Q { get; set; } = "";
    public TaskSort Sort { get; set; } = TaskSort.Due;
    public TaskGrouping Group { get; set; } = TaskGrouping.Due;
    public bool UpcomingEveryone { get; set; }
    /// <summary>Team: by person (the cards) or by team.</summary>
    public bool TeamByTeam { get; set; }
    /// <summary>Team by person: the one person shown ("none": unassigned); null: everyone.</summary>
    public string? TeamFocus { get; set; }

    public static readonly string[] Kinds = { "status", "assignee", "tags", "team", "priority", "due", "source" };

    public bool IsOn(string kind) => kind switch
    {
        "status" => Status != TaskStatusFilter.Open, "assignee" => Assignee.Count > 0, "tags" => Tags.Count > 0, "team" => Teams.Count > 0,
        "priority" => Priority.Count > 0, "due" => Due != TaskDueFilter.Any, "source" => Source.Count > 0, _ => false,
    };

    public IReadOnlyList<string> ActiveKinds => Kinds.Where(IsOn).ToList();
    /// <summary>The conditions other than Status.</summary>
    public IReadOnlyList<string> ActiveFilters => ActiveKinds.Where(k => k != "status").ToList();
    public bool AnyFilter => ActiveKinds.Count > 0 || Q.Trim().Length > 0;

    public void Clear(string kind)
    {
        switch (kind)
        {
            case "status": Status = TaskStatusFilter.Open; break;
            case "assignee": Assignee = new(); break;
            case "tags": Tags = new(); break;
            case "team": Teams = new(); break;
            case "priority": Priority = new(); break;
            case "due": Due = TaskDueFilter.Any; break;
            case "source": Source = new(); break;
        }
    }

    public void ClearAll() { foreach (var k in Kinds) Clear(k); Q = ""; }

    /// <summary>Nothing changed from the start: the view shows its own lists as they are.</summary>
    public bool IsDefault => !AnyFilter && Sort == TaskSort.Due && Group == TaskGrouping.Due && !UpcomingEveryone;

    public static bool Toggle<T>(HashSet<T> set, T value) { if (!set.Remove(value)) { set.Add(value); return true; } return false; }

    public string ToJson() => JsonSerializer.Serialize(this);

    public static TaskViewState FromJson(string? json)
    {
        if (string.IsNullOrEmpty(json)) return new();
        try { return JsonSerializer.Deserialize<TaskViewState>(json) ?? new(); } catch (Exception) { return new(); }
    }

    // ---- words ----
    public static string StatusLabel(TaskStatusFilter s) => s switch { TaskStatusFilter.Open => "Open", TaskStatusFilter.Done => "Completed", _ => "All" };
    public static string DueLabel(TaskDueFilter d) => d switch
    {
        TaskDueFilter.Any => "Any", TaskDueFilter.Overdue => "Overdue", TaskDueFilter.Today => "Today or earlier", TaskDueFilter.Week => "Next 7 days", _ => "No date",
    };
    public static string SortLabel(TaskSort s) => s switch { TaskSort.Due => "Due date", TaskSort.Priority => "Priority", TaskSort.Created => "Newest", _ => "Name" };
    public static string GroupLabel(TaskGrouping g) => g switch
    {
        TaskGrouping.None => "None", TaskGrouping.Due => "Due date", TaskGrouping.Assignee => "Assignee", TaskGrouping.Team => "Team", TaskGrouping.Page => "Page", _ => "Priority",
    };
    public static string PriorityLabel(int p) => p >= 4 ? "No priority" : p switch { 1 => "Urgent", 2 => "High", _ => "Medium" };
    public static string KindLabel(string k) => k switch
    {
        "status" => "Status", "assignee" => "Assignee", "tags" => "Tags", "team" => "Team", "priority" => "Priority", "due" => "Due", _ => "Source",
    };

    /// <summary>"Assignee: Me, Ann" for the summary line.</summary>
    public string Summary(string kind, TaskContext ctx, IReadOnlyList<TagInfo> tags)
    {
        IEnumerable<string> values = kind switch
        {
            "status" => new[] { StatusLabel(Status) },
            "assignee" => Assignee.OrderBy(x => x).Select(v => v switch
            {
                "me" => "Me", "others" => "Someone else", "unassigned" => "Unassigned", _ => ctx.Members.FirstOrDefault(m => m.Id == v)?.Name ?? "Someone",
            }),
            "tags" => Tags.Select(id => tags.FirstOrDefault(t => t.Id == id)?.Name).Where(n => n is not null).Select(n => n!).OrderBy(n => n),
            "team" => Teams.Select(id => id == "none" ? "No team" : ctx.Teams.FirstOrDefault(t => t.Id == id)?.Label ?? "Team").OrderBy(n => n),
            "priority" => Priority.OrderBy(p => p).Select(PriorityLabel),
            "due" => new[] { DueLabel(Due) },
            _ => Source.OrderBy(s => s).Select(s => s == "notes" ? "On pages" : "Standalone"),
        };
        return KindLabel(kind) + ": " + string.Join(", ", values);
    }
}

/// <summary>The lists, the filters, the sort and the groups (Apple's TaskBuckets and TaskViewState.filter/sorted/grouped).</summary>
public static class TaskViewLogic
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    private static string Day(DateOnly d) => d.ToString("yyyy-MM-dd", Inv);

    /// <summary>The open tasks a view lists before the conditions: Today (mine, due today or earlier), My Tasks (mine), Upcoming (the next seven days; everyone's or mine),
    /// All and Team (everyone's).</summary>
    public static IReadOnlyList<TaskFact> Base(TaskViewKind view, IEnumerable<TaskFact> all, TaskContext ctx, bool everyone = false)
    {
        var open = all.Where(t => !t.Done).ToList();
        var today = Day(ctx.Today); var week = Day(ctx.Today.AddDays(7));
        bool Mine(TaskFact t) => t.AssigneeId is not null && t.AssigneeId == ctx.Me;
        return view switch
        {
            TaskViewKind.Today => open.Where(t => Mine(t) && t.Due is { } d && string.CompareOrdinal(d, today) <= 0).ToList(),
            TaskViewKind.MyTasks => open.Where(Mine).ToList(),
            TaskViewKind.Upcoming => open.Where(t => (everyone || Mine(t)) && t.Due is { } d && string.CompareOrdinal(d, today) > 0 && string.CompareOrdinal(d, week) <= 0).ToList(),
            _ => open,
        };
    }

    /// <summary>The tasks that pass the conditions (Status is the caller's: it picks open or done first). The search text applies with <paramref name="includeSearch"/>.</summary>
    public static IReadOnlyList<TaskFact> Filter(IEnumerable<TaskFact> list, TaskViewState s, TaskContext ctx, bool includeSearch = true)
    {
        var today = Day(ctx.Today); var weekEnd = Day(ctx.Today.AddDays(7));
        var query = includeSearch ? s.Q.Trim().ToLowerInvariant() : "";
        var scope = new Dictionary<string, HashSet<string>>();
        foreach (var id in s.Teams.Where(x => x != "none"))
        {
            var ids = new HashSet<string> { id };
            if (s.IncludeSubteams) foreach (var t in ctx.Teams.Where(t => t.ParentId == id)) ids.Add(t.Id);
            scope[id] = ids;
        }
        bool Pass(TaskFact t)
        {
            if (query.Length > 0 && !t.Item.Title.ToLowerInvariant().Contains(query) && !t.Description.ToLowerInvariant().Contains(query)) return false;
            if (s.Assignee.Count > 0)
            {
                var hit = s.Assignee.Any(v => v switch
                {
                    "me" => t.AssigneeId is not null && t.AssigneeId == ctx.Me,
                    "unassigned" => t.AssigneeId is null,
                    "others" => t.AssigneeId is not null && t.AssigneeId != ctx.Me,
                    _ => t.AssigneeId == v,
                });
                if (!hit) return false;
            }
            if (s.Priority.Count > 0 && !s.Priority.Contains(t.Priority)) return false;
            switch (s.Due)
            {
                case TaskDueFilter.Overdue: if (t.Due is not { } o || string.CompareOrdinal(o, today) >= 0) return false; break;
                case TaskDueFilter.Today: if (t.Due is not { } d || string.CompareOrdinal(d, today) > 0) return false; break;
                case TaskDueFilter.Week: if (t.Due is not { } w || string.CompareOrdinal(w, weekEnd) > 0) return false; break;
                case TaskDueFilter.None: if (t.Due is not null) return false; break;
            }
            if (s.Source.Count > 0 && !s.Source.Any(v => v == "notes" ? t.PageId is not null : t.PageId is null)) return false;
            if (s.Tags.Count > 0 && !t.TagIds.Any(s.Tags.Contains)) return false;
            if (s.Teams.Count > 0)
            {
                var team = t.TeamId;
                var hit = s.Teams.Any(v => v == "none" ? team is null : team is not null && scope.TryGetValue(v, out var ids) && ids.Contains(team));
                if (!hit) return false;
            }
            return true;
        }
        return list.Where(Pass).ToList();
    }

    public static IReadOnlyList<TaskFact> Sorted(IEnumerable<TaskFact> list, TaskSort key)
    {
        var l = list.ToList();
        Comparison<TaskFact> cmp = key switch
        {
            TaskSort.Due => (a, b) =>
            {
                var c = string.CompareOrdinal(a.Due ?? "9999", b.Due ?? "9999");
                if (c == 0) c = string.CompareOrdinal(a.DueTime ?? "99", b.DueTime ?? "99");
                if (c == 0) c = a.Priority.CompareTo(b.Priority);
                return c != 0 ? c : string.CompareOrdinal(a.CreatedAt, b.CreatedAt);
            },
            TaskSort.Priority => (a, b) => { var c = a.Priority.CompareTo(b.Priority); return c != 0 ? c : string.CompareOrdinal(a.Due ?? "9999", b.Due ?? "9999"); },
            TaskSort.Created => (a, b) => string.CompareOrdinal(b.CreatedAt, a.CreatedAt),
            _ => (a, b) => string.Compare(a.Item.Title, b.Item.Title, StringComparison.CurrentCultureIgnoreCase),
        };
        // a stable sort (List.Sort is not)
        return l.Select((t, i) => (t, i)).OrderBy(x => x, Comparer<(TaskFact t, int i)>.Create((x, y) => { var c = cmp(x.t, y.t); return c != 0 ? c : x.i.CompareTo(y.i); })).Select(x => x.t).ToList();
    }

    /// <summary>The heading of a day: "Today · Sat 21 Nov", "Tomorrow · Sun 22 Nov", a weekday, then "30 Nov".</summary>
    public static string DayTitle(string day, DateOnly today)
    {
        if (TaskLogic.ParseDay(day) is not { } d) return day;
        var n = d.DayNumber - today.DayNumber;
        var ci = CultureInfo.CurrentCulture;
        return n switch
        {
            0 => "Today · " + d.ToString("ddd d MMM", ci), 1 => "Tomorrow · " + d.ToString("ddd d MMM", ci),
            >= 2 and <= 6 => d.ToString("dddd", ci), _ => d.ToString("ddd d MMM", ci),
        };
    }

    /// <summary>The tasks sorted, then grouped: Overdue first, then the others in order, with "No date", "Unassigned", "No team" and "Not on a page" last. Due-date groups
    /// are Overdue, Today, Later, No date (the lists' own look); <paramref name="perDay"/> makes one group per day (Upcoming).</summary>
    public static IReadOnlyList<TaskGroup> Grouped(IEnumerable<TaskFact> list, TaskGrouping key, TaskSort sort, TaskContext ctx, bool perDay = false)
    {
        var items = Sorted(list, sort);
        if (key == TaskGrouping.None) return items.Count == 0 ? Array.Empty<TaskGroup>() : new[] { new TaskGroup("", items.Count, false, items.Select(t => t.Item).ToList()) };
        var order = new List<string>();
        var blocks = new Dictionary<string, (string Title, bool Overdue, List<TaskItem> Tasks)>();
        void Add(string k, string title, TaskFact t, bool overdue = false)
        {
            if (!blocks.ContainsKey(k)) { blocks[k] = (title, overdue, new List<TaskItem>()); order.Add(k); }
            blocks[k].Tasks.Add(t.Item);
        }
        var today = Day(ctx.Today);
        var teams = TaskLogic.Order(ctx.Teams);
        foreach (var t in items)
        {
            switch (key)
            {
                case TaskGrouping.Due:
                    if (t.Due is { } d)
                    {
                        if (string.CompareOrdinal(d, today) < 0) Add("!overdue", "Overdue", t, true);
                        else if (d == today) Add(perDay ? d : "0today", DayTitle(d, ctx.Today), t);
                        else if (perDay) Add(d, DayTitle(d, ctx.Today), t);
                        else Add("5later", "Later", t);
                    }
                    else Add("~none", "No date", t);
                    break;
                case TaskGrouping.Assignee:
                    if (ctx.Members.FirstOrDefault(m => m.Id == t.AssigneeId) is { } m) Add("a" + m.Name + m.Id, m.Name, t); else Add("~", "Unassigned", t);
                    break;
                case TaskGrouping.Priority:
                    Add(t.Priority.ToString(Inv), t.Priority >= 4 ? "No priority" : "Priority " + t.Priority, t);
                    break;
                case TaskGrouping.Team:
                    if (t.TeamId is { } id && teams.ToList().FindIndex(x => x.Id == id) is var i and >= 0) Add("t" + i.ToString("D5", Inv), teams[i].Label, t);
                    else Add("~", "No team", t);
                    break;
                case TaskGrouping.Page:
                    if (t.PageId is { } pid && ctx.PageTitle(pid) is { } title) Add("p" + title + pid, title.Length == 0 ? "Untitled" : title, t);
                    else Add("~", "Not on a page", t);
                    break;
            }
        }
        static int Rank(string k) => k.StartsWith('!') ? 0 : k.StartsWith('~') ? 2 : 1;
        return order.OrderBy(k => Rank(k)).ThenBy(k => k, StringComparer.Ordinal)
            .Select(k => new TaskGroup(blocks[k].Title, blocks[k].Tasks.Count, blocks[k].Overdue, blocks[k].Tasks)).ToList();
    }

    /// <summary>One person's open, overdue and done-this-week numbers on the Team cards.</summary>
    public static (int Open, int Overdue, int Done) PersonStats(IEnumerable<TaskFact> theirs, TaskContext ctx)
    {
        var today = Day(ctx.Today);
        var weekAgo = ctx.Today.AddDays(-7);
        var all = theirs.ToList();
        var open = all.Where(t => !t.Done).ToList();
        var overdue = open.Count(t => t.Due is { } d && string.CompareOrdinal(d, today) < 0);
        var done = all.Count(t => t.Done && t.CompletedAt is { } c && DateTimeOffset.TryParse(c, Inv, DateTimeStyles.AssumeUniversal, out var o) && DateOnly.FromDateTime(o.LocalDateTime) > weekAgo);
        return (open.Count, overdue, done);
    }

    /// <summary>My open tasks due today or earlier (the taskbar badge: Apple's AppBadge, the web's dueTodayCount).</summary>
    public static int DueTodayCount(IEnumerable<TaskFact> all, TaskContext ctx)
    {
        var today = Day(ctx.Today);
        return all.Count(t => !t.Done && t.AssigneeId is not null && t.AssigneeId == ctx.Me && t.Due is { } d && string.CompareOrdinal(d, today) <= 0);
    }
}
