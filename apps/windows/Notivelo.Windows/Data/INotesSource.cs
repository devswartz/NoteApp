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
    /// <summary>Ink can be drawn on this page (a live page; the offline sample page keeps its strokes in memory). The writes below go through the core's ink
    /// calls (Apple's InkSession) and join page undo; they raise no Changed, so the caller reads <see cref="InkOf"/> again.</summary>
    bool CanInk(string pageId) => false;
    /// <summary>The finished stroke of a builder (core <c>AddInkStroke</c>).</summary>
    bool AddInkStroke(string pageId, Notivelo.Native.InkStrokeBuilder builder, byte tool, uint color) => false;
    /// <summary>Core <c>EraseInk(track, radius, partial)</c>: a flat x,y track.</summary>
    bool EraseInk(string pageId, float[] track, float radius, bool partial) => false;
    /// <summary>Core <c>InkHitLasso(polygon, 0.5)</c>.</summary>
    IReadOnlyList<string> InkHitLasso(string pageId, float[] polygon) => Array.Empty<string>();
    /// <summary>Core <c>InkHitPoint(x, y, radius)</c>.</summary>
    IReadOnlyList<string> InkHitPoint(string pageId, float x, float y, float radius) => Array.Empty<string>();
    /// <summary>Core <c>MoveInkStrokes</c>: the moved strokes get new ids. Null when it failed.</summary>
    IReadOnlyList<(string OldId, string NewId)>? MoveInkStrokes(string pageId, IReadOnlyList<string> ids, float dx, float dy) => null;
    /// <summary>Core <c>DeleteInkStrokes</c>.</summary>
    bool DeleteInkStrokes(string pageId, IReadOnlyList<string> ids) => false;


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
    /// <summary>Your tasks and, with <paramref name="everyone"/>, everyone's, open and done, by due date (the Calendar applies its status filter).</summary>
    IReadOnlyList<CalendarTask> CalendarTasks(bool everyone) => everyone ? Array.Empty<CalendarTask>() : CalendarTasks();

    // ---- task sheet extras (Apple's TaskDetail / TaskPickers: team, tags, time, repeat, reminders, subtasks) and "Tasks on this page" ----
    IReadOnlyList<TeamInfo> Teams() => Array.Empty<TeamInfo>();
    IReadOnlyList<TagInfo> Tags() => Array.Empty<TagInfo>();
    /// <summary>A tag by name, made when it doesn't exist (core <c>create_tag</c>); null when it can't be.</summary>
    Task<TagInfo?> CreateTag(string name) => Task.FromResult<TagInfo?>(null);
    IReadOnlyList<ReminderInfo> Reminders(string taskId) => Array.Empty<ReminderInfo>();
    /// <summary>Load what the pickers and the sheet show beyond the task list (full task, reminders, teams, tags; null task: the lists only). Raises Changed when it has them.</summary>
    void LoadTaskExtras(string? taskId) { }
    Task<string?> AddReminder(string taskId, ReminderInput reminder) => Task.FromResult<string?>("Not available.");
    Task<string?> DeleteReminder(string taskId, string reminderId) => Task.FromResult<string?>("Not available.");
    /// <summary>A subtask of a task (it lives on the parent's page). Returns an error sentence, or null.</summary>
    Task<string?> AddSubtask(string parentId, string title) => Task.FromResult<string?>("Not available.");
    /// <summary>The tasks written on a page, open ones by due date first (done ones included: the panel hides them behind "Show n completed").</summary>
    IReadOnlyList<TaskItem> PageTasks(string pageId) => Array.Empty<TaskItem>();


    // ---- account (the core's account calls; online only: offline each answers Offline and changes nothing) ----
    Task<AccountResult<AccountProfile>> LoadProfile() => Task.FromResult(AccountResult<AccountProfile>.Off());
    Task<AccountResult<AccountProfile>> UpdateProfile(string? name, string? color) => Task.FromResult(AccountResult<AccountProfile>.Off());
    /// <summary>Change the password. A wrong current password answers Code "wrong_password". The core's new refresh token is stored by the source.</summary>
    Task<AccountResult<bool>> ChangePassword(string current, string next) => Task.FromResult(AccountResult<bool>.Off());
    Task<AccountResult<NotificationPrefs>> LoadNotifications() => Task.FromResult(AccountResult<NotificationPrefs>.Off());
    Task<AccountResult<NotificationPrefs>> UpdateNotifications(NotificationChange change) => Task.FromResult(AccountResult<NotificationPrefs>.Off());
    Task<AccountResult<IReadOnlyList<ConnectedAppInfo>>> LoadConnectedApps() => Task.FromResult(AccountResult<IReadOnlyList<ConnectedAppInfo>>.Off());
    Task<AccountResult<bool>> DisconnectApp(string clientId) => Task.FromResult(AccountResult<bool>.Off());

    // ---- images and attachments (core upload_file / file_url / download_file; online only. The offline sample keeps uploads in memory) ----
    /// <summary>Files can be added to this page (a live page, or the offline test page).</summary>
    bool CanUpload(string pageId) => false;
    /// <summary>Upload a file to the page (off the UI thread). The answer's Url is what the document keeps; an error is one sentence for a toast.</summary>
    Task<MediaResult<UploadedMedia>> UploadFile(string pageId, string name, byte[] data) => Task.FromResult(MediaResult<UploadedMedia>.Fail("Not available."));
    /// <summary>An absolute link for a stored path to draw an image from (signed; ask again later rather than keep it). A link that isn't an upload comes back as it is. Null when it can't be made (offline).</summary>
    Task<string?> FileUrl(string stored) => Task.FromResult<string?>(null);
    /// <summary>The bytes of a stored file (to open or save it).</summary>
    Task<MediaResult<MediaBytes>> DownloadFile(string stored) => Task.FromResult(MediaResult<MediaBytes>.Fail("Not available."));

    // ---- page tools (PARITY batch 2): comments, version history, sharing, locked pages, export, icons. Online sources use the core's calls (each off the UI thread,
    // an error is one sentence); the offline sample keeps everything in memory. ----
    /// <summary>The signed-in user can comment on / edit this page (not a viewer).</summary>
    bool CanComment(string pageId) => false;
    Task<PageToolResult<IReadOnlyList<CommentThreadInfo>>> LoadComments(string pageId) => Task.FromResult(PageToolResult<IReadOnlyList<CommentThreadInfo>>.Fail("Not available."));
    /// <summary>Start a thread with its first comment (the id is the one the page's comment mark carries).</summary>
    Task<PageToolResult<CommentThreadInfo>> AddCommentThread(string pageId, string threadId, string quote, string body) => Task.FromResult(PageToolResult<CommentThreadInfo>.Fail("Not available."));
    Task<PageToolResult<CommentThreadInfo>> ReplyToThread(string threadId, string body) => Task.FromResult(PageToolResult<CommentThreadInfo>.Fail("Not available."));
    Task<PageToolResult<CommentThreadInfo>> SetThreadResolved(string threadId, bool resolved) => Task.FromResult(PageToolResult<CommentThreadInfo>.Fail("Not available."));
    Task<PageToolResult<CommentThreadInfo>> EditComment(string commentId, string body) => Task.FromResult(PageToolResult<CommentThreadInfo>.Fail("Not available."));
    /// <summary>Delete a comment; the value says whether its thread went with it (the last comment).</summary>
    Task<PageToolResult<bool>> DeleteComment(string commentId) => Task.FromResult(PageToolResult<bool>.Fail("Not available."));
    Task<PageToolResult<bool>> DeleteThread(string threadId) => Task.FromResult(PageToolResult<bool>.Fail("Not available."));
    /// <summary>Open (unresolved) comment threads of a page, as last loaded (the top bar's badge).</summary>
    int OpenCommentCount(string pageId) => 0;

    Task<PageToolResult<IReadOnlyList<VersionInfo>>> LoadVersions(string pageId) => Task.FromResult(PageToolResult<IReadOnlyList<VersionInfo>>.Fail("Not available."));
    /// <summary>A version as Markdown text.</summary>
    Task<PageToolResult<string>> VersionPreview(string pageId, string versionId) => Task.FromResult(PageToolResult<string>.Fail("Not available."));
    /// <summary>Restore a version into the open page. The value is the id of the "before restore" version (null for an empty page).</summary>
    Task<PageToolResult<string?>> RestoreVersion(string pageId, string versionId) => Task.FromResult(PageToolResult<string?>.Fail("Not available."));
    bool CanRestoreVersion(string pageId) => false;

    IReadOnlyList<MemberInfo> Members() => Array.Empty<MemberInfo>();
    /// <summary>owner, admin, member or viewer (null when unknown).</summary>
    string? WorkspaceRole => null;
    Task<PageToolResult<PageSharesInfo>> LoadShares(string pageId) => Task.FromResult(PageToolResult<PageSharesInfo>.Fail("Not available."));
    /// <summary>Share with a member (<paramref name="userId"/>) or by email.</summary>
    Task<PageToolResult<ShareOutcome>> SharePage(string pageId, string? userId, string? email, bool canEdit) => Task.FromResult(PageToolResult<ShareOutcome>.Fail("Not available."));
    Task<PageToolResult<PageSharesInfo>> SetShareEdit(string pageId, string userId, bool canEdit) => Task.FromResult(PageToolResult<PageSharesInfo>.Fail("Not available."));
    Task<PageToolResult<PageSharesInfo>> RemoveShare(string pageId, string userId) => Task.FromResult(PageToolResult<PageSharesInfo>.Fail("Not available."));
    Task<PageToolResult<PageSharesInfo>> RevokeInvite(string pageId, string email) => Task.FromResult(PageToolResult<PageSharesInfo>.Fail("Not available."));
    /// <summary>Pages shared with you one by one, newest first (the sidebar's "Shared with me"); loaded with the tree.</summary>
    IReadOnlyList<SharedPageInfo> SharedWithMe => Array.Empty<SharedPageInfo>();
    /// <summary>"Remove from Shared with me" (the core's remove_page_share with your own id).</summary>
    Task<string?> LeaveShare(string pageId) => Task.FromResult<string?>("Not available.");

    LockInfo LockState => new(true, true);
    /// <summary>Set the locked-pages password (or change it: <paramref name="current"/> is then required).</summary>
    Task<string?> SetLockPassword(string password, string? current) => Task.FromResult<string?>("Not available.");
    Task<string?> UnlockLocked(string password) => Task.FromResult<string?>("Not available.");
    Task<string?> LockPage(string pageId) => Task.FromResult<string?>("Not available.");
    Task<string?> RemovePageLock(string pageId, string password) => Task.FromResult<string?>("Not available.");
    /// <summary>"Lock now": the locked pages lock again for this sign-in.</summary>
    Task<string?> LockNow() => Task.FromResult<string?>("Not available.");

    /// <summary>The page as Markdown (the core's page_markdown over the open page; the sample writes it from its blocks).</summary>
    Task<PageToolResult<string>> ExportMarkdown(string pageId) => Task.FromResult(PageToolResult<string>.Fail("Not available."));
    /// <summary>Set (or with null remove) the page's icon emoji.</summary>
    Task<string?> SetPageIcon(string pageId, string? icon) => Task.FromResult<string?>("Not available.");

    // ---- people (PARITY batch 3): workspace members, roles, email invites and invite links (core workspace_people, invite_member, resend_invite, revoke_invite,
    // set_member_role, remove_member, leave_workspace, invite_info, accept_invite; online only). The offline sample keeps them in memory. ----
    Task<PageToolResult<PeopleInfo>> LoadPeople() => Task.FromResult(PageToolResult<PeopleInfo>.Fail("Not available."));
    Task<PageToolResult<InviteOutcome>> InviteToWorkspace(string email, string role) => Task.FromResult(PageToolResult<InviteOutcome>.Fail("Not available."));
    Task<PageToolResult<InviteOutcome>> ResendWorkspaceInvite(string email) => Task.FromResult(PageToolResult<InviteOutcome>.Fail("Not available."));
    Task<PageToolResult<bool>> RevokeWorkspaceInvite(string email) => Task.FromResult(PageToolResult<bool>.Fail("Not available."));
    Task<PageToolResult<bool>> SetMemberRole(string userId, string role) => Task.FromResult(PageToolResult<bool>.Fail("Not available."));
    Task<PageToolResult<bool>> RemoveMember(string userId) => Task.FromResult(PageToolResult<bool>.Fail("Not available."));
    /// <summary>Leave the open workspace; the source then shows another one.</summary>
    Task<PageToolResult<bool>> LeaveWorkspace() => Task.FromResult(PageToolResult<bool>.Fail("Not available."));
    /// <summary>What an invite link (or its token) is for.</summary>
    Task<PageToolResult<InviteLinkInfo>> LookUpInvite(string token) => Task.FromResult(PageToolResult<InviteLinkInfo>.Fail("Not available."));
    /// <summary>Accept it as the signed-in user; a workspace invite makes that workspace the open one.</summary>
    Task<PageToolResult<JoinedInfo>> AcceptInvite(string token) => Task.FromResult(PageToolResult<JoinedInfo>.Fail("Not available."));

    TaskCounts GetTaskCounts();
    TodayStats GetTodayStats();
    string TasksSubtitle(TaskViewKind view);
    IReadOnlyList<TaskGroup> GetTaskGroups(TaskViewKind view);
    event EventHandler? Changed;
}
