package com.notivelo.app.look

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import com.notivelo.app.data.AppState
import com.notivelo.app.data.NoActions
import com.notivelo.app.data.Phase
import com.notivelo.app.ui.LocalNow
import com.notivelo.app.ui.NotiveloRoot
import com.notivelo.core.Notebook
import com.notivelo.core.PageMeta
import com.notivelo.core.Section
import com.notivelo.core.Tree
import com.notivelo.core.User
import com.notivelo.core.Workspace
import java.time.Instant

/** One screenshot state: the app state, the theme, and what is open on top. */
class LookScene(
    val state: AppState,
    val mode: ThemeMode = ThemeMode.Light,
    val drawerOpen: Boolean = false,
)

/**
 * The look-reference data, in memory (docs/rewrite/look/seed.ts, as the Apple app's `LookData`): the demo user,
 * workspace "Demo Team" with the notebooks of the demo seed and "Look reference" (section "Corpus" with the corpus
 * pages, an "Empty section"), and "Empty Space". The screenshot tests and a debug build's `lookState` extra
 * (`MainActivity`) render the same scenes, so the CI shots show the states of `docs/rewrite/look/reference/`
 * without a server.
 */
object LookData {
    /** Relative times ("12m ago") are measured from here, so the shots are the same every run. */
    val now: Instant = Instant.parse("2026-11-21T12:00:00Z")

    private fun ago(minutes: Double): String = now.minusSeconds((minutes * 60).toLong()).toString()

    val user = User(id = "demo", email = "demo@example.com", name = "Demo User", color = "#f59e0b", emailVerified = true)

    val workspaces = listOf(
        Workspace(id = "demos-space", name = "Demo's Space", role = "owner", createdAt = "2026-11-21T00:00:00Z"),
        Workspace(id = "demo-team", name = "Demo Team", role = "owner", createdAt = "2026-11-21T00:00:00Z"),
        Workspace(id = "empty-space", name = "Empty Space", role = "owner", createdAt = "2026-11-21T00:00:00Z"),
    )

    /** seed.ts ORDER with the titles the corpus cases carry. */
    private val corpusPages = listOf("canvas" to "Canvas", "sandbox" to "Sandbox", "blocks" to "Blocks", "lists" to "Lists", "tasks" to "Tasks",
        "settings" to "Settings and ink", "document" to "Document page", "geometry" to "Geometry", "converted" to "Converted")

    fun pageId(name: String) = "corpus:$name"

    private fun nb(id: String, name: String, color: String, position: Double, visibility: String = "shared") =
        Notebook(id = id, name = name, color = color, visibility = visibility, position = position)

    private fun sec(id: String, notebook: String, name: String, color: String, position: Double) =
        Section(id = id, notebookId = notebook, parentId = null, name = name, color = color, position = position)

    private fun page(id: String, section: String, title: String, position: Double, minutes: Double, icon: String? = null) =
        PageMeta(id = id, sectionId = section, title = title, icon = icon, position = position, updatedAt = ago(minutes), locked = false)

    val demoTeamTree: Tree = Tree(
        notebooks = listOf(
            nb("team", "Team Notebook", "#6366f1", 0.0),
            nb("look", "Look reference", "#ec4899", 1.0),
            nb("product", "Product", "#6366f1", 2.0),
            nb("engineering", "Engineering", "#10b981", 3.0),
            nb("marketing", "Marketing", "#f59e0b", 4.0),
            nb("personal", "Personal (private)", "#8b5cf6", 5.0, visibility = "private"),
        ),
        sections = listOf(
            sec("getting-started", "team", "Getting started", "#6366f1", 1.0),
            sec("corpus", "look", "Corpus", "#ec4899", 1.0),
            sec("empty-section", "look", "Empty section", "#14b8a6", 2.0),
            sec("roadmap", "product", "Roadmap", "#6366f1", 1.0),
            sec("meetings", "product", "Meetings", "#0ea5e9", 2.0),
        ),
        pages = listOf(
            page("welcome", "getting-started", "Welcome 👋", 1.0, 13.8),
            page("q4-roadmap", "roadmap", "Q4 roadmap", 1.0, 13.0, icon = "🗺️"),
            page("weekly-sync", "meetings", "Weekly sync · Saturday 21 November", 1.0, 13.1, icon = "🤝"),
        ) + corpusPages.mapIndexed { i, (name, title) ->
            page(pageId(name), "corpus", title, i + 1.0, when (name) {
                "sandbox" -> 1.0
                "canvas" -> 12.0
                else -> 13.3 + i * 0.1
            })
        },
    )

    val emptyTree = Tree(notebooks = emptyList(), sections = emptyList(), pages = emptyList())

    /** Open tasks per page (the counts beside the page rows: Canvas 1, Sandbox 1, Tasks 2). */
    val taskCounts = mapOf(pageId("canvas") to 1, pageId("sandbox") to 1, pageId("tasks") to 2)

    private fun signedIn(workspace: String, tree: Tree, counts: Map<String, Int> = taskCounts, edit: AppState.() -> AppState = { this }) =
        AppState(
            phase = Phase.SignedIn, user = user, workspaces = workspaces, workspaceId = workspace, tree = tree,
            taskCounts = counts, notebookId = tree.notebooks.firstOrNull { it.id == "look" }?.id ?: tree.notebooks.firstOrNull()?.id,
        ).edit()

    private val signedOut = AppState(phase = Phase.SignedOut)

    /** The scene for a state name (the reference file name without `.png`), or null. */
    fun scene(name: String): LookScene? = when (name) {
        "sign-in" -> LookScene(signedOut, ThemeMode.Light)
        "dark-sign-in" -> LookScene(signedOut, ThemeMode.Dark)
        "hybrid-sign-in" -> LookScene(signedOut, ThemeMode.Hybrid)
        // Phone
        "notes-home" -> LookScene(signedIn("demo-team", demoTeamTree))
        "sidebar-drawer" -> LookScene(signedIn("demo-team", demoTeamTree) { copy(notebookId = "product", sectionId = "roadmap") }, drawerOpen = true)
        "dark-sidebar-drawer" ->
            LookScene(signedIn("demo-team", demoTeamTree) { copy(sectionId = "corpus", phoneNotebookId = "look") }, ThemeMode.Dark, drawerOpen = true)
        "hybrid-sidebar-drawer" ->
            LookScene(signedIn("demo-team", demoTeamTree) { copy(sectionId = "corpus", phoneNotebookId = "look") }, ThemeMode.Hybrid, drawerOpen = true)
        "empty-workspace-notes" -> LookScene(signedIn("empty-space", emptyTree, emptyMap()))
        "empty-workspace-drawer" -> LookScene(signedIn("empty-space", emptyTree, emptyMap()), drawerOpen = true)
        "empty-section" -> LookScene(signedIn("demo-team", demoTeamTree) { copy(phoneNotebookId = "look", sectionId = "empty-section") })
        // Tablet (the same names where the reference exists; `sidebar` is the sidebar column with Canvas open)
        "empty-no-page" -> LookScene(signedIn("demo-team", demoTeamTree) { copy(sectionId = "corpus") })
        "sidebar" -> LookScene(signedIn("demo-team", demoTeamTree) { copy(sectionId = "corpus", pageId = pageId("canvas")) })
        else -> null
    }
}

/** A look scene as the app draws it: theme, root, fixed clock, no actions. */
@Composable
fun LookRoot(name: String) {
    val scene = LookData.scene(name) ?: error("Unknown look state: $name")
    CompositionLocalProvider(LocalNow provides LookData.now) {
        NotiveloTheme(scene.mode) {
            NotiveloRoot(
                state = scene.state,
                actions = NoActions,
                initialDrawerOpen = scene.drawerOpen,
                initialSidebarOpen = true,
                emailFocusedLook = true,
                handleBack = false,
            )
        }
    }
}
