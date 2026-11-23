package com.notivelo.app.data

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.notivelo.core.SignedIn
import com.notivelo.core.Tree
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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

    init {
        restore()
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
                workspaceId = id, tree = null, taskCounts = emptyMap(), treeLoading = true,
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
            val counts = openTaskCounts(blocking { backend.tasks(id) })
            _state.update { if (it.workspaceId == id) it.copy(taskCounts = counts) else it }
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
        _state.update { it.copy(phoneNotebookId = id, notebookId = id, sectionId = null, pageId = null) }
    }

    override fun openSection(id: String) {
        _state.update { s ->
            val index = s.tree?.let(::TreeIndex)
            val section = index?.section(id)
            s.copy(
                sectionId = id,
                pageId = null,
                notebookId = section?.notebookId ?: s.notebookId,
                phoneNotebookId = if (s.phoneNotebookId != null) section?.notebookId ?: s.phoneNotebookId else null,
            )
        }
    }

    override fun openPage(id: String) {
        _state.update { s ->
            val index = s.tree?.let(::TreeIndex)
            val page = index?.page(id)
            val section = index?.section(page?.sectionId)
            s.copy(
                pageId = id,
                sectionId = page?.sectionId ?: s.sectionId,
                notebookId = section?.notebookId ?: s.notebookId,
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
        _state.update { it.copy(phoneNotebookId = null, sectionId = null, pageId = null) }
    }

    class Factory(private val backend: Backend, private val store: SessionStore) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = AppViewModel(backend, store) as T
    }
}
