namespace Notivelo.Windows.Data;
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

    public TaskDetailItem? GetTaskDetail(string id)
    {
        var t = AllTasks().FirstOrDefault(x => x.Id == id);
        if (t is null) return null;
        var ex = _extra.GetValueOrDefault(id);
        return new TaskDetailItem(t.Id, t.Title, _desc.GetValueOrDefault(id, ""), t.Done, t.Priority == 0 ? 4 : t.Priority, ex.Due, t.DueLabel, t.Tone,
            t.Assignee is null ? null : "u1", t.Assignee is null ? null : "Devon", null, t.PageTitle, "Created by Devon · 13m ago");
    }

    public void UpdateTask(string id, TaskPatch p)
    {
        if (p.Description is not null) _desc[id] = p.Description;
        if (p.DueDate is not null || p.ClearDue) _extra[id] = (p.ClearDue ? null : p.DueDate, null);
        ReplaceTask(id, t =>
        {
            var label = t.DueLabel; var tone = t.Tone;
            if (p.ClearDue) { label = null; tone = DueTone.None; }
            else if (p.DueDate is { } d && DateOnly.TryParse(d, out var dd)) { label = dd.ToString("d MMM"); tone = DueTone.Later; }
            return t with
            {
                Title = p.Title ?? t.Title, Done = p.Done ?? t.Done, Priority = p.Priority is { } pr ? (pr >= 4 ? 0 : pr) : t.Priority,
                DueLabel = label, Tone = tone, Assignee = p.ClearAssignee ? null : p.AssigneeId is not null ? "DU" : t.Assignee,
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
        var item = new TaskItem(id, title, false, t.Priority >= 4 ? 0 : t.Priority, label, tone, t.Recurrence is not null, null, null, "DU", t.Tags, 0, 0);
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

    public IReadOnlyList<CalendarTask> CalendarTasks()
    {
        var today = TodayDay;
        // the sample tasks' days (their lists carry only labels)
        DateOnly? Seed(string id) => id switch
        {
            "t-launch" => today.AddDays(-1), "t-welcome" or "t-notes" => today, "t-up1" => today.AddDays(1), "t-up2" or "t-slow" => today.AddDays(2),
            "t-plan" => today.AddDays(9), _ => null,
        };
        return AllTasks().DistinctBy(t => t.Id).Where(t => !t.Done && t.Assignee is not null).Select(t =>
        {
            DateOnly? due = _extra.TryGetValue(t.Id, out var e) ? (e.Due is { } str && DateOnly.TryParse(str, out var p) ? p : null) : Seed(t.Id);
            return new CalendarTask(due?.ToString("yyyy-MM-dd"), t);
        }).ToList();
    }
}
