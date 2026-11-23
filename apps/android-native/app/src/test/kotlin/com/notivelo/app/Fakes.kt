package com.notivelo.app

import com.notivelo.app.data.Backend
import com.notivelo.app.data.BackendError
import com.notivelo.app.data.SessionStore
import com.notivelo.core.Notebook
import com.notivelo.core.PageMeta
import com.notivelo.core.Section
import com.notivelo.core.SignedIn
import com.notivelo.core.Task
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

    override fun signOut() {
        signedOut = true
    }
}
