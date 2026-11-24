namespace Notivelo.Windows.Data;
using Tsk = System.Threading.Tasks.Task;

// Page tools on the sample data (PARITY batch 2): comments, version history, page sharing, locked pages, Markdown export and page icons all work in
// memory, so the dialogs can be shown and driven (the UI tests, the look screenshots) with no server. The core source does the same through the core's calls.
public sealed partial class SampleNotesSource
{
    private const string Me = "u1";

    private sealed class SComment { public string Id = ""; public string Author = ""; public string Body = ""; public DateTimeOffset At; public bool Edited; }
    private sealed class SThread { public string Id = ""; public string PageId = ""; public string Quote = ""; public bool Resolved; public string? ResolvedBy; public DateTimeOffset? ResolvedAt; public List<SComment> Comments = new(); }

    private static readonly MemberInfo[] SampleMembers =
    {
        new("u1", "Demo User", "demo@example.com", "#6366f1", "owner"),
        new("u2", "Sam Rivera", "sam@example.com", "#14b8a6", "member"),
        new("u3", "Priya Nair", "priya@example.com", "#ec4899", "member"),
        new("u4", "Lee Chen", "lee@example.com", "#f59e0b", "viewer"),
    };

    private readonly List<SThread> _threads = new();
    private bool _seeded;
    private readonly Dictionary<string, List<(string Id, string Title, string Who, DateTimeOffset At, string Reason)>> _versions = new();
    private readonly Dictionary<string, List<ShareEntry>> _shares = new();
    private readonly Dictionary<string, List<InviteEntry>> _invites = new();
    private readonly Dictionary<string, string?> _icons = new();
    private readonly HashSet<string> _lockedPages = new();
    private string? _lockPassword;
    private bool _unlocked;
    private List<SharedPageInfo> _sharedWithMe = new()
    {
        new("shared-q4", "Q4 launch plan", "\U0001F680", "ws-sam", "Sam's workspace", true, "Sam Rivera"),
    };

    public string? WorkspaceRole => "owner";
    public IReadOnlyList<MemberInfo> Members() => _people;
    public IReadOnlyList<SharedPageInfo> SharedWithMe => _sharedWithMe;
    public LockInfo LockState => new(_lockPassword is not null, _unlocked);
    public bool CanComment(string pageId) => true;

    private void SeedShared()
    {
        _pages["shared-q4"] = new NotePage("shared-q4", "Q4 launch plan", "Edited 1h ago by Sam Rivera", "Sam's workspace", "#14b8a6", Array.Empty<string>(),
            PageColour.None, RuleLines.None, new CanvasBox[]
            {
                new(20, 20, 560, true, new BoxBlock[] { new(BlockKind.Heading1, "Q4 launch plan"), new(BlockKind.Paragraph, "Shared with you by Sam Rivera. You can edit this page.") }),
            }, 0, 0, Emoji: "\U0001F680");
    }

    /// <summary>The page as the shell shows it: the lock screen while it is locked, and its icon.</summary>
    private NotePage? Overlay(NotePage? p)
    {
        if (p is null) return null;
        var locked = _lockedPages.Contains(p.Id);
        var emoji = _icons.TryGetValue(p.Id, out var e) ? e : p.Emoji;
        return p with { Locked = locked, Emoji = emoji, State = locked && !_unlocked ? PageState.Locked : p.State, Comments = OpenCommentCount(p.Id) };
    }

    public string? EmojiOfPage(string pageId) => _icons.TryGetValue(pageId, out var e) ? e : null;

    // ---- comments ----

    private static string NameOfMember(string id) => SampleMembers.FirstOrDefault(m => m.Id == id)?.Name ?? "Former member";

    private CommentThreadInfo Map(SThread t) => new(t.Id, t.Quote, t.Resolved,
        t.Resolved ? $"Resolved {(t.ResolvedBy is null ? "" : "by " + NameOfMember(t.ResolvedBy) + " ")}{PageToolRules.Ago((t.ResolvedAt ?? DateTimeOffset.UtcNow).ToString("o"))}" : null,
        true,
        t.Comments.Select(c => new CommentInfo(c.Id, c.Author, NameOfMember(c.Author), SampleMembers.FirstOrDefault(m => m.Id == c.Author)?.Color, c.Body,
            PageToolRules.Ago(c.At.ToString("o")), c.Edited, c.Author == Me, c.Author == Me)).ToList());

    private void SeedComments(string pageId)
    {
        if (pageId != "canvas" || _threads.Any(t => t.PageId == pageId) || _seeded) return;
        _seeded = true;
        _threads.Add(new SThread
        {
            Id = "th-" + pageId + "-1", PageId = pageId, Quote = "Same place as a, id breaks the tie",
            Comments = { new SComment { Id = "c-" + pageId + "-1", Author = "u2", Body = "Can we move this above the heading?", At = DateTimeOffset.UtcNow.AddHours(-3) },
                         new SComment { Id = "c-" + pageId + "-2", Author = Me, Body = "Yes, I will do it today.", At = DateTimeOffset.UtcNow.AddMinutes(-40) } },
        });
        _threads.Add(new SThread
        {
            Id = "th-" + pageId + "-2", PageId = pageId, Quote = "Box c", Resolved = true, ResolvedBy = "u3", ResolvedAt = DateTimeOffset.UtcNow.AddDays(-1),
            Comments = { new SComment { Id = "c-" + pageId + "-3", Author = "u3", Body = "Typo fixed.", At = DateTimeOffset.UtcNow.AddDays(-2) } },
        });
    }

    public int OpenCommentCount(string pageId) { SeedComments(pageId); return _threads.Count(t => t.PageId == pageId && !t.Resolved); }

    public Task<PageToolResult<IReadOnlyList<CommentThreadInfo>>> LoadComments(string pageId)
    {
        SeedComments(pageId);
        IReadOnlyList<CommentThreadInfo> list = _threads.Where(t => t.PageId == pageId).Select(Map).ToList();
        return Tsk.FromResult(new PageToolResult<IReadOnlyList<CommentThreadInfo>>(list));
    }

    private Task<PageToolResult<CommentThreadInfo>> Ok(SThread t) { Raise(); return Tsk.FromResult(new PageToolResult<CommentThreadInfo>(Map(t))); }

    public Task<PageToolResult<CommentThreadInfo>> AddCommentThread(string pageId, string threadId, string quote, string body)
    {
        var t = _threads.FirstOrDefault(x => x.Id == threadId);
        if (t is null)
        {
            t = new SThread { Id = threadId, PageId = pageId, Quote = quote.Length > 500 ? quote[..500] : quote };
            t.Comments.Add(new SComment { Id = NewId("c"), Author = Me, Body = body, At = DateTimeOffset.UtcNow });
            _threads.Add(t);
            Log($"comment add {body}");
        }
        return Ok(t);
    }

    public Task<PageToolResult<CommentThreadInfo>> ReplyToThread(string threadId, string body)
    {
        var t = _threads.FirstOrDefault(x => x.Id == threadId);
        if (t is null) return Tsk.FromResult(PageToolResult<CommentThreadInfo>.Fail("That thread is gone."));
        t.Comments.Add(new SComment { Id = NewId("c"), Author = Me, Body = body, At = DateTimeOffset.UtcNow });
        t.Resolved = false; t.ResolvedAt = null; t.ResolvedBy = null;
        Log($"comment reply {body}");
        return Ok(t);
    }

    public Task<PageToolResult<CommentThreadInfo>> SetThreadResolved(string threadId, bool resolved)
    {
        var t = _threads.FirstOrDefault(x => x.Id == threadId);
        if (t is null) return Tsk.FromResult(PageToolResult<CommentThreadInfo>.Fail("That thread is gone."));
        t.Resolved = resolved; t.ResolvedBy = resolved ? Me : null; t.ResolvedAt = resolved ? DateTimeOffset.UtcNow : null;
        Log($"comment {(resolved ? "resolve" : "reopen")} {threadId}");
        return Ok(t);
    }

    public Task<PageToolResult<CommentThreadInfo>> EditComment(string commentId, string body)
    {
        var t = _threads.FirstOrDefault(x => x.Comments.Any(c => c.Id == commentId));
        var c = t?.Comments.First(x => x.Id == commentId);
        if (t is null || c is null) return Tsk.FromResult(PageToolResult<CommentThreadInfo>.Fail("That comment is gone."));
        c.Body = body; c.Edited = true;
        return Ok(t);
    }

    public Task<PageToolResult<bool>> DeleteComment(string commentId)
    {
        var t = _threads.FirstOrDefault(x => x.Comments.Any(c => c.Id == commentId));
        if (t is null) return Tsk.FromResult(PageToolResult<bool>.Fail("That comment is gone."));
        t.Comments.RemoveAll(c => c.Id == commentId);
        var gone = t.Comments.Count == 0;
        if (gone) _threads.Remove(t);
        Raise();
        return Tsk.FromResult(new PageToolResult<bool>(gone));
    }

    public Task<PageToolResult<bool>> DeleteThread(string threadId)
    {
        _threads.RemoveAll(t => t.Id == threadId);
        Raise();
        return Tsk.FromResult(new PageToolResult<bool>(true));
    }

    // ---- version history ----

    private List<(string Id, string Title, string Who, DateTimeOffset At, string Reason)> VersionsOf(string pageId)
    {
        if (_versions.TryGetValue(pageId, out var l)) return l;
        var title = _pages.GetValueOrDefault(pageId)?.Title ?? "Untitled";
        var now = DateTimeOffset.UtcNow;
        return _versions[pageId] = new()
        {
            ($"v-{pageId}-3", title, "u1", now.AddMinutes(-12), "auto"),
            ($"v-{pageId}-2", title, "u2", now.AddHours(-5), "manual"),
            ($"v-{pageId}-1", title + " (draft)", "u1", now.AddDays(-2), "auto"),
        };
    }

    public bool CanRestoreVersion(string pageId) => true;

    public Task<PageToolResult<IReadOnlyList<VersionInfo>>> LoadVersions(string pageId)
    {
        IReadOnlyList<VersionInfo> list = VersionsOf(pageId).Select(v =>
            new VersionInfo(v.Id, PageToolRules.WhenLabel(v.At.ToString("o")), NameOfMember(v.Who), PageToolRules.Ago(v.At.ToString("o")) + PageToolRules.VersionTag(v.Reason))).ToList();
        return Tsk.FromResult(new PageToolResult<IReadOnlyList<VersionInfo>>(list));
    }

    public Task<PageToolResult<string>> VersionPreview(string pageId, string versionId)
    {
        var v = VersionsOf(pageId).FirstOrDefault(x => x.Id == versionId);
        if (v.Id is null) return Tsk.FromResult(PageToolResult<string>.Fail("That version is gone."));
        var page = _pages.GetValueOrDefault(pageId);
        var text = page is null ? "# " + v.Title + "\n" : PageToolRules.Markdown(page with { Title = v.Title });
        return Tsk.FromResult(new PageToolResult<string>(text));
    }

    public Task<PageToolResult<string?>> RestoreVersion(string pageId, string versionId)
    {
        var list = VersionsOf(pageId);
        var before = $"v-{pageId}-b{list.Count}";
        list.Insert(0, (before, _pages.GetValueOrDefault(pageId)?.Title ?? "Untitled", Me, DateTimeOffset.UtcNow, "restore"));
        Log($"version restore {versionId}");
        Raise();
        return Tsk.FromResult(new PageToolResult<string?>(before));
    }

    // ---- sharing ----

    private PageSharesInfo SharesOf(string pageId) => new(_shares.GetValueOrDefault(pageId)?.ToList() ?? new(), _invites.GetValueOrDefault(pageId)?.ToList() ?? new());

    public Task<PageToolResult<PageSharesInfo>> LoadShares(string pageId)
    {
        if (!_shares.ContainsKey(pageId) && pageId == "canvas")
            _shares[pageId] = new() { new ShareEntry("u2", "Sam Rivera", "sam@example.com", "#14b8a6", true, true, false) };
        return Tsk.FromResult(new PageToolResult<PageSharesInfo>(SharesOf(pageId)));
    }

    public Task<PageToolResult<ShareOutcome>> SharePage(string pageId, string? userId, string? email, bool canEdit)
    {
        if (_lockedPages.Contains(pageId)) return Tsk.FromResult(PageToolResult<ShareOutcome>.Fail("A locked page can't be shared."));
        var shares = _shares.TryGetValue(pageId, out var s) ? s : _shares[pageId] = new();
        var invites = _invites.TryGetValue(pageId, out var iv) ? iv : _invites[pageId] = new();
        var member = userId is not null ? _people.FirstOrDefault(m => m.Id == userId) : _people.FirstOrDefault(m => m.Email.Equals(email, StringComparison.OrdinalIgnoreCase));
        if (member is not null)
        {
            shares.RemoveAll(x => x.UserId == member.Id);
            shares.Add(new ShareEntry(member.Id, member.Name, member.Email, member.Color, canEdit, true, member.Role == "viewer"));
            Log($"share {member.Name} {(canEdit ? "edit" : "view")}");
            return Tsk.FromResult(new PageToolResult<ShareOutcome>(new ShareOutcome(SharesOf(pageId), "shared", false, null)));
        }
        invites.RemoveAll(x => x.Email.Equals(email, StringComparison.OrdinalIgnoreCase));
        invites.Add(new InviteEntry(email ?? "", canEdit));
        Log($"invite {email}");
        return Tsk.FromResult(new PageToolResult<ShareOutcome>(new ShareOutcome(SharesOf(pageId), "invited", false, "https://app.example.com/invite/sample-token")));
    }

    public Task<PageToolResult<PageSharesInfo>> SetShareEdit(string pageId, string userId, bool canEdit)
    {
        if (_shares.TryGetValue(pageId, out var l)) { var i = l.FindIndex(x => x.UserId == userId); if (i >= 0) l[i] = l[i] with { CanEdit = canEdit }; }
        return Tsk.FromResult(new PageToolResult<PageSharesInfo>(SharesOf(pageId)));
    }

    public Task<PageToolResult<PageSharesInfo>> RemoveShare(string pageId, string userId)
    {
        _shares.GetValueOrDefault(pageId)?.RemoveAll(x => x.UserId == userId);
        return Tsk.FromResult(new PageToolResult<PageSharesInfo>(SharesOf(pageId)));
    }

    public Task<PageToolResult<PageSharesInfo>> RevokeInvite(string pageId, string email)
    {
        _invites.GetValueOrDefault(pageId)?.RemoveAll(x => x.Email.Equals(email, StringComparison.OrdinalIgnoreCase));
        return Tsk.FromResult(new PageToolResult<PageSharesInfo>(SharesOf(pageId)));
    }

    public Task<string?> LeaveShare(string pageId)
    {
        _sharedWithMe = _sharedWithMe.Where(x => x.Id != pageId).ToList();
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    // ---- locked pages ----

    public Task<string?> SetLockPassword(string password, string? current)
    {
        if (_lockPassword is not null && current != _lockPassword) return Tsk.FromResult<string?>("That is not your current locked pages password.");
        _lockPassword = password; _unlocked = true;
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    public Task<string?> UnlockLocked(string password)
    {
        if (_lockPassword is null) return Tsk.FromResult<string?>("Set a locked pages password first.");
        if (password != _lockPassword) return Tsk.FromResult<string?>("Wrong password. Try again.");
        _unlocked = true;
        Log("unlock");
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    private void MarkLocked(string pageId, bool locked) => MapTree(s => s with { Pages = s.Pages.Select(p => p.Id == pageId ? p with { Locked = locked } : p).ToList() });

    public Task<string?> LockPage(string pageId)
    {
        if (_lockPassword is null) return Tsk.FromResult<string?>("Set a locked pages password first.");
        if (_shares.GetValueOrDefault(pageId)?.Count > 0) return Tsk.FromResult<string?>("Only a page nobody else can see can be locked.");
        _lockedPages.Add(pageId); MarkLocked(pageId, true);
        Log("lock " + pageId);
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    public Task<string?> RemovePageLock(string pageId, string password)
    {
        if (password != _lockPassword) return Tsk.FromResult<string?>("Wrong password. Try again.");
        _lockedPages.Remove(pageId); MarkLocked(pageId, false);
        Log("unlock page " + pageId);
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    public Task<string?> LockNow()
    {
        _unlocked = false;
        Log("lock now");
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    // ---- export and icons ----

    public Task<PageToolResult<string>> ExportMarkdown(string pageId)
    {
        var page = Overlay(_pages.GetValueOrDefault(pageId));
        return Tsk.FromResult(page is null ? PageToolResult<string>.Fail("That page is not open.") : new PageToolResult<string>(PageToolRules.Markdown(page)));
    }

    public Task<string?> SetPageIcon(string pageId, string? icon)
    {
        _icons[pageId] = icon;
        MapTree(s => s with { Pages = s.Pages.Select(p => p.Id == pageId ? p with { Emoji = icon } : p).ToList() });
        Log("icon " + (icon ?? "none"));
        Raise();
        return Tsk.FromResult<string?>(null);
    }
}
