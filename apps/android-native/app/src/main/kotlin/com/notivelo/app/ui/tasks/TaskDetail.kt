package com.notivelo.app.ui.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.unit.dp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.Due
import com.notivelo.app.data.ShellActions
import com.notivelo.app.data.TaskEdit
import com.notivelo.app.data.person
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.WebType
import com.notivelo.app.look.parseHex
import com.notivelo.app.look.pal
import com.notivelo.app.ui.Avatar
import com.notivelo.app.ui.LocalNow
import com.notivelo.app.ui.LocalToday
import com.notivelo.app.ui.page.TaskCircle
import com.notivelo.app.ui.page.priorityColor
import com.notivelo.app.ui.page.toneColor
import com.notivelo.app.ui.relativeTime
import com.notivelo.app.ui.tappable
import com.notivelo.core.TaskChanges

/** What a property row opens. */
private enum class Picking { Assignee, Team, Tags, Due, Time, Priority, Repeat }

/**
 * A task's detail (the web's task sheet): the head with the page it is on, Delete and Close, the title with its circle, the
 * property rows (assignee, team, tags, due date, time, priority, repeat, reminders), the details, subtasks. Everything but the
 * reminders is editable: the title and details are text fields saved when they lose focus, the rows open a picker, the trash
 * button asks first. Team, tags and the repeat rule come from the task's full record (`state.details`); who an assignee is
 * comes from `state.members`.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TaskDetailContent(state: AppState, actions: ShellActions, phone: Boolean, modifier: Modifier = Modifier) {
    val p = pal()
    val task = state.tasks.firstOrNull { it.id == state.taskDetailId } ?: return
    val detail = state.details[task.id]
    val today = LocalToday.current
    val pageTitle = task.pageId?.let { id -> state.tree?.pages?.firstOrNull { it.id == id }?.title ?: state.otherPageTitles[id] }
    val subtasks = state.tasks.filter { it.parentId == task.id }
    val priority = task.priority.toInt()
    val team = detail?.teamId?.let { id -> state.teams.firstOrNull { it.id == id } }
    val tags = task.tagIds.mapNotNull { id -> state.tags.firstOrNull { it.id == id } }
    val who = state.person(task.assigneeId)
    val focus = LocalFocusManager.current
    var picking by remember(task.id) { mutableStateOf<Picking?>(null) }
    var confirmDelete by remember(task.id) { mutableStateOf(false) }
    var title by remember(task.id, task.title) { mutableStateOf(task.title) }
    var description by remember(task.id, task.description) { mutableStateOf(task.description) }
    var subtask by remember(task.id) { mutableStateOf("") }
    val fs = if (phone) 16f else 13f
    fun edit(c: TaskChanges) {
        picking = null
        actions.updateTask(task.id, c)
    }
    fun saveTitle() {
        val t = title.trim()
        if (t.isEmpty()) title = task.title else if (t != task.title) actions.updateTask(task.id, TaskChanges(title = t))
    }
    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().height(52.dp)
                .drawBehind { drawRect(p.border, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }
                .padding(start = 24.dp, end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WText(if (task.pageId != null) "On “${pageTitle ?: "a page"}”" else "Standalone task", if (phone) 14.5f else 13f, p.text2, Modifier.weight(1f), lineHeight = 1.3f)
            Box(Modifier.size(40.dp).tappable { confirmDelete = true }, contentAlignment = Alignment.Center) { LIcon(Ic.trash, 18.dp, p.text2) }
            Box(Modifier.size(40.dp).tappable { actions.openTask(null) }, contentAlignment = Alignment.Center) { LIcon(Ic.x, 20.dp, p.text2) }
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = if (phone) 16.dp else 24.dp),
        ) {
            Row(Modifier.padding(top = if (phone) 24.dp else 20.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(Modifier.tappable { actions.toggleTask(task.id) }) { TaskCircle(priority, task.done, p, if (phone) 22.dp else 18.dp) }
                BasicTextField(
                    value = title, onValueChange = { title = it },
                    textStyle = WebType.style(if (phone) 22f else 17f, 650, 1.3f, -0.01f).copy(
                        color = if (task.done) p.textMuted else p.text, textDecoration = if (task.done) TextDecoration.LineThrough else null,
                    ),
                    cursorBrush = SolidColor(p.accent),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { saveTitle(); focus.clearFocus() }),
                    modifier = Modifier.weight(1f).onFocusChanged { if (!it.isFocused) saveTitle() },
                )
            }
            Spacer(Modifier.height(if (phone) 12.dp else 8.dp))
            Prop(Ic.user, "Assignee", phone, { picking = Picking.Assignee }) {
                if (who != null) {
                    Avatar(who, if (phone) 20.dp else 18.dp)
                    WText(who.name, fs, p.text, lineHeight = 1.3f)
                } else {
                    WText(if (task.assigneeId == null) "Unassigned" else "Another member", fs, p.textMuted, lineHeight = 1.3f)
                }
            }
            Prop(Ic.usersRound, "Team", phone, { picking = Picking.Team }) {
                if (team != null) {
                    Box(Modifier.size(9.dp).background(parseHex(team.color), CircleShape))
                    WText(TaskEdit.teamLabel(team, state.teams), fs, p.text, lineHeight = 1.3f)
                } else {
                    WText("No team", fs, p.textMuted, lineHeight = 1.3f)
                }
            }
            Prop(Ic.tag, "Tags", phone, { picking = Picking.Tags }) {
                if (tags.isEmpty()) {
                    WText("No tags", fs, p.textMuted, lineHeight = 1.3f)
                } else {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (t in tags) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Box(Modifier.size(8.dp).background(parseHex(t.color), CircleShape))
                                WText(t.name, fs, p.text, lineHeight = 1.3f)
                            }
                        }
                    }
                }
            }
            Prop(Ic.calendarDays, "Due date", phone, { picking = Picking.Due }) {
                val words = Due.words(task.dueDate, null, today)
                WText(words ?: "No date", fs, if (words == null) p.textMuted else toneColor(p, Due.tone(task.dueDate, today)), lineHeight = 1.3f)
            }
            Prop(Ic.clock, "Time", phone, { picking = Picking.Time }) {
                WText(task.dueTime ?: "--:-- --", fs, if (task.dueTime == null) p.textMuted else p.text, lineHeight = 1.3f)
                Spacer(Modifier.width(24.dp))
                LIcon(Ic.clock, 14.dp, p.text)
            }
            Prop(Ic.flag, "Priority", phone, { picking = Picking.Priority }) {
                if (priority < 4) {
                    LIcon(Ic.flagFilled, 14.dp, priorityColor(p, priority))
                    WText("Priority $priority", fs, p.text, lineHeight = 1.3f)
                } else {
                    WText("No priority", fs, p.textMuted, lineHeight = 1.3f)
                }
            }
            Prop(Ic.repeat, "Repeat", phone, { picking = Picking.Repeat }) {
                WText(TaskEdit.describeRepeat(detail?.recurrence), fs, if (detail?.recurrence == null) p.textMuted else p.text, lineHeight = 1.3f)
            }
            Prop(Ic.bell, "Reminders", phone, null) {
                LIcon(Ic.plus, 14.dp, p.text2)
                WText("Add reminder", if (phone) 15f else 13f, p.text2, weight = 600, lineHeight = 1.3f)
            }
            val shape = RoundedCornerShape(8.dp)
            BasicTextField(
                value = description, onValueChange = { description = it },
                textStyle = WebType.style(fs, 400, 1.5f).copy(color = p.text),
                cursorBrush = SolidColor(p.accent),
                modifier = Modifier.padding(top = 18.dp).fillMaxWidth().heightIn(min = 120.dp).background(p.bgSubtle, shape).border(1.dp, p.border, shape)
                    .onFocusChanged { if (!it.isFocused && description != task.description) actions.updateTask(task.id, TaskChanges(description = description)) }
                    .padding(13.dp),
                decorationBox = { inner ->
                    Box {
                        if (description.isEmpty()) WText("Add details…", fs, p.textMuted, lineHeight = 1.5f)
                        inner()
                    }
                },
            )
            Row(Modifier.padding(top = 18.dp, bottom = 6.dp).height(32.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                LIcon(Ic.listChecks, 16.dp, p.text2)
                WText("Subtasks", if (phone) 14.5f else 13f, p.text2, weight = 600, lineHeight = 1.3f)
            }
            for (s in subtasks) {
                Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.tappable { actions.toggleTask(s.id) }) { TaskCircle(s.priority.toInt(), s.done, p, 16.dp) }
                    WText(s.title, if (phone) 15f else 13f, if (s.done) p.textMuted else p.text, strike = s.done, lineHeight = 1.3f)
                }
            }
            Row(Modifier.padding(vertical = 8.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                LIcon(Ic.plus, 16.dp, p.textMuted)
                BasicTextField(
                    value = subtask, onValueChange = { subtask = it }, singleLine = true,
                    textStyle = WebType.style(fs, 400, 1.3f).copy(color = p.text),
                    cursorBrush = SolidColor(p.accent),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {
                        if (subtask.isNotBlank()) actions.addSubtask(task.id, subtask)
                        subtask = ""
                        focus.clearFocus()
                    }),
                    modifier = Modifier.weight(1f),
                    decorationBox = { inner ->
                        Box {
                            if (subtask.isEmpty()) WText("Add a subtask…", fs, p.textMuted, lineHeight = 1.3f)
                            inner()
                        }
                    },
                )
            }
            WText(
                "Created by ${state.person(detail?.createdBy)?.name ?: state.user?.name ?: "you"} · ${relativeTime(task.createdAt, LocalNow.current)}",
                if (phone) 14.5f else 12f, p.textMuted, Modifier.padding(top = 28.dp, bottom = 24.dp), lineHeight = 1.3f,
            )
        }
    }
    when (picking) {
        Picking.Assignee -> AssigneePicker(state, task.assigneeId, { id -> edit(if (id == null) TaskChanges(clearAssignee = true) else TaskChanges(assigneeId = id)) }, { picking = null })
        Picking.Team -> TeamPicker(state.teams, detail?.teamId, { id -> edit(if (id == null) TaskChanges(clearTeam = true) else TaskChanges(teamId = id)) }, { picking = null })
        Picking.Tags -> TagPicker(state, task.tagIds, { ids -> actions.updateTask(task.id, TaskChanges(tagIds = ids)) }, { picking = null })
        Picking.Due -> DuePicker(task.dueDate, today, { d -> edit(if (d == null) TaskChanges(clearDueDate = true, clearDueTime = true) else TaskChanges(dueDate = d.toString())) }, { picking = null })
        Picking.Time -> TimePicker(task.dueTime, { t -> edit(if (t == null) TaskChanges(clearDueTime = true) else TaskChanges(dueTime = t)) }, { picking = null })
        Picking.Priority -> PriorityPicker(priority, { n -> edit(TaskChanges(priority = n.toUByte())) }, { picking = null })
        Picking.Repeat -> RepeatPicker(detail?.recurrence, { rule -> edit(if (rule == null) TaskChanges(clearRecurrence = true) else TaskChanges(recurrence = rule)) }, { picking = null })
        null -> {}
    }
    if (confirmDelete) {
        PickerDialog("Delete this task?", { confirmDelete = false }) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                WText(
                    "“${task.title}”" + if (subtasks.isNotEmpty()) " and its ${subtasks.size} subtask" + (if (subtasks.size > 1) "s" else "") + " will be deleted. This can’t be undone." else " will be deleted. This can’t be undone.",
                    14f, p.text2, lineHeight = 1.45f, maxLines = 5,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Spacer(Modifier.weight(1f))
                    PickerButton("Cancel", false) { confirmDelete = false }
                    PickerButton("Delete", true) { confirmDelete = false; actions.deleteTask(task.id) }
                }
            }
        }
    }
}

@Composable
private fun Prop(icon: Int, label: String, phone: Boolean, onClick: (() -> Unit)?, value: @Composable () -> Unit) {
    val p = pal()
    Row(
        Modifier.fillMaxWidth().height(46.dp).then(if (onClick != null) Modifier.tappable(onClick) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(Modifier.width(if (phone) 110.dp else 120.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            LIcon(icon, if (phone) 18.dp else 15.dp, p.text2)
            WText(label, if (phone) 15f else 12.5f, p.text2, lineHeight = 1.3f)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { value() }
    }
}
