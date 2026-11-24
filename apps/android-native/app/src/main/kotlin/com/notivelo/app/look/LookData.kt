package com.notivelo.app.look

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import com.notivelo.app.edit.EditingBox
import com.notivelo.app.edit.LineSpec
import com.notivelo.app.edit.LocalLookEdit
import com.notivelo.app.edit.StaticEngine
import com.notivelo.app.edit.StaticRender
import com.notivelo.app.data.AppState
import com.notivelo.app.data.NoActions
import com.notivelo.app.data.Phase
import com.notivelo.app.ui.LocalNow
import com.notivelo.app.ui.NotiveloRoot
import com.notivelo.core.Notebook
import com.notivelo.core.PageMeta
import com.notivelo.core.Section
import com.notivelo.core.Task
import com.notivelo.app.data.PageStatus
import com.notivelo.app.data.PageView
import com.notivelo.app.data.Tab
import com.notivelo.app.data.TaskList
import com.notivelo.app.ui.LocalToday
import java.time.LocalDate
import com.notivelo.core.Tree
import com.notivelo.core.User
import com.notivelo.core.Workspace
import java.time.Instant

/** One screenshot state: the app state, the theme, and what is open on top. */
class LookScene(
    val state: AppState,
    val mode: ThemeMode = ThemeMode.Light,
    val drawerOpen: Boolean = false,
    /** The sidebar on tablets: open, or null for the width's default (closed below 900 dp). */
    val sidebar: Boolean? = true,
    /** The page's scroll position in px (the `-2` references are scrolled). */
    val scrollPx: Int = 0,
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

    /** "Today" of the look data: Saturday 21 November 2026, as in the reference captures. */
    val today: LocalDate = LocalDate.of(2026, 11, 21)

    private fun day(offset: Int) = today.plusDays(offset.toLong()).toString()

    private fun task(
        id: String, title: String, due: Int? = null, priority: Int = 4, page: String? = null, assignee: String? = "demo",
        done: Boolean = false, parent: String? = null, time: String? = null, checklist: Pair<Int, Int>? = null,
    ) = Task(
        id = id, workspaceId = "demo-team", title = title, description = "", done = done, priority = priority.toUByte(),
        dueDate = due?.let(::day), dueTime = time, assigneeId = assignee, pageId = page, parentId = parent, tagIds = emptyList(),
        checklistDone = checklist?.first?.toUInt(), checklistTotal = checklist?.second?.toUInt(),
        completedAt = if (done) "2026-11-21T11:30:00Z" else null, createdAt = ago(10.0), updatedAt = ago(30.0), locked = false,
    )

    /** The demo seed's tasks as the Tasks views show them: 3 for Today (1 overdue), 7 in the next two weeks, 15 assigned to the
     *  demo user, 1 done today, plus the task lines of the corpus pages and the meeting notes. */
    val tasks: List<Task> = buildList {
        add(task("t-review", "Review the launch checklist", due = -1, priority = 1))
        add(task("t-try", "Try checking off this task — it also completes on the Tasks dashboard", due = 0, priority = 2, page = "welcome"))
        add(task("t-notes", "Send the meeting notes to the team", due = 0, priority = 2, page = "weekly-sync"))
        add(task("t-done", "Book the venue", due = 0, done = true))
        val upcoming = listOf("Draft the Q4 roadmap", "Prepare the demo", "Plan the offsite", "Write the release notes", "Interview candidates", "Update the onboarding guide", "Review the budget")
        upcoming.forEachIndexed { i, t -> add(task("t-up$i", t, due = 1 + i * 2, priority = if (i == 0) 3 else 4)) }
        listOf("Clean up old pages", "Try the mobile app", "Invite a teammate", "Set up a template", "Read the guide").forEachIndexed { i, t -> add(task("t-later$i", t)) }
        add(task("tb", "Task in box b", page = pageId("canvas"), assignee = null))
        add(task("t1", "Write the plan", due = 9, page = pageId("tasks"), assignee = null, checklist = 1 to 2))
        add(task("t2", "Ship it", page = pageId("tasks"), assignee = null, done = true))
        add(task("t3", "Subtask", parent = "t1", assignee = null))
        add(task("m-pricing", "Finalise launch pricing", due = 2, priority = 1, page = "weekly-sync", assignee = "sam"))
        add(task("m-sub1", "Check competitor pricing pages", due = 1, parent = "m-pricing", assignee = "sam"))
        add(task("m-sub2", "Draft three pricing options", due = 2, parent = "m-pricing", assignee = "sam"))
        add(task("m-standup", "Prepare the weekly sync agenda", due = 6, time = "09:30", page = "weekly-sync", assignee = "sam"))
    }

    val otherPageTitles = mapOf("welcome" to "Welcome 👋", "weekly-sync" to "Weekly sync · Saturday 21 November",
        "launch" to "Launch plan", "spec" to "Search architecture", "page-2" to "Canvas")

    /** What a page id opens: the corpus pages and the two demo pages. */
    private fun pageOf(id: String): LookPage? = when (id) {
        pageId("canvas"), pageId("sandbox") -> LookPages.canvasBoxes
        pageId("blocks") -> LookPages.blocks
        pageId("lists") -> LookPages.lists
        pageId("tasks") -> LookPages.tasks
        pageId("settings") -> LookPages.settingsAndInk
        "weekly-sync" -> LookDemoPages.meeting
        "q4-roadmap" -> LookDemoPages.roadmap
        else -> null
    }

    private fun signedIn(workspace: String, tree: Tree, counts: Map<String, Int> = taskCounts, edit: AppState.() -> AppState = { this }) =
        AppState(
            phase = Phase.SignedIn, user = user, workspaces = workspaces, workspaceId = workspace, tree = tree,
            taskCounts = counts, notebookId = tree.notebooks.firstOrNull { it.id == "look" }?.id ?: tree.notebooks.firstOrNull()?.id,
            tasks = if (workspace == "demo-team") tasks else emptyList(), preview = true, otherPageTitles = otherPageTitles,
        ).edit()

    /** A page open in a notebook and section (the page content as the core returns it). */
    private fun onPage(id: String, notebook: String, section: String): AppState.() -> AppState = {
        copy(
            notebookId = notebook, phoneNotebookId = notebook, sectionId = section, pageId = id,
            page = PageView(id, pageOf(id)?.info(), emptyList(), PageStatus.Synced),
        )
    }

    private val pageStates = mapOf(
        "page-canvas-boxes" to Triple(pageId("canvas"), "look", "corpus"),
        "page-blocks" to Triple(pageId("blocks"), "look", "corpus"),
        "page-lists" to Triple(pageId("lists"), "look", "corpus"),
        "page-tasks" to Triple(pageId("tasks"), "look", "corpus"),
        "page-settings-and-ink" to Triple(pageId("settings"), "look", "corpus"),
        "page-meeting" to Triple("weekly-sync", "product", "meetings"),
        "page-roadmap" to Triple("q4-roadmap", "product", "roadmap"),
    )

    private val taskStates = mapOf(
        "tasks-today" to TaskList.Today, "tasks-upcoming" to TaskList.Upcoming, "tasks-my" to TaskList.My, "tasks-all" to TaskList.All,
    )

    /** How far the `-2` references are scrolled (px at the shot's density; refined against the references). */
    private const val SCROLL = 800

    /** `[dark-|hybrid-]name[-2]` for the states with a page or task list. */
    private fun dataScene(full: String): LookScene? {
        val mode = when {
            full.startsWith("dark-") -> ThemeMode.Dark
            full.startsWith("hybrid-") -> ThemeMode.Hybrid
            else -> ThemeMode.Light
        }
        var name = full.removePrefix("dark-").removePrefix("hybrid-")
        val scrolled = name.endsWith("-2")
        if (scrolled) name = name.removeSuffix("-2")
        val demo = "demo-team"
        pageStates[name]?.let { (id, nb, sec) ->
            return LookScene(signedIn(demo, demoTeamTree, edit = onPage(id, nb, sec)), mode, sidebar = null, scrollPx = if (scrolled) SCROLL else 0)
        }
        taskStates[name]?.let { list ->
            return LookScene(signedIn(demo, demoTeamTree) { copy(tab = Tab.Tasks, taskList = list) }, mode, sidebar = null)
        }
        return when (name) {
            "empty-tasks-today" -> LookScene(signedIn("empty-space", emptyTree, emptyMap()) { copy(tab = Tab.Tasks, taskList = TaskList.Today) }, mode, sidebar = null)
            "empty-tasks-all" -> LookScene(signedIn("empty-space", emptyTree, emptyMap()) { copy(tab = Tab.Tasks, taskList = TaskList.All) }, mode, sidebar = null)
            "task-detail" -> LookScene(signedIn(demo, demoTeamTree) { copy(tab = Tab.Tasks, taskList = TaskList.My, taskDetailId = "t-review") }, mode, sidebar = null)
            else -> null
        }
    }

    private val signedOut = AppState(phase = Phase.SignedOut)

    /** A box of the Canvas page being edited, with the engine's frame fixed: caret, selection, or the slash menu open. */
    private fun editScene(full: String): LookScene? {
        val mode = when {
            full.startsWith("dark-") -> ThemeMode.Dark
            full.startsWith("hybrid-") -> ThemeMode.Hybrid
            else -> ThemeMode.Light
        }
        val box = full.removePrefix("dark-").removePrefix("hybrid-")
        val box_c = listOf(LineSpec("Right lower", "heading", 2), LineSpec("Box c"))
        val editing = when (box) {
            "edit-caret" -> EditingBox("c", StaticEngine(StaticRender.of(box_c, 17)))
            "edit-selection" -> EditingBox("c", StaticEngine(StaticRender.of(box_c, 12, 17)))
            "slash-menu" -> EditingBox("blank", StaticEngine(StaticRender.of(listOf(LineSpec("/")), 1, suggestion = StaticRender.slash())))
            else -> return null
        }
        val demo = "demo-team"
        val withPage = onPage(pageId("canvas"), "look", "corpus")
        return LookScene(
            signedIn(demo, demoTeamTree) { withPage(this).let { st -> st.copy(page = st.page?.copy(editing = editing)) } },
            mode, sidebar = null,
        )
    }

    /** The scene for a state name (the reference file name without `.png`), or null. */
    fun scene(name: String): LookScene? = dataScene(name) ?: editScene(name) ?: when (name) {
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
    CompositionLocalProvider(LocalNow provides LookData.now, LocalToday provides LookData.today, LocalLookEdit provides true) {
        NotiveloTheme(scene.mode) {
            NotiveloRoot(
                state = scene.state,
                actions = NoActions,
                initialDrawerOpen = scene.drawerOpen,
                initialSidebarOpen = scene.sidebar,
                emailFocusedLook = true,
                handleBack = false,
                scrollPx = scene.scrollPx,
            )
        }
    }
}
