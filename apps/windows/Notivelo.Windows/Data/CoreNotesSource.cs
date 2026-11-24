using System.Globalization;
using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

/// <summary>
/// <see cref="INotesSource"/> over the Rust core: workspaces, the notebook/section/page tree and the task list are loaded in the
/// background (the on-device copy first, then the server's) and the open page is a core <c>LivePage</c>. Everything here runs on the UI
/// thread except the core calls themselves (<see cref="AppSession.CallAsync"/>) and the live page's listener, which hops back through
/// <see cref="AppSession.Post"/>. <see cref="Changed"/> is raised on the UI thread.
/// </summary>
internal sealed partial class CoreNotesSource : INotesSource, IDisposable
{
    private readonly AppSession _session;
    private readonly N.User _user;
    private N.Workspace[] _workspaces = Array.Empty<N.Workspace>();
    private string? _wsId;
    private N.Tree? _tree;
    private N.Task[] _tasks = Array.Empty<N.Task>();
    private IReadOnlyList<Notebook> _notebooks = Array.Empty<Notebook>();
    private string? _notebookId;
    private bool _disposed;

    // the open page
    private string? _openId;
    private N.LivePage? _live;
    private N.PageInfo? _info;
    private PageState _state = PageState.Connecting;
    private string? _stateMessage;
    private int _gen, _attempts;

    public event EventHandler? Changed;

    public CoreNotesSource(AppSession session, N.User user)
    {
        _session = session;
        _user = user;
        Workspace = new Workspace("Workspace", "W", Initials(user.Name, user.Email), user.Name, user.Email);
        Loading = true;
    }

    public Workspace Workspace { get; private set; }
    public IReadOnlyList<WorkspaceInfo> Workspaces => _workspaces.Select(w => new WorkspaceInfo(w.Id, w.Name, w.Role)).ToList();
    public string? CurrentWorkspaceId => _wsId;
    public IReadOnlyList<Notebook> Notebooks => _notebooks;
    public string? CurrentNotebookId => _notebookId;
    public bool Loading { get; private set; }
    public string? LoadError { get; private set; }
    public string? InitialPageId => null;

    private void Raise() { if (!_disposed) Changed?.Invoke(this, EventArgs.Empty); }

    private static string Initials(string name, string email)
    {
        var parts = name.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 2) return (parts[0][..1] + parts[^1][..1]).ToUpperInvariant();
        if (parts.Length == 1) return parts[0][..Math.Min(2, parts[0].Length)].ToUpperInvariant();
        return string.IsNullOrEmpty(email) ? "?" : email[..1].ToUpperInvariant();
    }

    // ---- loading ----------------------------------------------------------------------------------------------

    /// <summary>Workspaces (the stored copy first), then the chosen workspace's tree and tasks.</summary>
    public async void Start()
    {
        try
        {
            if (_workspaces.Length == 0)
            {
                var cached = await Task.Run(() => _session.Core.CachedWorkspaces());
                if (cached is { Length: > 0 } && !_disposed) { _workspaces = cached; PickWorkspace(); }
            }
            var list = await _session.CallAsync(c => c.Workspaces());
            _workspaces = list;
            LoadError = list.Length == 0 ? "No workspaces yet. Create one in the web app." : null;
            Loading = false;
            PickWorkspace();
            Raise();
            _ = LoadPageToolsAsync();
        }
        catch (OperationCanceledException) { }
        catch (Exception e)
        {
            Loading = false;
            LoadError = ErrorText.Message(e);
            Raise();
        }
    }

    private bool _hookDone, _nbHookDone;

    private void PickWorkspace()
    {
        if (_workspaces.Length == 0) return;
        var saved = AppSettings.Workspace(_session.ServerUrl);
        // dev hook: NOTIVELO_WORKSPACE=<part of a name> picks that workspace at startup (loopback servers only, like the sign-in hook)
        var hook = Environment.GetEnvironmentVariable("NOTIVELO_WORKSPACE");
        var hooked = hook is not null && _session.ServerUrl.Contains("127.0.0.1") && !_hookDone ? _workspaces.FirstOrDefault(w => w.Name.Contains(hook, StringComparison.OrdinalIgnoreCase)) : null;
        if (hooked is not null) _hookDone = true;
        var pick = hooked ?? _workspaces.FirstOrDefault(w => w.Id == _wsId) ?? _workspaces.FirstOrDefault(w => w.Id == saved) ?? _workspaces[0];
        if (pick.Id != _wsId || _tree is null) SelectWorkspace(pick.Id);
    }

    public async void SelectWorkspace(string id)
    {
        if (_disposed) return;
        var changed = id != _wsId;
        _wsId = id;
        AppSettings.SetWorkspace(_session.ServerUrl, id);
        var ws = _workspaces.FirstOrDefault(w => w.Id == id);
        if (ws is not null) Workspace = Workspace with { Name = ws.Name, Initial = ws.Name.Length > 0 ? ws.Name[..1].ToUpperInvariant() : "W" };
        if (changed) { _members = Array.Empty<N.WorkspaceMember>(); _tree = null; _tasks = Array.Empty<N.Task>(); _notebookId = null; _notebooks = Array.Empty<Notebook>(); OpenPage(null); }
        Loading = _tree is null;
        Raise();
        try
        {
            if (_tree is null)
            {
                var (t, ts) = await Task.Run(() => (_session.Core.CachedTree(id), _session.Core.CachedTasks(id)));
                if (id == _wsId && _tree is null && t is not null) { _tree = t; _tasks = ts ?? Array.Empty<N.Task>(); Rebuild(); Raise(); }
            }
            var (tree, tasks) = await _session.CallAsync(c => (c.Tree(id), c.Tasks(id)));
            if (id != _wsId) return;
            _tree = tree; _tasks = tasks; _tasksVersion++; LoadError = null; Loading = false; _netDown = false;
            Rebuild();
            Raise();
            _ = LoadMembersAsync(id);
        }
        catch (OperationCanceledException) { }
        catch (Exception e)
        {
            if (id != _wsId) return;
            Loading = false; LoadError = ErrorText.Message(e); NoteNetwork(e);
            Raise();
        }
    }

    public void SelectNotebook(string id)
    {
        if (_notebooks.All(n => n.Id != id)) return;
        _notebookId = id;
        Raise();
    }

    // ---- tree -------------------------------------------------------------------------------------------------

    private void Rebuild()
    {
        if (_tree is null) { _notebooks = Array.Empty<Notebook>(); return; }
        var open = _tasks.Where(t => !t.Done && t.PageId is not null).GroupBy(t => t.PageId!).ToDictionary(g => g.Key, g => g.Count());
        Section Build(N.Section s)
        {
            var pages = _tree.Pages.Where(p => p.SectionId == s.Id).OrderBy(p => p.Position)
                .Select(p => new PageSummary(p.Id, p.Title.Length == 0 ? "Untitled" : p.Title, open.GetValueOrDefault(p.Id), p.Icon, p.Locked)).ToList();
            var kids = _tree.Sections.Where(c => c.ParentId == s.Id).OrderBy(c => c.Position).Select(Build).ToList();
            return new Section(s.Id, s.Name, s.Color, pages, kids);
        }
        _notebooks = _tree.Notebooks.OrderBy(n => n.Position).Select(n => new Notebook(
            n.Id, n.Name, n.Name.Length > 0 ? n.Name[..1].ToUpperInvariant() : "N", n.Color, n.Visibility == "private",
            _tree.Sections.Where(s => s.NotebookId == n.Id && s.ParentId is null).OrderBy(s => s.Position).Select(Build).ToList())).ToList();
        if (_notebookId is null || _notebooks.All(n => n.Id != _notebookId)) _notebookId = _notebooks.FirstOrDefault()?.Id;
        // dev hook: NOTIVELO_NOTEBOOK=<part of a name> shows that notebook first (loopback servers only)
        if (Environment.GetEnvironmentVariable("NOTIVELO_NOTEBOOK") is { } nbHook && !_nbHookDone && _session.ServerUrl.Contains("127.0.0.1")
            && _notebooks.FirstOrDefault(n => n.Name.Contains(nbHook, StringComparison.OrdinalIgnoreCase)) is { } nbPick) { _notebookId = nbPick.Id; _nbHookDone = true; }
    }

    private string PageTitle(string id)
    {
        var t = _tree?.Pages.FirstOrDefault(p => p.Id == id)?.Title;
        return string.IsNullOrEmpty(t) ? "Untitled" : t;
    }

    public IReadOnlyList<(PageSummary Page, string Where, string Edited)> RecentPages(int count)
    {
        if (_tree is null) return Array.Empty<(PageSummary, string, string)>();
        var sections = _tree.Sections.ToDictionary(s => s.Id);
        var notebooks = _tree.Notebooks.ToDictionary(n => n.Id);
        string Where(string sectionId)
        {
            var names = new List<string>();
            var cur = sections.GetValueOrDefault(sectionId);
            for (var i = 0; cur is not null && i < 12; i++)
            {
                names.Insert(0, cur.Name);
                if (cur.ParentId is { } p) cur = sections.GetValueOrDefault(p);
                else { if (notebooks.TryGetValue(cur.NotebookId, out var nb)) names.Insert(0, nb.Name); cur = null; }
            }
            return string.Join(" › ", names);
        }
        var open = _tasks.Where(t => !t.Done && t.PageId is not null).GroupBy(t => t.PageId!).ToDictionary(g => g.Key, g => g.Count());
        return _tree.Pages.OrderByDescending(p => p.UpdatedAt, StringComparer.Ordinal).Take(count)
            .Select(p => (new PageSummary(p.Id, p.Title.Length == 0 ? "Untitled" : p.Title, open.GetValueOrDefault(p.Id), p.Icon, p.Locked), Where(p.SectionId), Ago(p.UpdatedAt)))
            .ToList();
    }

    private static string Ago(string iso)
    {
        if (!DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)) return "";
        var d = DateTimeOffset.UtcNow - t;
        if (d.TotalMinutes < 1) return "just now";
        if (d.TotalMinutes < 60) return $"{(int)d.TotalMinutes}m ago";
        if (d.TotalHours < 24) return $"{(int)d.TotalHours}h ago";
        if (d.TotalDays < 7) return $"{(int)d.TotalDays}d ago";
        return t.ToLocalTime().ToString("d MMM yyyy", CultureInfo.CurrentCulture);
    }

    // ---- the open page (core LivePage) ------------------------------------------------------------------------

    public void OpenPage(string? pageId)
    {
        if (pageId == _openId) return;
        CloseLive();
        _openId = pageId;
        _info = null; _attempts = 0; _stateMessage = null;
        _state = PageState.Connecting;
        _gen++;
        if (pageId is not null) { StartOpen(); _ = LoadComments(pageId); }
    }

    /// <summary>Close the page's connection off the UI thread (close may wait for the socket thread).</summary>
    private void CloseLive()
    {
        _gen++;
        var live = _live;
        _live = null;
        if (live is not null) CloseInBackground(live);
    }

    private static void CloseInBackground(N.LivePage page) => _ = Task.Run(() => { try { page.Close(); } catch { } });

    private async void StartOpen()
    {
        var id = _openId;
        if (id is null || _live is not null || _disposed) return;
        if (PageLockedNow(id)) { _state = PageState.Locked; _stateMessage = null; Raise(); return; }   // the lock screen asks for the password first
        var gen = ++_gen;
        var listener = new Listener(this, gen);
        try
        {
            var live = await _session.CallAsync(c => c.OpenPage(id, listener));
            if (gen != _gen || _disposed) { CloseInBackground(live); return; }
            _live = live;
            // Synced may have been heard before this hop (an empty page sends no change).
            if (_info is null && _state == PageState.Live) { _info = await Task.Run(() => live.Info()); Raise(); }
        }
        catch (OperationCanceledException) { }
        catch (Exception e)
        {
            if (gen != _gen) return;
            if (e is N.CoreException.Server s && (s.status == 403 || s.status == 404))
            {
                if (s.status == 403 && IsLockedPage(id)) { LockLapsed(); return; }
                _state = PageState.Ended; _stateMessage = s.status == 404 ? "This page was deleted." : "You don't have access to this page.";
                Raise(); return;
            }
            _state = PageState.Offline; _stateMessage = ErrorText.Message(e);
            Raise();
            RetryLater();
        }
    }

    private async void RetryLater()
    {
        _attempts++;
        var gen = _gen;
        await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, Math.Pow(2, Math.Min(_attempts, 5)))));
        _session.Post(() => { if (gen == _gen && _live is null && !_disposed) StartOpen(); });
    }

    private void DropConnection() { CloseLive(); }

    private void Heard(N.SyncStatus status, int gen)
    {
        if (gen != _gen || _disposed) return;
        switch (status)
        {
            case N.SyncStatus.Synced:
                _attempts = 0; _state = PageState.Live; _stateMessage = null;
                if (_info is null && _live is { } live) { _ = ReadInfoAsync(live, gen); return; }
                Raise();
                break;
            case N.SyncStatus.Closed c:
                DropConnection();
                if (c.Code == 4403 && _openId is { } lockedId && IsLockedPage(lockedId)) LockLapsed();
                else if (c.Code == 4403) { _state = PageState.Ended; _stateMessage = "You no longer have access to this page."; Raise(); }
                else if (c.Code == 4401 && _attempts < 3) { _attempts++; StartOpen(); }
                else { _state = PageState.Offline; _stateMessage = c.Reason.Length == 0 ? $"Disconnected ({c.Code})." : c.Reason; Raise(); RetryLater(); }
                break;
            case N.SyncStatus.Failed f:
                DropConnection();
                _state = PageState.Offline; _stateMessage = f.Message;
                Raise(); RetryLater();
                break;
        }
    }

    private async Task ReadInfoAsync(N.LivePage live, int gen)
    {
        var info = await Task.Run(() => live.Info());
        if (gen == _gen && _info is null) { _info = info; Raise(); }
    }

    private void Changed_(N.PageInfo page, int gen)
    {
        if (gen != _gen || _disposed) return;
        _info = page;
        if (_state == PageState.Connecting) _state = PageState.Live;
        Raise();
    }

    /// <summary>Hears a live page on the core's sync thread; changes are coalesced (a newer one replaces one still waiting for the UI thread).</summary>
    private sealed class Listener : N.PageListener
    {
        private readonly CoreNotesSource _owner;
        private readonly int _gen;
        private readonly object _lock = new();
        private N.PageInfo? _pending;

        public Listener(CoreNotesSource owner, int gen) { _owner = owner; _gen = gen; }

        public void OnStatus(N.SyncStatus status)
        {
            try { _owner._session.Post(() => { Flush(); _owner.Heard(status, _gen); }); } catch { }
        }

        public void OnChange(N.PageInfo page)
        {
            bool schedule;
            lock (_lock) { schedule = _pending is null; _pending = page; }
            if (schedule) { try { _owner._session.Post(Flush); } catch { } }
        }

        private void Flush()
        {
            N.PageInfo? page;
            lock (_lock) { page = _pending; _pending = null; }
            if (page is not null) _owner.Changed_(page, _gen);
        }
    }

    public N.LivePage? LivePageOf(string pageId) => pageId == _openId && _state == PageState.Live && _info is not null ? _live : null;
    public bool? PageUndo(string pageId, bool undo)
    {
        if (LivePageOf(pageId) is not { } live) return null;
        try
        {
            var changed = undo ? live.Undo() : live.Redo();
            _info = live.Info();
            Raise();
            return changed;
        }
        catch (Exception e) { System.Diagnostics.Debug.WriteLine("page undo: " + e.Message); return false; }
    }

    public bool? CanPageUndo(string pageId, bool undo)
    {
        if (LivePageOf(pageId) is not { } live) return null;
        try { return undo ? live.CanUndo() : live.CanRedo(); } catch (Exception) { return false; }
    }

    public TaskItem? FindTask(string taskId) => TaskLine(taskId);
    public string? PageTitleOf(string pageId) => _tree?.Pages.FirstOrDefault(p => p.Id == pageId)?.Title ?? _shared.FirstOrDefault(s => s.Id == pageId)?.Title;
    public string? EmojiOfPage(string pageId) => _tree?.Pages.FirstOrDefault(p => p.Id == pageId)?.Icon is { Length: > 0 } i ? i : null;
    public string? UserId => _user.Id;

    /// <summary>Pages for the [[ menu: titles starting with the query first, then words starting with it, then containing it (Apple's pageMatches); newest first within each.</summary>
    public IReadOnlyList<(string Id, string Title, string Crumb)> SearchPages(string query, int max)
    {
        if (_tree is null) return Array.Empty<(string, string, string)>();
        var q = query.Trim().ToLowerInvariant();
        int Score(string t) => q.Length == 0 ? 1 : t.StartsWith(q) ? 0 : t.Split(' ').Any(w => w.StartsWith(q)) ? 1 : t.Contains(q) ? 2 : -1;
        return _tree.Pages.Where(p => !p.Locked)
            .Select(p => (P: p, Score: Score((p.Title.Length == 0 ? "Untitled" : p.Title).ToLowerInvariant())))
            .Where(x => x.Score >= 0).OrderBy(x => x.Score).ThenByDescending(x => x.P.UpdatedAt, StringComparer.Ordinal).Take(max)
            .Select(x => (x.P.Id, x.P.Title.Length == 0 ? "Untitled" : x.P.Title, CrumbOf(x.P))).ToList();
    }

    private string CrumbOf(N.PageMeta p)
    {
        var names = new List<string>();
        var sec = _tree!.Sections.FirstOrDefault(s => s.Id == p.SectionId);
        var nb = sec is null ? null : _tree.Notebooks.FirstOrDefault(n => n.Id == sec.NotebookId);
        if (nb is not null) names.Add(nb.Name);
        var path = new List<string>();
        for (var cur = sec; cur is not null;) { path.Insert(0, cur.Name); cur = cur.ParentId is { } pid ? _tree.Sections.FirstOrDefault(s => s.Id == pid) : null; }
        names.AddRange(path);
        return string.Join(" \u203A ", names);
    }

    /// <summary>The workspace's members (core call <c>members</c>, needs the network); until they load, only yourself.</summary>
    private N.WorkspaceMember[] _members = Array.Empty<N.WorkspaceMember>();

    private async Task LoadMembersAsync(string ws)
    {
        try
        {
            var list = await _session.CallAsync(c => c.Members(ws));
            if (ws == _wsId && !_disposed) _members = list;
        }
        catch (Exception) { }
    }

    public IReadOnlyList<(string Id, string Label, string Detail, string? ColorHex)> People(string query)
    {
        bool Match(string n) => query.Length == 0 || n.Contains(query, StringComparison.OrdinalIgnoreCase);
        var res = _members.Where(m => Match(m.Name) || Match(m.Email)).Take(8).Select(m => (m.Id, m.Name.Length > 0 ? m.Name : m.Email, m.Email, (string?)m.Color)).ToList();
        if (_members.Length == 0 && _user.Name is { Length: > 0 } n && Match(n)) res.Add((_user.Id, n, _user.Email, null));
        return res;
    }

    // ---- canvas boxes and ink ---------------------------------------------------------------------------------------

    public bool CanEditBoxes(string pageId) => LivePageOf(pageId) is not null && _info?.Kind == N.PageKind.Canvas;

    /// <summary>One box call on the open page, then show the page as it is (the call is a local edit of the page document).</summary>
    private bool BoxCall(string pageId, Action<N.LivePage> call)
    {
        if (LivePageOf(pageId) is not { } live) return false;
        try { call(live); _info = live.Info(); Raise(); return true; }
        catch (Exception e) { System.Diagnostics.Debug.WriteLine("box call: " + e.Message); return false; }
    }

    public string? CreateBox(string pageId, double x, double y, double w, double z)
    {
        var id = N.NvCore.NewBoxId();
        return BoxCall(pageId, l => l.CreateBoxWithId(id, x, y, w, z)) ? id : null;
    }
    public void MoveBox(string pageId, string boxId, double x, double y) => BoxCall(pageId, l => l.MoveBox(boxId, x, y));
    public void ResizeBox(string pageId, string boxId, double w) => BoxCall(pageId, l => l.ResizeBox(boxId, w));
    public void BringBoxToFront(string pageId, string boxId) => BoxCall(pageId, l => l.BringToFront(boxId));
    public bool DeleteBox(string pageId, string boxId) => BoxCall(pageId, l => l.DeleteBox(boxId));

    private readonly Dictionary<string, float[]> _outlines = new();

    public IReadOnlyList<InkStroke> InkOf(string pageId)
    {
        if (LivePageOf(pageId) is not { } live) return Array.Empty<InkStroke>();
        var res = new List<InkStroke>();
        var kept = new Dictionary<string, float[]>();
        try
        {
            foreach (var s in live.InkStrokes())
            {
                if (!s.Readable || s.Bounds is not { } b) continue;
                var key = $"{s.Id}|{s.Data.Length}|{b.MinX}|{b.MinY}";
                if (!_outlines.TryGetValue(key, out var ops)) ops = N.NvCore.InkOutlineOps(s.Data);
                if (ops.Length == 0) continue;
                kept[key] = ops;
                res.Add(new InkStroke(s.Id, s.Tool == 1, s.Color, ops, b.MaxX, b.MaxY, b.MinX, b.MinY));
            }
        }
        catch (Exception) { }
        _outlines.Clear();
        foreach (var kv in kept) _outlines[kv.Key] = kv.Value;
        return res;
    }

    // ink writes: the core's calls on the open live page (Apple's InkSession); no Changed is raised, the page reads InkOf again
    public bool CanInk(string pageId) => LivePageOf(pageId) is not null;

    private bool InkCall(string pageId, Action<N.LivePage> call)
    {
        if (LivePageOf(pageId) is not { } live) return false;
        try { call(live); return true; }
        catch (Exception e) { System.Diagnostics.Debug.WriteLine("ink call: " + e.Message); return false; }
    }

    public bool AddInkStroke(string pageId, N.InkStrokeBuilder builder, byte tool, uint color) => InkCall(pageId, l => l.AddInkStroke(builder));
    public bool EraseInk(string pageId, float[] track, float radius, bool partial) => InkCall(pageId, l => l.EraseInk(track, radius, partial));
    public bool DeleteInkStrokes(string pageId, IReadOnlyList<string> ids) => InkCall(pageId, l => l.DeleteInkStrokes(ids.ToArray()));

    public IReadOnlyList<string> InkHitLasso(string pageId, float[] polygon)
    {
        string[] r = Array.Empty<string>();
        InkCall(pageId, l => r = l.InkHitLasso(polygon, 0.5f));
        return r;
    }

    public IReadOnlyList<string> InkHitPoint(string pageId, float x, float y, float radius)
    {
        string[] r = Array.Empty<string>();
        InkCall(pageId, l => r = l.InkHitPoint(x, y, radius));
        return r;
    }

    public IReadOnlyList<(string OldId, string NewId)>? MoveInkStrokes(string pageId, IReadOnlyList<string> ids, float dx, float dy)
    {
        N.InkMovedStroke[]? r = null;
        return InkCall(pageId, l => r = l.MoveInkStrokes(ids.ToArray(), dx, dy)) && r is not null ? r.Select(m => (m.OldId, m.NewId)).ToList() : null;
    }

    public async void CreateTask(string id, string title, bool done, string? pageId)
    {
        var ws = _wsId;
        if (ws is null) return;
        try
        {
            var made = await _session.CallAsync(c => c.CreateTaskWith(ws, new N.NewTaskInput(title, id, pageId, null, done)));
            if (ws != _wsId) return;
            _tasks = _tasks.Where(t => t.Id != made.Id).Append(made).ToArray(); _tasksVersion++;
            Raise();
        }
        catch (Exception) { }
    }

    public async Task<string?> AddTask(NewTask t)
    {
        var ws = _wsId;
        if (ws is null) return "Not signed in.";
        try
        {
            var title = t.Title;
            string? assignee = t.AssigneeId is { Length: 0 } ? null : t.AssigneeId ?? _user.Id;
            if (t.AssigneeId is null && t.AssigneeMention is { } mention)
            {
                if (N.NvCore.ResolveMember(mention, _members, _user.Id) is { } id) assignee = id; else title += " @" + mention;
            }
            string? teamId = t.TeamId;
            if (teamId is null && t.TeamText is { } team)
            {
                var teams = await _session.CallAsync(c => c.Teams(ws));
                if (N.NvCore.ResolveTeam(team, teams) is { } id) teamId = id; else title += " +" + team;
            }
            title = title.Trim();
            if (title.Length == 0) return "Give the task a title.";
            string[]? tagIds = null;
            if (t.Tags.Count > 0)
            {
                var known = await _session.CallAsync(c => c.Tags(ws));
                var ids = new List<string>();
                foreach (var name in t.Tags)
                {
                    var hit = known.FirstOrDefault(k => string.Equals(k.Name, name, StringComparison.OrdinalIgnoreCase));
                    ids.Add(hit?.Id ?? (await _session.CallAsync(c => c.CreateTag(ws, name, null))).Id);
                }
                tagIds = ids.ToArray();
            }
            var input = new N.NewTaskInput(title, null, t.PageId, null, false, t.Description.Length == 0 ? null : t.Description, t.Priority, t.DueDate, t.DueTime,
                t.Recurrence, null, assignee, teamId, tagIds);
            var made = await _session.CallAsync(c => c.CreateTaskWith(ws, input));
            if (ws == _wsId) { _tasks = _tasks.Where(x => x.Id != made.Id).Append(made).ToArray(); _tasksVersion++; Raise(); }
            return null;
        }
        catch (Exception e) { return ErrorText.Message(e); }
    }

    // ---- task sheet extras: the full task, teams, tags and your reminders (Apple's loadDetail, loadReminders) ----

    private readonly Dictionary<string, N.TaskDetail> _details = new();
    private readonly Dictionary<string, N.TaskReminder[]> _reminders = new();
    private N.TaskTeam[] _teams = Array.Empty<N.TaskTeam>();
    private N.TaskTag[] _tags = Array.Empty<N.TaskTag>();

    private static T? Try<T>(Func<T> f) where T : class { try { return f(); } catch (Exception) { return null; } }

    public async void LoadTaskExtras(string? taskId)
    {
        var ws = _wsId;
        if (ws is null) return;
        try
        {
            var r = await _session.CallAsync(c => (
                One: taskId is null ? null : Try(() => c.CachedTaskDetail(taskId)), All: taskId is null ? null : Try(() => c.TaskDetails(ws)),
                Teams: Try(() => c.Teams(ws)), Tags: Try(() => c.Tags(ws)), Rem: taskId is null ? null : Try(() => c.TaskReminders(taskId))));
            if (ws != _wsId || _disposed) return;
            if (r.One is not null && taskId is not null && !_details.ContainsKey(taskId)) _details[taskId] = r.One;
            if (r.All is not null) foreach (var d in r.All) _details[d.Id] = d;
            if (r.Teams is not null) _teams = r.Teams;
            if (r.Tags is not null) _tags = r.Tags;
            if (r.Rem is not null && taskId is not null) _reminders[taskId] = r.Rem;
            Raise();
        }
        catch (Exception) { }
    }

    public IReadOnlyList<TeamInfo> Teams()
    {
        var res = _teams.Select(t => new TeamInfo(t.Id, t.Name, TaskLogic.TeamLabel(t.Name, t.ParentId is { } p ? _teams.FirstOrDefault(x => x.Id == p)?.Name : null), t.Color, t.ParentId)).ToList();
        return TaskLogic.Order(res);
    }

    public IReadOnlyList<TagInfo> Tags() => _tags.OrderBy(t => t.Name, StringComparer.CurrentCultureIgnoreCase).Select(t => new TagInfo(t.Id, t.Name, t.Color)).ToList();

    public async Task<TagInfo?> CreateTag(string name)
    {
        var ws = _wsId;
        if (ws is null) return null;
        try
        {
            var t = await _session.CallAsync(c => c.CreateTag(ws, name, null));
            if (ws == _wsId && _tags.All(x => x.Id != t.Id)) { _tags = _tags.Append(t).ToArray(); Raise(); }
            return new TagInfo(t.Id, t.Name, t.Color);
        }
        catch (Exception) { return null; }
    }

    public IReadOnlyList<ReminderInfo> Reminders(string taskId)
    {
        if (!_reminders.TryGetValue(taskId, out var list)) return Array.Empty<ReminderInfo>();
        var t = _tasks.FirstOrDefault(x => x.Id == taskId);
        return list.Select(r =>
        {
            var before = r.Spec as N.ReminderSpec.Before;
            var text = TaskLogic.ReminderText(before?.Minutes, (r.Spec as N.ReminderSpec.At)?.AtValue);
            return new ReminderInfo(r.Id, text, TaskLogic.ReminderNote(r.NextFireAt is not null, r.LastFiredAt is not null, t?.Done ?? false, before is not null, t?.DueDate is not null));
        }).ToList();
    }

    public async Task<string?> AddReminder(string taskId, ReminderInput input)
    {
        N.ReminderSpec spec = input.BeforeMinutes is { } m ? new N.ReminderSpec.Before(m) : new N.ReminderSpec.At(input.At ?? "");
        try
        {
            var r = await _session.CallAsync(c => c.AddReminder(taskId, spec));
            _reminders[taskId] = (_reminders.TryGetValue(taskId, out var cur) ? cur : Array.Empty<N.TaskReminder>()).Append(r).ToArray();
            Raise();
            return null;
        }
        catch (Exception e) { return ErrorText.Message(e); }
    }

    public async Task<string?> DeleteReminder(string taskId, string reminderId)
    {
        var before = _reminders.TryGetValue(taskId, out var cur) ? cur : Array.Empty<N.TaskReminder>();
        _reminders[taskId] = before.Where(r => r.Id != reminderId).ToArray();
        Raise();
        try { await _session.CallAsync(c => { c.DeleteReminder(reminderId); return 0; }); return null; }
        catch (Exception e) { _reminders[taskId] = before; Raise(); return ErrorText.Message(e); }
    }

    public async Task<string?> AddSubtask(string parentId, string title)
    {
        var ws = _wsId;
        var parent = _tasks.FirstOrDefault(t => t.Id == parentId);
        title = title.Trim();
        if (ws is null || parent is null || title.Length == 0) return null;
        try
        {
            var made = await _session.CallAsync(c => c.CreateTaskWith(ws, new N.NewTaskInput(title, null, parent.PageId, parentId, false)));
            if (ws == _wsId) { _tasks = _tasks.Where(t => t.Id != made.Id).Append(made).ToArray(); _tasksVersion++; Raise(); }
            return null;
        }
        catch (Exception e) { return ErrorText.Message(e); }
    }

    public IReadOnlyList<TaskItem> PageTasks(string pageId)
    {
        var today = Today();
        return _tasks.Where(t => t.PageId == pageId && !t.Locked)
            .OrderBy(t => t.DueDate is null ? 1 : 0).ThenBy(t => t.DueDate, StringComparer.Ordinal).ThenBy(t => t.Priority)
            .Select(t => ToItem(t, today)).ToList();
    }

    public IReadOnlyList<CalendarTask> CalendarTasks(bool everyone) =>
        (everyone ? Visible() : Mine()).Select(t => new CalendarTask(t.DueDate, ToItem(t, Today()), t.DueTime)).ToList();

    public IReadOnlyList<CalendarTask> CalendarTasks() =>
        Mine().Where(t => !t.Done).Select(t => new CalendarTask(t.DueDate, ToItem(t, Today()), t.DueTime)).ToList();

    public async void DeleteTask(string id)
    {
        try
        {
            await _session.CallAsync(c => { c.DeleteTask(id); return 0; });
            _tasks = _tasks.Where(t => t.Id != id).ToArray(); _tasksVersion++;
            Raise();
        }
        catch (Exception) { }
    }

    public NotePage? GetPage(string pageId)
    {
        var meta = _tree?.Pages.FirstOrDefault(p => p.Id == pageId);
        var live = pageId == _openId;
        var boxes = live && _info is not null ? BoxesOf(_info) : Array.Empty<CanvasBox>();
        var settings = live ? _info?.Settings : null;
        if (meta is null)
        {
            // a page someone shared with you, from another workspace (or one not in this tree): its words come from the shared list
            if (_shared.FirstOrDefault(s => s.Id == pageId) is not { } sh) return null;
            return new NotePage(pageId, sh.Title.Length == 0 ? "Untitled" : sh.Title, sh.SharedBy is null ? "Shared with you" : "Shared by " + sh.SharedBy, sh.WorkspaceName, "#6366f1", Array.Empty<string>(),
                ParseColour(settings?.Color), ParseRules(settings?.Rules), boxes, 0, OpenCommentCount(pageId), live ? _state : PageState.Connecting, live ? _stateMessage : null,
                false, sh.Icon, sh.CanEdit);
        }
        var sec = _tree!.Sections.FirstOrDefault(s => s.Id == meta.SectionId);
        var path = new List<string>();
        for (var cur = sec; cur is not null;) { path.Insert(0, cur.Name); cur = cur.ParentId is { } p ? _tree.Sections.FirstOrDefault(s => s.Id == p) : null; }
        var nb = sec is null ? null : _tree.Notebooks.FirstOrDefault(n => n.Id == sec.NotebookId);
        return new NotePage(
            pageId, meta.Title.Length == 0 ? "Untitled" : meta.Title, "Edited " + Ago(meta.UpdatedAt), nb?.Name ?? "", nb?.Color ?? "#6366f1", path,
            ParseColour(settings?.Color), ParseRules(settings?.Rules), boxes, _tasks.Count(t => !t.Done && t.PageId == pageId), OpenCommentCount(pageId),
            live ? _state : PageState.Connecting, live ? _stateMessage : null, meta.Locked, meta.Icon is { Length: > 0 } icon ? icon : null, WorkspaceRole != "viewer");
    }

    private static PageColour ParseColour(string? c) => Enum.TryParse<PageColour>(c, true, out var v) ? v : PageColour.None;
    private static RuleLines ParseRules(string? r) => Enum.TryParse<RuleLines>(r, true, out var v) ? v : RuleLines.None;

    private IReadOnlyList<CanvasBox> BoxesOf(N.PageInfo info)
    {
        var mapper = new ContentMapper(TaskLine, PageTitle);
        // A document page is one wide box at the origin (as the web app shows an old single-column page).
        var boxes = info.Kind == N.PageKind.Canvas
            ? info.Boxes
            : new[] { new N.PageBox("default", 0, 0, 686, 0, true) };
        return boxes.Select(b =>
        {
            var content = info.Kind == N.PageKind.Canvas ? info.Content.FirstOrDefault(c => c.BoxId == b.Id) : info.Content.FirstOrDefault(c => c.BoxId is null);
            return new CanvasBox(b.X, b.Y, b.W, b.Wide, mapper.Blocks(content?.Nodes ?? Array.Empty<N.ContentNode>()), info.Kind == N.PageKind.Canvas ? "box:" + b.Id : "default",
                info.Kind == N.PageKind.Canvas ? b.Id : null, b.Z);
        }).ToList();
    }

    // ---- tasks ------------------------------------------------------------------------------------------------

    private TaskItem? TaskLine(string id)
    {
        var t = _tasks.FirstOrDefault(x => x.Id == id);
        return t is null || t.Locked ? null : ToItem(t, Today());
    }

    private static DateOnly Today() => DateOnly.FromDateTime(DateTime.Now);

    private static DateOnly? Due(N.Task t) => t.DueDate is { } d && DateOnly.TryParseExact(d, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var v) ? v : null;

    private TaskItem ToItem(N.Task t, DateOnly today)
    {
        var due = Due(t);
        var (label, tone) = DueText(due, today);
        var page = t.PageId is null ? null : _tree?.Pages.FirstOrDefault(p => p.Id == t.PageId)?.Title;
        return new TaskItem(t.Id, t.Title, t.Done, t.Priority, label, tone, false, string.IsNullOrEmpty(page) ? null : page, null,
            t.AssigneeId == _user.Id ? Workspace.UserInitials : null, Array.Empty<string>(), (int)(t.ChecklistDone ?? 0), (int)(t.ChecklistTotal ?? 0));
    }

    private static (string? Label, DueTone Tone) DueText(DateOnly? due, DateOnly today)
    {
        if (due is not { } d) return (null, DueTone.None);
        var diff = d.DayNumber - today.DayNumber;
        if (diff < 0) return (diff == -1 ? "Yesterday" : d.ToString("d MMM", CultureInfo.CurrentCulture), DueTone.Overdue);
        if (diff == 0) return ("Today", DueTone.Today);
        if (diff == 1) return ("Tomorrow", DueTone.Soon);
        if (diff < 7) return (d.ToString("ddd", CultureInfo.CurrentCulture), DueTone.Soon);
        return (d.ToString("d MMM", CultureInfo.CurrentCulture), DueTone.Later);
    }

    /// <summary>Top-level tasks this person can see.</summary>
    private IEnumerable<N.Task> Visible() => _tasks.Where(t => !t.Locked && t.ParentId is null);
    private IEnumerable<N.Task> Mine() => Visible().Where(t => t.AssigneeId == _user.Id);

    // ---- images and attachments: the core's upload_file / file_url / download_file (online only; each runs on the core's call queue, off the UI thread) ----

    public bool CanUpload(string pageId) => _wsId is not null && LivePageOf(pageId) is not null;

    public async Task<MediaResult<UploadedMedia>> UploadFile(string pageId, string name, byte[] data)
    {
        if (_wsId is not { } ws) return MediaResult<UploadedMedia>.Fail("Open a workspace first.");
        try
        {
            var up = await _session.CallAsync(c => c.UploadFile(ws, pageId, name, data));
            return new MediaResult<UploadedMedia>(new UploadedMedia(up.Url, up.Name, up.Mime, (long)up.Size));
        }
        catch (OperationCanceledException) { return MediaResult<UploadedMedia>.Fail("You were signed out. Sign in again."); }
        catch (Exception e) { return MediaResult<UploadedMedia>.Fail(ErrorText.Media(e, name)); }
    }

    public async Task<string?> FileUrl(string stored)
    {
        try { return await _session.CallAsync(c => c.FileUrl(stored)); }
        catch { return null; }
    }

    public async Task<MediaResult<MediaBytes>> DownloadFile(string stored)
    {
        try
        {
            var f = await _session.CallAsync(c => c.DownloadFile(stored));
            return new MediaResult<MediaBytes>(new MediaBytes(f.Bytes, f.Mime));
        }
        catch (OperationCanceledException) { return MediaResult<MediaBytes>.Fail("You were signed out. Sign in again."); }
        catch (Exception e) { return MediaResult<MediaBytes>.Fail(ErrorText.Media(e, Path.GetFileName(stored))); }
    }

    public TaskCounts GetTaskCounts()
    {
        var today = Today();
        var open = Mine().Where(t => !t.Done).ToList();
        var todayList = open.Where(t => Due(t) is { } d && d <= today).ToList();
        var week = today.AddDays(7);
        return new TaskCounts(todayList.Count, todayList.Any(t => Due(t)! < today), open.Count,
            open.Count(t => Due(t) is { } d && d > today && d <= week));
    }

    public TodayStats GetTodayStats()
    {
        var today = Today();
        var mine = Mine().ToList();
        DateOnly? Completed(N.Task t) => t.CompletedAt is { } c && DateTimeOffset.TryParse(c, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var o) ? DateOnly.FromDateTime(o.LocalDateTime) : null;
        var days = mine.Where(t => t.Done).Select(Completed).Where(d => d is not null).Select(d => d!.Value).ToHashSet();
        var done = mine.Count(t => t.Done && Completed(t) == today);
        var left = mine.Count(t => !t.Done && Due(t) is { } d && d <= today);
        var streak = 0;
        for (var d = days.Contains(today) ? today : today.AddDays(-1); days.Contains(d); d = d.AddDays(-1)) streak++;
        var week = Enumerable.Range(0, 7).Select(i => days.Contains(today.AddDays(i - 6))).ToList();
        return new TodayStats(done, left, streak, week, done + left == 0 ? 0 : (double)done / (done + left));
    }

    public string TasksSubtitle(TaskViewKind view) => view switch
    {
        TaskViewKind.Today => "Due today and overdue, assigned to you.",
        TaskViewKind.MyTasks => "Everything assigned to you.",
        TaskViewKind.Upcoming => "The next seven days.",
        TaskViewKind.All => "Every task in this workspace.",
        _ => "Tasks assigned to your teams.",
    };

    public IReadOnlyList<TaskGroup> GetTaskGroups(TaskViewKind view)
    {
        var today = Today();
        var groups = new List<TaskGroup>();
        void Add(string title, bool overdue, IEnumerable<N.Task> tasks)
        {
            var items = tasks.OrderBy(t => t.DueTime ?? "99").ThenByDescending(t => t.Priority).ThenBy(t => t.CreatedAt, StringComparer.Ordinal).Select(t => ToItem(t, today)).ToList();
            if (items.Count > 0) groups.Add(new TaskGroup(title, items.Count, overdue, items));
        }
        string Day(DateOnly d) => d.ToString("ddd d MMM", CultureInfo.CurrentCulture);
        switch (view)
        {
            case TaskViewKind.Today:
            {
                var open = Mine().Where(t => !t.Done).ToList();
                Add("Overdue", true, open.Where(t => Due(t) is { } d && d < today));
                Add("Today · " + Day(today), false, open.Where(t => Due(t) == today));
                break;
            }
            case TaskViewKind.Upcoming:
            {
                var week = today.AddDays(7);
                var open = Mine().Where(t => !t.Done && Due(t) is { } d && d > today && d <= week).ToList();
                foreach (var g in open.GroupBy(t => Due(t)!.Value).OrderBy(g => g.Key))
                    Add(g.Key.ToString("dddd d MMM", CultureInfo.CurrentCulture), false, g);
                break;
            }
            case TaskViewKind.Team:
                break;
            default:
            {
                var all = view == TaskViewKind.MyTasks ? Mine() : Visible();
                var open = all.Where(t => !t.Done).ToList();
                Add("Overdue", true, open.Where(t => Due(t) is { } d && d < today));
                Add("Today · " + Day(today), false, open.Where(t => Due(t) == today));
                Add("Later", false, open.Where(t => Due(t) is { } d && d > today));
                Add("No date", false, open.Where(t => Due(t) is null));
                if (view == TaskViewKind.All) Add("Done", false, all.Where(t => t.Done).OrderByDescending(t => t.CompletedAt, StringComparer.Ordinal).Take(20));
                break;
            }
        }
        return groups;
    }

    // ---- parity B: tree actions, Trash, search, task detail -----------------------------------------------------------

    public bool CanEditTree => _tree is not null && !_disposed;
    private long _tasksVersion;
    public long TasksVersion => _tasksVersion;

    // ---- account: online only; offline (Network) answers Offline and changes nothing ----

    private async Task<AccountResult<T>> Account<T>(Func<N.Core, T> call)
    {
        try { return new AccountResult<T>(await _session.CallAsync(call)); }
        catch (OperationCanceledException) { return new AccountResult<T>(Error: "Cancelled."); }
        catch (N.CoreException.Network) { return AccountResult<T>.Off(); }
        catch (N.CoreException.Server s) { return new AccountResult<T>(Error: ErrorText.Message(s), Code: s.code); }
        catch (Exception e) { return new AccountResult<T>(Error: ErrorText.Message(e)); }
    }

    private static AccountProfile Map(N.User u) => new(u.Name, u.Email, u.Color);
    private static NotificationPrefs Map(N.NotificationSettings n) => new(n.TimeZone, n.EmailEnabled, n.DefaultReminderTime, n.DigestEnabled, n.DigestTime);

    public async Task<AccountResult<AccountProfile>> LoadProfile() => Shown(await Account(c => Map(c.Profile())));

    public async Task<AccountResult<AccountProfile>> UpdateProfile(string? name, string? color) => Shown(await Account(c => Map(c.UpdateProfile(name, color))));

    /// <summary>The name the tree and rail show follows a saved profile.</summary>
    private AccountResult<AccountProfile> Shown(AccountResult<AccountProfile> r)
    {
        if (r is { Ok: true, Value: { } p } && !_disposed)
        {
            Workspace = Workspace with { UserInitials = Initials(p.Name, p.Email), UserName = p.Name, UserEmail = p.Email };
            Raise();
        }
        return r;
    }

    public async Task<AccountResult<bool>> ChangePassword(string current, string next)
    {
        var r = await Account(c => c.ChangePassword(current, next));
        if (r.Value is { } signedIn)
        {
            // the old refresh token no longer works: keep the new one now (CallAsync only stores what the core reports later)
            _session.KeepToken(signedIn.RefreshToken);
            return new AccountResult<bool>(true);
        }
        return r.Code == "wrong_password" ? new AccountResult<bool>(Error: "That is not your current password.", Code: r.Code) : new AccountResult<bool>(false, r.Error, r.Offline, r.Code);
    }

    public async Task<AccountResult<NotificationPrefs>> LoadNotifications() => await Account(c => Map(c.NotificationSettings()));

    public async Task<AccountResult<NotificationPrefs>> UpdateNotifications(NotificationChange ch) =>
        await Account(c => Map(c.UpdateNotificationSettings(new N.NotificationSettingsChange(ch.TimeZone, ch.EmailEnabled, ch.DefaultReminderTime, ch.DigestEnabled, ch.DigestTime))));

    public async Task<AccountResult<IReadOnlyList<ConnectedAppInfo>>> LoadConnectedApps() =>
        await Account<IReadOnlyList<ConnectedAppInfo>>(c => c.ConnectedApps().Select(a =>
            new ConnectedAppInfo(a.ClientId, a.Name, AccountRules.AccessLabel(a.Scopes), a.ConnectedAt, a.LastUsedAt)).ToList());

    public async Task<AccountResult<bool>> DisconnectApp(string clientId) => await Account(c => { c.DisconnectApp(clientId); return true; });

    /// <summary>One tree call on the core thread, then the tree again (Apple's changeTree): the views show the result when <see cref="Changed"/> fires.</summary>
    private async Task<TreeResult> Change(Func<N.Core, (string? Id, string? Note)> call)
    {
        var ws = _wsId;
        if (ws is null) return new TreeResult(Error: "No workspace is open.");
        try
        {
            var (r, tree) = await _session.CallAsync(c => { var x = call(c); return (x, c.Tree(ws)); });
            _netDown = false;
            if (ws == _wsId) { _tree = tree; Rebuild(); Raise(); }
            return new TreeResult(r.Id, null, r.Note);
        }
        catch (OperationCanceledException) { return new TreeResult(Error: "Cancelled."); }
        catch (Exception e) { NoteNetwork(e); return new TreeResult(Error: ErrorText.Message(e)); }
    }

    public async Task<TreeResult> CreateNotebook(string name)
    {
        var r = await Change(c => (c.CreateNotebook(_wsId!, name).Id, null));
        if (r.Ok && r.Id is not null && _notebooks.Any(n => n.Id == r.Id)) { _notebookId = r.Id; Raise(); }
        return r;
    }

    public Task<TreeResult> CreateSection(string notebookId, string? parentId, string name) => Change(c => (c.CreateSection(notebookId, name, parentId), null));
    public Task<TreeResult> CreatePage(string sectionId, string title) => Change(c => (c.CreatePage(sectionId, title), null));

    public Task<TreeResult> Rename(TreeKind kind, string id, string name) => Change(c =>
    {
        switch (kind)
        {
            case TreeKind.Notebook: c.RenameNotebook(id, name); break;
            case TreeKind.Section: c.RenameSection(id, name); break;
            default: c.RenamePage(id, name); break;
        }
        return (null, null);
    });

    public Task<TreeResult> Duplicate(TreeKind kind, string id) => Change(c => (kind == TreeKind.Section ? c.CopySection(id) : c.CopyPage(id), null));

    public Task<TreeResult> Move(TreeKind kind, string id, string notebookId, string? sectionId) => Change(c =>
    {
        if (kind == TreeKind.Page) { if (sectionId is not null) c.MovePage(id, sectionId); }
        else if (kind == TreeKind.Section) c.MoveSection(id, notebookId, sectionId);
        return (null, null);
    });

    public Task<TreeResult> Delete(TreeKind kind, string id)
    {
        if (kind == TreeKind.Page && _openId == id) OpenPage(null);
        return Change(c =>
        {
            switch (kind)
            {
                case TreeKind.Notebook: c.DeleteNotebook(id); break;
                case TreeKind.Section: c.DeleteSection(id); break;
                default: c.DeletePage(id); break;
            }
            return (null, null);
        });
    }

    private static N.TrashKind KindOf(TreeKind k) => k switch { TreeKind.Notebook => N.TrashKind.Notebook, TreeKind.Section => N.TrashKind.Section, _ => N.TrashKind.Page };

    public async Task<TrashList> LoadTrash()
    {
        var ws = _wsId;
        if (ws is null) return new TrashList(Array.Empty<TrashItem>(), "No workspace is open.");
        try
        {
            var list = await _session.CallAsync(c => c.Trash(ws));
            return new TrashList(list.Select(e => new TrashItem(
                e.Kind == N.TrashKind.Notebook ? TreeKind.Notebook : e.Kind == N.TrashKind.Section ? TreeKind.Section : TreeKind.Page,
                e.Id, e.Name.Length == 0 ? "Untitled" : e.Name, e.Path, e.DeletedByName ?? "", (int)e.DaysLeft, e.Icon)).ToList());
        }
        catch (Exception e) { return new TrashList(Array.Empty<TrashItem>(), ErrorText.Message(e)); }
    }

    public Task<TreeResult> Restore(TrashItem item) => Change(c => (null, c.RestoreFromTrash(_wsId!, KindOf(item.Kind), item.Id) is { } place ? "Restored to " + place : "Restored"));
    public Task<TreeResult> DeleteForever(TrashItem item) => Change(c => { c.DeleteForever(_wsId!, KindOf(item.Kind), item.Id); return (null, null); });
    public Task<TreeResult> EmptyTrash() => Change(c => { c.EmptyTrash(_wsId!); return (null, null); });

    public async Task<SearchOutcome?> SearchAsync(string query)
    {
        var ws = _wsId;
        if (ws is null || string.IsNullOrWhiteSpace(query)) return null;
        try
        {
            var r = await _session.CallAsync(c => c.Search(ws, query.Trim(), null));
            var today = Today();
            return new SearchOutcome(
                r.Pages.Select(h => new SearchPageHit(h.PageId, h.Title.Length == 0 ? "Untitled" : h.Title, h.Path, h.Snippet.Select(s => (s.Text, s.Matched)).ToList())).ToList(),
                r.Tasks.Select(h =>
                {
                    var due = h.Task.DueDate is { } d && DateOnly.TryParseExact(d, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var v) ? v : (DateOnly?)null;
                    var (label, tone) = DueText(due, today);
                    return new SearchTaskHit(h.Task.Id, h.Task.Title.Length == 0 ? "Untitled task" : h.Task.Title, label, tone, h.Task.Done);
                }).ToList());
        }
        catch (Exception) { return null; }
    }

    private string? NameOf(string? userId)
    {
        if (userId is null) return null;
        if (userId == _user.Id) return string.IsNullOrEmpty(_user.Name) ? "You" : _user.Name;
        return _members.FirstOrDefault(m => m.Id == userId) is { } m ? (m.Name.Length > 0 ? m.Name : m.Email) : null;
    }

    public TaskDetailItem? GetTaskDetail(string id)
    {
        var t = _tasks.FirstOrDefault(x => x.Id == id);
        if (t is null || t.Locked) return null;
        var (label, tone) = DueText(Due(t), Today());
        var page = t.PageId is null ? null : _tree?.Pages.FirstOrDefault(p => p.Id == t.PageId)?.Title;
        _details.TryGetValue(id, out var full);
        var subs = _tasks.Where(x => x.ParentId == id && !x.Locked).Select(x => new SubtaskInfo(x.Id, x.Title, x.Done, x.Priority)).ToList();
        var parent = t.ParentId is null ? null : _tasks.FirstOrDefault(x => x.Id == t.ParentId)?.Title;
        var role = Workspaces.FirstOrDefault(w => w.Id == _wsId)?.Role;
        return new TaskDetailItem(t.Id, t.Title, t.Description, t.Done, t.Priority, t.DueDate, label, tone, t.AssigneeId, NameOf(t.AssigneeId),
            t.PageId, t.PageId is null ? null : (string.IsNullOrEmpty(page) ? "Untitled" : page), "Created by " + (NameOf(full?.CreatedBy ?? _user.Id) ?? "a former member") + " Â· " + Ago(t.CreatedAt),
            t.DueTime, full?.TeamId, t.TagIds, full?.Recurrence, full?.Recurrence is { } rule ? TaskLogic.Describe(rule, t.DueDate) : null,
            t.ParentId, t.ParentId is null ? null : (string.IsNullOrEmpty(parent) ? "a task" : parent), subs,
            full?.AssignedBy is { } by && by != t.AssigneeId ? NameOf(by) ?? "a former member" : null, role != "viewer");
    }

    public async void UpdateTask(string id, TaskPatch p)
    {
        var i = Array.FindIndex(_tasks, t => t.Id == id);
        if (i < 0) return;
        var ws = _wsId;
        var old = _tasks[i];
        var now = old with
        {
            Title = p.Title ?? old.Title, Description = p.Description ?? old.Description, Done = p.Done ?? old.Done,
            Priority = p.Priority is { } pr ? (byte)pr : old.Priority,
            DueDate = p.ClearDue ? null : p.DueDate ?? old.DueDate, DueTime = p.ClearDue || p.ClearDueTime ? null : p.DueTime ?? old.DueTime,
            TagIds = p.TagIds ?? old.TagIds,
            AssigneeId = p.ClearAssignee ? null : p.AssigneeId ?? old.AssigneeId,
            CompletedAt = p.Done is true ? DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) : p.Done is false ? null : old.CompletedAt,
        };
        var copy = (N.Task[])_tasks.Clone();
        copy[i] = now;
        _tasks = copy; _tasksVersion++;
        if (_details.TryGetValue(id, out var det))
            _details[id] = det with
            {
                TeamId = p.ClearTeam ? null : p.TeamId ?? det.TeamId, Recurrence = p.ClearRecurrence ? null : p.Recurrence ?? det.Recurrence,
                DueDate = now.DueDate, DueTime = now.DueTime,
            };
        Raise();
        var changes = new N.TaskChanges(
            Title: p.Title, Description: p.Description, Done: p.Done, Priority: p.Priority is { } q ? (byte)q : null,
            DueDate: p.DueDate, ClearDueDate: p.ClearDue, DueTime: p.DueTime, ClearDueTime: p.ClearDueTime, AssigneeId: p.AssigneeId, ClearAssignee: p.ClearAssignee,
            TeamId: p.TeamId, ClearTeam: p.ClearTeam, TagIds: p.TagIds, Recurrence: p.Recurrence, ClearRecurrence: p.ClearRecurrence);
        try
        {
            var d = await _session.CallAsync(c => c.UpdateTask(id, changes));
            if (ws != _wsId) return;
            _details[id] = d;
            var j = Array.FindIndex(_tasks, t => t.Id == id);
            if (j < 0) return;
            var merged = (N.Task[])_tasks.Clone();
            merged[j] = merged[j] with
            {
                Title = d.Title, Description = d.Description, Done = d.Done, Priority = d.Priority, DueDate = d.DueDate, DueTime = d.DueTime,
                AssigneeId = d.AssigneeId, CompletedAt = d.CompletedAt, UpdatedAt = d.UpdatedAt, TagIds = d.TagIds,
            };
            _tasks = merged; _tasksVersion++;
            Raise();
        }
        catch (OperationCanceledException) { }
        catch (Exception)
        {
            // refused or offline beyond what the core queues: show the list as the server has it
            try
            {
                var fresh = await _session.CallAsync(c => c.Tasks(ws!));
                if (ws == _wsId) { _tasks = fresh; _tasksVersion++; Raise(); }
            }
            catch (Exception) { }
        }
    }

    public void Dispose()
    {
        _disposed = true;
        CloseLive();
    }
}
