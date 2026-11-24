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
import com.notivelo.core.NewTaskInput
import com.notivelo.core.Task
import com.notivelo.core.TaskChanges
import com.notivelo.core.TaskDetail
import com.notivelo.core.TaskRecurrence
import com.notivelo.core.TaskTag
import com.notivelo.core.TaskTeam
import com.notivelo.core.parseQuickAdd
import com.notivelo.core.resolveMember
import com.notivelo.core.resolveTeam
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

    /** The workspace's tasks with every field (team, repeat rule, ...). Empty when unknown. */
    fun taskDetails(workspaceId: String): List<TaskDetail> = emptyList()
    fun teams(workspaceId: String): List<TaskTeam> = emptyList()
    fun tags(workspaceId: String): List<TaskTag> = emptyList()

    /** Change fields of a task; returns it as the server has it. */
    fun updateTask(taskId: String, changes: TaskChanges): TaskDetail = throw BackendError.Other("Editing tasks is not available.")
    fun deleteTask(taskId: String) {}

    /** Quick add: parses [text] (the web's words), resolves @people, #tags and +team, creates the task. [dueDate] is the default date. */
    fun quickAdd(workspaceId: String, text: String, today: String, meId: String, dueDate: String?, pageId: String?): Task =
        throw BackendError.Other("Adding tasks is not available.")

    fun createSubtask(workspaceId: String, parentId: String, pageId: String?, title: String): Task =
        throw BackendError.Other("Adding tasks is not available.")

    /** The first date of a repeat rule on or after [from] (YYYY-MM-DD), for a rule set on a task with no date. */
    fun firstOccurrence(rule: TaskRecurrence, from: String): String = from

    /** Upload a file into the workspace (onto the page when given). Blocking, up to 25 MB; the server's refusals come as [BackendError.Other] with its message. */
    fun uploadFile(workspaceId: String, pageId: String?, filename: String, data: ByteArray): Uploaded =
        throw BackendError.Other("Uploads are not available.")

    /** A stored file's bytes (`/uploads/...`), fetched with the session. Blocking. */
    fun downloadFile(url: String): Downloaded = throw BackendError.Other("Files are not available.")

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

    /** Box calls (written with the core's geometry origin, so they join the page's undo). Page pixels from the page origin. */
    fun createBox(x: Double, y: Double, w: Double, z: Double): String = throw UnsupportedOperationException("not editable")
    fun moveBox(id: String, x: Double, y: Double) {}
    fun resizeBox(id: String, w: Double) {}
    fun bringToFront(id: String) {}

    /** Remove a box that holds nothing (the core refuses one with content). */
    fun deleteEmptyBox(id: String) {}

    /** Ink: one stroke from its samples (six numbers each: x, y, pressure, altitude, azimuth, t ms; page points), one undo step. [color] is 0xRRGGBBAA. */
    fun addInkStroke(tool: Int, color: Long, width: Float, pressure: Boolean, samples: DoubleArray) {}

    /** Ink: erase along a track (x, y pairs, page points) with a disc of [radius]; [partial] cuts strokes instead of deleting them. One undo step. */
    fun eraseInk(track: FloatArray, radius: Float, partial: Boolean) {}

    /** The page's one undo stack (text, ink, boxes). */
    fun undo(): Boolean = false
    fun redo(): Boolean = false
    fun canUndo(): Boolean = false
    fun canRedo(): Boolean = false
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
    override fun taskDetails(workspaceId: String): List<TaskDetail> = call { current().taskDetails(workspaceId) }
    override fun teams(workspaceId: String): List<TaskTeam> = call { current().teams(workspaceId) }
    override fun tags(workspaceId: String): List<TaskTag> = call { current().tags(workspaceId) }
    override fun updateTask(taskId: String, changes: TaskChanges): TaskDetail = call { current().updateTask(taskId, changes) }
    override fun deleteTask(taskId: String) = call { current().deleteTask(taskId) }
    override fun firstOccurrence(rule: TaskRecurrence, from: String): String = try { com.notivelo.core.firstOccurrence(rule, from) } catch (e: Exception) { from }

    override fun createSubtask(workspaceId: String, parentId: String, pageId: String?, title: String): Task = call {
        current().createTaskWith(workspaceId, NewTaskInput(title = title, pageId = pageId, parentId = parentId))
    }

    override fun quickAdd(workspaceId: String, text: String, today: String, meId: String, dueDate: String?, pageId: String?): Task = call {
        val core = current()
        val r = parseQuickAdd(text, today)
        val people = try { core.members(workspaceId) } catch (e: CoreException) { emptyList() }
        val teams = try { core.teams(workspaceId) } catch (e: CoreException) { emptyList() }
        val known = try { core.tags(workspaceId) } catch (e: CoreException) { emptyList() }
        var title = r.title
        val mentioned = r.assignee?.let { resolveMember(it, people, meId) }
        // As the web: an @name nobody matches stays in the title, and the task is yours.
        if (r.assignee != null && mentioned == null) title += " @" + r.assignee
        val teamId = r.team?.let { resolveTeam(it, teams) }
        if (r.team != null && teamId == null) title += " +" + r.team
        val tagIds = r.tags.map { name -> known.firstOrNull { it.name.equals(name, ignoreCase = true) }?.id ?: core.createTag(workspaceId, name, "#6b7280").id }
        core.createTaskWith(
            workspaceId,
            NewTaskInput(
                title = title.trim(), pageId = pageId, dueDate = r.dueDate ?: dueDate, dueTime = r.dueTime,
                priority = (r.priority ?: 4.toUByte()), recurrence = r.recurrence,
                assigneeId = mentioned ?: meId, teamId = teamId, tagIds = tagIds.ifEmpty { null },
            ),
        )
    }

    override fun uploadFile(workspaceId: String, pageId: String?, filename: String, data: ByteArray): Uploaded = call {
        val f = current().uploadFile(workspaceId, pageId, filename, data)
        Uploaded(f.url, f.name, f.mime, f.size.toLong())
    }

    override fun downloadFile(url: String): Downloaded = call {
        val f = current().downloadFile(url)
        Downloaded(f.bytes, f.mime)
    }

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

    override fun createBox(x: Double, y: Double, w: Double, z: Double): String = boxCall { page.createBox(x, y, w, z) }
    override fun moveBox(id: String, x: Double, y: Double) = boxCall { page.moveBox(id, x, y) }
    override fun resizeBox(id: String, w: Double) = boxCall { page.resizeBox(id, w) }
    override fun bringToFront(id: String) { boxCall { page.bringToFront(id) } }
    override fun deleteEmptyBox(id: String) = boxCall { page.deleteBox(id) }
    override fun addInkStroke(tool: Int, color: Long, width: Float, pressure: Boolean, samples: DoubleArray) {
        boxCall { page.addInkStrokeFromSamples(tool.toUByte(), color.toUInt(), width, pressure, false, samples.toList()) }
    }

    override fun eraseInk(track: FloatArray, radius: Float, partial: Boolean) {
        boxCall { page.eraseInk(track.toList(), radius, partial) }
    }

    override fun undo(): Boolean = boxCall { page.undo() }
    override fun redo(): Boolean = boxCall { page.redo() }
    override fun canUndo(): Boolean = page.canUndo()
    override fun canRedo(): Boolean = page.canRedo()

    private fun <T> boxCall(block: () -> T): T = try {
        block()
    } catch (e: Exception) {
        throw BackendError.Other(e.message ?: "The page could not be changed.")
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
