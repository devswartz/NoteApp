namespace Notivelo.Windows.Data;

/// <summary>In-memory sample data that mirrors the reference captures (docs/rewrite/look/reference).</summary>
public sealed class SampleNotesSource : INotesSource
{
    public event EventHandler? Changed { add { } remove { } }

    public Workspace Workspace { get; } = new("Workspace", "D", "DU", "Devon", "devon@example.com");

    public IReadOnlyList<Notebook> Notebooks { get; }

    public string? InitialPageId => "canvas";

    private readonly Dictionary<string, NotePage> _pages = new();
    private readonly Dictionary<TaskViewKind, IReadOnlyList<TaskGroup>> _groups;

    public SampleNotesSource()
    {
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
            },
            [TaskViewKind.Team] = Array.Empty<TaskGroup>(),
        };
    }

    private static TaskItem Task(string id, string title, int priority, string? due, DueTone tone, string? page, string? team, bool done = false)
        => new(id, title, done, priority, due, tone, false, page, team, "DU", Array.Empty<string>(), 0, 0);

    public NotePage? GetPage(string pageId) => _pages.GetValueOrDefault(pageId);

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
