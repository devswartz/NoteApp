package com.notivelo.app.data

import com.notivelo.core.Core
import com.notivelo.core.CoreException
import com.notivelo.core.SignedIn
import com.notivelo.core.Task
import com.notivelo.core.Tree
import com.notivelo.core.Workspace

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
    fun signOut()
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

    override fun signOut() {
        core?.signOut()
    }
}
