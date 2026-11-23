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

    /// <summary>The open page's live connection once it has synced (null for a source with none, or while connecting). The box views open editor sessions on it.</summary>
    Notivelo.Native.LivePage? LivePageOf(string pageId);
    /// <summary>A task by id for task lines in a box (null: missing or not visible).</summary>
    TaskItem? FindTask(string taskId);
    /// <summary>The title of a page by id, or null when it isn't in the tree (a missing page link).</summary>
    string? PageTitleOf(string pageId);
    string? EmojiOfPage(string pageId);
    /// <summary>The signed-in user's id, so a mention of yourself can be drawn yellow.</summary>
    string? UserId { get; }

    TaskCounts GetTaskCounts();
    TodayStats GetTodayStats();
    string TasksSubtitle(TaskViewKind view);
    IReadOnlyList<TaskGroup> GetTaskGroups(TaskViewKind view);
    event EventHandler? Changed;
}
