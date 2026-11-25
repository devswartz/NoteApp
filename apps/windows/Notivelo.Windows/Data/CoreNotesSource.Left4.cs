#if NV_LEFT4
using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// Saved task views and backlinks over the core (apple-left4: task_views, create/update/delete_task_view, backlinks). Online only; a call answers one sentence on failure
// (the server's own words: 403 sharing needs an owner or admin, 404 gone, 400 name or query). Compiled only with the left4 core bindings (see Notivelo.Windows.csproj, NvLeft4).
internal sealed partial class CoreNotesSource
{
    private IReadOnlyList<SavedView> _views = Array.Empty<SavedView>();
    private string? _viewsFor;
    private string? _viewsAsked;
    private DateTime _viewsTried = DateTime.MinValue;

    public bool CanSaveViews => true;
    public IReadOnlyList<SavedView> SavedViews => _viewsFor == _wsId ? _views : Array.Empty<SavedView>();

    private static SavedView Map(N.TaskViewInfo v) => new(v.Id, v.Name, v.QueryJson, v.Shared, v.OwnerId, v.Position);

    public async void LoadSavedViews(bool force = false)
    {
        if (_disposed || _wsId is not { } ws) return;
        if (!force && (_viewsFor == ws || _viewsAsked == ws && DateTime.UtcNow - _viewsTried < TimeSpan.FromSeconds(30))) return;
        _viewsAsked = ws; _viewsTried = DateTime.UtcNow;
        try
        {
            var list = await _session.CallAsync(c => c.TaskViews(ws));
            if (ws != _wsId) return;
            _views = list.Select(Map).OrderBy(v => v.Position).ToList();
            _viewsFor = ws;
            Raise();
        }
        catch (Exception) { }   // offline or signed out: the sidebar shows none, the next ask (30 s later) tries again
    }

    public async Task<PageToolResult<SavedView>> CreateSavedView(string name, string queryJson, bool shared)
    {
        if (_wsId is not { } ws) return NoWorkspace<SavedView>();
        if (SavedViewRules.CleanName(name) is not { } clean) return PageToolResult<SavedView>.Fail("Give the view a name.");
        var r = await Tool(async () => Map(await _session.CallAsync(c => c.CreateTaskView(ws, clean, queryJson, shared))));
        if (r.Ok && ws == _wsId && r.Value is { } v) { _views = SavedViews.Append(v).OrderBy(x => x.Position).ToList(); _viewsFor = ws; Raise(); }
        return r;
    }

    public async Task<string?> UpdateSavedView(string id, string? name = null, string? queryJson = null, bool? shared = null)
    {
        string? clean = null;
        if (name is not null && (clean = SavedViewRules.CleanName(name)) is null) return "Give the view a name.";
        var ws = _wsId;
        var r = await Tool(async () => Map(await _session.CallAsync(c => c.UpdateTaskView(id, clean, queryJson, shared, null))));
        if (!r.Ok) return r.Error;
        if (ws == _wsId && r.Value is { } v) { _views = SavedViews.Select(x => x.Id == id ? v : x).OrderBy(x => x.Position).ToList(); Raise(); }
        return null;
    }

    public async Task<string?> DeleteSavedView(string id)
    {
        var ws = _wsId;
        var err = await Do(c => { c.DeleteTaskView(id); return null; });
        if (err is not null) return err;
        if (ws == _wsId) { _views = SavedViews.Where(x => x.Id != id).ToList(); Raise(); }
        return null;
    }

    public Task<PageToolResult<IReadOnlyList<BacklinkItem>>> LoadBacklinks(string pageId) => Tool<IReadOnlyList<BacklinkItem>>(async () =>
    {
        var list = await _session.CallAsync(c => c.Backlinks(pageId));
        return list.Select(b => new BacklinkItem(b.PageId, b.Title, b.Icon, b.NotebookName.Length > 0 ? b.NotebookName + " › " + b.SectionName : b.SectionName, Ago(b.UpdatedAt))).ToList();
    });
}
#endif
