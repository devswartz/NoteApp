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
public sealed record InkStroke(string Id, bool Highlighter, uint Color, float[] Ops, float MaxX, float MaxY, float MinX = 0, float MinY = 0);

public enum BlockKind { Paragraph, Heading1, Heading2, Heading3, Task, ListItem, CheckItem, Quote, Code, Rule }

/// <summary>A run of text with its marks (read-only rich text from the core's box content).</summary>
public sealed record TextSpan(string Text, bool Bold = false, bool Italic = false, bool Underline = false, bool Strike = false,
    bool Code = false, string? Href = null, string? ColorHex = null, string? HighlightHex = null);

/// <summary>One block of a box. Spans (when set) carry the marks; Text is the plain text. Marker is a list bullet/number, Indent the list depth.</summary>
public sealed record BoxBlock(BlockKind Kind, string Text, TaskItem? Task = null, IReadOnlyList<TextSpan>? Spans = null,
    string? Marker = null, int Indent = 0, bool Checked = false);

public enum PageState { Live, Connecting, Offline, Ended, Locked }

public sealed record WorkspaceInfo(string Id, string Name, string Role);

public sealed record NotePage(
    string Id, string Title, string EditedLine, string NotebookName, string NotebookColorHex, IReadOnlyList<string> SectionPath,
    PageColour Colour, RuleLines Rules, IReadOnlyList<CanvasBox> Boxes, int OpenTasks, int Comments,
    PageState State = PageState.Live, string? StateMessage = null, bool Locked = false, string? Emoji = null, bool CanEdit = true);

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
    string? AssigneeId, string? AssigneeName, string? PageId, string? PageTitle, string CreatedLine,
    string? DueTime = null, string? TeamId = null, IReadOnlyList<string>? TagIds = null, Notivelo.Native.TaskRecurrence? Recurrence = null, string? RecurrenceText = null,
    string? ParentId = null, string? ParentTitle = null, IReadOnlyList<SubtaskInfo>? Subtasks = null, string? AssignedByName = null, bool Editable = true);

/// <summary>A subtask of the sheet's task (a task whose parent it is).</summary>
public sealed record SubtaskInfo(string Id, string Title, bool Done, int Priority);

/// <summary>A team of the workspace; Depth 1 is a subteam (<see cref="Label"/> is then "Parent › Child").</summary>
public sealed record TeamInfo(string Id, string Name, string Label, string Color, string? ParentId, int Depth = 0);

public sealed record TagInfo(string Id, string Name, string Color);

/// <summary>One of your reminders on a task: its words and, when it will not fire, why (sent / done / no due date).</summary>
public sealed record ReminderInfo(string Id, string Text, string? Note);

/// <summary>A reminder to add: this many minutes before the due time (<see cref="BeforeMinutes"/>), or at a fixed instant (<see cref="At"/>, ISO UTC).</summary>
public sealed record ReminderInput(uint? BeforeMinutes, string? At);

/// <summary>The Calendar's status select (Apple's Shell.CalendarStatus): the days show open tasks, completed ones, or both.</summary>
public enum CalendarStatus { Open, Completed, All }

/// <summary>Fields to change on a task (what the core's TaskChanges carries for the ones the sheet edits).</summary>
public sealed record TaskPatch(
    string? Title = null, string? Description = null, bool? Done = null, int? Priority = null,
    string? DueDate = null, bool ClearDue = false, string? AssigneeId = null, bool ClearAssignee = false,
    string? DueTime = null, bool ClearDueTime = false, string? TeamId = null, bool ClearTeam = false, string[]? TagIds = null,
    Notivelo.Native.TaskRecurrence? Recurrence = null, bool ClearRecurrence = false);

/// <summary>What quick add makes (Apple's SessionModel.NewTaskFields): the words the core's parse_quick_add read, plus the chips' overrides. The source resolves
/// <see cref="AssigneeMention"/> (@name) and <see cref="TeamText"/> (+team) and finds or makes the tags.</summary>
public sealed record NewTask(
    string Title, string Description, byte Priority, string? DueDate, string? DueTime, Notivelo.Native.TaskRecurrence? Recurrence,
    string? AssigneeMention, string? TeamText, IReadOnlyList<string> Tags, string? PageId, string? AssigneeId = null, string? TeamId = null);

/// <summary>An open task with a due date (yyyy-MM-dd) for the Calendar's month grid; a task without one is listed in its "No date" tray.</summary>
public sealed record CalendarTask(string? Due, TaskItem Task, string? DueTime = null);
