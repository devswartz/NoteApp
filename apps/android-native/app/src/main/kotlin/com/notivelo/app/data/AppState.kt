package com.notivelo.app.data

import androidx.compose.runtime.Immutable
import com.notivelo.core.PageInfo
import com.notivelo.core.Task
import com.notivelo.core.Tree
import com.notivelo.core.User
import com.notivelo.core.Workspace

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
)

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

    fun signOut() {}
}

object NoActions : ShellActions
