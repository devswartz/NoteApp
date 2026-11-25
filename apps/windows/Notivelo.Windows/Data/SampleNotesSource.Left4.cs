using Tsk = System.Threading.Tasks.Task;

namespace Notivelo.Windows.Data;

// left4 on the sample data (offline test mode and screenshots): saved task views, backlinks and real task removal, all in memory.
public sealed partial class SampleNotesSource
{
    public bool CanSaveViews => true;

    private static string Query(Action<TaskViewState> set)
    {
        var s = new TaskViewState { Group = TaskGrouping.None };
        set(s);
        return SavedViewRules.ToQueryJson(s);
    }

    private readonly List<SavedView> _savedViews = new()
    {
        new("view-urgent", "Urgent this week", Query(s => { s.Priority.Add(1); s.Priority.Add(2); s.Due = TaskDueFilter.Week; s.Sort = TaskSort.Priority; }), false, Me, 1),
        new("view-mine", "Mine, by page", Query(s => { s.Assignee.Add("me"); s.Group = TaskGrouping.Page; }), true, Me, 2),
    };

    public IReadOnlyList<SavedView> SavedViews => _savedViews;
    public void LoadSavedViews(bool force = false) { }

    public Task<PageToolResult<SavedView>> CreateSavedView(string name, string queryJson, bool shared)
    {
        if (SavedViewRules.CleanName(name) is not { } clean) return Tsk.FromResult(PageToolResult<SavedView>.Fail("Give the view a name."));
        var v = new SavedView(NewId("view"), clean, queryJson, shared, Me, _savedViews.Count == 0 ? 1 : _savedViews.Max(x => x.Position) + 1);
        _savedViews.Add(v);
        Log("view create " + clean);
        Raise();
        return Tsk.FromResult(new PageToolResult<SavedView>(v));
    }

    public Task<string?> UpdateSavedView(string id, string? name = null, string? queryJson = null, bool? shared = null)
    {
        var i = _savedViews.FindIndex(v => v.Id == id);
        if (i < 0) return Tsk.FromResult<string?>("That view is gone.");
        var cur = _savedViews[i];
        string? clean = null;
        if (name is not null && (clean = SavedViewRules.CleanName(name)) is null) return Tsk.FromResult<string?>("Give the view a name.");
        _savedViews[i] = cur with { Name = clean ?? cur.Name, QueryJson = queryJson ?? cur.QueryJson, Shared = shared ?? cur.Shared };
        Log("view update " + _savedViews[i].Name);
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    public Task<string?> DeleteSavedView(string id)
    {
        var gone = _savedViews.RemoveAll(v => v.Id == id) > 0;
        if (gone) { Log("view delete " + id); Raise(); }
        return Tsk.FromResult<string?>(gone ? null : "That view is gone.");
    }

    // ---- backlinks: which sample pages link to which ----

    private static readonly Dictionary<string, string[]> Links = new()
    {
        ["canvas"] = new[] { "sandbox", "tasks" }, ["blocks"] = new[] { "lists" }, ["uitest"] = new[] { "canvas" },
    };

    public Task<PageToolResult<IReadOnlyList<BacklinkItem>>> LoadBacklinks(string pageId)
    {
        IReadOnlyList<BacklinkItem> list = !Links.TryGetValue(pageId, out var from)
            ? Array.Empty<BacklinkItem>()
            : from.Where(id => _pages.ContainsKey(id)).Select(id => new BacklinkItem(id, _pages[id].Title, null, "Look reference › Corpus", "2h ago")).ToList();
        return Tsk.FromResult(new PageToolResult<IReadOnlyList<BacklinkItem>>(list));
    }

    // ---- tasks gone for good (the bulk bar, the task sheet) ----

    private bool RemoveTask(string id)
    {
        var found = false;
        foreach (var key in _groups.Keys.ToList())
            _groups[key] = _groups[key].Select(g =>
            {
                var rest = g.Tasks.Where(t => t.Id != id).ToList();
                if (rest.Count != g.Tasks.Count) found = true;
                return g with { Tasks = rest, Count = rest.Count };
            }).Where(g => g.Tasks.Count > 0).ToList();
        _made.Remove(id);
        foreach (var l in _onPage.Values) l.Remove(id);
        return found;
    }
}
