using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// Page tools over the core (PARITY batch 2): comments (page_comments, add_comment_thread, reply, resolve, edit, delete), version history (page_versions,
// page_version, restore_version), page sharing (page_shares, share_page_*, set_page_share_edit, remove_page_share, revoke_page_invite, shared_pages),
// locked pages (locked_notes_status, unlock_locked_notes, lock_page, remove_page_lock, ...), Markdown export (page_markdown) and set_page_icon. Every core call
// runs on the core's call queue (AppSession.CallAsync); a failure comes back as one sentence.
internal sealed partial class CoreNotesSource
{
    private N.LockedNotesStatus? _lock;
    private IReadOnlyList<SharedPageInfo> _shared = Array.Empty<SharedPageInfo>();
    private readonly Dictionary<string, Dictionary<string, N.CommentThread>> _threads = new();

    public string? WorkspaceRole => _workspaces.FirstOrDefault(w => w.Id == _wsId)?.Role;
    private bool IsAdmin => WorkspaceRole is "owner" or "admin";

    private string PersonName(string userId) =>
        userId == _user.Id ? _user.Name : _members.FirstOrDefault(m => m.Id == userId) is { } m ? (m.Name.Length > 0 ? m.Name : m.Email) : "Former member";

    private static async Task<PageToolResult<T>> Tool<T>(Func<Task<T>> call)
    {
        try { return new PageToolResult<T>(await call()); }
        catch (OperationCanceledException) { return PageToolResult<T>.Fail("You were signed out. Sign in again."); }
        catch (Exception e) { return PageToolResult<T>.Fail(ErrorText.Message(e)); }
    }

    private async Task LoadPageToolsAsync()
    {
        try { _lock = await _session.CallAsync(c => c.LockedNotesStatus()); } catch (Exception) { }
        await LoadSharedAsync();
        Raise();
    }

    private async Task LoadSharedAsync()
    {
        try
        {
            var list = await _session.CallAsync(c => c.SharedPages());
            if (!_disposed) _shared = list.Select(p => new SharedPageInfo(p.Id, p.Title, p.Icon is { Length: > 0 } ? p.Icon : null, p.WorkspaceId, p.WorkspaceName, p.CanEdit, p.SharedByName)).ToList();
        }
        catch (Exception) { }
    }

    // ---- comments ----

    public bool CanComment(string pageId) => WorkspaceRole != "viewer";

    private CommentThreadInfo Map(N.CommentThread t) => new(
        t.Id, t.Quote, t.Resolved,
        t.Resolved ? "Resolved " + (t.ResolvedBy is { } by ? "by " + PersonName(by) + " " : "") + (t.ResolvedAt is { } at ? PageToolRules.Ago(at) : "") : null,
        t.CreatedBy == _user.Id || IsAdmin,
        t.Comments.Select(c =>
        {
            var mine = c.AuthorId == _user.Id;
            return new CommentInfo(c.Id, c.AuthorId, PersonName(c.AuthorId), _members.FirstOrDefault(m => m.Id == c.AuthorId)?.Color, c.Body, PageToolRules.Ago(c.CreatedAt), c.EditedAt is not null, mine, mine || IsAdmin);
        }).ToList());

    private void Cache(N.CommentThread t)
    {
        if (!_threads.TryGetValue(t.PageId, out var d)) _threads[t.PageId] = d = new();
        d[t.Id] = t;
    }

    public int OpenCommentCount(string pageId) => _threads.TryGetValue(pageId, out var d) ? d.Values.Count(t => !t.Resolved) : 0;

    public async Task<PageToolResult<IReadOnlyList<CommentThreadInfo>>> LoadComments(string pageId)
    {
        var r = await Tool<IReadOnlyList<CommentThreadInfo>>(async () =>
        {
            var list = await _session.CallAsync(c => c.PageComments(pageId));
            _threads[pageId] = list.ToDictionary(t => t.Id);
            return list.Select(Map).ToList();
        });
        Raise();
        return r;
    }

    private async Task<PageToolResult<CommentThreadInfo>> Thread(Func<N.Core, N.CommentThread> call)
    {
        var r = await Tool(async () => { var t = await _session.CallAsync(call); Cache(t); return Map(t); });
        if (r.Ok) Raise();
        return r;
    }

    public Task<PageToolResult<CommentThreadInfo>> AddCommentThread(string pageId, string threadId, string quote, string body) => Thread(c => c.AddCommentThread(pageId, threadId, quote, body));
    public Task<PageToolResult<CommentThreadInfo>> ReplyToThread(string threadId, string body) => Thread(c => c.ReplyToCommentThread(threadId, body));
    public Task<PageToolResult<CommentThreadInfo>> SetThreadResolved(string threadId, bool resolved) => Thread(c => resolved ? c.ResolveCommentThread(threadId) : c.ReopenCommentThread(threadId));
    public Task<PageToolResult<CommentThreadInfo>> EditComment(string commentId, string body) => Thread(c => c.EditComment(commentId, body));

    public async Task<PageToolResult<bool>> DeleteComment(string commentId)
    {
        var r = await Tool(() => _session.CallAsync(c => c.DeleteComment(commentId)));
        if (r.Ok) { foreach (var d in _threads.Values) foreach (var t in d.Values.Where(t => t.Comments.Any(x => x.Id == commentId)).ToList()) { if (r.Value) d.Remove(t.Id); } Raise(); }
        return r;
    }

    public async Task<PageToolResult<bool>> DeleteThread(string threadId)
    {
        var r = await Tool(async () => { await _session.CallAsync(c => { c.DeleteCommentThread(threadId); return 0; }); return true; });
        if (r.Ok) { foreach (var d in _threads.Values) d.Remove(threadId); Raise(); }
        return r;
    }

    // ---- version history ----

    public bool CanRestoreVersion(string pageId) => WorkspaceRole != "viewer" && LivePageOf(pageId) is not null;

    public Task<PageToolResult<IReadOnlyList<VersionInfo>>> LoadVersions(string pageId) => Tool<IReadOnlyList<VersionInfo>>(async () =>
    {
        var list = await _session.CallAsync(c => c.PageVersions(pageId));
        return list.Select(v => new VersionInfo(v.Id, PageToolRules.WhenLabel(v.At), v.AuthorId is null ? "Unknown" : PersonName(v.AuthorId), PageToolRules.Ago(v.At) + PageToolRules.VersionTag(v.Reason))).ToList();
    });

    public Task<PageToolResult<string>> VersionPreview(string pageId, string versionId) => Tool(() => _session.CallAsync(c =>
    {
        var d = c.PageVersion(pageId, versionId);
        var text = N.NvCore.PageMarkdown(d.Document, d.Version.Title, new Dictionary<string, N.TaskLineInput>());
        return text.Length == 0 ? "(an empty page)" : text;
    }));

    public async Task<PageToolResult<string?>> RestoreVersion(string pageId, string versionId)
    {
        if (LivePageOf(pageId) is not { } live) return PageToolResult<string?>.Fail("Open the page first, and wait until it has loaded.");
        var r = await Tool(() => _session.CallAsync(c => c.RestoreVersion(live, versionId)));
        if (r.Ok)
        {
            try { _info = await Task.Run(() => live.Info()); } catch (Exception) { }
            Raise();
        }
        return r.Ok ? new PageToolResult<string?>(r.Value) : PageToolResult<string?>.Fail(r.Error!);
    }

    // ---- sharing ----

    public IReadOnlyList<MemberInfo> Members() =>
        _members.Length > 0 ? _members.Select(m => new MemberInfo(m.Id, m.Name, m.Email, m.Color, m.Role)).ToList()
                            : OfflineStart.IsKnown(_user) ? new[] { new MemberInfo(_user.Id, _user.Name, _user.Email, "#6366f1", WorkspaceRole ?? "owner") } : Array.Empty<MemberInfo>();

    private PageSharesInfo Map(N.PageShares s) => new(
        s.Shares.Select(x => new ShareEntry(x.UserId, x.Name, x.Email, x.Color, x.CanEdit, x.Member, x.Member && _members.FirstOrDefault(m => m.Id == x.UserId)?.Role == "viewer")).ToList(),
        s.Invites.Select(i => new InviteEntry(i.Email, i.CanEdit)).ToList());

    public Task<PageToolResult<PageSharesInfo>> LoadShares(string pageId) => Tool(async () => Map(await _session.CallAsync(c => c.PageShares(pageId))));

    public Task<PageToolResult<ShareOutcome>> SharePage(string pageId, string? userId, string? email, bool canEdit) => Tool(async () =>
    {
        var r = await _session.CallAsync(c => userId is not null ? c.SharePageWithMember(pageId, userId, canEdit) : c.SharePageByEmail(pageId, email ?? "", canEdit));
        return new ShareOutcome(Map(r.Shares), r.Status, r.Emailed, r.InviteUrl);
    });

    public Task<PageToolResult<PageSharesInfo>> SetShareEdit(string pageId, string userId, bool canEdit) => Tool(async () => Map(await _session.CallAsync(c => c.SetPageShareEdit(pageId, userId, canEdit))));
    public Task<PageToolResult<PageSharesInfo>> RemoveShare(string pageId, string userId) => Tool(async () => Map(await _session.CallAsync(c => c.RemovePageShare(pageId, userId))));
    public Task<PageToolResult<PageSharesInfo>> RevokeInvite(string pageId, string email) => Tool(async () => Map(await _session.CallAsync(c => c.RevokePageInvite(pageId, email))));

    public IReadOnlyList<SharedPageInfo> SharedWithMe => _shared;

    public async Task<string?> LeaveShare(string pageId)
    {
        try
        {
            await _session.CallAsync(c => c.RemovePageShare(pageId, _user.Id));
            _shared = _shared.Where(s => s.Id != pageId).ToList();
            if (_openId == pageId) OpenPage(null);
            Raise();
            return null;
        }
        catch (Exception e) { return ErrorText.Message(e); }
    }

    // ---- locked pages ----

    public LockInfo LockState => new(_lock?.HasPassword ?? false, _lock?.Unlocked ?? false);

    private bool IsLockedPage(string pageId) => _tree?.Pages.FirstOrDefault(p => p.Id == pageId)?.Locked == true;
    private bool PageLockedNow(string pageId) => IsLockedPage(pageId) && _lock?.Unlocked != true;

    /// <summary>The open locked page can't be read any more (the unlock lapsed, or "Lock now"): the lock screen takes its place.</summary>
    private void LockLapsed()
    {
        CloseLive();
        if (_lock is not null) _lock = _lock with { Unlocked = false };
        _info = null; _state = PageState.Locked; _stateMessage = null;
        Raise();
    }

    private async Task RefreshLock()
    {
        try { _lock = await _session.CallAsync(c => c.LockedNotesStatus()); } catch (Exception) { }
    }

    private async Task<string?> Lock(Func<N.Core, object?> call, Func<Task>? after = null)
    {
        try
        {
            await _session.CallAsync(c => { call(c); return 0; });
            await RefreshLock();
            if (after is not null) await after();
            Raise();
            return null;
        }
        catch (OperationCanceledException) { return "You were signed out. Sign in again."; }
        catch (Exception e) { return ErrorText.Message(e); }
    }

    public Task<string?> SetLockPassword(string password, string? current) => Lock(c => c.SetLockedNotesPassword(password, current));

    public async Task<string?> UnlockLocked(string password)
    {
        var err = await Lock(c => c.UnlockLockedNotes(password), () =>
        {
            if (_state == PageState.Locked && _openId is not null) { _state = PageState.Connecting; _attempts = 0; _info = null; StartOpen(); }
            KeepAlive();
            return Task.CompletedTask;
        });
        return err;
    }

    public async Task<string?> LockPage(string pageId)
    {
        var tree = await Change(c => { c.LockPage(pageId); return (null, null); });
        if (!tree.Ok) return tree.Error;
        await RefreshLock();
        if (_openId == pageId && !PageLockedNow(pageId)) { CloseLive(); _info = null; _state = PageState.Connecting; _attempts = 0; StartOpen(); }
        else if (_openId == pageId) LockLapsed();
        Raise();
        return null;
    }

    public async Task<string?> RemovePageLock(string pageId, string password)
    {
        var r = await Change(c => { c.RemovePageLock(pageId, password); return (null, null); });
        if (r.Ok && _openId == pageId) { CloseLive(); _info = null; _state = PageState.Connecting; _attempts = 0; StartOpen(); }
        return r.Error;
    }

    public async Task<string?> LockNow()
    {
        var err = await Lock(c => { c.LockLockedNotes(); return null; });
        if (err is null && _openId is { } id && IsLockedPage(id)) LockLapsed();
        return err;
    }

    private bool _keeping;

    /// <summary>While locked pages are open, ask the server about once a minute to keep them open (activity pushes the lapse back).</summary>
    private async void KeepAlive()
    {
        if (_keeping) return;
        _keeping = true;
        try
        {
            while (!_disposed && _lock?.Unlocked == true)
            {
                await Task.Delay(TimeSpan.FromSeconds(60));
                if (_disposed || _openId is not { } id || !IsLockedPage(id)) continue;
                var k = await _session.CallAsync(c => c.KeepLockedNotesUnlocked());
                if (!k.Unlocked) { await RefreshLock(); if (_openId == id && PageLockedNow(id)) LockLapsed(); }
            }
        }
        catch (Exception) { }
        finally { _keeping = false; }
    }

    // ---- export and icons ----

    public Task<PageToolResult<string>> ExportMarkdown(string pageId) => Tool(async () =>
    {
        if (LivePageOf(pageId) is not { } live) throw new InvalidOperationException("Open the page first, and wait until it has loaded.");
        var title = _tree?.Pages.FirstOrDefault(p => p.Id == pageId)?.Title ?? _shared.FirstOrDefault(s => s.Id == pageId)?.Title ?? "";
        var lines = new Dictionary<string, N.TaskLineInput>();
        foreach (var t in _tasks.Where(t => t.PageId == pageId))
            lines[t.Id] = t.Locked ? new N.TaskLineInput.Hidden() : new N.TaskLineInput.Shown(t.Title, t.Done, t.DueDate);
        return await Task.Run(() => N.NvCore.PageMarkdown(live.Document(), title, lines));
    });

    public async Task<string?> SetPageIcon(string pageId, string? icon) => (await Change(c => { c.SetPageIcon(pageId, icon); return (null, null); })).Error;
}
