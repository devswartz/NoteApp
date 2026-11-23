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
    /// <summary>Undo (or redo) the page's newest change through the core's page undo. Null: the page isn't live (the box's own undo applies);
    /// otherwise whether something changed. Nothing is notified by the core: the page info is read again here and <c>Changed</c> is raised.</summary>
    bool? PageUndo(string pageId, bool undo);
    /// <summary>Whether <see cref="PageUndo"/> would change something; null when the page isn't live.</summary>
    bool? CanPageUndo(string pageId, bool undo);
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


    // ---- parity B: tree actions (the core's create/rename/move/delete/trash calls; each refreshes the tree), search, task detail ----
    /// <summary>The tree can be changed (a signed-in core source, or the sample).</summary>
    bool CanEditTree => false;
    Task<TreeResult> CreateNotebook(string name) => Task.FromResult(new TreeResult(Error: "Not available."));
    Task<TreeResult> CreateSection(string notebookId, string? parentId, string name) => Task.FromResult(new TreeResult(Error: "Not available."));
    Task<TreeResult> CreatePage(string sectionId, string title) => Task.FromResult(new TreeResult(Error: "Not available."));
    Task<TreeResult> Rename(TreeKind kind, string id, string name) => Task.FromResult(new TreeResult(Error: "Not available."));
    /// <summary>Copy a page or section next to the original (Apple's Duplicate).</summary>
    Task<TreeResult> Duplicate(TreeKind kind, string id) => Task.FromResult(new TreeResult(Error: "Not available."));
    /// <summary>Move a page (to <paramref name="sectionId"/>) or a section (to a notebook, optionally under a section).</summary>
    Task<TreeResult> Move(TreeKind kind, string id, string notebookId, string? sectionId) => Task.FromResult(new TreeResult(Error: "Not available."));
    /// <summary>Delete moves to the Trash (kept 60 days).</summary>
    Task<TreeResult> Delete(TreeKind kind, string id) => Task.FromResult(new TreeResult(Error: "Not available."));
    Task<TrashList> LoadTrash() => Task.FromResult(new TrashList(Array.Empty<TrashItem>(), "Not available."));
    Task<TreeResult> Restore(TrashItem item) => Task.FromResult(new TreeResult(Error: "Not available."));
    Task<TreeResult> DeleteForever(TrashItem item) => Task.FromResult(new TreeResult(Error: "Not available."));
    Task<TreeResult> EmptyTrash() => Task.FromResult(new TreeResult(Error: "Not available."));

    /// <summary>The core's content search (page text, task titles and descriptions); null when it can't be asked (offline): the caller keeps the title matches.</summary>
    Task<SearchOutcome?> SearchAsync(string query) => Task.FromResult<SearchOutcome?>(null);

    /// <summary>Raised at each change to the task list, so views that draw task lines draw them again.</summary>
    long TasksVersion => 0;
    TaskDetailItem? GetTaskDetail(string taskId) => null;
    /// <summary>Change a task (shown at once, then sent to the core). A tick is <c>new TaskPatch(Done: true)</c>.</summary>
    void UpdateTask(string taskId, TaskPatch patch) { }

    /// <summary>Quick add: make a task (shown at once on success). Returns an error sentence, or null.</summary>
    Task<string?> AddTask(NewTask task) => Task.FromResult<string?>("Not available.");
    /// <summary>The open tasks assigned to you (with their due day, null when none) for the Calendar.</summary>
    IReadOnlyList<CalendarTask> CalendarTasks() => Array.Empty<CalendarTask>();

    TaskCounts GetTaskCounts();
    TodayStats GetTodayStats();
    string TasksSubtitle(TaskViewKind view);
    IReadOnlyList<TaskGroup> GetTaskGroups(TaskViewKind view);
    event EventHandler? Changed;
}
