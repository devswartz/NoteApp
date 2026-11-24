package com.notivelo.app.data

import com.notivelo.core.Task
import com.notivelo.core.TaskChanges
import com.notivelo.core.TaskDetail
import com.notivelo.core.TaskRecurrence
import com.notivelo.core.TaskTeam
import com.notivelo.core.User
import com.notivelo.core.WorkspaceMember
import java.time.LocalDate

/** A task as the list views hold it, from its full record. */
fun TaskDetail.toTask(): Task = Task(
    id = id, workspaceId = workspaceId, title = title, description = description, done = done, priority = priority,
    dueDate = dueDate, dueTime = dueTime, assigneeId = assigneeId, pageId = pageId, parentId = parentId, tagIds = tagIds,
    checklistDone = checklistDone, checklistTotal = checklistTotal, completedAt = completedAt, createdAt = createdAt,
    updatedAt = updatedAt, locked = locked,
)

/** [TaskChanges] shown at once, before the server answers: set fields replace, `clear...` flags empty, the rest stay. */
fun Task.with(c: TaskChanges): Task = copy(
    title = c.title ?: title,
    description = c.description ?: description,
    done = c.done ?: done,
    priority = c.priority ?: priority,
    dueDate = c.dueDate ?: if (c.clearDueDate) null else dueDate,
    dueTime = c.dueTime ?: if (c.clearDueTime) null else dueTime,
    assigneeId = c.assigneeId ?: if (c.clearAssignee) null else assigneeId,
    pageId = c.pageId ?: if (c.clearPage) null else pageId,
    parentId = c.parentId ?: if (c.clearParent) null else parentId,
    tagIds = c.tagIds ?: tagIds,
)

fun TaskDetail.with(c: TaskChanges): TaskDetail = copy(
    title = c.title ?: title,
    description = c.description ?: description,
    done = c.done ?: done,
    priority = c.priority ?: priority,
    dueDate = c.dueDate ?: if (c.clearDueDate) null else dueDate,
    dueTime = c.dueTime ?: if (c.clearDueTime) null else dueTime,
    recurrence = c.recurrence ?: if (c.clearRecurrence) null else recurrence,
    reminderAt = c.reminderAt ?: if (c.clearReminderAt) null else reminderAt,
    assigneeId = c.assigneeId ?: if (c.clearAssignee) null else assigneeId,
    teamId = c.teamId ?: if (c.clearTeam) null else teamId,
    pageId = c.pageId ?: if (c.clearPage) null else pageId,
    parentId = c.parentId ?: if (c.clearParent) null else parentId,
    tagIds = c.tagIds ?: tagIds,
)

/** What the task detail's pickers build and the checks they share (the web's `TaskControls`). */
object TaskEdit {
    /**
     * The web's two conveniences, which the core leaves to the app: a time set on a task with no date also sets the date
     * to [today]; a repeat rule set on a task with no date sets it to the rule's first occurrence ([first]). [currentDate]
     * is the task's due date now.
     */
    fun complete(c: TaskChanges, currentDate: String?, today: LocalDate, first: (TaskRecurrence, String) -> String): TaskChanges {
        var out = c
        fun hasDate() = out.dueDate != null || (currentDate != null && !out.clearDueDate)
        if (out.dueTime != null && !hasDate()) out = out.copy(dueDate = today.toString())
        val rule = out.recurrence
        if (rule != null && !hasDate()) out = out.copy(dueDate = first(rule, today.toString()))
        return out
    }

    /** The repeat choices (the web's `RECURRENCE_PRESETS`), null = does not repeat. */
    val repeatPresets: List<Pair<String, TaskRecurrence?>> = listOf(
        "Does not repeat" to null,
        "Every day" to TaskRecurrence(freq = "day", interval = 1u),
        "Every weekday" to TaskRecurrence(freq = "weekday"),
        "Every week" to TaskRecurrence(freq = "week", interval = 1u),
        "Every 2 weeks" to TaskRecurrence(freq = "week", interval = 2u),
        "Every month" to TaskRecurrence(freq = "month", interval = 1u),
        "Every year" to TaskRecurrence(freq = "year", interval = 1u),
    )

    /** `describeRecurrence` of the web, with "Does not repeat" for none. */
    fun describeRepeat(rule: TaskRecurrence?): String {
        if (rule == null) return "Does not repeat"
        if (rule.freq == "weekday") return "Every weekday"
        val n = rule.interval?.toInt() ?: 1
        if (n == 1) {
            return when (rule.freq) {
                "day" -> "Every day"
                "week" -> "Every week"
                "month" -> "Every month"
                else -> "Every year"
            }
        }
        return "Every $n ${rule.freq}s"
    }

    /** "Parent › Team" for a subteam (the web's `teamLabel`). */
    fun teamLabel(team: TaskTeam, teams: List<TaskTeam>): String {
        val parent = team.parentId?.let { id -> teams.firstOrNull { it.id == id } }
        return if (parent != null) "${parent.name} › ${team.name}" else team.name
    }

    /** "9:30", "09:30", "930", "3pm", "3:30 pm" as "HH:mm", or null. */
    fun parseTime(input: String): String? {
        val m = Regex("""^\s*(\d{1,2})(?::?(\d{2}))?\s*([ap]m?)?\s*$""", RegexOption.IGNORE_CASE).matchEntire(input) ?: return null
        var h = m.groupValues[1].toInt()
        val min = m.groupValues[2].ifEmpty { "0" }.toInt()
        val ap = m.groupValues[3].lowercase()
        if (min > 59) return null
        if (ap.isNotEmpty()) {
            if (h !in 1..12) return null
            h = h % 12 + if (ap.startsWith("p")) 12 else 0
        } else if (h > 23) {
            return null
        }
        return "%02d:%02d".format(h, min)
    }

    /** The shortcuts of the due-date menu: Today, Tomorrow, Next Monday ("Next week"), as dates. */
    fun dueShortcuts(today: LocalDate): List<Pair<String, LocalDate>> {
        var monday = today.plusDays(1)
        while (monday.dayOfWeek.value != 1) monday = monday.plusDays(1)
        return listOf("Today" to today, "Tomorrow" to today.plusDays(1), "Next week" to monday)
    }

    /** The cells of a month grid, Monday first: leading and trailing days are null. */
    fun monthCells(year: Int, month: Int): List<LocalDate?> {
        val first = LocalDate.of(year, month, 1)
        val lead = first.dayOfWeek.value - 1
        val days = first.lengthOfMonth()
        val cells = MutableList<LocalDate?>(lead) { null }
        for (d in 1..days) cells += first.withDayOfMonth(d)
        while (cells.size % 7 != 0) cells += null
        return cells
    }
}

/** A workspace member as the avatar draws a user. */
fun WorkspaceMember.asUser(): User = User(id = id, email = email, name = name, color = color, emailVerified = true)

/** Who an assignee id is: you, or one of the workspace's people (null: unassigned or unknown). */
fun AppState.person(id: String?): User? = when {
    id == null -> null
    id == user?.id -> user
    else -> members.firstOrNull { it.id == id }?.asUser()
}
