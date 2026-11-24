package com.notivelo.app.ui.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.Due
import com.notivelo.app.data.ShellActions
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.WebType
import com.notivelo.app.look.pal
import com.notivelo.app.ui.Avatar
import com.notivelo.app.ui.LocalNow
import com.notivelo.app.ui.LocalToday
import com.notivelo.app.ui.page.TaskCircle
import com.notivelo.app.ui.page.priorityColor
import com.notivelo.app.ui.page.toneColor
import com.notivelo.app.ui.relativeTime
import com.notivelo.app.ui.tappable

/**
 * A task's detail (the web's task sheet, read-only here): the head with the page it is on and Close, the title with its
 * circle, the property rows (assignee, tags, due date, time, priority, reminders), the details, subtasks. The core's
 * `Task` has no team or repeat rule, so those rows are left out (as in the Apple app). Ticking the circle is the one write.
 */
@Composable
fun TaskDetailContent(state: AppState, actions: ShellActions, phone: Boolean, modifier: Modifier = Modifier) {
    val p = pal()
    val task = state.tasks.firstOrNull { it.id == state.taskDetailId } ?: return
    val today = LocalToday.current
    val pageTitle = task.pageId?.let { id -> state.tree?.pages?.firstOrNull { it.id == id }?.title ?: state.otherPageTitles[id] }
    val subtasks = state.tasks.filter { it.parentId == task.id }
    val priority = task.priority.toInt()
    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().height(if (phone) 52.dp else 52.dp)
                .drawBehind { drawRect(p.border, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }
                .padding(start = if (phone) 24.dp else 24.dp, end = if (phone) 16.dp else 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WText(if (task.pageId != null) "On “${pageTitle ?: "a page"}”" else "Standalone task", if (phone) 14.5f else 13f, p.text2, Modifier.weight(1f), lineHeight = 1.3f)
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) { LIcon(Ic.trash, 18.dp, p.text2) }
            Box(Modifier.size(40.dp).tappable { actions.openTask(null) }, contentAlignment = Alignment.Center) { LIcon(Ic.x, 20.dp, p.text2) }
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = if (phone) 16.dp else 24.dp),
        ) {
            Row(Modifier.padding(top = if (phone) 24.dp else 20.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(Modifier.tappable { actions.toggleTask(task.id) }) { TaskCircle(priority, task.done, p, if (phone) 22.dp else 18.dp) }
                Text(
                    task.title,
                    color = if (task.done) p.textMuted else p.text,
                    style = WebType.style(if (phone) 22f else 17f, 650, 1.3f, -0.01f).copy(textDecoration = if (task.done) TextDecoration.LineThrough else null),
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(if (phone) 12.dp else 8.dp))
            Prop(Ic.user, "Assignee", phone) {
                val me = state.user
                if (me != null && task.assigneeId == me.id) {
                    Avatar(me, if (phone) 20.dp else 18.dp)
                    WText(me.name, if (phone) 16f else 13f, p.text, lineHeight = 1.3f)
                } else {
                    WText(if (task.assigneeId == null) "Unassigned" else "Another member", if (phone) 16f else 13f, p.textMuted, lineHeight = 1.3f)
                }
            }
            Prop(Ic.tag, "Tags", phone) {
                WText(if (task.tagIds.isEmpty()) "No tags" else "${task.tagIds.size} tag" + if (task.tagIds.size > 1) "s" else "", if (phone) 16f else 13f, p.textMuted, lineHeight = 1.3f)
            }
            Prop(Ic.calendarDays, "Due date", phone) {
                val words = Due.words(task.dueDate, null, today)
                WText(words ?: "No date", if (phone) 16f else 13f, if (words == null) p.textMuted else toneColor(p, Due.tone(task.dueDate, today)), lineHeight = 1.3f)
            }
            Prop(Ic.clock, "Time", phone) {
                WText(task.dueTime ?: "--:-- --", if (phone) 16f else 13f, if (task.dueTime == null) p.textMuted else p.text, lineHeight = 1.3f)
                Spacer(Modifier.width(24.dp))
                LIcon(Ic.clock, 14.dp, p.text)
            }
            Prop(Ic.flag, "Priority", phone) {
                if (priority < 4) {
                    LIcon(Ic.flagFilled, 14.dp, priorityColor(p, priority))
                    WText("Priority $priority", if (phone) 16f else 13f, p.text, lineHeight = 1.3f)
                } else {
                    WText("No priority", if (phone) 16f else 13f, p.textMuted, lineHeight = 1.3f)
                }
            }
            Prop(Ic.bell, "Reminders", phone) {
                LIcon(Ic.plus, 14.dp, p.text2)
                WText("Add reminder", if (phone) 15f else 13f, p.text2, weight = 600, lineHeight = 1.3f)
            }
            val shape = RoundedCornerShape(8.dp)
            Box(Modifier.padding(top = 18.dp).fillMaxWidth().height(if (phone) 120.dp else 120.dp).background(p.bgSubtle, shape).border(1.dp, p.border, shape).padding(13.dp)) {
                WText(task.description.ifEmpty { "Add details…" }, if (phone) 16f else 13f, if (task.description.isEmpty()) p.textMuted else p.text, lineHeight = 1.5f, maxLines = 5)
            }
            Row(Modifier.padding(top = 18.dp, bottom = 6.dp).height(32.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                LIcon(Ic.listChecks, 16.dp, p.text2)
                WText("Subtasks", if (phone) 14.5f else 13f, p.text2, weight = 600, lineHeight = 1.3f)
            }
            for (s in subtasks) {
                Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TaskCircle(s.priority.toInt(), s.done, p, 16.dp)
                    WText(s.title, if (phone) 15f else 13f, if (s.done) p.textMuted else p.text, strike = s.done, lineHeight = 1.3f)
                }
            }
            Row(Modifier.padding(vertical = 8.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                LIcon(Ic.plus, 16.dp, p.textMuted)
                WText("Add a subtask…", if (phone) 16f else 13f, p.textMuted, lineHeight = 1.3f)
            }
            WText(
                "Created by ${state.user?.name ?: "you"} · ${relativeTime(task.createdAt, LocalNow.current)}",
                if (phone) 14.5f else 12f, p.textMuted, Modifier.padding(top = 28.dp, bottom = 24.dp), lineHeight = 1.3f,
            )
        }
    }
}

@Composable
private fun Prop(icon: Int, label: String, phone: Boolean, value: @Composable () -> Unit) {
    val p = pal()
    Row(Modifier.fillMaxWidth().height(if (phone) 46.dp else 46.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.width(if (phone) 110.dp else 120.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            LIcon(icon, if (phone) 18.dp else 15.dp, p.text2)
            WText(label, if (phone) 15f else 12.5f, p.text2, lineHeight = 1.3f)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { value() }
    }
}
