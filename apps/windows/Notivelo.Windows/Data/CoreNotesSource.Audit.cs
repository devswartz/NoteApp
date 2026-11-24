using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// The audit batch over the core: task facts for the filters, the notification inbox, the save state, the public share link and account deletion.
// Each call runs on the core's call queue (off the UI thread) and an error is one sentence.
internal sealed partial class CoreNotesSource
{
    public IReadOnlyList<TaskFact> TaskFacts()
    {
        var today = Today();
        return Visible().Select(t => new TaskFact(ToItem(t, today), t.Priority, t.DueDate, t.DueTime, t.AssigneeId, _details.GetValueOrDefault(t.Id)?.TeamId,
            t.TagIds, t.PageId, t.CreatedAt, t.CompletedAt, t.Description)).ToList();
    }

    public async void LoadTaskTeams()
    {
        var ws = _wsId;
        if (ws is null) return;
        try
        {
            var r = await _session.CallAsync(c => (All: Try(() => c.TaskDetails(ws)), Teams: Try(() => c.Teams(ws)), Tags: Try(() => c.Tags(ws))));
            if (ws != _wsId || _disposed) return;
            if (r.All is not null) foreach (var d in r.All) _details[d.Id] = d;
            if (r.Teams is not null) _teams = r.Teams;
            if (r.Tags is not null) _tags = r.Tags;
            _tasksVersion++;
            Raise();
        }
        catch (Exception) { }
    }

    // ---- inbox ----

    private InboxItem Map(N.AppNotification n)
    {
        var actor = n.ActorId is null ? null : n.ActorId == _user.Id ? (_user.Name, (string?)null) : _members.FirstOrDefault(m => m.Id == n.ActorId) is { } m ? (m.Name.Length > 0 ? m.Name : m.Email, m.Color) : default((string, string?)?);
        return new InboxItem(n.Id, n.Kind, actor?.Item1, actor?.Item2, n.Title, n.Body, n.CreatedAt, n.IsRead, n.WorkspaceId, n.PageId, n.TaskId);
    }

    public Task<PageToolResult<InboxPage>> LoadInbox(string? before) => Tool(async () =>
    {
        var p = await _session.CallAsync(c => c.Notifications(30, before));
        return new InboxPage(p.Items.Select(Map).ToList(), (int)p.Unread, p.NextBefore);
    });

    public async Task<int?> UnreadCount()
    {
        try { return (int)await _session.CallAsync(c => c.UnreadNotificationCount()); }
        catch (Exception) { return null; }
    }

    public async Task MarkNotificationRead(string id) { try { await _session.CallAsync(c => { c.MarkNotificationRead(id); return 0; }); } catch (Exception) { } }
    public async Task MarkAllNotificationsRead() { try { await _session.CallAsync(c => { c.MarkAllNotificationsRead(); return 0; }); } catch (Exception) { } }

    // ---- save state ----

    private SaveState _save = SaveState.Saved;
    public SaveState SaveState => _save;

    public async Task RefreshSaveState()
    {
        if (_disposed) return;
        var live = _live;
        try
        {
            var (updates, pages) = await _session.CallAsync(c => (live is null ? 0u : live.UnsentUpdates(), c.UnsentPages().Length));
            _save = AuditRules.SaveOf(IsOffline, updates, pages);
        }
        catch (Exception) { _save = AuditRules.SaveOf(IsOffline, 0, 0); }
    }

    // ---- public share link ----

    public Task<PageToolResult<string?>> LoadShareLink(string pageId) => Tool<string?>(async () => (await _session.CallAsync(c => c.PageShareLink(pageId)))?.Url);
    public Task<PageToolResult<string>> CreateShareLink(string pageId) => Tool(async () => (await _session.CallAsync(c => c.CreatePageShareLink(pageId))).Url);
    public Task<PageToolResult<bool>> DeleteShareLink(string pageId) => Tool(async () => { await _session.CallAsync(c => { c.DeletePageShareLink(pageId); return 0; }); return true; });

    // ---- delete account ----

    public async Task<AccountResult<DeletionPreviewInfo>> LoadDeletionPreview() => await Account(c =>
    {
        var p = c.AccountDeletionPreview();
        return new DeletionPreviewInfo(p.DeletedWorkspaces.Select(w => w.Name).ToList(), p.TransferredWorkspaces.Select(w => (w.Name, w.NewOwnerName)).ToList(),
            p.SharedOwnership.Select(w => w.Name).ToList(), p.LeftWorkspaces.Select(w => w.Name).ToList(), (int)p.PrivateNotebooks);
    });

    public async Task<AccountResult<bool>> DeleteAccount(string password) => await Account(c => { c.DeleteAccount(password); return true; });
}
