package com.notivelo.app

import com.notivelo.app.data.TaskEdit
import com.notivelo.app.data.toTask
import com.notivelo.app.data.with
import com.notivelo.app.ui.tasks.orderedTeams
import com.notivelo.core.Task
import com.notivelo.core.TaskChanges
import com.notivelo.core.TaskRecurrence
import com.notivelo.core.TaskTeam
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class TaskEditTest {
    private val today = LocalDate.of(2026, 11, 21) // a Saturday

    private fun task(due: String? = null, time: String? = null) = Task(
        id = "t", workspaceId = "w1", title = "Old", description = "", done = false, priority = 4.toUByte(),
        dueDate = due, dueTime = time, assigneeId = "u1", pageId = null, parentId = null, tagIds = listOf("a"),
        checklistDone = null, checklistTotal = null, completedAt = null, createdAt = "", updatedAt = "", locked = false,
    )

    @Test
    fun changesShowAtOnce() {
        val t = task(due = "2026-11-22", time = "10:00").with(TaskChanges(title = "New", priority = 1.toUByte(), clearDueTime = true, tagIds = listOf("a", "b")))
        assertEquals("New", t.title)
        assertEquals(1, t.priority.toInt())
        assertEquals("2026-11-22", t.dueDate)
        assertNull(t.dueTime)
        assertEquals(listOf("a", "b"), t.tagIds)
        // A value wins over its clear flag; nothing set leaves everything.
        assertEquals("2026-12-01", task(due = "2026-11-22").with(TaskChanges(dueDate = "2026-12-01", clearDueDate = true)).dueDate)
        assertEquals(task(due = "2026-11-22"), task(due = "2026-11-22").with(TaskChanges()))
        assertNull(task().with(TaskChanges(clearAssignee = true)).assigneeId)
    }

    @Test
    fun theDetailKeepsTeamAndRepeat() {
        val d = detailOf(task(), team = "tm").with(TaskChanges(recurrence = TaskRecurrence(freq = "week", interval = 1u)))
        assertEquals("tm", d.teamId)
        assertEquals("week", d.recurrence?.freq)
        val cleared = d.with(TaskChanges(clearRecurrence = true, clearTeam = true))
        assertNull(cleared.recurrence)
        assertNull(cleared.teamId)
        assertEquals(task(), detailOf(task()).toTask())
    }

    @Test
    fun aTimeOnATaskWithNoDateSetsTodayAsTheWebDoes() {
        val c = TaskEdit.complete(TaskChanges(dueTime = "09:30"), null, today) { _, from -> from }
        assertEquals("2026-11-21", c.dueDate)
        assertEquals("09:30", c.dueTime)
        // With a date there is nothing to add.
        assertNull(TaskEdit.complete(TaskChanges(dueTime = "09:30"), "2026-11-25", today) { _, from -> from }.dueDate)
        // Clearing the date and setting a time in one go keeps today.
        assertEquals("2026-11-21", TaskEdit.complete(TaskChanges(dueTime = "09:30", clearDueDate = true), "2026-11-25", today) { _, from -> from }.dueDate)
    }

    @Test
    fun aRuleOnATaskWithNoDateGetsItsFirstOccurrence() {
        val rule = TaskRecurrence(freq = "week", interval = 1u)
        val c = TaskEdit.complete(TaskChanges(recurrence = rule), null, today) { _, from -> "first:$from" }
        assertEquals("first:2026-11-21", c.dueDate)
        assertNull(TaskEdit.complete(TaskChanges(recurrence = rule), "2026-11-25", today) { _, from -> "first:$from" }.dueDate)
    }

    @Test
    fun timesAreParsedLeniently() {
        assertEquals("09:30", TaskEdit.parseTime("9:30"))
        assertEquals("09:30", TaskEdit.parseTime("0930"))
        assertEquals("15:00", TaskEdit.parseTime("3pm"))
        assertEquals("00:15", TaskEdit.parseTime("12:15 am"))
        assertEquals("12:00", TaskEdit.parseTime("12pm"))
        assertEquals("23:59", TaskEdit.parseTime("23:59"))
        assertNull(TaskEdit.parseTime("24:00"))
        assertNull(TaskEdit.parseTime("9:75"))
        assertNull(TaskEdit.parseTime("13pm"))
        assertNull(TaskEdit.parseTime("soon"))
    }

    @Test
    fun repeatsAreWordedAsTheWeb() {
        assertEquals("Does not repeat", TaskEdit.describeRepeat(null))
        assertEquals("Every weekday", TaskEdit.describeRepeat(TaskRecurrence(freq = "weekday")))
        assertEquals("Every week", TaskEdit.describeRepeat(TaskRecurrence(freq = "week", interval = 1u)))
        assertEquals("Every 3 months", TaskEdit.describeRepeat(TaskRecurrence(freq = "month", interval = 3u)))
        assertEquals(7, TaskEdit.repeatPresets.size)
        // Every preset reads back as its own name.
        for ((label, rule) in TaskEdit.repeatPresets) assertEquals(label, TaskEdit.describeRepeat(rule))
    }

    @Test
    fun dueShortcutsAreTodayTomorrowAndNextMonday() {
        val s = TaskEdit.dueShortcuts(today)
        assertEquals(listOf("Today", "Tomorrow", "Next week"), s.map { it.first })
        assertEquals(LocalDate.of(2026, 11, 23), s[2].second)
        // On a Monday "next week" is a week away, not today.
        assertEquals(LocalDate.of(2026, 11, 30), TaskEdit.dueShortcuts(LocalDate.of(2026, 11, 23))[2].second)
    }

    @Test
    fun aMonthGridStartsOnMonday() {
        val cells = TaskEdit.monthCells(2026, 11) // 1 Nov 2026 is a Sunday
        assertEquals(0, cells.size % 7)
        assertEquals(6, cells.takeWhile { it == null }.size)
        assertEquals(LocalDate.of(2026, 11, 1), cells[6])
        assertEquals(30, cells.filterNotNull().size)
        assertTrue(cells.last() == null || cells.last() == LocalDate.of(2026, 11, 30))
    }

    @Test
    fun teamsListWithTheirSubteamsAfterThem() {
        fun team(id: String, name: String, parent: String? = null) = TaskTeam(id, name, "#0ea5e9", parent, emptyList())
        val teams = listOf(team("c", "Core", "b"), team("b", "Beta"), team("a", "Alpha"), team("z", "Zed", "gone"))
        assertEquals(listOf("a", "b", "c", "z"), orderedTeams(teams).map { it.id })
        assertEquals("Beta › Core", TaskEdit.teamLabel(teams[0], teams))
        assertEquals("Alpha", TaskEdit.teamLabel(teams[2], teams))
    }
}
