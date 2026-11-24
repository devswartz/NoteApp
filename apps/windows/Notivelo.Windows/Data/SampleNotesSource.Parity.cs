namespace Notivelo.Windows.Data;
using N = Notivelo.Native;
using Tsk = System.Threading.Tasks.Task;

// Parity B on the sample data: the tree, Trash, search and task edits all work in memory, so the UI (and the UI tests, in offline mode)
// can be driven without a server. The core source does the same through the core's calls.
public sealed partial class SampleNotesSource
{
    private sealed record TrashRec(TrashItem Item, object Payload, string? NotebookId, string? ParentId);

    private readonly List<TrashRec> _trash = new();
    private readonly Dictionary<string, string> _desc = new();
    private readonly Dictionary<string, (string? Due, string? Assignee)> _extra = new();
    private int _ids;
    private long _tasksVersion;

    public bool CanEditTree => true;
    public long TasksVersion => _tasksVersion;

    private void Raise() => Changed?.Invoke(this, EventArgs.Empty);
    private string NewId(string p) => p + "-n" + ++_ids;

    // ---- tree helpers ----

    private static Section? MapSec(Section s, Func<Section, Section?> f)
    {
        var kids = s.Children.Select(c => MapSec(c, f)).Where(c => c is not null).Select(c => c!).ToList();
        return f(s with { Children = kids });
    }

    private void MapTree(Func<Section, Section?> f) =>
        Notebooks = Notebooks.Select(n => n with { Sections = n.Sections.Select(s => MapSec(s, f)).Where(s => s is not null).Select(s => s!).ToList() }).ToList();

    private IEnumerable<(Section S, string NotebookId, string? ParentId)> AllSections()
    {
        IEnumerable<(Section, string, string?)> Walk(Section s, string nb, string? parent)
        {
            yield return (s, nb, parent);
            foreach (var c in s.Children) foreach (var x in Walk(c, nb, s.Id)) yield return x;
        }
        foreach (var n in Notebooks) foreach (var s in n.Sections) foreach (var x in Walk(s, n.Id, null)) yield return x;
    }

    private string PathOfSection(string sectionId)
    {
        var all = AllSections().ToList();
        var names = new List<string>();
        var cur = all.FirstOrDefault(x => x.S.Id == sectionId);
        for (var i = 0; cur.S is not null && i < 12; i++)
        {
            names.Insert(0, cur.S.Name);
            if (cur.ParentId is null) { names.Insert(0, Notebooks.First(n => n.Id == cur.NotebookId).Name); break; }
            cur = all.First(x => x.S.Id == cur.ParentId);
        }
        return string.Join(" › ", names);
    }

    private static Task<TreeResult> Done(string? id = null, string? note = null) => Tsk.FromResult(new TreeResult(id, null, note));

    private void AddPage(string sectionId, PageSummary p) => MapTree(s => s.Id == sectionId ? s with { Pages = s.Pages.Append(p).ToList() } : s);

    private void EnsurePage(PageSummary p, string? source = null)
    {
        if (_pages.ContainsKey(p.Id)) { _pages[p.Id] = _pages[p.Id] with { Title = p.Title }; return; }
        var basis = source is not null && _pages.TryGetValue(source, out var b) ? b : null;
        _pages[p.Id] = new NotePage(p.Id, p.Title, "Edited just now by you", "Look reference", "#ec4899", new[] { "Corpus" }, PageColour.None, RuleLines.None,
            basis?.Boxes ?? new CanvasBox[] { new(20, 20, 560, true, new BoxBlock[] { new(BlockKind.Heading1, p.Title), new(BlockKind.Paragraph, "A new page.") }) }, 0, 0);
    }

    // ---- tree actions ----

    public Task<TreeResult> CreateNotebook(string name)
    {
        var id = NewId("nb");
        Notebooks = Notebooks.Append(new Notebook(id, name, name.Length > 0 ? name[..1].ToUpperInvariant() : "N", "#6366f1", false, Array.Empty<Section>())).ToList();
        _nb = id; Raise();
        return Done(id);
    }

    public Task<TreeResult> CreateSection(string notebookId, string? parentId, string name)
    {
        var id = NewId("sec");
        var sec = new Section(id, name, "#6366f1", Array.Empty<PageSummary>(), Array.Empty<Section>());
        if (parentId is null) Notebooks = Notebooks.Select(n => n.Id == notebookId ? n with { Sections = n.Sections.Append(sec).ToList() } : n).ToList();
        else MapTree(s => s.Id == parentId ? s with { Children = s.Children.Append(sec).ToList() } : s);
        Raise();
        return Done(id);
    }

    public Task<TreeResult> CreatePage(string sectionId, string title)
    {
        var p = new PageSummary(NewId("page"), title.Length == 0 ? "Untitled" : title, 0);
        AddPage(sectionId, p); EnsurePage(p); Raise();
        return Done(p.Id);
    }

    public Task<TreeResult> Rename(TreeKind kind, string id, string name)
    {
        switch (kind)
        {
            case TreeKind.Notebook: Notebooks = Notebooks.Select(n => n.Id == id ? n with { Name = name, Initial = name.Length > 0 ? name[..1].ToUpperInvariant() : "N" } : n).ToList(); break;
            case TreeKind.Section: MapTree(s => s.Id == id ? s with { Name = name } : s); break;
            default:
                MapTree(s => s with { Pages = s.Pages.Select(p => p.Id == id ? p with { Title = name } : p).ToList() });
                if (_pages.TryGetValue(id, out var pg)) _pages[id] = pg with { Title = name };
                break;
        }
        Raise();
        return Done();
    }

    public Task<TreeResult> Duplicate(TreeKind kind, string id)
    {
        if (kind == TreeKind.Page)
        {
            var host = AllSections().FirstOrDefault(x => x.S.Pages.Any(p => p.Id == id));
            var src = host.S?.Pages.FirstOrDefault(p => p.Id == id);
            if (src is null) return Tsk.FromResult(new TreeResult(Error: "That page is gone."));
            var copy = src with { Id = NewId("page"), Title = src.Title + " copy" };
            AddPage(host.S!.Id, copy); EnsurePage(copy, id); Raise();
            return Done(copy.Id);
        }
        var found = AllSections().FirstOrDefault(x => x.S.Id == id);
        if (found.S is null) return Tsk.FromResult(new TreeResult(Error: "That section is gone."));
        var dup = found.S with { Id = NewId("sec"), Name = found.S.Name + " copy" };
        return CreateSectionFrom(found.NotebookId, found.ParentId, dup);
    }

    private Task<TreeResult> CreateSectionFrom(string notebookId, string? parentId, Section sec)
    {
        if (parentId is null) Notebooks = Notebooks.Select(n => n.Id == notebookId ? n with { Sections = n.Sections.Append(sec).ToList() } : n).ToList();
        else MapTree(s => s.Id == parentId ? s with { Children = s.Children.Append(sec).ToList() } : s);
        Raise();
        return Done(sec.Id);
    }

    public Task<TreeResult> Move(TreeKind kind, string id, string notebookId, string? sectionId)
    {
        if (kind == TreeKind.Page && sectionId is not null)
        {
            var host = AllSections().FirstOrDefault(x => x.S.Pages.Any(p => p.Id == id));
            var page = host.S?.Pages.FirstOrDefault(p => p.Id == id);
            if (page is null) return Tsk.FromResult(new TreeResult(Error: "That page is gone."));
            MapTree(s => s.Id == host.S!.Id ? s with { Pages = s.Pages.Where(p => p.Id != id).ToList() } : s);
            AddPage(sectionId, page);
        }
        else if (kind == TreeKind.Section)
        {
            var found = AllSections().FirstOrDefault(x => x.S.Id == id);
            if (found.S is null) return Tsk.FromResult(new TreeResult(Error: "That section is gone."));
            if (sectionId == id || (sectionId is not null && IsInside(found.S, sectionId))) return Tsk.FromResult(new TreeResult(Error: "A section can't go inside itself."));
            Notebooks = Notebooks.Select(n => n with { Sections = n.Sections.Select(s => MapSec(s, x => x.Id == id ? null : x)).Where(s => s is not null).Select(s => s!).ToList() }).ToList();
            return CreateSectionFrom(notebookId, sectionId, found.S);
        }
        Raise();
        return Done();
    }

    private static bool IsInside(Section s, string id) => s.Children.Any(c => c.Id == id || IsInside(c, id));

    public Task<TreeResult> Delete(TreeKind kind, string id)
    {
        switch (kind)
        {
            case TreeKind.Page:
            {
                var host = AllSections().FirstOrDefault(x => x.S.Pages.Any(p => p.Id == id));
                var page = host.S?.Pages.FirstOrDefault(p => p.Id == id);
                if (page is null) break;
                MapTree(s => s.Id == host.S!.Id ? s with { Pages = s.Pages.Where(p => p.Id != id).ToList() } : s);
                _pages.Remove(id);
                _trash.Add(new TrashRec(new TrashItem(TreeKind.Page, id, page.Title, PathOfSectionSafe(host.S!.Id), "You", 60), page, null, host.S!.Id));
                break;
            }
            case TreeKind.Section:
            {
                var found = AllSections().FirstOrDefault(x => x.S.Id == id);
                if (found.S is null) break;
                var path = PathOfSectionSafe(id);
                Notebooks = Notebooks.Select(n => n with { Sections = n.Sections.Select(s => MapSec(s, x => x.Id == id ? null : x)).Where(s => s is not null).Select(s => s!).ToList() }).ToList();
                _trash.Add(new TrashRec(new TrashItem(TreeKind.Section, id, found.S.Name, path, "You", 60), found.S, found.NotebookId, found.ParentId));
                break;
            }
            default:
            {
                var nb = Notebooks.FirstOrDefault(n => n.Id == id);
                if (nb is null) break;
                Notebooks = Notebooks.Where(n => n.Id != id).ToList();
                _trash.Add(new TrashRec(new TrashItem(TreeKind.Notebook, id, nb.Name, "", "You", 60), nb, null, null));
                break;
            }
        }
        Raise();
        return Done();
    }

    private string PathOfSectionSafe(string id) { try { return PathOfSection(id); } catch { return ""; } }

    public Task<TrashList> LoadTrash() => Tsk.FromResult(new TrashList(_trash.Select(t => t.Item).ToList()));

    public Task<TreeResult> Restore(TrashItem item)
    {
        var rec = _trash.FirstOrDefault(t => t.Item.Id == item.Id && t.Item.Kind == item.Kind);
        if (rec is null) return Tsk.FromResult(new TreeResult(Error: "That item is already gone."));
        string where = "";
        switch (rec.Payload)
        {
            case PageSummary p:
            {
                var target = AllSections().Any(x => x.S.Id == rec.ParentId) ? rec.ParentId : AllSections().FirstOrDefault().S?.Id;
                if (target is null) return Tsk.FromResult(new TreeResult(Error: "There is no section to restore it to."));
                AddPage(target, p); EnsurePage(p); where = AllSections().First(x => x.S.Id == target).S.Name;
                break;
            }
            case Section s:
            {
                var nb = Notebooks.Any(n => n.Id == rec.NotebookId) ? rec.NotebookId! : Notebooks.FirstOrDefault()?.Id;
                if (nb is null) return Tsk.FromResult(new TreeResult(Error: "There is no notebook to restore it to."));
                _ = CreateSectionFrom(nb, AllSections().Any(x => x.S.Id == rec.ParentId) ? rec.ParentId : null, s);
                where = Notebooks.First(n => n.Id == nb).Name;
                break;
            }
            case Notebook n:
                Notebooks = Notebooks.Append(n).ToList(); where = n.Name;
                break;
        }
        _trash.Remove(rec);
        Raise();
        return Done(null, "Restored to " + where);
    }

    public Task<TreeResult> DeleteForever(TrashItem item) { _trash.RemoveAll(t => t.Item.Id == item.Id && t.Item.Kind == item.Kind); return Done(); }
    public Task<TreeResult> EmptyTrash() { _trash.Clear(); return Done(); }

    // ---- search ----

    public Task<SearchOutcome?> SearchAsync(string query)
    {
        var q = query.Trim();
        if (q.Length == 0) return Tsk.FromResult<SearchOutcome?>(null);
        var pages = new List<SearchPageHit>();
        foreach (var (s, nb, _) in AllSections())
            foreach (var p in s.Pages)
            {
                var snippet = _pages.TryGetValue(p.Id, out var pg) ? pg.Boxes.SelectMany(b => b.Blocks).Select(b => b.Text).FirstOrDefault(t => t.Contains(q, StringComparison.OrdinalIgnoreCase)) : null;
                if (!p.Title.Contains(q, StringComparison.OrdinalIgnoreCase) && snippet is null) continue;
                var runs = new List<(string, bool)>();
                if (snippet is not null && p.Title.IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    var i = snippet.IndexOf(q, StringComparison.OrdinalIgnoreCase);
                    runs.Add((snippet[..i], false)); runs.Add((snippet.Substring(i, q.Length), true)); runs.Add((snippet[(i + q.Length)..], false));
                }
                pages.Add(new SearchPageHit(p.Id, p.Title, PathOfSectionSafe(s.Id), runs));
            }
        var tasks = AllTasks().DistinctBy(t => t.Id).Where(t => t.Title.Contains(q, StringComparison.OrdinalIgnoreCase))
            .Select(t => new SearchTaskHit(t.Id, t.Title, t.DueLabel, t.Tone, t.Done)).ToList();
        return Tsk.FromResult<SearchOutcome?>(new SearchOutcome(pages, tasks));
    }

    // ---- tasks ----

    private IEnumerable<TaskItem> AllTasks() => _groups.Values.SelectMany(g => g).SelectMany(g => g.Tasks).Concat(_made.Values);

    private void ReplaceTask(string id, Func<TaskItem, TaskItem> f)
    {
        foreach (var key in _groups.Keys.ToList())
            _groups[key] = _groups[key].Select(g => g with { Tasks = g.Tasks.Select(t => t.Id == id ? f(t) : t).ToList() }).ToList();
        if (_made.TryGetValue(id, out var m)) _made[id] = f(m);
    }

    // the task sheet's fields beyond the list row, in memory (the core source reads them from the core's full task)
    private sealed record Extra(string? TeamId = null, string[]? Tags = null, string? Time = null, N.TaskRecurrence? Rule = null,
        List<ReminderInfo>? Reminders = null, List<SubtaskInfo>? Subs = null);
    private readonly Dictionary<string, Extra> _x = new();
    private readonly Dictionary<string, List<string>> _onPage = new() { ["tasks"] = new() { "t-welcome", "t-notes", "t-slow" } };
    private readonly List<TagInfo> _tagList = new() { new("tag-launch", "launch", "#ef4444"), new("tag-docs", "docs", "#3b82f6") };
    private static readonly TeamInfo[] TeamList =
    {
        new("team-staff", "Staff", "Staff", "#0ea5e9", null), new("team-design", "Design", "Design", "#a855f7", null),
        new("team-eng", "Engineering", "Engineering", "#22c55e", null), new("team-web", "Web", "Engineering › Web", "#16a34a", "team-eng"),
    };

    private Extra X(string id) => _x.GetValueOrDefault(id) ?? (id == "t-launch" ? new Extra(TeamId: "team-staff") : new Extra());
    private List<string> OnPage(string pageId) => _onPage.TryGetValue(pageId, out var l) ? l : _onPage[pageId] = new List<string>();

    public IReadOnlyList<TeamInfo> Teams() => TaskLogic.Order(TeamList);
    public IReadOnlyList<TagInfo> Tags() => _tagList.OrderBy(t => t.Name, StringComparer.CurrentCultureIgnoreCase).ToList();

    public Task<TagInfo?> CreateTag(string name)
    {
        var n = name.Trim().TrimStart('#');
        if (n.Length == 0) return Tsk.FromResult<TagInfo?>(null);
        var hit = _tagList.FirstOrDefault(t => string.Equals(t.Name, n, StringComparison.OrdinalIgnoreCase));
        if (hit is null) { hit = new TagInfo(NewId("tag"), n, "#f59e0b"); _tagList.Add(hit); Raise(); }
        return Tsk.FromResult<TagInfo?>(hit);
    }

    public IReadOnlyList<ReminderInfo> Reminders(string taskId) => X(taskId).Reminders ?? new List<ReminderInfo>();

    public Task<string?> AddReminder(string taskId, ReminderInput r)
    {
        var x = X(taskId);
        _x[taskId] = x with { Reminders = (x.Reminders ?? new()).Append(new ReminderInfo(NewId("rem"), TaskLogic.ReminderText(r.BeforeMinutes, r.At), null)).ToList() };
        Log($"reminder {taskId} {TaskLogic.ReminderText(r.BeforeMinutes, r.At)}");
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    public Task<string?> DeleteReminder(string taskId, string reminderId)
    {
        var x = X(taskId);
        _x[taskId] = x with { Reminders = (x.Reminders ?? new()).Where(r => r.Id != reminderId).ToList() };
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    public Task<string?> AddSubtask(string parentId, string title)
    {
        title = title.Trim();
        if (title.Length == 0) return Tsk.FromResult<string?>(null);
        var x = X(parentId);
        _x[parentId] = x with { Subs = (x.Subs ?? new()).Append(new SubtaskInfo(NewId("sub"), title, false, 0)).ToList() };
        _tasksVersion++;
        Log($"subtask {parentId} {title}");
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    public IReadOnlyList<TaskItem> PageTasks(string pageId) =>
        _onPage.TryGetValue(pageId, out var ids) ? ids.Select(i => AllTasks().FirstOrDefault(t => t.Id == i)).Where(t => t is not null).Select(t => t!).ToList() : Array.Empty<TaskItem>();

    public TaskDetailItem? GetTaskDetail(string id)
    {
        var t = AllTasks().FirstOrDefault(x => x.Id == id);
        if (t is null) return null;
        var ex = _extra.GetValueOrDefault(id);
        var xx = X(id);
        return new TaskDetailItem(t.Id, t.Title, _desc.GetValueOrDefault(id, ""), t.Done, t.Priority == 0 ? 4 : t.Priority, ex.Due, t.DueLabel, t.Tone,
            t.Assignee is null ? null : "u1", t.Assignee is null ? null : "Demo User", null, t.PageTitle, "Created by Demo User · 13m ago",
            xx.Time, xx.TeamId, xx.Tags ?? Array.Empty<string>(), xx.Rule, xx.Rule is { } rule ? TaskLogic.Describe(rule, ex.Due) : null, null, null, xx.Subs ?? new List<SubtaskInfo>());
    }

    public void UpdateTask(string id, TaskPatch p)
    {
        // a subtask ticked in the sheet
        foreach (var kv in _x.ToList())
            if (kv.Value.Subs is { } subs && subs.Any(s => s.Id == id))
                _x[kv.Key] = kv.Value with { Subs = subs.Select(s => s.Id == id ? s with { Title = p.Title ?? s.Title, Done = p.Done ?? s.Done } : s).ToList() };
        if (p.Description is not null) _desc[id] = p.Description;
        if (p.DueDate is not null || p.ClearDue) _extra[id] = (p.ClearDue ? null : p.DueDate, null);
        var x = X(id);
        _x[id] = x with
        {
            TeamId = p.ClearTeam ? null : p.TeamId ?? x.TeamId, Tags = p.TagIds ?? x.Tags, Rule = p.ClearRecurrence ? null : p.Recurrence ?? x.Rule,
            Time = p.ClearDueTime || p.ClearDue ? null : p.DueTime ?? x.Time,
        };
        var teamLabel = _x[id].TeamId is { } tid ? TeamList.FirstOrDefault(tm => tm.Id == tid)?.Name : null;
        var tagNames = (_x[id].Tags ?? Array.Empty<string>()).Select(i => _tagList.FirstOrDefault(g => g.Id == i)?.Name).Where(n => n is not null).Select(n => n!).ToList();
        ReplaceTask(id, t =>
        {
            var label = t.DueLabel; var tone = t.Tone;
            if (p.ClearDue) { label = null; tone = DueTone.None; }
            else if (p.DueDate is { } d && DateOnly.TryParse(d, out var dd)) { label = dd.ToString("d MMM"); tone = DueTone.Later; }
            return t with
            {
                Title = p.Title ?? t.Title, Done = p.Done ?? t.Done, Priority = p.Priority is { } pr ? (pr >= 4 ? 0 : pr) : t.Priority,
                DueLabel = label, Tone = tone, Assignee = p.ClearAssignee ? null : p.AssigneeId is not null ? "DU" : t.Assignee,
                Team = (p.TeamId is not null || p.ClearTeam) ? teamLabel : t.Team, Tags = p.TagIds is not null ? tagNames : t.Tags,
                Recurring = (p.Recurrence is not null || p.ClearRecurrence) ? p.Recurrence is not null : t.Recurring,
            };
        });
        _tasksVersion++;
        Log($"task {id} " + (p.Done is { } dn ? (dn ? "done" : "open") : "edit"));
        Raise();
    }
    // ---- quick add and the Calendar (in memory) ----

    private static DateOnly TodayDay => DateOnly.FromDateTime(DateTime.Now);

    public Task<string?> AddTask(NewTask t)
    {
        var title = t.Title.Trim();
        if (title.Length == 0) return Tsk.FromResult<string?>("Give the task a title.");
        var id = NewId("t");
        DateOnly? due = t.DueDate is { } d && DateOnly.TryParseExact(d, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var v) ? v : null;
        var diff = due is { } dd ? dd.DayNumber - TodayDay.DayNumber : 0;
        var (label, tone) = due is null ? ((string?)null, DueTone.None) : diff < 0 ? (due.Value.ToString("d MMM"), DueTone.Overdue) : diff == 0 ? ("Today", DueTone.Today)
            : diff == 1 ? ("Tomorrow", DueTone.Soon) : (due.Value.ToString("d MMM"), diff < 7 ? DueTone.Soon : DueTone.Later);
        var teamName = t.TeamId is { } tmid ? TeamList.FirstOrDefault(tm => tm.Id == tmid)?.Name : t.TeamText;
        var item = new TaskItem(id, title, false, t.Priority >= 4 ? 0 : t.Priority, label, tone, t.Recurrence is not null, t.PageId is null ? null : PageTitleOf(t.PageId), teamName,
            t.AssigneeId is { Length: 0 } ? null : t.AssigneeId is not null && t.AssigneeId != "u1" ? "SR" : "DU", t.Tags, 0, 0);
        if (t.PageId is not null) OnPage(t.PageId).Add(id);
        var tagIds = new List<string>();
        foreach (var name in t.Tags)
        {
            var tag = _tagList.FirstOrDefault(g => string.Equals(g.Name, name, StringComparison.OrdinalIgnoreCase)) ?? new TagInfo(NewId("tag"), name, "#f59e0b");
            if (!_tagList.Contains(tag)) _tagList.Add(tag);
            tagIds.Add(tag.Id);
        }
        _x[id] = new Extra(TeamId: t.TeamId, Tags: tagIds.ToArray(), Time: t.DueTime, Rule: t.Recurrence);
        if (t.Description.Length > 0) _desc[id] = t.Description;
        if (due is { } dv) _extra[id] = (dv.ToString("yyyy-MM-dd"), null);
        // a new task is shown in the lists it belongs to: Today when due today or earlier, always My Tasks and All tasks
        void Put(TaskViewKind view, string group, bool overdue)
        {
            var list = _groups[view].ToList();
            var i = list.FindIndex(g => g.Title.StartsWith(group));
            if (i >= 0) list[i] = list[i] with { Count = list[i].Count + 1, Tasks = list[i].Tasks.Append(item).ToList() };
            else list.Add(new TaskGroup(group, 1, overdue, new[] { item }));
            _groups[view] = list;
        }
        var g = due is null ? "No date" : diff < 0 ? "Overdue" : diff == 0 ? "Today" : "Later";
        if (diff <= 0 && due is not null) Put(TaskViewKind.Today, g, diff < 0);
        Put(TaskViewKind.MyTasks, g, g == "Overdue");
        Put(TaskViewKind.All, g, g == "Overdue");
        _tasksVersion++;
        Log($"quickadd {id} {title}");
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    public IReadOnlyList<CalendarTask> CalendarTasks() => CalendarTasks(false).Where(t => !t.Task.Done).ToList();

    /// <summary>Mine: assigned to Demo User ("DU"); Everyone: every sample task, open and done, on its day.</summary>
    public IReadOnlyList<CalendarTask> CalendarTasks(bool everyone)
    {
        var today = TodayDay;
        // the sample tasks' days (their lists carry only labels)
        DateOnly? Seed(string id) => id switch
        {
            "t-launch" => today.AddDays(-1), "t-welcome" or "t-notes" or "t-other" or "t-slow" => today, "t-up1" => today.AddDays(1), "t-up2" => today.AddDays(2),
            "t-plan" => today.AddDays(9), _ => null,
        };
        return AllTasks().DistinctBy(t => t.Id).Where(t => everyone ? t.Assignee is not null : t.Assignee == "DU").Select(t =>
        {
            DateOnly? due = _extra.TryGetValue(t.Id, out var e) ? (e.Due is { } str && DateOnly.TryParse(str, out var p) ? p : null) : Seed(t.Id);
            return new CalendarTask(due?.ToString("yyyy-MM-dd"), t, X(t.Id).Time);
        }).ToList();
    }
    // ---- account (in memory; the core source asks the server) ----
    private string _color = "#f59e0b";
    private NotificationPrefs _notes = new("Europe/London", true, "09:00", false, "08:00");
    private readonly List<ConnectedAppInfo> _apps = new()
    {
        new("chatgpt", "ChatGPT", "Read and write notes", "2026-11-02T10:00:00Z", "2026-11-20T09:30:00Z"),
        new("claude", "Claude", "Read notes", "2026-11-10T16:20:00Z", null),
    };

    public Task<AccountResult<AccountProfile>> LoadProfile() =>
        Tsk.FromResult(new AccountResult<AccountProfile>(new AccountProfile(Workspace.UserName, Workspace.UserEmail, _color)));

    public Task<AccountResult<AccountProfile>> UpdateProfile(string? name, string? color)
    {
        if (color is not null) _color = color;
        if (name is not null)
        {
            var parts = name.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var initials = parts.Length >= 2 ? (parts[0][..1] + parts[^1][..1]).ToUpperInvariant() : name[..Math.Min(2, name.Length)].ToUpperInvariant();
            Workspace = Workspace with { UserName = name, UserInitials = initials };
            Raise();
        }
        return LoadProfile();
    }

    public Task<AccountResult<bool>> ChangePassword(string current, string next) =>
        Tsk.FromResult(current == "wrong"
            ? new AccountResult<bool>(Error: "That is not your current password.", Code: "wrong_password")
            : new AccountResult<bool>(true));

    public Task<AccountResult<NotificationPrefs>> LoadNotifications() => Tsk.FromResult(new AccountResult<NotificationPrefs>(_notes));

    public Task<AccountResult<NotificationPrefs>> UpdateNotifications(NotificationChange c)
    {
        _notes = new NotificationPrefs(c.TimeZone ?? _notes.TimeZone, c.EmailEnabled ?? _notes.EmailEnabled, c.DefaultReminderTime ?? _notes.DefaultReminderTime,
            c.DigestEnabled ?? _notes.DigestEnabled, c.DigestTime ?? _notes.DigestTime);
        return LoadNotifications();
    }

    public Task<AccountResult<IReadOnlyList<ConnectedAppInfo>>> LoadConnectedApps() =>
        Tsk.FromResult(new AccountResult<IReadOnlyList<ConnectedAppInfo>>(_apps.ToList()));

    public Task<AccountResult<bool>> DisconnectApp(string clientId)
    {
        _apps.RemoveAll(a => a.ClientId == clientId);
        return Tsk.FromResult(new AccountResult<bool>(true));
    }
}
