namespace Notivelo.Windows.Data;

/// <summary>
/// The shell's only door to data. <see cref="CoreNotesSource"/> implements it over the Rust core; <see cref="SampleNotesSource"/>
/// fakes it for offline screenshots. Reads are synchronous and served from what the source has loaded; a source loads in the
/// background and raises <see cref="Changed"/> (always on the UI thread) when anything the views show has changed.
/// </summary>
public interface INotesSource
{
    Workspace Workspace { get; }
    IReadOnlyList<WorkspaceInfo> Workspaces { get; }
    string? CurrentWorkspaceId { get; }
    void SelectWorkspace(string id);

    IReadOnlyList<Notebook> Notebooks { get; }
    string? CurrentNotebookId { get; }
    void SelectNotebook(string id);

    /// <summary>The first load is under way (nothing to show yet).</summary>
    bool Loading { get; }
    /// <summary>Why the last load failed, or null.</summary>
    string? LoadError { get; }

    /// <summary>The page to show first (null: the Notes overview).</summary>
    string? InitialPageId { get; }
    /// <summary>The page the shell now shows (null: none). A live source opens it and closes the previous one.</summary>
    void OpenPage(string? pageId);
    NotePage? GetPage(string pageId);
    /// <summary>Newest first, for the Notes overview.</summary>
    IReadOnlyList<(PageSummary Page, string Where, string Edited)> RecentPages(int count);

    TaskCounts GetTaskCounts();
    TodayStats GetTodayStats();
    string TasksSubtitle(TaskViewKind view);
    IReadOnlyList<TaskGroup> GetTaskGroups(TaskViewKind view);
    event EventHandler? Changed;
}
