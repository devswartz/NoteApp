package com.notivelo.app.data

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.notivelo.core.PageInfo
import com.notivelo.core.SignedIn
import com.notivelo.core.Tree
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The session and the notes tree. Core calls block, so they run on [io]; results land in [state].
 * Restores the session from the stored refresh token at start (the cached workspaces and tree show at
 * once, the server's answer replaces them), signs in and out, switches workspaces.
 */
class AppViewModel(
    private val backend: Backend,
    private val store: SessionStore,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel(), ShellActions {
    private val _state = MutableStateFlow(AppState(server = store.server))
    val state: StateFlow<AppState> = _state.asStateFlow()

    private var handle: PageHandle? = null

    init {
        restore()
        // A page is open live while it is the one chosen; leaving it closes the connection.
        viewModelScope.launch {
            _state.map { it.pageId }.distinctUntilChanged().collect { openPageHandle(it) }
        }
    }

    private suspend fun <T> blocking(block: () -> T): T = withContext(io) { block() }

    // Session

    fun restore() {
        viewModelScope.launch {
            val token = store.refreshToken
            if (token == null) {
                _state.update { it.copy(phase = Phase.SignedOut, server = store.server) }
                return@launch
            }
            try {
                val signedIn = blocking { backend.restore(store.server, token) }
                enter(signedIn)
            } catch (e: BackendError.SignedOut) {
                store.refreshToken = null
                _state.update { it.copy(phase = Phase.SignedOut, error = null) }
            } catch (e: BackendError) {
                // Keep the token: the next launch (or Retry) tries again.
                _state.update { it.copy(phase = Phase.SignedOut, error = "Can't reach the server. Check your connection.") }
            }
        }
    }

    fun signIn(server: String, email: String, password: String) {
        val url = server.trim().ifEmpty { DEFAULT_SERVER }
        if (email.isBlank() || password.isEmpty()) {
            _state.update { it.copy(error = "Enter your email and password.") }
            return
        }
        if (_state.value.signingIn) return
        _state.update { it.copy(signingIn = true, error = null, server = url) }
        viewModelScope.launch {
            try {
                val signedIn = blocking { backend.signIn(url, email.trim(), password) }
                store.server = url
                enter(signedIn)
            } catch (e: BackendError.SignedOut) {
                _state.update { it.copy(signingIn = false, error = "Wrong email or password.") }
            } catch (e: BackendError.Offline) {
                _state.update { it.copy(signingIn = false, error = "Can't reach the server. Check your connection.") }
            } catch (e: BackendError) {
                _state.update { it.copy(signingIn = false, error = e.message ?: "Sign-in failed.") }
            }
        }
    }

    override fun signOut() {
        viewModelScope.launch {
            try {
                blocking { backend.signOut() }
            } catch (e: Exception) {
                // Signed out here either way.
            }
            store.refreshToken = null
            store.workspaceId = null
            _state.value = AppState(phase = Phase.SignedOut, server = store.server)
        }
    }

    private suspend fun enter(signedIn: SignedIn) {
        store.refreshToken = blocking { backend.refreshToken() } ?: signedIn.refreshToken
        _state.update {
            it.copy(phase = Phase.SignedIn, signingIn = false, error = null, user = signedIn.user)
        }
        loadWorkspaces()
    }

    // Workspaces and the tree

    private suspend fun loadWorkspaces() {
        val cached = blocking { backend.cachedWorkspaces() }
        if (!cached.isNullOrEmpty()) applyWorkspaces(cached)
        try {
            val fresh = blocking { backend.workspaces() }
            applyWorkspaces(fresh)
            storeRefreshToken()
        } catch (e: BackendError.SignedOut) {
            expire()
        } catch (e: BackendError) {
            if (cached.isNullOrEmpty()) _state.update { it.copy(error = "Can't load your workspaces.") }
        }
    }

    private suspend fun applyWorkspaces(list: List<com.notivelo.core.Workspace>) {
        val current = _state.value.workspaceId
        val wanted = listOfNotNull(current, store.workspaceId).firstOrNull { id -> list.any { it.id == id } }
        val id = wanted ?: list.firstOrNull()?.id
        _state.update { it.copy(workspaces = list) }
        if (id != null && id != current) switchTo(id)
    }

    override fun selectWorkspace(id: String) {
        if (id == _state.value.workspaceId) return
        store.workspaceId = id
        viewModelScope.launch { switchTo(id) }
    }

    private suspend fun switchTo(id: String) {
        _state.update {
            it.copy(
                workspaceId = id, tree = null, taskCounts = emptyMap(), tasks = emptyList(), members = emptyList(), taskDetailId = null, treeLoading = true,
                notebookId = null, phoneNotebookId = null, sectionId = null, pageId = null,
            )
        }
        val cached = blocking { backend.cachedTree(id) }
        if (cached != null) applyTree(id, cached, loading = true)
        try {
            val tree = blocking { backend.tree(id) }
            applyTree(id, tree, loading = false)
            storeRefreshToken()
        } catch (e: BackendError.SignedOut) {
            expire()
            return
        } catch (e: BackendError) {
            _state.update { if (it.workspaceId == id) it.copy(treeLoading = false) else it }
        }
        try {
            val tasks = blocking { backend.tasks(id) }
            _state.update { if (it.workspaceId == id) it.copy(tasks = tasks, taskCounts = openTaskCounts(tasks)) else it }
        } catch (e: BackendError) {
            // Counts are a nicety.
        }
    }

    /** Applies a tree if [id] is still the workspace shown; keeps the choice of notebook/section/page when they still exist. */
    private fun applyTree(id: String, tree: Tree, loading: Boolean) {
        _state.update { s ->
            if (s.workspaceId != id) return@update s
            val index = TreeIndex(tree)
            val notebook = index.resolveNotebook(s.notebookId)
            s.copy(
                tree = tree,
                treeLoading = loading,
                notebookId = notebook?.id,
                phoneNotebookId = s.phoneNotebookId?.takeIf { index.notebook(it) != null },
                sectionId = s.sectionId?.takeIf { index.section(it) != null },
                pageId = s.pageId?.takeIf { index.page(it) != null },
            )
        }
    }

    private suspend fun storeRefreshToken() {
        val token = blocking { backend.refreshToken() } ?: return
        // A session that expired meanwhile stays forgotten.
        if (_state.value.phase == Phase.SignedIn) store.refreshToken = token
    }

    private fun expire() {
        store.refreshToken = null
        _state.value = AppState(phase = Phase.SignedOut, server = store.server)
    }

    // Navigation

    override fun selectNotebook(id: String) {
        _state.update { it.copy(notebookId = id, sectionId = null, pageId = null) }
    }

    override fun openPhoneNotebook(id: String) {
        _state.update { it.copy(tab = Tab.Notes, phoneNotebookId = id, notebookId = id, sectionId = null, pageId = null) }
    }

    override fun openSection(id: String) {
        _state.update { s ->
            val index = s.tree?.let(::TreeIndex)
            val section = index?.section(id)
            s.copy(
                tab = Tab.Notes,
                sectionId = id,
                pageId = null,
                notebookId = section?.notebookId ?: s.notebookId,
                phoneNotebookId = section?.notebookId ?: s.phoneNotebookId,
            )
        }
    }

    override fun openPage(id: String) {
        _state.update { s ->
            val index = s.tree?.let(::TreeIndex)
            val page = index?.page(id)
            val section = index?.section(page?.sectionId)
            s.copy(
                tab = Tab.Notes,
                pageId = id,
                sectionId = page?.sectionId ?: s.sectionId,
                notebookId = section?.notebookId ?: s.notebookId,
                phoneNotebookId = section?.notebookId ?: s.phoneNotebookId,
            )
        }
    }

    /** Phone back: page to its section, a section to its parent (or the notebook), a notebook to the list. */
    override fun back() {
        _state.update { s ->
            val index = s.tree?.let(::TreeIndex)
            when {
                s.pageId != null -> s.copy(pageId = null)
                s.sectionId != null -> s.copy(sectionId = index?.section(s.sectionId)?.parentId)
                s.phoneNotebookId != null -> s.copy(phoneNotebookId = null)
                else -> s
            }
        }
    }

    override fun goNotes() {
        _state.update { it.copy(tab = Tab.Notes, phoneNotebookId = null, sectionId = null, pageId = null) }
    }

    // Tasks

    override fun goTasks() {
        _state.update { it.copy(tab = Tab.Tasks) }
        refreshTasks()
    }

    override fun selectTaskList(list: TaskList) {
        _state.update { it.copy(tab = Tab.Tasks, taskList = list) }
    }

    override fun setEveryone(everyone: Boolean) {
        _state.update { it.copy(everyone = everyone) }
    }

    override fun openTask(id: String?) {
        _state.update { it.copy(taskDetailId = id) }
    }

    override fun clearNotice() {
        _state.update { it.copy(notice = null) }
    }

    private fun refreshTasks() {
        val ws = _state.value.workspaceId ?: return
        viewModelScope.launch {
            try {
                val tasks = blocking { backend.tasks(ws) }
                _state.update { if (it.workspaceId == ws) it.copy(tasks = tasks, taskCounts = openTaskCounts(tasks)) else it }
            } catch (e: BackendError) {
                // The list on screen stays.
            }
        }
    }

    /** Ticks a task at once and asks the server; a refusal puts it back and says so. */
    override fun toggleTask(id: String) {
        val before = _state.value.tasks.firstOrNull { it.id == id } ?: return
        if (before.locked) return
        val done = !before.done
        setTasks { it.withDone(id, done, java.time.Instant.now().toString()) }
        viewModelScope.launch {
            try {
                val saved = blocking { backend.setTaskDone(id, done) }
                setTasks { list -> list.map { if (it.id == id) saved else it } }
            } catch (e: BackendError) {
                setTasks { list -> list.map { if (it.id == id) before else it } }
                _state.update { it.copy(notice = "Could not update the task.") }
            }
        }
    }

    private fun setTasks(f: (List<com.notivelo.core.Task>) -> List<com.notivelo.core.Task>) {
        _state.update { val t = f(it.tasks); it.copy(tasks = t, taskCounts = openTaskCounts(t)) }
    }

    // The open page

    private suspend fun openPageHandle(id: String?) {
        val old = handle
        handle = null
        _state.value.page?.editing?.let { e -> blocking { try { e.engine.close() } catch (x: Exception) { } } }
        if (old != null) blocking { try { old.close() } catch (e: Exception) { } }
        if (id == null) {
            _state.update { it.copy(page = null) }
            return
        }
        val cached = blocking { backend.cachedPage(id) }
        _state.update { it.copy(page = PageView(id, cached)) }
        val locked = _state.value.tree?.pages?.firstOrNull { it.id == id }?.locked == true
        if (locked) return
        val events = object : PageEvents {
            override fun onStatus(status: PageStatus) {
                viewModelScope.launch { editPage(id) { it.copy(status = status) } }
            }

            override fun onChange(info: PageInfo) {
                viewModelScope.launch { applyPage(id, info) }
            }
        }
        try {
            val h = blocking { backend.openPage(id, events) }
            if (_state.value.pageId == id) {
                handle = h
            } else {
                blocking { h.close() }
            }
        } catch (e: BackendError.SignedOut) {
            expire()
        } catch (e: BackendError) {
            editPage(id) { it.copy(status = PageStatus.Offline) }
        }
    }

    // Editing a box: a core session on it (others' edits come into it, its edits go into the page)

    override fun startEditing(boxId: String, tapX: Float, tapY: Float) {
        val s = _state.value
        val pid = s.pageId ?: return
        val h = handle ?: return
        val ws = s.workspaceId ?: return
        if (s.page?.editing?.boxId == boxId) return
        viewModelScope.launch {
            try {
                val engine = blocking { h.openEditor(boxId, ws) }
                if (_state.value.pageId != pid || handle !== h) {
                    blocking { engine.close() }
                    return@launch
                }
                val old = _state.value.page?.editing
                editPage(pid) { it.copy(editing = EditingBox(boxId, engine, tapX, tapY)) }
                if (old != null) blocking { old.engine.close() }
                loadMembers(ws)
            } catch (e: Exception) {
                _state.update { it.copy(notice = "This box could not be opened for editing.") }
            }
        }
    }

    override fun stopEditing() {
        val pid = _state.value.pageId ?: return
        val e = _state.value.page?.editing ?: return
        editPage(pid) { it.copy(editing = null) }
        viewModelScope.launch { blocking { try { e.engine.close() } catch (x: Exception) { } } }
    }

    private suspend fun loadMembers(workspaceId: String) {
        if (_state.value.members.isNotEmpty()) return
        val people = try { blocking { backend.members(workspaceId) } } catch (e: Exception) { return }
        if (_state.value.workspaceId == workspaceId) _state.update { it.copy(members = people) }
    }

    private suspend fun applyPage(id: String, info: PageInfo) {
        val h = handle ?: return
        val (fresh, ink) = blocking { info to h.ink() }
        editPage(id) { it.copy(info = fresh, ink = ink) }
    }

    private fun editPage(id: String, f: (PageView) -> PageView) {
        _state.update { s -> val pv = s.page; if (pv != null && pv.pageId == id) s.copy(page = f(pv)) else s }
    }

    class Factory(private val backend: Backend, private val store: SessionStore) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = AppViewModel(backend, store) as T
    }
}
