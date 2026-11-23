namespace Notivelo.Windows.Data;

// Plain view models for the shell. The Rust core's C# bindings will fill these later through INotesSource;
// nothing in the UI reads anything else.

public sealed record Workspace(string Name, string Initial, string UserInitials, string UserName, string UserEmail);

public sealed record Notebook(string Id, string Name, string Initial, string ColorHex, bool IsPrivate, IReadOnlyList<Section> Sections);

public sealed record Section(string Id, string Name, string ColorHex, IReadOnlyList<PageSummary> Pages, IReadOnlyList<Section> Children);

public sealed record PageSummary(string Id, string Title, int OpenTasks, string? Emoji = null, bool Locked = false);

public enum PageColour { None, Yellow, Green, Blue, Purple, Pink, Grey }

public enum RuleLines { None, Lines, Grid }

/// <summary>A text box on the canvas. X/Y are page points from the canvas surface origin.</summary>
public sealed record CanvasBox(double X, double Y, double Width, bool Wide, IReadOnlyList<BoxBlock> Blocks, string? Field = null, string? Id = null, double Z = 0);

/// <summary>One ink stroke of the page: the core's outline (path commands: 0 x y move, 1 x y line, 2 cx cy r circle, 3 close; fill nonzero), 0xRRGGBBAA colour.</summary>
public sealed record InkStroke(string Id, bool Highlighter, uint Color, float[] Ops, float MaxX, float MaxY);

public enum BlockKind { Paragraph, Heading1, Heading2, Heading3, Task, ListItem, CheckItem, Quote, Code, Rule }

/// <summary>A run of text with its marks (read-only rich text from the core's box content).</summary>
public sealed record TextSpan(string Text, bool Bold = false, bool Italic = false, bool Underline = false, bool Strike = false,
    bool Code = false, string? Href = null, string? ColorHex = null, string? HighlightHex = null);

/// <summary>One block of a box. Spans (when set) carry the marks; Text is the plain text. Marker is a list bullet/number, Indent the list depth.</summary>
public sealed record BoxBlock(BlockKind Kind, string Text, TaskItem? Task = null, IReadOnlyList<TextSpan>? Spans = null,
    string? Marker = null, int Indent = 0, bool Checked = false);

public enum PageState { Live, Connecting, Offline, Ended }

public sealed record WorkspaceInfo(string Id, string Name, string Role);

public sealed record NotePage(
    string Id, string Title, string EditedLine, string NotebookName, string NotebookColorHex, IReadOnlyList<string> SectionPath,
    PageColour Colour, RuleLines Rules, IReadOnlyList<CanvasBox> Boxes, int OpenTasks, int Comments,
    PageState State = PageState.Live, string? StateMessage = null, bool Locked = false);

public enum DueTone { None, Overdue, Today, Soon, Later }

public sealed record TaskItem(
    string Id, string Title, bool Done, int Priority, string? DueLabel, DueTone Tone, bool Recurring,
    string? PageTitle, string? Team, string? Assignee, IReadOnlyList<string> Tags, int ChecklistDone, int ChecklistTotal);

public sealed record TaskGroup(string Title, int Count, bool IsOverdue, IReadOnlyList<TaskItem> Tasks);

public enum TaskViewKind { Today, MyTasks, Upcoming, All, Team }

public sealed record TaskCounts(int Today, bool TodayOverdue, int MyTasks, int Upcoming);

public sealed record TodayStats(int DoneToday, int Left, int DayStreak, IReadOnlyList<bool> WeekDone, double Progress);

// ---- parity B: tree actions, Trash, search, task detail ----

public enum TreeKind { Notebook, Section, Page }

/// <summary>The outcome of a tree call: the new id (create), or an error sentence for the screen.</summary>
public sealed record TreeResult(string? Id = null, string? Error = null, string? Note = null)
{
    public bool Ok => Error is null;
}

/// <summary>One entry of the workspace Trash (a deleted page, section or notebook), kept 60 days.</summary>
public sealed record TrashItem(TreeKind Kind, string Id, string Name, string Path, string DeletedBy, int DaysLeft, string? Icon = null);

public sealed record TrashList(IReadOnlyList<TrashItem> Items, string? Error = null);

/// <summary>Search results (the core's content search): pages with a snippet (runs, Matched true where a term matched) and tasks.</summary>
public sealed record SearchPageHit(string PageId, string Title, string Path, IReadOnlyList<(string Text, bool Matched)> Snippet);
public sealed record SearchTaskHit(string TaskId, string Title, string? DueLabel, DueTone Tone, bool Done);
public sealed record SearchOutcome(IReadOnlyList<SearchPageHit> Pages, IReadOnlyList<SearchTaskHit> Tasks);

/// <summary>A task as the detail sheet shows it. Priority 1 urgent .. 4 none (0 = none too). DueDate is yyyy-MM-dd.</summary>
public sealed record TaskDetailItem(
    string Id, string Title, string Description, bool Done, int Priority, string? DueDate, string? DueLabel, DueTone Tone,
    string? AssigneeId, string? AssigneeName, string? PageId, string? PageTitle, string CreatedLine);

/// <summary>Fields to change on a task (what the core's TaskChanges carries for the ones the sheet edits).</summary>
public sealed record TaskPatch(
    string? Title = null, string? Description = null, bool? Done = null, int? Priority = null,
    string? DueDate = null, bool ClearDue = false, string? AssigneeId = null, bool ClearAssignee = false);
