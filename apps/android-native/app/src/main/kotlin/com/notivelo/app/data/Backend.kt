package com.notivelo.app.data

import com.notivelo.app.edit.CoreTextEngine
import com.notivelo.app.edit.TextEngine
import com.notivelo.core.Core
import com.notivelo.core.CoreException
import com.notivelo.core.EditorSession
import com.notivelo.core.LiveEnd
import com.notivelo.core.LivePage
import com.notivelo.core.LivePageListener
import com.notivelo.core.LiveStatus
import com.notivelo.core.PageInfo
import com.notivelo.core.readPage
import com.notivelo.core.SignedIn
import com.notivelo.core.Task
import com.notivelo.core.Tree
import com.notivelo.core.Workspace
import com.notivelo.core.WorkspaceMember

const val DEFAULT_SERVER = "https://app.notiveloapp.com"

/** What the app needs from the server, in the core's own record types. Blocking: call from `Dispatchers.IO`. */
interface Backend {
    fun signIn(server: String, email: String, password: String): SignedIn

    /** Resume a session from its refresh token. [BackendError.SignedOut] when it no longer works. */
    fun restore(server: String, refreshToken: String): SignedIn

    /** The current refresh token (it rotates: store it again after calls). */
    fun refreshToken(): String?
    fun cachedWorkspaces(): List<Workspace>?
    fun workspaces(): List<Workspace>
    fun cachedTree(workspaceId: String): Tree?
    fun tree(workspaceId: String): Tree
    fun tasks(workspaceId: String): List<Task>

    /** The workspace's people, for the `@` menu. Empty when unknown. */
    fun members(workspaceId: String): List<WorkspaceMember> = emptyList()

    /** Tick or untick a task; returns it as the server has it. */
    fun setTaskDone(taskId: String, done: Boolean): Task

    /** The page as last stored on the device, if any (instant). */
    fun cachedPage(pageId: String): PageInfo?

    /** Open a page live: [events] are called on a core thread. [PageHandle.close] ends it. */
    fun openPage(pageId: String, events: PageEvents): PageHandle
    fun signOut()
}

interface PageEvents {
    fun onStatus(status: PageStatus)
    fun onChange(info: PageInfo)
}

interface PageHandle {
    fun info(): PageInfo

    /** The strokes in drawing order, with their outlines. */
    fun ink(): List<InkShape>

    /** A text engine on one box of this page (`box:<id>`, or `default`): its edits go into the live page. */
    fun openEditor(boxId: String, workspaceId: String): TextEngine = throw UnsupportedOperationException("not editable")
    fun close()
}

/** The failures the screens tell apart. */
sealed class BackendError(message: String) : Exception(message) {
    /** The session is gone or the credentials were refused. */
    object SignedOut : BackendError("Signed out")

    /** The server could not be reached. */
    class Offline(message: String) : BackendError(message)

    class Other(message: String) : BackendError(message)
}

/** The Rust core (crates/nv-core) behind [Backend]: one store file in the app's private files. */
class CoreBackend(private val storePath: String) : Backend {
    private var core: Core? = null
    private var coreServer: String? = null

    @Synchronized
    private fun core(server: String): Core {
        val url = server.trim().trimEnd('/')
        val existing = core
        if (existing != null && coreServer == url) return existing
        existing?.close()
        return Core.withStore(url, storePath).also {
            core = it
            coreServer = url
        }
    }

    @Synchronized
    private fun current(): Core = core ?: throw BackendError.SignedOut

    private fun <T> call(block: () -> T): T = try {
        block()
    } catch (e: CoreException) {
        throw map(e)
    }

    private fun map(e: CoreException): BackendError = when (e) {
        is CoreException.SignedOut -> BackendError.SignedOut
        is CoreException.Network -> BackendError.Offline(e.message ?: "Network error")
        is CoreException.Server -> BackendError.Other(e.details)
        else -> BackendError.Other(e.message ?: "Something went wrong")
    }

    override fun signIn(server: String, email: String, password: String): SignedIn =
        call { core(server).signIn(email, password) }

    override fun restore(server: String, refreshToken: String): SignedIn =
        call { core(server).restoreSession(refreshToken) }

    override fun refreshToken(): String? = current().refreshToken()
    override fun cachedWorkspaces(): List<Workspace>? = core?.cachedWorkspaces()
    override fun workspaces(): List<Workspace> = call { current().workspaces() }
    override fun cachedTree(workspaceId: String): Tree? = core?.cachedTree(workspaceId)
    override fun tree(workspaceId: String): Tree = call { current().tree(workspaceId) }
    override fun tasks(workspaceId: String): List<Task> = call { current().tasks(workspaceId) }

    override fun setTaskDone(taskId: String, done: Boolean): Task = call { current().setTaskDone(taskId, done) }

    override fun members(workspaceId: String): List<WorkspaceMember> = call { current().members(workspaceId) }

    override fun cachedPage(pageId: String): PageInfo? = try {
        core?.cachedPageDocument(pageId)?.let { readPage(it) }
    } catch (e: Exception) {
        null
    }

    override fun openPage(pageId: String, events: PageEvents): PageHandle {
        val page = call {
            current().openLivePage(pageId, object : LivePageListener {
                override fun onStatus(status: LiveStatus) {
                    events.onStatus(
                        when (status) {
                            is LiveStatus.Synced -> PageStatus.Synced
                            is LiveStatus.Reconnecting -> PageStatus.Offline
                            is LiveStatus.Ended -> if (status.reason == LiveEnd.NO_ACCESS) PageStatus.NoAccess else PageStatus.Ended
                            else -> PageStatus.Connecting
                        },
                    )
                }

                override fun onChange(page: PageInfo) = events.onChange(page)
            })
        }
        return CorePageHandle(page, current(), pageId)
    }

    override fun signOut() {
        core?.signOut()
    }
}

private class CorePageHandle(private val page: LivePage, private val core: Core, private val pageId: String) : PageHandle {
    override fun info(): PageInfo = page.info()

    override fun openEditor(boxId: String, workspaceId: String): TextEngine {
        val field = if (boxId == "default") "default" else "box:$boxId"
        val tasks = core.pageTasks(workspaceId, pageId)
        return CoreTextEngine(EditorSession.openLive(page, field, tasks))
    }

    override fun ink(): List<InkShape> = page.inkStrokes().filter { it.readable }.mapNotNull { s ->
        val ops = page.inkOutline(s.id)
        if (ops.isEmpty()) {
            null
        } else {
            val c = s.color.toLong()
            // 0xRRGGBBAA as stored to ARGB.
            val argb = (((c and 0xFF) shl 24) or ((c shr 8) and 0xFFFFFF)).toInt()
            InkShape(s.id, s.tool.toInt() == 1, argb, ops.toFloatArray())
        }
    }

    override fun close() {
        try {
            page.shutdown()
        } finally {
            page.close()
        }
    }
}
