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
    /// <summary>A task made from a box line (Ctrl+Enter, the Task button, the slash menu): the editor chose its id and wants it created in the workspace, on this page.</summary>
    void CreateTask(string id, string title, bool done, string? pageId);
    /// <summary>The task line was removed from the box for good.</summary>
    void DeleteTask(string id);
    /// <summary>Pages whose title contains the query, for the [[ menu (at most <paramref name="max"/>).</summary>
    IReadOnlyList<(string Id, string Title, string Crumb)> SearchPages(string query, int max);
    /// <summary>People that can be mentioned with @ (the signed-in user until the workspace member list is exposed).</summary>
    IReadOnlyList<(string Id, string Label, string Detail, string? ColorHex)> People(string query);

    /// <summary>Offline test mode (NOTIVELO_SOURCE=offline): the source opens the boxes' editor sessions over local documents, with no live page.</summary>
    bool OffersOfflineBoxes => false;
    Notivelo.Native.EditorSession? OpenOfflineBox(string pageId, string field, Notivelo.Native.TaskCallbacks tasks) => null;

    // ---- canvas boxes and ink (the core's box and ink calls on the open page; Apple's BoxGeometryStore / MacInkView) ----
    /// <summary>Boxes can be made, moved, resized and removed on this page.</summary>
    bool CanEditBoxes(string pageId) => false;
    /// <summary>A new empty box (x, y from the surface origin, w wide, z in front); returns its id, or null when refused.</summary>
    string? CreateBox(string pageId, double x, double y, double w, double z) => null;
    void MoveBox(string pageId, string boxId, double x, double y) { }
    void ResizeBox(string pageId, string boxId, double w) { }
    void BringBoxToFront(string pageId, string boxId) { }
    /// <summary>Remove a box that holds nothing (the core refuses one that does); true when it is gone.</summary>
    bool DeleteBox(string pageId, string boxId) => false;
    /// <summary>The page's ink in drawing order (empty for a source without a live page).</summary>
    IReadOnlyList<InkStroke> InkOf(string pageId) => Array.Empty<InkStroke>();

    TaskCounts GetTaskCounts();
    TodayStats GetTodayStats();
    string TasksSubtitle(TaskViewKind view);
    IReadOnlyList<TaskGroup> GetTaskGroups(TaskViewKind view);
    event EventHandler? Changed;
}
