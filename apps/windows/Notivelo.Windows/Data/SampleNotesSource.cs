namespace Notivelo.Windows.Data;

/// <summary>In-memory sample data that mirrors the reference captures (docs/rewrite/look/reference).</summary>
public sealed partial class SampleNotesSource : INotesSource
{
    public event EventHandler? Changed;

    public Workspace Workspace { get; private set; } = new("Workspace", "D", "DU", "Demo User", "demo@example.com");
    public IReadOnlyList<WorkspaceInfo> Workspaces { get; } = new WorkspaceInfo[] { new("sample", "Workspace", "owner") };
    public string? CurrentWorkspaceId => "sample";
    public void SelectWorkspace(string id) { }
    private string? _nb;
    public string? CurrentNotebookId => Notebooks.Any(n => n.Id == _nb) ? _nb : Notebooks.Count > 0 ? Notebooks[0].Id : null;
    public void SelectNotebook(string id) { _nb = id; Changed?.Invoke(this, EventArgs.Empty); }
    public bool Loading => false;
    public string? LoadError => null;
    public void OpenPage(string? pageId) { }
    public IReadOnlyList<(PageSummary Page, string Where, string Edited)> RecentPages(int count) =>
        Notebooks.SelectMany(n => n.Sections.SelectMany(s => s.Pages.Select(p => (p, $"{n.Name} · {s.Name}", "2h ago")))).Take(count).ToList();

    public IReadOnlyList<Notebook> Notebooks { get; private set; }

    public string? InitialPageId => Offline ? "uitest" : Environment.GetEnvironmentVariable("NOTIVELO_SAMPLE_PAGE") is { Length: > 0 } p && _pages.ContainsKey(p) ? p : "canvas";

    private readonly Dictionary<string, NotePage> _pages = new();
    private readonly Dictionary<TaskViewKind, IReadOnlyList<TaskGroup>> _groups;

    /// <summary>Offline test mode (NOTIVELO_SOURCE=offline): a fixed page "uitest" with two editable boxes, each an editor session over a
    /// local document; tasks made from box lines are kept here (and logged to NOTIVELO_OFFLINE_LOG). Never used in normal startup.</summary>
    public bool Offline { get; }
    public bool OffersOfflineBoxes => Offline;
    private readonly Dictionary<string, TaskItem> _made = new();

    public Notivelo.Native.EditorSession? OpenOfflineBox(string pageId, string field, Notivelo.Native.TaskCallbacks tasks)
    {
        if (!Offline) return null;
        // [0, 0] is the empty Yjs update; the "default" field needs no box record in the document
        var s = Notivelo.Native.EditorSession.Open(new byte[] { 0, 0 }, "default", tasks);
        if (field == "box:b") s.InsertText("Second box");
        return s;
    }

    private void Log(string line)
    {
        try { if (Environment.GetEnvironmentVariable("NOTIVELO_OFFLINE_LOG") is { Length: > 0 } f) File.AppendAllText(f, line + Environment.NewLine); } catch { }
    }

    public SampleNotesSource(bool offline = false)
    {
        Offline = offline;
        var corpus = new Section("corpus", "Corpus", "#ec4899", new PageSummary[]
        {
            new("canvas", "Canvas", 1), new("sandbox", "Sandbox", 1), new("blocks", "Blocks", 0), new("lists", "Lists", 0),
            new("tasks", "Tasks", 2), new("settings-ink", "Settings and ink", 0), new("document", "Document page", 0),
            new("geometry", "Geometry", 0), new("converted", "Converted", 0),
        }, Array.Empty<Section>());
        var empty = new Section("empty", "Empty section", "#14b8a6", Array.Empty<PageSummary>(), Array.Empty<Section>());
        Notebooks = new[] { new Notebook("look", "Look reference", "L", "#ec4899", false, new[] { corpus, empty }) };

        var launch = Task("t-launch", "Review the launch checklist", 1, "Yesterday", DueTone.Overdue, null, "Staff");
        var welcome = Task("t-welcome", "Try checking off this task — it also completes on the Tasks dashboard", 2, "Today", DueTone.Today, "Welcome \U0001F44B", null);
        var notes = Task("t-notes", "Send the meeting notes to the team", 2, "Today", DueTone.Today, "Weekly sync · Saturday 21 November", null);

        _pages["canvas"] = new NotePage("canvas", "Canvas", "Edited 10m ago by you", "Look reference", "#ec4899", new[] { "Corpus" },
            PageColour.None, RuleLines.None, new CanvasBox[]
            {
                new(20, 306, 240, false, new BoxBlock[] { new(BlockKind.Paragraph, "Same place as a, id breaks the tie") }),
                new(20, 337, 240, false, new BoxBlock[] { new(BlockKind.Heading1, "Left lower") }),
                new(20, 371, 280, false, new BoxBlock[] { new(BlockKind.Task, "", new TaskItem("t-box", "", false, 0, null, DueTone.None, false, null, null, "DU", Array.Empty<string>(), 0, 0)) }),
                new(20, 381, 240, false, new BoxBlock[] { new(BlockKind.Paragraph, "Box a") }),
                new(500, 330, 260, false, new BoxBlock[] { new(BlockKind.Heading2, "Right lower"), new(BlockKind.Paragraph, "Box c") }),
            }, 1, 0);

        if (offline)
            _pages["uitest"] = new NotePage("uitest", "UI test", "Edited just now", "Look reference", "#ec4899", new[] { "Corpus" },
                PageColour.None, RuleLines.None, new CanvasBox[]
                {
                    new(40, 40, 420, false, new BoxBlock[] { new(BlockKind.Paragraph, "") }, "box:a", "a", 0),
                    new(40, 220, 420, false, new BoxBlock[] { new(BlockKind.Paragraph, "Second box") }, "box:b", "b", 1),
                }, 0, 0);

        foreach (var s in corpus.Pages.Skip(1))
            _pages[s.Id] = new NotePage(s.Id, s.Title, "Edited 2h ago by you", "Look reference", "#ec4899", new[] { "Corpus" },
                PageColour.None, RuleLines.None, new CanvasBox[]
                {
                    new(20, 20, 560, true, new BoxBlock[]
                    {
                        new(BlockKind.Heading1, s.Title),
                        new(BlockKind.Paragraph, "Sample text in a canvas box. The real box text view arrives with the editor session."),
                    }),
                }, s.OpenTasks, 0);

        SeedShared();
        // the reference "Settings and ink" page has a blue page colour and a grid (LOOK 1.3)
        _pages["settings-ink"] = _pages["settings-ink"] with { Colour = PageColour.Blue, Rules = RuleLines.Grid };

        _groups = new Dictionary<TaskViewKind, IReadOnlyList<TaskGroup>>
        {
            [TaskViewKind.Today] = new TaskGroup[]
            {
                new("Overdue", 1, true, new[] { launch }),
                new("Today · Sat 21 Nov", 2, false, new[] { welcome, notes }),
            },
            [TaskViewKind.MyTasks] = new TaskGroup[]
            {
                new("Overdue", 1, true, new[] { launch }),
                new("Today · Sat 21 Nov", 2, false, new[] { welcome, notes }),
                new("Later", 2, false, new[]
                {
                    Task("t-plan", "Draft the Q4 roadmap", 3, "30 Nov", DueTone.Later, "Q4 roadmap", null),
                    Task("t-slow", "Look into slow search", 0, "Mon", DueTone.Soon, "Weekly sync", "Staff", done: true),
                }),
            },
            [TaskViewKind.Upcoming] = new TaskGroup[]
            {
                new("Sunday 22 Nov", 1, false, new[] { Task("t-up1", "Plan the week", 0, "Tomorrow", DueTone.Soon, "Weekly sync", null) }),
                new("Monday 23 Nov", 1, false, new[] { Task("t-up2", "Look into slow search", 2, "Mon", DueTone.Soon, "Weekly sync", null) }),
            },
            [TaskViewKind.All] = new TaskGroup[]
            {
                new("Overdue", 1, true, new[] { launch }),
                new("Today · Sat 21 Nov", 2, false, new[] { welcome, notes }),
                new("No date", 1, false, new[] { Task("t-nodate", "Someday: tidy the sandbox", 0, null, DueTone.None, "Sandbox", null) }),
                new("Later", 1, false, new[] { Task("t-other", "Sam: book the offsite", 3, "Wed", DueTone.Soon, "Weekly sync", null, assignee: "SR") }),
            },
            [TaskViewKind.Team] = Array.Empty<TaskGroup>(),
        };
    }

    private static TaskItem Task(string id, string title, int priority, string? due, DueTone tone, string? page, string? team, bool done = false, string assignee = "DU")
        => new(id, title, done, priority, due, tone, false, page, team, assignee, Array.Empty<string>(), 0, 0);

    // ---- canvas boxes (offline test mode only): the page record is replaced with the boxes changed, as the core's page info would be ----
    private void EditBoxes(string pageId, Func<List<CanvasBox>, bool> edit)
    {
        if (!Offline || !_pages.TryGetValue(pageId, out var p)) return;
        var list = p.Boxes.ToList();
        if (!edit(list)) return;
        _pages[pageId] = p with { Boxes = list };
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private static void Replace(List<CanvasBox> l, string id, Func<CanvasBox, CanvasBox> f)
    {
        var i = l.FindIndex(b => b.Id == id);
        if (i >= 0) l[i] = f(l[i]);
    }

    public bool CanEditBoxes(string pageId) => Offline && pageId == "uitest";

    public string? CreateBox(string pageId, double x, double y, double w, double z)
    {
        if (!CanEditBoxes(pageId)) return null;
        var id = "n" + Guid.NewGuid().ToString("N")[..8];
        EditBoxes(pageId, l => { l.Add(new CanvasBox(Math.Round(x), Math.Round(y), Math.Clamp(Math.Round(w), 120, 2400), false, new BoxBlock[] { new(BlockKind.Paragraph, "") }, "box:" + id, id, z)); return true; });
        Log($"box create {id}");
        return id;
    }
    public void MoveBox(string pageId, string boxId, double x, double y) => EditBoxes(pageId, l => { Replace(l, boxId, b => b with { X = Math.Round(Math.Max(0, x)), Y = Math.Round(Math.Max(0, y)) }); return true; });
    public void ResizeBox(string pageId, string boxId, double w) => EditBoxes(pageId, l => { Replace(l, boxId, b => b with { Width = Math.Clamp(Math.Round(w), 120, 2400), Wide = false }); return true; });
    public void BringBoxToFront(string pageId, string boxId) => EditBoxes(pageId, l =>
    {
        var top = l.Where(b => b.Id != boxId).Select(b => b.Z).DefaultIfEmpty(-1).Max();
        Replace(l, boxId, b => b.Z > top ? b : b with { Z = top + 1 });
        return true;
    });
    public bool DeleteBox(string pageId, string boxId)
    {
        var gone = false;
        EditBoxes(pageId, l => { gone = l.RemoveAll(b => b.Id == boxId) > 0; return gone; });
        if (gone) Log($"box delete {boxId}");
        return gone;
    }

    /// <summary>The sample "Settings and ink" page shows a few strokes made with the core's stroke builder (screenshots).</summary>
    private IReadOnlyList<InkStroke>? _demoInk;

    private IReadOnlyList<InkStroke> DemoInk(string pageId)
    {
        if (pageId != "settings-ink") return Array.Empty<InkStroke>();
        if (_demoInk is not null) return _demoInk;
        InkStroke Make(string id, byte tool, uint color, float width, IEnumerable<(double X, double Y)> pts)
        {
            using var b = new Notivelo.Native.InkStrokeBuilder(tool, color, width, false, false);
            var samples = new List<double>();
            var i = 0;
            foreach (var p in pts) { samples.AddRange(new[] { p.X, p.Y, 0.5, 1.2, 0, i++ * 8.0 }); }
            b.PushMany(samples.ToArray());
            return Measured(new InkStroke(id, tool == 1, color, b.Preview(Array.Empty<float>()), 0, 0));
        }
        var wave = Enumerable.Range(0, 54).Select(i => (20.0 + i * 6, 130 + 28 * Math.Sin(i * 6 / 28.0)));
        var loop = Enumerable.Range(0, 43).Select(i => (420 + 40 * Math.Cos(i * 0.15), 150 + 40 * Math.Sin(i * 0.15)));
        try
        {
            return _demoInk = new[]
            {
                Make("h", 1, 0xFACC1559, 18, new[] { (0.0, 14.0), (60, 14), (130, 14) }),
                Make("w", 0, 0x1D4ED8FF, 4, wave),
                Make("l", 0, 0xDC2626FF, 2.5f, loop),
            };
        }
        catch (Exception) { return _demoInk = Array.Empty<InkStroke>(); }
    }

    public Notivelo.Native.LivePage? LivePageOf(string pageId) => null;
    public TaskItem? FindTask(string taskId) => _made.GetValueOrDefault(taskId);
    public string? PageTitleOf(string pageId) => _pages.GetValueOrDefault(pageId)?.Title;
    public string? UserId => Me;
    public void CreateTask(string id, string title, bool done, string? pageId)
    {
        if (!Offline) return;
        _made[id] = Task(id, title, 0, null, DueTone.None, pageId is null ? null : PageTitleOf(pageId), null, done);
        if (pageId is not null) OnPage(pageId).Add(id);
        Log($"create {id} {title}");
    }
    public void DeleteTask(string id) { if (Offline) { _made.Remove(id); Log($"delete {id}"); } }
    public IReadOnlyList<(string Id, string Title, string Crumb)> SearchPages(string query, int max) =>
        Notebooks.SelectMany(n => n.Sections.SelectMany(s => s.Pages.Select(p => (p.Id, p.Title, Crumb: n.Name + " \u203A " + s.Name))))
            .Where(p => query.Length == 0 || p.Title.Contains(query, StringComparison.OrdinalIgnoreCase)).Take(max).ToList();
    public IReadOnlyList<(string Id, string Label, string Detail, string? ColorHex)> People(string query) =>
        new (string, string, string, string?)[] { ("u1", "Demo User", "demo@example.com", "#6366f1"), ("u2", "Sam Rivera", "sam@example.com", "#14b8a6"), ("u3", "Priya Nair", "priya@example.com", "#ec4899") }
            .Where(p => query.Length == 0 || p.Item2.Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();
    public NotePage? GetPage(string pageId) => Overlay(_pages.GetValueOrDefault(pageId));

    public TaskCounts GetTaskCounts() => new(3, true, 15, 7);

    public TodayStats GetTodayStats() => new(1, 3, 1, new[] { false, false, false, false, false, false, true }, 0.25);

    public string TasksSubtitle(TaskViewKind view) => view switch
    {
        TaskViewKind.Today => "Due today and overdue, assigned to you.",
        TaskViewKind.MyTasks => "Everything assigned to you.",
        TaskViewKind.Upcoming => "The next seven days.",
        TaskViewKind.All => "Every task in this workspace.",
        _ => "Tasks assigned to your teams.",
    };

    public IReadOnlyList<TaskGroup> GetTaskGroups(TaskViewKind view) => _groups[view];
}
