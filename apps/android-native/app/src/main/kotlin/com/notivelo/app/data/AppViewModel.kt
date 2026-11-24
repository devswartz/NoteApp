package com.notivelo.app.data

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.notivelo.app.edit.EditingBox
import com.notivelo.app.ink.InkSettings
import com.notivelo.app.ink.InkStrokeSpec
import com.notivelo.app.media.MediaKind
import com.notivelo.app.media.MediaSizing
import com.notivelo.app.media.PickedFile
import com.notivelo.core.PageInfo
import com.notivelo.core.TaskChanges
import java.time.LocalDate
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
    private val today: () -> LocalDate = { LocalDate.now() },
    private val media: MediaHooks = NoMediaHooks,
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
                workspaceId = id, tree = null, taskCounts = emptyMap(), tasks = emptyList(), members = emptyList(), details = emptyMap(), teams = emptyList(), tags = emptyList(), quickAdd = null, taskDetailId = null, treeLoading = true,
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
        loadTaskExtras(id)
    }

    /** Team, repeat rule, tags, teams and people: from the full task records and the workspace's lists. Online only; quiet when it fails. */
    private suspend fun loadTaskExtras(ws: String) {
        try {
            val d = blocking { backend.taskDetails(ws) }
            _state.update { if (it.workspaceId == ws) it.copy(details = d.associateBy { x -> x.id }) else it }
        } catch (e: BackendError) {
        }
        try {
            val t = blocking { backend.teams(ws) }
            _state.update { if (it.workspaceId == ws) it.copy(teams = t) else it }
        } catch (e: BackendError) {
        }
        try {
            val t = blocking { backend.tags(ws) }
            _state.update { if (it.workspaceId == ws) it.copy(tags = t) else it }
        } catch (e: BackendError) {
        }
        loadMembers(ws)
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
                loadTaskExtras(ws)
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

    /** Shows the change at once, sends it, and keeps the server's answer; a refusal puts the task back and says so. */
    override fun updateTask(id: String, changes: TaskChanges) {
        val s = _state.value
        val before = s.tasks.firstOrNull { it.id == id } ?: return
        if (before.locked) return
        val beforeDetail = s.details[id]
        val c = TaskEdit.complete(changes, before.dueDate, today()) { rule, from -> backend.firstOccurrence(rule, from) }
        setTasks { list -> list.map { if (it.id == id) it.with(c) else it } }
        if (beforeDetail != null) _state.update { it.copy(details = it.details + (id to beforeDetail.with(c))) }
        viewModelScope.launch {
            try {
                val saved = blocking { backend.updateTask(id, c) }
                setTasks { list -> list.map { if (it.id == id) saved.toTask() else it } }
                _state.update { it.copy(details = it.details + (id to saved)) }
            } catch (e: BackendError) {
                setTasks { list -> list.map { if (it.id == id) before else it } }
                _state.update { st -> st.copy(details = if (beforeDetail != null) st.details + (id to beforeDetail) else st.details, notice = "Could not update the task.") }
            }
        }
    }

    /** Deletes a task (its subtasks go with it): gone from the lists at once, back with a message if the server refuses. */
    override fun deleteTask(id: String) {
        val s = _state.value
        val before = s.tasks
        val detailsBefore = s.details
        if (before.none { it.id == id }) return
        setTasks { list -> list.filter { it.id != id && it.parentId != id } }
        _state.update { it.copy(details = it.details - id, taskDetailId = if (it.taskDetailId == id) null else it.taskDetailId) }
        viewModelScope.launch {
            try {
                blocking { backend.deleteTask(id) }
            } catch (e: BackendError) {
                setTasks { before }
                _state.update { it.copy(details = detailsBefore, notice = "Could not delete the task.") }
            }
        }
    }

    override fun addSubtask(parentId: String, title: String) {
        val s = _state.value
        val parent = s.tasks.firstOrNull { it.id == parentId } ?: return
        val ws = s.workspaceId ?: return
        if (title.isBlank()) return
        viewModelScope.launch {
            try {
                val made = blocking { backend.createSubtask(ws, parentId, parent.pageId, title.trim()) }
                if (_state.value.workspaceId == ws) setTasks { list -> list + made }
            } catch (e: BackendError) {
                _state.update { it.copy(notice = "Could not add the subtask.") }
            }
        }
    }

    override fun newTask(dueDate: String?) {
        _state.update { it.copy(quickAdd = QuickAddState(dueDate)) }
    }

    override fun closeQuickAdd() {
        _state.update { it.copy(quickAdd = null) }
    }

    override fun addQuickTask(text: String) {
        val s = _state.value
        val ws = s.workspaceId ?: return
        val me = s.user?.id ?: return
        if (text.isBlank()) return
        val due = s.quickAdd?.dueDate
        viewModelScope.launch {
            try {
                val made = blocking { backend.quickAdd(ws, text.trim(), today().toString(), me, due, null) }
                _state.update { it.copy(quickAdd = null) }
                if (_state.value.workspaceId == ws) setTasks { list -> list + made }
                loadTaskExtras(ws)
            } catch (e: BackendError) {
                _state.update { it.copy(quickAdd = null, notice = "Could not add the task.") }
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
        _state.value.page?.editing?.let { e ->
            val empty = old != null && isEmpty(e)
            blocking { try { e.engine.close() } catch (x: Exception) { } }
            if (empty) blocking { try { old?.deleteEmptyBox(e.boxId) } catch (x: Exception) { } }
        }
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
        // A finger tap on text with the pen bar open (finger drawing off) is a wish to type: the bar closes.
        closeInkBar()
        viewModelScope.launch { openEditing(boxId, tapX, tapY) }
    }

    private suspend fun openEditing(boxId: String, tapX: Float, tapY: Float) {
        val s = _state.value
        val pid = s.pageId ?: return
        val h = handle ?: return
        val ws = s.workspaceId ?: return
        if (s.page?.editing?.boxId == boxId) return
        try {
            val engine = blocking { h.openEditor(boxId, ws) }
            if (_state.value.pageId != pid || handle !== h) {
                blocking { engine.close() }
                return
            }
            val old = _state.value.page?.editing
            editPage(pid) { it.copy(editing = EditingBox(boxId, engine, tapX, tapY)) }
            if (old != null) {
                val empty = isEmpty(old)
                blocking { old.engine.close() }
                if (empty) {
                    blocking { try { h.deleteEmptyBox(old.boxId) } catch (x: Exception) { } }
                    reloadPage(pid)
                }
            }
            refreshFlags(pid)
            loadMembers(ws)
        } catch (e: Exception) {
            _state.update { it.copy(notice = "This box could not be opened for editing.") }
        }
    }

    /** The box being edited holds nothing (and is not the page's document): it goes when editing ends, as the web drops an empty box you leave. */
    private suspend fun isEmpty(e: EditingBox): Boolean {
        if (e.boxId == "default") return false
        return blocking { try { e.engine.render().view.text.isBlank() } catch (x: Exception) { false } }
    }

    override fun stopEditing() {
        val pid = _state.value.pageId ?: return
        val e = _state.value.page?.editing ?: return
        val h = handle
        editPage(pid) { it.copy(editing = null) }
        viewModelScope.launch {
            val empty = h != null && isEmpty(e)
            blocking { try { e.engine.close() } catch (x: Exception) { } }
            if (empty && h != null) blocking { try { h.deleteEmptyBox(e.boxId) } catch (x: Exception) { } }
            if (empty) reloadPage(pid) else refreshFlags(pid)
        }
    }

    // Boxes: create, move, resize (one core call each, so one undo step each)

    private fun closeInkBar() {
        if (_state.value.ink.open) _state.update { it.copy(ink = it.ink.copy(open = false)) }
    }

    override fun createBox(x: Double, y: Double) {
        closeInkBar()
        val pid = _state.value.pageId ?: return
        val h = handle ?: return
        val top = _state.value.page?.info?.boxes?.maxOfOrNull { it.z } ?: 0.0
        viewModelScope.launch {
            val old = _state.value.page?.editing
            if (old != null) {
                editPage(pid) { it.copy(editing = null) }
                val empty = isEmpty(old)
                blocking { try { old.engine.close() } catch (x: Exception) { } }
                if (empty) blocking { try { h.deleteEmptyBox(old.boxId) } catch (x: Exception) { } }
            }
            try {
                val id = blocking { h.createBox(x, y, NEW_BOX_WIDTH, top + 1.0) }
                reloadPage(pid)
                openEditing(id, -1f, -1f)
            } catch (e: BackendError) {
                reloadPage(pid)
                _state.update { it.copy(notice = "Could not add a text box.") }
            }
        }
    }

    override fun moveBox(id: String, x: Double, y: Double) = boxWrite("Could not move the box.") { h ->
        h.moveBox(id, x, y)
    }

    override fun resizeBox(id: String, width: Double) = boxWrite("Could not resize the box.") { h ->
        h.resizeBox(id, width)
    }

    private fun boxWrite(failure: String, call: (PageHandle) -> Unit) {
        val pid = _state.value.pageId ?: return
        val h = handle ?: return
        viewModelScope.launch {
            try {
                blocking { call(h) }
            } catch (e: BackendError) {
                _state.update { it.copy(notice = failure) }
            }
            reloadPage(pid)
        }
    }

    // Images and files: the picker (the edited box takes the upload), opening a stored file

    override fun pickMedia(kind: MediaKind) {
        val editing = _state.value.page?.editing
        if (editing == null) {
            _state.update { it.copy(notice = "Tap into a text box first.") }
            return
        }
        _state.update { it.copy(pickRequest = kind) }
    }

    override fun clearPickRequest() {
        _state.update { if (it.pickRequest == null) it else it.copy(pickRequest = null) }
    }

    /** Uploads a picked or pasted file to the page's workspace, then inserts an image or a file card at the caret of the box that was edited. */
    override fun uploadMedia(file: PickedFile?) {
        val s = _state.value
        val pid = s.pageId ?: return
        val ws = s.workspaceId ?: return
        if (file == null) {
            _state.update { it.copy(notice = "Could not read that file.") }
            return
        }
        // Into the box being edited now (the picker leaves the editing as it was), if it still is when the upload ends.
        val target = s.page?.editing?.boxId
        if (target == null) {
            _state.update { it.copy(notice = "Tap into a text box first.") }
            return
        }
        _state.update { it.copy(notice = "Uploading…") }
        viewModelScope.launch {
            try {
                val up = blocking { backend.uploadFile(ws, pid, file.name, file.bytes) }
                val now = _state.value
                val editing = now.page?.editing?.takeIf { it.boxId == target && now.pageId == pid }
                if (editing == null) {
                    _state.update { it.copy(notice = "Uploaded, but the text box was closed.") }
                    return@launch
                }
                val (command, args) = MediaSizing.insertCommand(up.url, up.name, up.mime, up.size)
                // The picture is in hand: the box draws it at once, without fetching it back.
                if (MediaSizing.isImage(up.mime)) media.remember(up.url, file.bytes)
                if (editing.engine.command(command, args)) {
                    _state.update { it.copy(notice = null) }
                    reloadPage(pid)
                } else {
                    _state.update { it.copy(notice = "Could not add it to the page.") }
                }
            } catch (e: BackendError.SignedOut) {
                expire()
            } catch (e: BackendError.Offline) {
                _state.update { it.copy(notice = "You're offline. Nothing was uploaded.") }
            } catch (e: BackendError) {
                _state.update { it.copy(notice = e.message?.takeIf { m -> m.isNotBlank() } ?: "Could not upload the file.") }
            }
        }
    }

    /** Downloads a stored file with the session and hands it to the activity to open with the system. */
    override fun openMedia(src: String, name: String, mime: String) {
        if (src.isBlank() || src.startsWith("http://") || src.startsWith("https://")) return
        _state.update { it.copy(notice = "Opening…") }
        viewModelScope.launch {
            try {
                val f = blocking { backend.downloadFile(src) }
                val type = f.mime.ifEmpty { mime }
                val saved = blocking { media.saveForOpen(name, type, f.bytes) }
                _state.update { if (saved == null) it.copy(notice = "Could not open the file.") else it.copy(openFile = saved, notice = null) }
            } catch (e: BackendError.SignedOut) {
                expire()
            } catch (e: BackendError.Offline) {
                _state.update { it.copy(notice = "You're offline. The file can't be opened.") }
            } catch (e: BackendError) {
                _state.update { it.copy(notice = "Could not open the file.") }
            }
        }
    }

    override fun clearOpenFile() {
        _state.update { if (it.openFile == null) it else it.copy(openFile = null) }
    }

    // Draw mode: the pen bar, and the page's ink writes (one core call per gesture, so one undo step each)

    override fun toggleDraw() {
        stopEditing()
        _state.update { it.copy(ink = it.ink.copy(open = !it.ink.open)) }
    }

    override fun setInk(ink: InkSettings) {
        _state.update { it.copy(ink = ink) }
    }

    override fun addInkStroke(stroke: InkStrokeSpec) = boxWrite("Could not save the stroke.") { h ->
        h.addInkStroke(stroke.tool, stroke.color, stroke.width, stroke.pressure, stroke.samples)
    }

    override fun eraseInk(track: FloatArray, partial: Boolean) = boxWrite("Could not erase.") { h ->
        h.eraseInk(track, InkSettings.ERASER_RADIUS, partial)
    }

    // Page undo: the core's one stack (text of boxes opened live, ink, boxes). While a box is edited this is still the one to call:
    // the box's session writes into the same stack, and an undone text step puts the caret back in its box.

    override fun undoPage() = pageUndo(false)

    override fun redoPage() = pageUndo(true)

    private fun pageUndo(redo: Boolean) {
        val pid = _state.value.pageId ?: return
        val h = handle ?: return
        viewModelScope.launch {
            try {
                blocking { if (redo) h.redo() else h.undo() }
            } catch (e: BackendError) {
                // Nothing to take back.
            }
            reloadPage(pid)
        }
    }

    private var flagsPending = false

    override fun pageEdited() {
        val pid = _state.value.pageId ?: return
        if (flagsPending) return
        flagsPending = true
        viewModelScope.launch {
            try {
                refreshFlags(pid)
            } finally {
                flagsPending = false
            }
        }
    }

    private suspend fun refreshFlags(pid: String) {
        val h = handle ?: return
        val (u, r) = blocking { (try { h.canUndo() } catch (e: Exception) { false }) to (try { h.canRedo() } catch (e: Exception) { false }) }
        editPage(pid) { if (it.canUndo == u && it.canRedo == r) it else it.copy(canUndo = u, canRedo = r) }
    }

    /** Reads the page again after a local write (the core does not report those): boxes, ink, the undo flags; a box being edited that is gone (its creation undone) stops being edited. */
    private suspend fun reloadPage(pid: String) {
        val h = handle ?: return
        val snap = blocking {
            val info = try { h.info() } catch (e: Exception) { null }
            val ink = if (info != null) try { h.ink() } catch (e: Exception) { null } else null
            val u = try { h.canUndo() } catch (e: Exception) { false }
            val r = try { h.canRedo() } catch (e: Exception) { false }
            Reloaded(info, ink, u, r)
        }
        var gone: EditingBox? = null
        editPage(pid) { pv ->
            var next = pv.copy(canUndo = snap.canUndo, canRedo = snap.canRedo, rev = pv.rev + 1)
            if (snap.info != null) next = next.copy(info = snap.info, ink = snap.ink ?: pv.ink)
            val e = pv.editing
            if (snap.info != null && e != null && e.boxId != "default" && snap.info.boxes.none { it.id == e.boxId }) {
                gone = e
                next = next.copy(editing = null)
            }
            next
        }
        gone?.let { e -> blocking { try { e.engine.close() } catch (x: Exception) { } } }
    }

    private class Reloaded(val info: PageInfo?, val ink: List<InkShape>?, val canUndo: Boolean, val canRedo: Boolean)

    private suspend fun loadMembers(workspaceId: String) {
        if (_state.value.members.isNotEmpty()) return
        val people = try { blocking { backend.members(workspaceId) } } catch (e: Exception) { return }
        if (_state.value.workspaceId == workspaceId) _state.update { it.copy(members = people) }
    }

    private suspend fun applyPage(id: String, info: PageInfo) {
        val h = handle ?: return
        val (fresh, ink) = blocking { info to h.ink() }
        editPage(id) { it.copy(info = fresh, ink = ink) }
        refreshFlags(id)
    }

    private fun editPage(id: String, f: (PageView) -> PageView) {
        _state.update { s -> val pv = s.page; if (pv != null && pv.pageId == id) s.copy(page = f(pv)) else s }
    }

    companion object {
        /** A box made by tapping the canvas (the web's `BOX_DEFAULT_W`). */
        const val NEW_BOX_WIDTH = 360.0
    }

    class Factory(private val backend: Backend, private val store: SessionStore, private val media: MediaHooks = NoMediaHooks) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = AppViewModel(backend, store, media = media) as T
    }
}
