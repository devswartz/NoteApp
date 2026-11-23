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
public sealed record CanvasBox(double X, double Y, double Width, bool Wide, IReadOnlyList<BoxBlock> Blocks);

public enum BlockKind { Paragraph, Heading1, Heading2, Heading3, Task }

public sealed record BoxBlock(BlockKind Kind, string Text, TaskItem? Task = null);

public sealed record NotePage(
    string Id, string Title, string EditedLine, string NotebookName, string NotebookColorHex, IReadOnlyList<string> SectionPath,
    PageColour Colour, RuleLines Rules, IReadOnlyList<CanvasBox> Boxes, int OpenTasks, int Comments);

public enum DueTone { None, Overdue, Today, Soon, Later }

public sealed record TaskItem(
    string Id, string Title, bool Done, int Priority, string? DueLabel, DueTone Tone, bool Recurring,
    string? PageTitle, string? Team, string? Assignee, IReadOnlyList<string> Tags, int ChecklistDone, int ChecklistTotal);

public sealed record TaskGroup(string Title, int Count, bool IsOverdue, IReadOnlyList<TaskItem> Tasks);

public enum TaskViewKind { Today, MyTasks, Upcoming, All, Team }

public sealed record TaskCounts(int Today, bool TodayOverdue, int MyTasks, int Upcoming);

public sealed record TodayStats(int DoneToday, int Left, int DayStreak, IReadOnlyList<bool> WeekDone, double Progress);
