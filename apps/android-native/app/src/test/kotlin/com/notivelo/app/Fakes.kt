package com.notivelo.app

import com.notivelo.app.data.Backend
import com.notivelo.app.data.BackendError
import com.notivelo.app.data.InkShape
import com.notivelo.app.data.PageEvents
import com.notivelo.app.data.PageHandle
import com.notivelo.app.data.SessionStore
import com.notivelo.core.Notebook
import com.notivelo.core.PageMeta
import com.notivelo.core.Section
import com.notivelo.core.SignedIn
import com.notivelo.core.Task
import com.notivelo.core.TaskChanges
import com.notivelo.core.TaskDetail
import com.notivelo.core.TaskRecurrence
import com.notivelo.core.TaskTag
import com.notivelo.core.TaskTeam
import com.notivelo.app.data.toTask
import com.notivelo.app.data.with
import com.notivelo.core.Tree
import com.notivelo.core.User
import com.notivelo.core.Workspace

val demoUser = User(id = "u1", email = "demo@example.com", name = "Demo User", color = "#f59e0b", emailVerified = true)

fun workspace(id: String, name: String = id) = Workspace(id = id, name = name, role = "owner", createdAt = "2026-11-21T00:00:00Z")

fun notebook(id: String, name: String = id, position: Double = 0.0) =
    Notebook(id = id, name = name, color = "#6366f1", visibility = "shared", position = position)

fun section(id: String, notebook: String, name: String = id, position: Double = 0.0, parent: String? = null) =
    Section(id = id, notebookId = notebook, parentId = parent, name = name, color = "#ec4899", position = position)

fun page(id: String, section: String, title: String = id, position: Double = 0.0, updatedAt: String = "2026-11-21T10:00:00Z") =
    PageMeta(id = id, sectionId = section, title = title, icon = null, position = position, updatedAt = updatedAt, locked = false)

class MemoryStore(
    override var server: String = "https://example.test",
    override var refreshToken: String? = null,
    override var workspaceId: String? = null,
    override var theme: String? = null,
) : SessionStore

/** A [Backend] that answers from maps, or throws what a test sets. */
class FakeBackend : Backend {
    var token = "rt-1"
    var failSignIn: BackendError? = null
    var failRestore: BackendError? = null
    var failWorkspaces: BackendError? = null
    var failTree: BackendError? = null
    var workspaces = listOf(workspace("w1", "First"), workspace("w2", "Second"))
    var trees = mapOf<String, Tree>()
    var tasks = listOf<Task>()
    var cachedTrees = mapOf<String, Tree>()
    var cachedWorkspaces: List<Workspace>? = null
    val calls = mutableListOf<String>()
    var signedOut = false

    override fun signIn(server: String, email: String, password: String): SignedIn {
        calls += "signIn:$server:$email"
        failSignIn?.let { throw it }
        return SignedIn(user = demoUser, refreshToken = token)
    }

    override fun restore(server: String, refreshToken: String): SignedIn {
        calls += "restore:$refreshToken"
        failRestore?.let { throw it }
        token = "rt-rotated"
        return SignedIn(user = demoUser, refreshToken = token)
    }

    override fun refreshToken(): String? = token

    override fun cachedWorkspaces(): List<Workspace>? = cachedWorkspaces

    override fun workspaces(): List<Workspace> {
        calls += "workspaces"
        failWorkspaces?.let { throw it }
        return workspaces
    }

    override fun cachedTree(workspaceId: String): Tree? = cachedTrees[workspaceId]

    override fun tree(workspaceId: String): Tree {
        calls += "tree:$workspaceId"
        failTree?.let { throw it }
        return trees[workspaceId] ?: Tree(emptyList(), emptyList(), emptyList())
    }

    override fun tasks(workspaceId: String): List<Task> = tasks

    var failSetDone: BackendError? = null
    val doneCalls = mutableListOf<Pair<String, Boolean>>()

    override fun setTaskDone(taskId: String, done: Boolean): Task {
        doneCalls += taskId to done
        failSetDone?.let { throw it }
        return tasks.first { it.id == taskId }.copy(done = done, completedAt = if (done) "2026-11-21T12:00:00Z" else null)
    }

    var details = listOf<TaskDetail>()
    var teams = listOf<TaskTeam>()
    var tags = listOf<TaskTag>()
    var failUpdate: BackendError? = null
    var failDelete: BackendError? = null
    val updates = mutableListOf<Pair<String, TaskChanges>>()
    val deleted = mutableListOf<String>()
    val quickAdds = mutableListOf<String>()
    val subtasks = mutableListOf<String>()

    override fun taskDetails(workspaceId: String): List<TaskDetail> = details
    override fun teams(workspaceId: String): List<TaskTeam> = teams
    override fun tags(workspaceId: String): List<TaskTag> = tags
    override fun firstOccurrence(rule: TaskRecurrence, from: String): String = "first:$from"

    override fun updateTask(taskId: String, changes: TaskChanges): TaskDetail {
        updates += taskId to changes
        failUpdate?.let { throw it }
        val d = details.firstOrNull { it.id == taskId } ?: detailOf(tasks.first { it.id == taskId })
        return d.with(changes)
    }

    override fun deleteTask(taskId: String) {
        deleted += taskId
        failDelete?.let { throw it }
    }

    override fun quickAdd(workspaceId: String, text: String, today: String, meId: String, dueDate: String?, pageId: String?): Task {
        quickAdds += "$text|$today|$dueDate"
        return tasks.firstOrNull()?.copy(id = "new-${quickAdds.size}", title = text, dueDate = dueDate) ?: error("no task to copy")
    }

    override fun createSubtask(workspaceId: String, parentId: String, pageId: String?, title: String): Task {
        subtasks += "$parentId|$title"
        return tasks.first().copy(id = "sub-${subtasks.size}", title = title, parentId = parentId)
    }

    val openedPages = mutableListOf<String>()
    val closedPages = mutableListOf<String>()
    val openedBoxes = mutableListOf<String>()
    val engines = mutableListOf<com.notivelo.app.edit.FakeTextEngine>()
    var editorText = "hi"

    /** What the open page was asked to do, in order ("create 10,20", "move b1 5,6", "resize b1 200", "delete b1", "undo", "redo"). */
    val pageCalls = mutableListOf<String>()
    var canUndo = false
    var canRedo = false
    var failBox: BackendError? = null

    var uploaded = com.notivelo.app.data.Uploaded("/uploads/abc.png", "pic.png", "image/png", 4)
    var failUpload: BackendError? = null
    var download = com.notivelo.app.data.Downloaded(byteArrayOf(1, 2, 3), "application/pdf")
    val uploads = mutableListOf<String>()
    val downloads = mutableListOf<String>()

    override fun uploadFile(workspaceId: String, pageId: String?, filename: String, data: ByteArray): com.notivelo.app.data.Uploaded {
        uploads += "$workspaceId|$pageId|$filename|${data.size}"
        failUpload?.let { throw it }
        return uploaded
    }

    override fun downloadFile(url: String): com.notivelo.app.data.Downloaded {
        downloads += url
        return download
    }

    override fun cachedPage(pageId: String): com.notivelo.core.PageInfo? = null

    override fun openPage(pageId: String, events: PageEvents): PageHandle {
        openedPages += pageId
        return object : PageHandle {
            override fun info(): com.notivelo.core.PageInfo = error("no page content in the fake")
            override fun ink(): List<InkShape> = emptyList()
            override fun openEditor(boxId: String, workspaceId: String): com.notivelo.app.edit.TextEngine {
                openedBoxes += "$boxId@$workspaceId"
                return com.notivelo.app.edit.FakeTextEngine(editorText).also { engines += it }
            }

            override fun createBox(x: Double, y: Double, w: Double, z: Double): String {
                failBox?.let { throw it }
                pageCalls += "create ${x.toInt()},${y.toInt()} w=${w.toInt()} z=${z.toInt()}"
                return "nb"
            }

            override fun moveBox(id: String, x: Double, y: Double) {
                failBox?.let { throw it }
                pageCalls += "move $id ${x.toInt()},${y.toInt()}"
            }

            override fun resizeBox(id: String, w: Double) {
                pageCalls += "resize $id ${w.toInt()}"
            }

            override fun deleteEmptyBox(id: String) {
                pageCalls += "delete $id"
            }

            override fun addInkStroke(tool: Int, color: Long, width: Float, pressure: Boolean, samples: DoubleArray) {
                failBox?.let { throw it }
                pageCalls += "stroke tool=$tool color=${java.lang.Long.toHexString(color)} w=$width pressure=$pressure n=${samples.size / 6}"
            }

            override fun eraseInk(track: FloatArray, radius: Float, partial: Boolean) {
                pageCalls += "erase n=${track.size / 2} r=$radius partial=$partial"
            }

            override fun undo(): Boolean {
                pageCalls += "undo"
                return true
            }

            override fun redo(): Boolean {
                pageCalls += "redo"
                return true
            }

            override fun canUndo(): Boolean = this@FakeBackend.canUndo
            override fun canRedo(): Boolean = this@FakeBackend.canRedo
            override fun close() {
                closedPages += pageId
            }
        }
    }

    override fun signOut() {
        signedOut = true
    }
}

fun detailOf(t: Task, team: String? = null, recurrence: TaskRecurrence? = null) = TaskDetail(
    id = t.id, workspaceId = t.workspaceId, title = t.title, description = t.description, done = t.done, priority = t.priority,
    dueDate = t.dueDate, dueTime = t.dueTime, recurrence = recurrence, reminderAt = null, assigneeId = t.assigneeId, assignedBy = null,
    createdBy = "u1", completedBy = null, pageId = t.pageId, parentId = t.parentId, teamId = team, tagIds = t.tagIds,
    checklistDone = t.checklistDone, checklistTotal = t.checklistTotal, completedAt = t.completedAt, createdAt = t.createdAt,
    updatedAt = t.updatedAt, locked = t.locked,
)
