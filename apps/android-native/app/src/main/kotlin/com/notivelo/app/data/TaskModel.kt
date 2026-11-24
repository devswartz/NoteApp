package com.notivelo.app.data

import com.notivelo.core.Task
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The task views (the web's Tasks sidebar; Team is not in the native preview). */
enum class TaskList(val title: String, val subtitle: String) {
    Today("Today", "Due today and overdue, assigned to you."),
    My("My Tasks", "Everything assigned to you — from every page."),
    Upcoming("Upcoming", "What’s coming up over the next two weeks."),
    All("All tasks", "Every task in the workspace. Filter by status, sort and group."),
}

/** The bottom tabs (phone) and rail buttons (tablet). */
enum class Tab { Notes, Tasks, Calendar, Search }

enum class DueTone { Overdue, Today, Soon, Later }

/** Dates as the web words them (LOOK.md 6): Today, Tomorrow, Yesterday, weekday names within 6 days, else "30 Nov". */
object Due {
    private val uk = Locale.UK

    fun date(s: String?): LocalDate? = try {
        if (s.isNullOrEmpty()) null else LocalDate.parse(s)
    } catch (e: Exception) {
        null
    }

    /** Days from [today] (negative: past). */
    fun days(s: String?, today: LocalDate): Int? = date(s)?.let { (it.toEpochDay() - today.toEpochDay()).toInt() }

    fun fmt(d: LocalDate, pattern: String): String = DateTimeFormatter.ofPattern(pattern, uk).format(d)

    fun words(s: String?, time: String?, today: LocalDate): String? {
        val d = date(s) ?: return null
        val n = days(s, today) ?: return null
        val w = when {
            n == 0 -> "Today"
            n == 1 -> "Tomorrow"
            n == -1 -> "Yesterday"
            n in 2..6 -> fmt(d, "EEEE")
            d.year == today.year -> fmt(d, "d MMM")
            else -> fmt(d, "d MMM yyyy")
        }
        return if (time.isNullOrEmpty()) w else "$w $time"
    }

    /** Overdue danger, today success, within 6 days warn, later text-2. */
    fun tone(s: String?, today: LocalDate): DueTone {
        val n = days(s, today) ?: return DueTone.Later
        return when {
            n < 0 -> DueTone.Overdue
            n == 0 -> DueTone.Today
            n <= 6 -> DueTone.Soon
            else -> DueTone.Later
        }
    }
}

/** [date] (YYYY-MM-DD): the day the group stands for, which its "Add task" starts with; none for Overdue and No date. */
class TaskGroup(val title: String, val overdue: Boolean, val tasks: List<Task>, val date: String? = null)

/**
 * The task lists' contents and counts, as the Apple app's `TaskBuckets` (and the web's Tasks views): only open tasks
 * the viewer can see; Today = assigned to [meId] and due today or earlier; Upcoming = assigned to [meId] and due
 * within 14 days (overdue included); My Tasks = assigned to [meId]; All = everything open.
 */
class TaskBuckets(
    private val tasks: List<Task>,
    private val meId: String?,
    private val today: LocalDate,
    private val zone: ZoneId = ZoneId.systemDefault(),
) {
    private val open = tasks.filter { !it.done && !it.locked }
    private val mine = open.filter { it.assigneeId != null && it.assigneeId == meId }

    val overdue: Int get() = mine.count { (Due.days(it.dueDate, today) ?: 0) < 0 && it.dueDate != null }

    /** [everyone]: Upcoming for everyone's tasks instead of only yours. */
    fun list(l: TaskList, everyone: Boolean = false): List<Task> = when (l) {
        TaskList.Today -> mine.filter { it.dueDate != null && (Due.days(it.dueDate, today) ?: 1) <= 0 }
        TaskList.My -> mine
        TaskList.Upcoming -> (if (everyone) open else mine).filter { t -> Due.days(t.dueDate, today)?.let { it <= 14 } ?: false }
        TaskList.All -> open
    }

    /** The count beside a view in the sidebar (All has none). */
    fun count(l: TaskList): Int = when (l) {
        TaskList.All -> 0
        // The sidebar counts what is still ahead (tomorrow to two weeks), not what is overdue or due today.
        TaskList.Upcoming -> mine.count { t -> Due.days(t.dueDate, today)?.let { it in 1..14 } ?: false }
        else -> list(l).size
    }

    val doneToday: Int
        get() = tasks.count { t ->
            t.done && t.assigneeId == meId && t.completedAt?.let { at ->
                try {
                    Instant.parse(at).atZone(zone).toLocalDate() == today
                } catch (e: Exception) {
                    false
                }
            } == true
        }

    /** Sorted by due date (undated last), then priority; grouped by day: Overdue, "Today · Sat 21 Nov", "Tomorrow · ...", weekdays, dates, No date. */
    fun groups(l: TaskList, everyone: Boolean = false): List<TaskGroup> {
        val items = list(l, everyone).sortedWith { a, b ->
            val x = a.dueDate
            val y = b.dueDate
            when {
                x != null && y != null && x != y -> x.compareTo(y)
                x != null && y == null -> -1
                x == null && y != null -> 1
                else -> a.priority.toInt().compareTo(b.priority.toInt())
            }
        }
        val out = mutableListOf<Pair<String, MutableList<Task>>>()
        val late = mutableSetOf<String>()
        val dates = mutableMapOf<String, String>()
        for (t in items) {
            val d = Due.date(t.dueDate)
            val n = Due.days(t.dueDate, today)
            val title = if (d == null || n == null) {
                "No date"
            } else when {
                n < 0 -> "Overdue".also { late += it }
                n == 0 -> "Today · " + Due.fmt(d, "EEE d MMM")
                n == 1 -> "Tomorrow · " + Due.fmt(d, "EEE d MMM")
                n in 2..6 -> Due.fmt(d, "EEEE")
                else -> Due.fmt(d, "EEE d MMM")
            }
            if (d != null && n != null && n >= 0) dates[title] = d.toString()
            val last = out.lastOrNull()
            if (last != null && last.first == title) last.second += t else out += title to mutableListOf(t)
        }
        return out.map { TaskGroup(it.first, it.first in late, it.second, dates[it.first]) }
    }
}

/** The task list as the user ticks one: the task with `done` flipped (the core sets `completedAt` on the server). */
fun List<Task>.withDone(id: String, done: Boolean, completedAt: String?): List<Task> =
    map { if (it.id == id) it.copy(done = done, completedAt = if (done) completedAt else null) else it }
