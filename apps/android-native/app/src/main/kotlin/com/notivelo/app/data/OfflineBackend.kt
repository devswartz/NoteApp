package com.notivelo.app.data

import com.notivelo.app.edit.CoreTextEngine
import com.notivelo.app.edit.TextEngine
import com.notivelo.app.look.LookPage
import com.notivelo.app.look.el
import com.notivelo.app.look.p
import com.notivelo.core.BoxContent
import com.notivelo.core.EditorSession
import com.notivelo.core.NodeKind
import com.notivelo.core.Notebook
import com.notivelo.core.PageBox
import com.notivelo.core.PageInfo
import com.notivelo.core.PageMeta
import com.notivelo.core.Section
import com.notivelo.core.SignedIn
import com.notivelo.core.Task
import com.notivelo.core.TaskCallbacks
import com.notivelo.core.Tree
import com.notivelo.core.User
import com.notivelo.core.Workspace
import kotlin.concurrent.thread

/**
 * Test mode (debug builds only, `--es source offline`, see MainActivity): no server and no sign-in. One workspace with
 * one page ([PAGE_ID]) of two boxes. Every box is a REAL core [EditorSession] over a local document (the way the
 * Windows app's `NOTIVELO_SOURCE=offline` works), so typing, the menus, selection, the clipboard and undo go through
 * the actual engine; only the page record around them (box places, the static text of boxes not being edited) is
 * kept here. Page undo is the undo of the box edited last (there is no live page doc offline).
 */
class OfflineBackend : Backend {
    private val user = User(id = "u-offline", email = "offline@example.test", name = "Offline Tester", color = "#6366f1", emailVerified = true)
    private val page = OfflinePage()

    override fun signIn(server: String, email: String, password: String) = SignedIn(user = user, refreshToken = TOKEN)
    override fun restore(server: String, refreshToken: String) = SignedIn(user = user, refreshToken = TOKEN)
    override fun refreshToken(): String? = TOKEN
    override fun cachedWorkspaces(): List<Workspace>? = null
    override fun workspaces(): List<Workspace> = listOf(Workspace(id = WORKSPACE_ID, name = "Offline", role = "owner", createdAt = "2026-11-23T00:00:00Z"))
    override fun cachedTree(workspaceId: String): Tree? = null
    override fun tree(workspaceId: String): Tree = Tree(
        listOf(Notebook(id = "nb-offline", name = "Offline", color = "#6366f1", visibility = "shared", position = 0.0)),
        listOf(Section(id = "s-offline", notebookId = "nb-offline", parentId = null, name = "Tests", color = "#ec4899", position = 0.0)),
        listOf(PageMeta(id = PAGE_ID, sectionId = "s-offline", title = "Offline page", icon = null, position = 0.0, updatedAt = "2026-11-23T00:00:00Z", locked = false)),
    )

    override fun tasks(workspaceId: String): List<Task> = emptyList()
    override fun setTaskDone(taskId: String, done: Boolean): Task = throw BackendError.Other("Not available offline.")
    override fun cachedPage(pageId: String): PageInfo? = if (pageId == PAGE_ID) page.info() else null

    override fun openPage(pageId: String, events: PageEvents): PageHandle {
        if (pageId != PAGE_ID) throw BackendError.Other("No such page offline.")
        // The real core reports "synced" from its own thread a moment after opening.
        thread(isDaemon = true) {
            Thread.sleep(100)
            events.onStatus(PageStatus.Synced)
            events.onChange(page.info())
        }
        return OfflineHandle(page)
    }

    override fun signOut() {}

    companion object {
        const val PAGE_ID = "uitest"
        const val WORKSPACE_ID = "w-offline"
        private const val TOKEN = "offline-token"

        /** The first box is the page's document box (never deleted when empty), the second a plain box. */
        const val FIRST_BOX = "default"
        const val SECOND_BOX = "b2"
    }
}

/** Tasks made from box lines are kept in memory. */
private class MemoryTasks : TaskCallbacks {
    private val titles = HashMap<String, String>()
    private val gone = HashMap<String, String>()
    private var n = 0
    override fun newId(): String = "t-offline-${++n}"
    override fun create(id: String, title: String, done: Boolean) { titles[id] = title }
    override fun delete(id: String) { titles.remove(id)?.let { gone[id] = it } }
    override fun restore(id: String): Boolean = gone.remove(id)?.let { titles[id] = it; true } ?: false
    override fun title(id: String): String? = titles[id]
    override fun setTitle(id: String, title: String) { titles[id] = title }
}

/** The engine under the app's box view: closing it when editing ends would drop the box's text, so it stays open. */
private class KeepOpen(private val inner: TextEngine) : TextEngine by inner {
    override fun close() {}
    fun reallyClose() = inner.close()
}

private class OfflinePage {
    private val tasks = MemoryTasks()
    private val boxes = mutableListOf(
        PageBox(OfflineBackend.FIRST_BOX, 0.0, 0.0, 360.0, 1.0, false),
        PageBox(OfflineBackend.SECOND_BOX, 0.0, 220.0, 360.0, 2.0, false),
    )
    private val engines = LinkedHashMap<String, KeepOpen>()
    private var last: String = OfflineBackend.FIRST_BOX
    private var made = 0

    init {
        // The second box starts with a line of text, typed through the engine like anything else.
        engine(OfflineBackend.SECOND_BOX).insertText("Second box")
    }

    @Synchronized
    fun engine(id: String): KeepOpen = engines.getOrPut(id) {
        // An empty Yjs update: a fresh document with the `default` fragment, as the Windows offline mode does.
        KeepOpen(CoreTextEngine(EditorSession.open(byteArrayOf(0, 0), "default", tasks)))
    }

    @Synchronized
    fun edited(id: String): KeepOpen = engine(id).also { last = id }

    @Synchronized
    fun info(): PageInfo {
        val content = boxes.map { b ->
            val text = engines[b.id]?.render()?.view?.text.orEmpty()
            BoxContent(b.id, text.split('\n').map { line -> if (line.isEmpty()) el(NodeKind.Paragraph) else p(line.replace('￼', ' ')) })
        }
        return LookPage(boxes.toList(), content).info()
    }

    @Synchronized
    fun create(x: Double, y: Double, w: Double, z: Double): String {
        val id = "n${++made}"
        boxes += PageBox(id, x, y, w, z, false)
        return id
    }

    @Synchronized
    fun update(id: String, f: (PageBox) -> PageBox) {
        val i = boxes.indexOfFirst { it.id == id }
        if (i >= 0) boxes[i] = f(boxes[i])
    }

    @Synchronized
    fun delete(id: String) {
        if (id == OfflineBackend.FIRST_BOX) return
        boxes.removeAll { it.id == id }
        engines.remove(id)?.reallyClose()
    }

    @Synchronized
    fun lastEngine(): KeepOpen? = engines[last]
}

private class OfflineHandle(private val page: OfflinePage) : PageHandle {
    override fun info(): PageInfo = page.info()
    override fun ink(): List<InkShape> = emptyList()
    override fun openEditor(boxId: String, workspaceId: String): TextEngine = page.edited(boxId)
    override fun createBox(x: Double, y: Double, w: Double, z: Double): String = page.create(x, y, w, z)
    override fun moveBox(id: String, x: Double, y: Double) = page.update(id) { it.copy(x = x, y = y) }
    override fun resizeBox(id: String, w: Double) = page.update(id) { it.copy(w = w) }
    override fun deleteEmptyBox(id: String) = page.delete(id)
    override fun undo(): Boolean = page.lastEngine()?.undo() ?: false
    override fun redo(): Boolean = page.lastEngine()?.redo() ?: false
    override fun canUndo(): Boolean = page.lastEngine()?.render()?.canUndo ?: false
    override fun canRedo(): Boolean = page.lastEngine()?.render()?.canRedo ?: false
    override fun close() {}
}

/** A [SessionStore] that remembers nothing past the process (test mode). */
class MemorySessionStore(
    override var server: String = DEFAULT_SERVER,
    override var refreshToken: String? = null,
    override var workspaceId: String? = null,
    override var theme: String? = null,
) : SessionStore
