package com.notivelo.app.data

import androidx.compose.runtime.Immutable
import com.notivelo.core.Tree
import com.notivelo.core.User
import com.notivelo.core.Workspace

enum class Phase { Loading, SignedOut, SignedIn }

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

    fun signOut() {}
}

object NoActions : ShellActions
