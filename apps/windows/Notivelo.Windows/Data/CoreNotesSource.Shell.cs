using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// Tree and shell polish over the core (PARITY batch 4): set_notebook_color / set_section_color, move_notebook / move_section / move_page with an index,
// notebook_shares / set_notebook_visibility / set_notebook_shares. Each call runs on the core's call queue and the tree is read again after a change.
internal sealed partial class CoreNotesSource
{
    private bool _netDown;

    /// <summary>The open page cannot connect, or the tree could not be loaded or changed for want of a network.</summary>
    public bool IsOffline => _netDown || _session.Unconfirmed || (_openId is not null && _state == PageState.Offline);

    /// <summary>The session came back after a cold start without network: load the workspaces, the tree and the tasks from the server.</summary>
    public void GoLive()
    {
        if (_disposed) return;
        _netDown = false;
        Start();
        if (_wsId is { } id) SelectWorkspace(id);
        Raise();
    }

    private void NoteNetwork(Exception e) { var was = IsOffline; if (e is N.CoreException.Network) _netDown = true; if (was != IsOffline) Raise(); }
    private void NoteOnline() { var was = IsOffline; _netDown = false; if (was != IsOffline) Raise(); }

    public Task<TreeResult> SetColor(TreeKind kind, string id, string hex) => Change(c =>
    {
        if (kind == TreeKind.Notebook) c.SetNotebookColor(id, hex);
        else if (kind == TreeKind.Section) c.SetSectionColor(id, hex);
        return (null, null);
    });

    public Task<TreeResult> MoveTo(TreeKind kind, string id, string notebookId, string? parentId, int? index) => Change(c =>
    {
        uint? at = index is { } i ? (uint)Math.Max(0, i) : null;
        switch (kind)
        {
            case TreeKind.Page: if (parentId is not null) c.MovePage(id, parentId, at); break;
            case TreeKind.Section: c.MoveSection(id, notebookId, parentId, at); break;
            default: c.MoveNotebook(id, at); break;
        }
        return (null, null);
    });

    private static NotebookSharesInfo Map(N.NotebookShares s) => new(s.Visibility == "private", s.CreatedBy, s.UserIds);

    public Task<PageToolResult<NotebookSharesInfo>> LoadNotebookShares(string notebookId) =>
        Tool(async () => Map(await _session.CallAsync(c => c.NotebookShares(notebookId))));

    public async Task<PageToolResult<NotebookSharesInfo>> SetNotebookPrivate(string notebookId, bool isPrivate)
    {
        var r = await Tool(async () =>
        {
            await _session.CallAsync(c => c.SetNotebookVisibility(notebookId, isPrivate ? "private" : "shared"));
            return Map(await _session.CallAsync(c => c.NotebookShares(notebookId)));
        });
        if (r.Ok) await RefreshTree();
        return r;
    }

    public async Task<PageToolResult<NotebookSharesInfo>> SetNotebookShares(string notebookId, IReadOnlyList<string> userIds)
    {
        var r = await Tool(async () =>
        {
            await _session.CallAsync(c => c.SetNotebookShares(notebookId, userIds.ToArray()));
            return Map(await _session.CallAsync(c => c.NotebookShares(notebookId)));
        });
        if (r.Ok) await RefreshTree();
        return r;
    }

    /// <summary>Read the tree again after a change made outside <see cref="Change"/> (the visibility moves the lock and the tree's notebook flags).</summary>
    private async Task RefreshTree()
    {
        var ws = _wsId;
        if (ws is null) return;
        try
        {
            var tree = await _session.CallAsync(c => c.Tree(ws));
            if (ws == _wsId) { _tree = tree; Rebuild(); Raise(); }
        }
        catch (Exception) { }
    }
}
