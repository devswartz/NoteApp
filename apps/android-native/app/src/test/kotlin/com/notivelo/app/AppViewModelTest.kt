package com.notivelo.app

import com.notivelo.app.data.AppState
import com.notivelo.app.data.AppViewModel
import com.notivelo.app.data.BackendError
import com.notivelo.app.data.Phase
import com.notivelo.app.data.openTaskCounts
import com.notivelo.core.Task
import com.notivelo.core.Tree
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModelTest {
    private val dispatcher = UnconfinedTestDispatcher()
    private lateinit var backend: FakeBackend
    private lateinit var store: MemoryStore

    private val tree1 = Tree(
        notebooks = listOf(notebook("nb1", "One", 1.0), notebook("nb0", "Zero", 0.0)),
        sections = listOf(section("s1", "nb1", "Sec"), section("s0", "nb0", "Other")),
        pages = listOf(page("p1", "s1", "Page one")),
    )
    private val tree2 = Tree(listOf(notebook("nb2", "Two")), listOf(section("s2", "nb2")), listOf(page("p2", "s2")))

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        backend = FakeBackend().apply { trees = mapOf("w1" to tree1, "w2" to tree2) }
        store = MemoryStore()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun model() = AppViewModel(backend, store, dispatcher)

    @Test
    fun noStoredTokenShowsSignIn() {
        val vm = model()
        assertEquals(Phase.SignedOut, vm.state.value.phase)
        assertEquals("https://example.test", vm.state.value.server)
        assertTrue(backend.calls.isEmpty())
    }

    @Test
    fun restoresASessionFromTheStoredToken() {
        store.refreshToken = "rt-stored"
        val vm = model()
        val s = vm.state.value
        assertEquals(Phase.SignedIn, s.phase)
        assertEquals("Demo User", s.user?.name)
        assertEquals(listOf("w1", "w2"), s.workspaces.map { it.id })
        assertEquals("w1", s.workspaceId)
        assertEquals(tree1, s.tree)
        // The notebook shown is the first in the server's order.
        assertEquals("nb0", s.notebookId)
        // The refresh token rotated: the new one is stored.
        assertEquals("rt-rotated", store.refreshToken)
        assertEquals("restore:rt-stored", backend.calls.first())
    }

    @Test
    fun aRejectedTokenIsForgotten() {
        store.refreshToken = "old"
        backend.failRestore = BackendError.SignedOut
        val vm = model()
        assertEquals(Phase.SignedOut, vm.state.value.phase)
        assertNull(store.refreshToken)
        assertNull(vm.state.value.error)
    }

    @Test
    fun offlineKeepsTheTokenForTheNextLaunch() {
        store.refreshToken = "keep"
        backend.failRestore = BackendError.Offline("no route")
        val vm = model()
        assertEquals(Phase.SignedOut, vm.state.value.phase)
        assertEquals("keep", store.refreshToken)
        assertTrue(vm.state.value.error!!.contains("reach the server"))
    }

    @Test
    fun cachedDataStaysWhenTheServerIsUnreachable() {
        store.refreshToken = "t"
        backend.cachedWorkspaces = listOf(workspace("w2", "Cached"))
        backend.cachedTrees = mapOf("w2" to tree2)
        backend.failWorkspaces = BackendError.Offline("down")
        val vm = model()
        assertEquals(Phase.SignedIn, vm.state.value.phase)
        assertEquals("w2", vm.state.value.workspaceId)
        assertEquals(tree2, vm.state.value.tree)
    }

    @Test
    fun signInStoresTheSessionAndLoadsTheTree() {
        val vm = model()
        vm.signIn("https://other.test", " demo@example.com ", "pw")
        val s = vm.state.value
        assertEquals(Phase.SignedIn, s.phase)
        assertFalse(s.signingIn)
        assertEquals("https://other.test", store.server)
        assertEquals("rt-1", store.refreshToken)
        assertEquals("signIn:https://other.test:demo@example.com", backend.calls.first())
        assertEquals("w1", s.workspaceId)
    }

    @Test
    fun signInErrorsAreSaid() {
        val vm = model()
        vm.signIn("", "", "")
        assertEquals("Enter your email and password.", vm.state.value.error)

        backend.failSignIn = BackendError.SignedOut
        vm.signIn("", "a@b.c", "pw")
        assertEquals("Wrong email or password.", vm.state.value.error)
        assertFalse(vm.state.value.signingIn)

        backend.failSignIn = BackendError.Offline("x")
        vm.signIn("", "a@b.c", "pw")
        assertTrue(vm.state.value.error!!.contains("reach the server"))
        assertEquals(Phase.SignedOut, vm.state.value.phase)
        assertNull(store.refreshToken)
    }

    @Test
    fun anEmptyServerFieldMeansProduction() {
        val vm = model()
        vm.signIn("  ", "a@b.c", "pw")
        assertEquals("signIn:https://app.notiveloapp.com:a@b.c", backend.calls.first())
    }

    @Test
    fun switchingWorkspaceLoadsItsTreeAndResetsTheNavigation() {
        store.refreshToken = "t"
        val vm = model()
        vm.openPage("p1")
        assertEquals("p1", vm.state.value.pageId)
        assertEquals("s1", vm.state.value.sectionId)
        assertEquals("nb1", vm.state.value.notebookId)

        vm.selectWorkspace("w2")
        val s = vm.state.value
        assertEquals("w2", s.workspaceId)
        assertEquals(tree2, s.tree)
        assertEquals("nb2", s.notebookId)
        assertNull(s.pageId)
        assertNull(s.sectionId)
        assertEquals("w2", store.workspaceId)
    }

    @Test
    fun theLastWorkspaceIsRememberedAcrossLaunches() {
        store.refreshToken = "t"
        store.workspaceId = "w2"
        assertEquals("w2", model().state.value.workspaceId)
        store.workspaceId = "gone"
        assertEquals("w1", model().state.value.workspaceId)
    }

    @Test
    fun navigationDrillsDownAndBackUp() {
        store.refreshToken = "t"
        val vm = model()
        vm.openPhoneNotebook("nb1")
        assertEquals("nb1", vm.state.value.phoneNotebookId)
        vm.openSection("s1")
        assertEquals("s1", vm.state.value.sectionId)
        vm.openPage("p1")
        assertEquals("p1", vm.state.value.pageId)

        vm.back()
        assertNull(vm.state.value.pageId)
        assertEquals("s1", vm.state.value.sectionId)
        vm.back()
        assertNull(vm.state.value.sectionId)
        assertEquals("nb1", vm.state.value.phoneNotebookId)
        vm.back()
        assertNull(vm.state.value.phoneNotebookId)
        // At the top, back does nothing.
        val before: AppState = vm.state.value
        vm.back()
        assertEquals(before, vm.state.value)
    }

    @Test
    fun signOutClearsTheSession() {
        store.refreshToken = "t"
        val vm = model()
        vm.signOut()
        assertTrue(backend.signedOut)
        assertNull(store.refreshToken)
        assertNull(store.workspaceId)
        assertEquals(Phase.SignedOut, vm.state.value.phase)
        assertNull(vm.state.value.user)
        assertNull(vm.state.value.tree)
    }

    @Test
    fun aSessionThatExpiresMidwayEndsSignedOut() {
        store.refreshToken = "t"
        backend.failTree = BackendError.SignedOut
        val vm = model()
        assertEquals(Phase.SignedOut, vm.state.value.phase)
        assertNull(store.refreshToken)
    }

    @Test
    fun openTaskCountsPerPage() {
        fun task(id: String, page: String?, done: Boolean) = Task(
            id = id, workspaceId = "w1", title = id, description = "", done = done, priority = 4.toUByte(),
            dueDate = null, dueTime = null, assigneeId = null, pageId = page, parentId = null, tagIds = emptyList(),
            checklistDone = null, checklistTotal = null, completedAt = null, createdAt = "", updatedAt = "", locked = false,
        )
        val counts = openTaskCounts(
            listOf(task("a", "p1", false), task("b", "p1", false), task("c", "p1", true), task("d", null, false), task("e", "p2", false)),
        )
        assertEquals(mapOf("p1" to 2, "p2" to 1), counts)
    }

    private fun aTask(id: String, done: Boolean = false) = Task(
        id = id, workspaceId = "w1", title = id, description = "", done = done, priority = 4.toUByte(),
        dueDate = null, dueTime = null, assigneeId = "u1", pageId = "p1", parentId = null, tagIds = emptyList(),
        checklistDone = null, checklistTotal = null, completedAt = null, createdAt = "", updatedAt = "", locked = false,
    )

    @Test
    fun ticksATaskAtOnceAndKeepsTheServersAnswer() {
        store.refreshToken = "t"
        backend.tasks = listOf(aTask("a"), aTask("b"))
        val vm = model()
        assertEquals(2, vm.state.value.taskCounts["p1"])
        vm.toggleTask("a")
        assertEquals(listOf("a" to true), backend.doneCalls)
        assertTrue(vm.state.value.tasks.first { it.id == "a" }.done)
        assertEquals(1, vm.state.value.taskCounts["p1"])
        // Unticking again.
        backend.tasks = vm.state.value.tasks
        vm.toggleTask("a")
        assertFalse(vm.state.value.tasks.first { it.id == "a" }.done)
    }

    @Test
    fun aRefusedTickPutsTheTaskBackAndSaysSo() {
        store.refreshToken = "t"
        backend.tasks = listOf(aTask("a"))
        val vm = model()
        backend.failSetDone = BackendError.Offline("down")
        vm.toggleTask("a")
        assertFalse(vm.state.value.tasks.first { it.id == "a" }.done)
        assertEquals("Could not update the task.", vm.state.value.notice)
        vm.clearNotice()
        assertNull(vm.state.value.notice)
    }

    @Test
    fun aPageIsOpenLiveOnlyWhileItIsChosen() {
        store.refreshToken = "t"
        val vm = model()
        vm.openPage("p1")
        assertEquals(listOf("p1"), backend.openedPages)
        assertEquals("p1", vm.state.value.page?.pageId)
        vm.back()
        assertEquals(listOf("p1"), backend.closedPages)
        assertNull(vm.state.value.page)
    }

    @Test
    fun aBoxIsEditedThroughASessionOnTheLivePage() {
        store.refreshToken = "t"
        val vm = model()
        vm.openPage("p1")
        vm.startEditing("b1", 12f, 30f)
        val editing = vm.state.value.page?.editing
        assertEquals("b1", editing?.boxId)
        assertEquals(12f, editing?.tapX)
        assertEquals(listOf("b1@w1"), backend.openedBoxes)
        // Another box replaces it, and the first session is closed.
        vm.startEditing("b2")
        assertEquals("b2", vm.state.value.page?.editing?.boxId)
        assertTrue(backend.engines[0].closed)
        vm.stopEditing()
        assertNull(vm.state.value.page?.editing)
        assertTrue(backend.engines[1].closed)
    }

    @Test
    fun leavingThePageClosesTheBoxSession() {
        store.refreshToken = "t"
        val vm = model()
        vm.openPage("p1")
        vm.startEditing("b1")
        vm.back()
        assertTrue(backend.engines[0].closed)
        assertNull(vm.state.value.page)
    }

    @Test
    fun taskViewsAreChosenFromTheTab() {
        store.refreshToken = "t"
        val vm = model()
        vm.goTasks()
        assertEquals(com.notivelo.app.data.Tab.Tasks, vm.state.value.tab)
        vm.selectTaskList(com.notivelo.app.data.TaskList.Upcoming)
        vm.setEveryone(true)
        assertEquals(com.notivelo.app.data.TaskList.Upcoming, vm.state.value.taskList)
        assertTrue(vm.state.value.everyone)
        vm.openTask("a")
        assertEquals("a", vm.state.value.taskDetailId)
        vm.goNotes()
        assertEquals(com.notivelo.app.data.Tab.Notes, vm.state.value.tab)
    }

    // Boxes and page undo

    private fun livePage(): AppViewModel {
        store.refreshToken = "t"
        val vm = model()
        vm.openPage("p1")
        return vm
    }

    @Test
    fun aTapOnEmptyCanvasMakesABoxInFrontAndEditsIt() {
        val vm = livePage()
        vm.createBox(10.0, 20.0)
        assertEquals(listOf("create 10,20 w=360 z=1"), backend.pageCalls)
        assertEquals("nb", vm.state.value.page?.editing?.boxId)
        assertEquals(listOf("nb@w1"), backend.openedBoxes)
        assertTrue(vm.state.value.page!!.rev > 0)
    }

    @Test
    fun creatingABoxLeavesTheEmptyOneYouWereIn() {
        val vm = livePage()
        backend.editorText = ""
        vm.startEditing("b1")
        backend.editorText = "hi"
        vm.createBox(0.0, 0.0)
        assertTrue(backend.engines[0].closed)
        assertEquals(listOf("delete b1", "create 0,0 w=360 z=1"), backend.pageCalls)
        assertEquals("nb", vm.state.value.page?.editing?.boxId)
    }

    @Test
    fun aRefusedBoxSaysSo() {
        val vm = livePage()
        backend.failBox = BackendError.Other("no")
        vm.createBox(1.0, 2.0)
        assertEquals("Could not add a text box.", vm.state.value.notice)
        assertNull(vm.state.value.page?.editing)
    }

    @Test
    fun movesAndResizesGoToTheCoreOnce() {
        val vm = livePage()
        vm.moveBox("b1", 30.0, 60.0)
        vm.resizeBox("b1", 480.0)
        assertEquals(listOf("move b1 30,60", "resize b1 480"), backend.pageCalls)
    }

    @Test
    fun anEmptyBoxGoesWhenEditingEnds() {
        val vm = livePage()
        backend.editorText = ""
        vm.startEditing("b1")
        vm.stopEditing()
        assertEquals(listOf("delete b1"), backend.pageCalls)
        assertTrue(backend.engines[0].closed)
        assertNull(vm.state.value.page?.editing)
    }

    @Test
    fun aBoxWithTextStaysAndThePagesDocumentIsNeverDropped() {
        val vm = livePage()
        vm.startEditing("b1")
        vm.stopEditing()
        backend.editorText = ""
        vm.startEditing("default")
        vm.stopEditing()
        assertTrue(backend.pageCalls.isEmpty())
    }

    @Test
    fun anEmptyBoxGoesWhenThePageIsLeft() {
        val vm = livePage()
        backend.editorText = ""
        vm.startEditing("b1")
        vm.back()
        assertEquals(listOf("delete b1"), backend.pageCalls)
        assertTrue(backend.engines[0].closed)
    }

    @Test
    fun undoAndRedoAreThePagesOwnAndTheButtonsFollowTheStack() {
        val vm = livePage()
        assertFalse(vm.state.value.page!!.canUndo)
        backend.canUndo = true
        vm.pageEdited()
        assertTrue(vm.state.value.page!!.canUndo)
        assertFalse(vm.state.value.page!!.canRedo)
        // While a box is edited, undo is still the page's (one stack across text, ink and boxes).
        vm.startEditing("b1")
        backend.canUndo = false
        backend.canRedo = true
        vm.undoPage()
        assertEquals(listOf("undo"), backend.pageCalls)
        assertFalse(vm.state.value.page!!.canUndo)
        assertTrue(vm.state.value.page!!.canRedo)
        vm.redoPage()
        assertEquals(listOf("undo", "redo"), backend.pageCalls)
        // The box's own session is not asked to undo.
        assertFalse(backend.engines[0].calls.contains("undo"))
    }

    // Task edits

    private val today = java.time.LocalDate.of(2026, 11, 21)

    private fun withTasks(vararg t: Task): AppViewModel {
        store.refreshToken = "t"
        backend.tasks = t.toList()
        return AppViewModel(backend, store, dispatcher) { today }
    }

    @Test
    fun taskExtrasComeWithTheWorkspace() {
        val a = aTask("a")
        backend.details = listOf(detailOf(a, team = "tm"))
        backend.teams = listOf(com.notivelo.core.TaskTeam("tm", "Staff", "#0ea5e9", null, emptyList()))
        backend.tags = listOf(com.notivelo.core.TaskTag("g", "launch", "#8b5cf6"))
        val vm = withTasks(a)
        assertEquals("tm", vm.state.value.details["a"]?.teamId)
        assertEquals(listOf("Staff"), vm.state.value.teams.map { it.name })
        assertEquals(listOf("launch"), vm.state.value.tags.map { it.name })
    }

    @Test
    fun anEditShowsAtOnceAndKeepsTheServersAnswer() {
        val vm = withTasks(aTask("a"))
        vm.updateTask("a", com.notivelo.core.TaskChanges(title = "Renamed", priority = 1.toUByte()))
        assertEquals("a", backend.updates.single().first)
        val t = vm.state.value.tasks.single()
        assertEquals("Renamed", t.title)
        assertEquals(1, t.priority.toInt())
        assertEquals("Renamed", vm.state.value.details["a"]?.title)
    }

    @Test
    fun aRefusedEditPutsTheTaskBack() {
        val vm = withTasks(aTask("a"))
        backend.failUpdate = BackendError.Other("403")
        vm.updateTask("a", com.notivelo.core.TaskChanges(title = "Renamed"))
        assertEquals("a", vm.state.value.tasks.single().title)
        assertEquals("Could not update the task.", vm.state.value.notice)
    }

    @Test
    fun aTimeOnADatelessTaskAlsoSetsTodayAndARuleItsFirstDate() {
        val vm = withTasks(aTask("a"), aTask("b"))
        vm.updateTask("a", com.notivelo.core.TaskChanges(dueTime = "09:30"))
        assertEquals("2026-11-21", backend.updates[0].second.dueDate)
        vm.updateTask("b", com.notivelo.core.TaskChanges(recurrence = com.notivelo.core.TaskRecurrence(freq = "week", interval = 1u)))
        assertEquals("first:2026-11-21", backend.updates[1].second.dueDate)
        assertEquals("2026-11-21", vm.state.value.tasks.first { it.id == "a" }.dueDate)
    }

    @Test
    fun deletingATaskTakesItsSubtasksAndClosesTheDetail() {
        val vm = withTasks(aTask("a"), aTask("b").copy(parentId = "a"), aTask("c"))
        vm.openTask("a")
        vm.deleteTask("a")
        assertEquals(listOf("a"), backend.deleted)
        assertEquals(listOf("c"), vm.state.value.tasks.map { it.id })
        assertNull(vm.state.value.taskDetailId)
    }

    @Test
    fun aRefusedDeleteBringsTheTaskBack() {
        val vm = withTasks(aTask("a"))
        backend.failDelete = BackendError.Offline("down")
        vm.deleteTask("a")
        assertEquals(listOf("a"), vm.state.value.tasks.map { it.id })
        assertEquals("Could not delete the task.", vm.state.value.notice)
    }

    @Test
    fun quickAddOpensWithTheGroupsDateAndAddsTheTask() {
        val vm = withTasks(aTask("a"))
        vm.newTask("2026-11-22")
        assertEquals("2026-11-22", vm.state.value.quickAdd?.dueDate)
        vm.addQuickTask("Call Sam")
        assertEquals(listOf("Call Sam|2026-11-21|2026-11-22"), backend.quickAdds)
        assertNull(vm.state.value.quickAdd)
        assertEquals(listOf("a", "new-1"), vm.state.value.tasks.map { it.id })
        // A blank line adds nothing.
        vm.newTask()
        vm.addQuickTask("   ")
        assertEquals(1, backend.quickAdds.size)
        vm.closeQuickAdd()
        assertNull(vm.state.value.quickAdd)
    }

    @Test
    fun aSubtaskIsAddedUnderItsParent() {
        val vm = withTasks(aTask("a"))
        vm.addSubtask("a", "  Step one ")
        assertEquals(listOf("a|Step one"), backend.subtasks)
        assertEquals("a", vm.state.value.tasks.last().parentId)
    }
}
