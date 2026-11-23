package com.notivelo.app

import com.notivelo.app.data.Due
import com.notivelo.app.data.DueTone
import com.notivelo.app.data.TaskBuckets
import com.notivelo.app.data.TaskList
import com.notivelo.app.data.withDone
import com.notivelo.core.Task
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class TaskBucketsTest {
    private val today = LocalDate.of(2026, 11, 21) // a Saturday
    private val utc = ZoneId.of("UTC")

    private fun day(offset: Int) = today.plusDays(offset.toLong()).toString()

    private fun task(
        id: String, due: Int? = null, priority: Int = 4, assignee: String? = "me", done: Boolean = false,
        completedAt: String? = null, locked: Boolean = false,
    ) = Task(
        id = id, workspaceId = "w", title = id, description = "", done = done, priority = priority.toUByte(),
        dueDate = due?.let(::day), dueTime = null, assigneeId = assignee, pageId = null, parentId = null, tagIds = emptyList(),
        checklistDone = null, checklistTotal = null, completedAt = completedAt, createdAt = "2026-11-20T00:00:00Z",
        updatedAt = "2026-11-20T00:00:00Z", locked = locked,
    )

    private fun buckets(vararg tasks: Task) = TaskBuckets(tasks.toList(), "me", today, utc)

    @Test
    fun todayHoldsMineDueTodayOrEarlier() {
        val b = buckets(task("overdue", -3), task("today", 0), task("tomorrow", 1), task("none"), task("theirs", 0, assignee = "sam"), task("done", 0, done = true))
        assertEquals(listOf("overdue", "today"), b.list(TaskList.Today).map { it.id })
        assertEquals(1, b.overdue)
        assertEquals(2, b.count(TaskList.Today))
    }

    @Test
    fun upcomingIsTheNextTwoWeeksOverdueIncluded() {
        val b = buckets(task("late", -1), task("in14", 14), task("in15", 15), task("none"), task("theirs", 2, assignee = "sam"))
        assertEquals(listOf("late", "in14"), b.list(TaskList.Upcoming).map { it.id })
        // Everyone adds the other people's tasks.
        assertEquals(setOf("late", "in14", "theirs"), b.list(TaskList.Upcoming, everyone = true).map { it.id }.toSet())
    }

    @Test
    fun myTasksAreAllMineOpen() {
        val b = buckets(task("a", 5), task("b"), task("c", assignee = null), task("d", done = true))
        assertEquals(listOf("a", "b"), b.list(TaskList.My).map { it.id })
    }

    @Test
    fun allTasksHaveNoCountAndHideLockedAndDone() {
        val b = buckets(task("a"), task("b", assignee = "sam"), task("c", done = true), task("d", locked = true))
        assertEquals(listOf("a", "b"), b.list(TaskList.All).map { it.id })
        assertEquals(0, b.count(TaskList.All))
    }

    @Test
    fun groupsByDayWithOverdueFirstAndNoDateLast() {
        val b = buckets(task("later", 9), task("none"), task("tomorrow", 1), task("today2", 0, priority = 3), task("today1", 0, priority = 1), task("late", -2), task("thu", 5))
        val groups = b.groups(TaskList.My)
        assertEquals(
            listOf("Overdue", "Today · Sat 21 Nov", "Tomorrow · Sun 22 Nov", "Thursday", "Mon 30 Nov", "No date"),
            groups.map { it.title },
        )
        assertEquals(listOf(true, false, false, false, false, false), groups.map { it.overdue })
        // Within a day, urgent first.
        assertEquals(listOf("today1", "today2"), groups[1].tasks.map { it.id })
    }

    @Test
    fun countsDoneTodayInTheViewersDay() {
        val b = buckets(
            task("a", done = true, completedAt = "2026-11-21T08:00:00Z"),
            task("b", done = true, completedAt = "2026-11-20T23:59:00Z"),
            task("c", done = true, completedAt = "2026-11-21T09:00:00Z", assignee = "sam"),
            task("d"),
        )
        assertEquals(1, b.doneToday)
    }

    @Test
    fun dueWordsAndTones() {
        assertEquals("Today", Due.words(day(0), null, today))
        assertEquals("Tomorrow", Due.words(day(1), null, today))
        assertEquals("Yesterday", Due.words(day(-1), null, today))
        assertEquals("Monday", Due.words(day(2), null, today))
        assertEquals("Friday 09:30", Due.words(day(6), "09:30", today))
        assertEquals("30 Nov", Due.words(day(9), null, today))
        assertEquals("1 Mar 2027", Due.words("2027-03-01", null, today))
        assertNull(Due.words(null, null, today))
        assertEquals(DueTone.Overdue, Due.tone(day(-1), today))
        assertEquals(DueTone.Today, Due.tone(day(0), today))
        assertEquals(DueTone.Soon, Due.tone(day(6), today))
        assertEquals(DueTone.Later, Due.tone(day(7), today))
        assertEquals(DueTone.Later, Due.tone(null, today))
    }

    @Test
    fun withDoneTicksOneTask() {
        val list = listOf(task("a"), task("b"))
        val ticked = list.withDone("a", true, "2026-11-21T12:00:00Z")
        assertEquals(true, ticked[0].done)
        assertEquals("2026-11-21T12:00:00Z", ticked[0].completedAt)
        assertFalse(ticked[1].done)
        val back = ticked.withDone("a", false, "x")
        assertNull(back[0].completedAt)
    }
}
