package com.notivelo.app.data

import androidx.compose.runtime.Immutable
import com.notivelo.app.edit.EditingBox
import com.notivelo.core.PageInfo
import com.notivelo.core.Task
import com.notivelo.core.TaskChanges
import com.notivelo.core.TaskDetail
import com.notivelo.core.TaskTag
import com.notivelo.core.TaskTeam
import com.notivelo.core.Tree
import com.notivelo.core.User
import com.notivelo.core.Workspace
import com.notivelo.core.WorkspaceMember

enum class Phase { Loading, SignedOut, SignedIn }

/** One ink stroke ready to draw: the core's outline as path commands (0 move, 1 line, 2 circle cx cy r, 3 close). */
@Immutable
class InkShape(val id: String, val highlighter: Boolean, /** ARGB. */ val argb: Int, val ops: FloatArray)

enum class PageStatus { Connecting, Synced, Offline, NoAccess, Ended }

/** The page open on screen: what the core returned (from the store first, then live) and its connection. */
@Immutable
data class PageView(
    val pageId: String,
    val info: PageInfo? = null,
    val ink: List<InkShape> = emptyList(),
    val status: PageStatus = PageStatus.Connecting,
    /** The box being edited (its text engine), if any. */
    val editing: EditingBox? = null,
    /** The page's undo and redo have a step (the buttons enable from these). */
    val canUndo: Boolean = false,
    val canRedo: Boolean = false,
    /** Counts every box write and undo, so the canvas drops the drag it was showing. */
    val rev: Int = 0,
)

/** The quick-add dialog: the date the group it was opened from stands for. */
@Immutable
data class QuickAddState(val dueDate: String? = null)

/** Everything the screens show, in one value; [AppViewModel] is the only writer. */
@Immutable
data class AppState(
    val phase: Phase = Phase.Loading,
    val server: String = DEFAULT_SERVER,
    val signingIn: Boolean = false,
    val error: String? = null,
    val user: User? = null,
    val workspaces: List<Workspace> = emptyList(),
    val workspaceId: String? = null,
    val tree: Tree? = null,
    val treeLoading: Boolean = false,
    /** Open tasks per page id. */
    val taskCounts: Map<String, Int> = emptyMap(),
    /** The notebook the sidebar (tablet) and the drawer (phone) show. */
    val notebookId: String? = null,
    /** The notebook open in the phone's Notes drill-down; none shows the notebook list. */
    val phoneNotebookId: String? = null,
    val sectionId: String? = null,
    val pageId: String? = null,
    /** The workspace's tasks (the Tasks views, the task lines on pages). */
    val tasks: List<Task> = emptyList(),
    val tab: Tab = Tab.Notes,
    val taskList: TaskList = TaskList.Today,
    /** Upcoming: Mine (false) or Everyone. */
    val everyone: Boolean = false,
    /** The task whose detail sheet is open. */
    val taskDetailId: String? = null,
    val page: PageView? = null,
    /** A short message for the toast (a refused task tick). */
    val notice: String? = null,
    /** The look scenes: stand-in data (a page is "edited by you"). */
    val preview: Boolean = false,
    /** Titles of pages the tasks are written on that the tree doesn't list (the look scenes). */
    val otherPageTitles: Map<String, String> = emptyMap(),
    /** The workspace's people (the `@` menu), loaded when a box is first edited. */
    val members: List<WorkspaceMember> = emptyList(),
    /** The tasks with every field (by id), the workspace's teams and tags: for the team chip, tags, Team and Repeat rows. */
    val details: Map<String, TaskDetail> = emptyMap(),
    val teams: List<TaskTeam> = emptyList(),
    val tags: List<TaskTag> = emptyList(),
    val quickAdd: QuickAddState? = null,
) {
    val workspace: Workspace? get() = workspaces.firstOrNull { it.id == workspaceId }
}

/** What the shell can ask for. The look scenes use [NoActions]. */
interface ShellActions {
    fun selectWorkspace(id: String) {}

    /** The sidebar's notebook picker. */
    fun selectNotebook(id: String) {}

    /** The phone's Notes list: open a notebook screen. */
    fun openPhoneNotebook(id: String) {}

    fun openSection(id: String) {}
    fun openPage(id: String) {}
    fun back() {}

    /** The Notes tab / rail button: the overview. */
    fun goNotes() {}

    /** The Tasks tab / rail button, and a task view. */
    fun goTasks() {}
    fun selectTaskList(list: TaskList) {}
    fun setEveryone(everyone: Boolean) {}

    /** Tick or untick a task (the one write in the native preview). */
    fun toggleTask(id: String) {}

    /** Open (or close, with null) a task's detail sheet. */
    fun openTask(id: String?) {}
    fun clearNotice() {}

    /** Edit a box of the open page; the tap's place (px in the box) puts the caret there. */
    fun startEditing(boxId: String, tapX: Float = -1f, tapY: Float = -1f) {}
    fun stopEditing() {}

    /** Box calls on the open page (page px from the page origin). New boxes open for editing. */
    fun createBox(x: Double, y: Double) {}
    fun moveBox(id: String, x: Double, y: Double) {}
    fun resizeBox(id: String, width: Double) {}

    /** The page's undo and redo: one stack across text, ink and boxes. */
    fun undoPage() {}
    fun redoPage() {}

    /** The text view changed a box: the undo buttons read the stack again. */
    fun pageEdited() {}

    /** Task edits (task detail and lists). */
    fun updateTask(id: String, changes: TaskChanges) {}
    fun deleteTask(id: String) {}
    fun addSubtask(parentId: String, title: String) {}

    /** The quick-add dialog (the lists' Add task, the FAB), with the date of the group it was opened from. */
    fun newTask(dueDate: String? = null) {}
    fun closeQuickAdd() {}
    fun addQuickTask(text: String) {}

    fun signOut() {}
}

object NoActions : ShellActions
