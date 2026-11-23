namespace Notivelo.Windows.Data;

/// <summary>
/// The shell's only door to data. <see cref="SampleNotesSource"/> fakes it for now; the Rust core (via its C# bindings
/// and the editor session) implements this later. Methods are synchronous because the sample is in memory; a core-backed
/// source can cache and raise <see cref="Changed"/> when the underlying store changes.
/// </summary>
public interface INotesSource
{
    Workspace Workspace { get; }
    IReadOnlyList<Notebook> Notebooks { get; }
    /// <summary>The page to show first (null: the Notes overview).</summary>
    string? InitialPageId { get; }
    NotePage? GetPage(string pageId);
    TaskCounts GetTaskCounts();
    TodayStats GetTodayStats();
    string TasksSubtitle(TaskViewKind view);
    IReadOnlyList<TaskGroup> GetTaskGroups(TaskViewKind view);
    event EventHandler? Changed;
}
