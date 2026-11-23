package com.notivelo.app.ui.tasks

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.Due
import com.notivelo.app.data.ShellActions
import com.notivelo.app.data.TaskBuckets
import com.notivelo.app.data.TaskList
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.Palette
import com.notivelo.app.look.WText
import com.notivelo.app.look.WebType
import com.notivelo.app.look.parseHex
import com.notivelo.app.look.pal
import com.notivelo.app.ui.Avatar
import com.notivelo.app.ui.LocalNow
import com.notivelo.app.ui.LocalToday
import com.notivelo.app.ui.page.TaskCircle
import com.notivelo.app.ui.page.toneColor
import com.notivelo.app.ui.tappable
import com.notivelo.core.Task
import java.time.ZoneId

/** The buckets for the state's tasks, as of the screen's "today". */
@Composable
fun rememberBuckets(state: AppState): TaskBuckets {
    val today = LocalToday.current
    return remember(state.tasks, state.user, today) {
        TaskBuckets(state.tasks, state.user?.id, today, ZoneId.of("UTC").takeIf { state.preview } ?: ZoneId.systemDefault())
    }
}

/** Today, My Tasks, Upcoming and All tasks (LOOK.md 4.10; the Apple app's `TasksScreen`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TasksScreen(state: AppState, actions: ShellActions, phone: Boolean, modifier: Modifier = Modifier, onNotYet: (String) -> Unit) {
    val p = pal()
    val list = state.taskList
    val buckets = rememberBuckets(state)
    val groups = buckets.groups(list, state.everyone)
    val today = LocalToday.current
    Column(
        modifier
            .verticalScroll(rememberScrollState())
            .padding(top = if (phone) 20.dp else 42.dp, start = if (phone) 16.dp else 40.dp, end = if (phone) 16.dp else 40.dp, bottom = if (phone) 96.dp else 120.dp),
    ) {
        WText(list.title, if (phone) 24f else 26f, p.text, Modifier.height(if (phone) 38.dp else 34.dp), weight = 700, lineHeight = if (phone) 38f / 24f else 34f / 26f, tracking = -0.02f)
        WText(list.subtitle, 14f, p.textMuted, Modifier.padding(top = 4.dp).height(21.dp), lineHeight = 1.5f, maxLines = 2)
        if (phone) {
            AddFilter(Modifier.padding(top = 16.dp)) { onNotYet("Filters") }
            if (list == TaskList.Upcoming) {
                Row(
                    Modifier.padding(top = 12.dp).background(p.bgHover, RoundedCornerShape(8.dp)).padding(2.dp),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    for (label in listOf("Mine", "Everyone")) {
                        val active = (label == "Everyone") == state.everyone
                        Box(
                            Modifier.height(26.dp)
                                .then(if (active) Modifier.shadow(1.dp, RoundedCornerShape(6.dp), clip = false, ambientColor = p.shadow, spotColor = p.shadow) else Modifier)
                                .background(if (active) p.bgElevated else Color.Transparent, RoundedCornerShape(6.dp))
                                .tappable { actions.setEveryone(label == "Everyone") }
                                .padding(horizontal = 12.dp),
                            contentAlignment = Alignment.Center,
                        ) { WText(label, 13.5f, p.text, weight = 500, lineHeight = 1f) }
                    }
                }
            }
        }
        if (list == TaskList.Today) {
            StatsCard(buckets.doneToday, buckets.list(TaskList.Today).size, Modifier.padding(top = if (phone) 12.dp else 20.dp))
        }
        if (groups.isEmpty()) {
            if (list == TaskList.Today) {
                Column(Modifier.padding(top = 20.dp)) {
                    GroupHeading("Today · " + Due.fmt(today, "EEE d MMM"), null, false)
                    AddTaskRow(Modifier.padding(top = 2.dp)) { onNotYet("Adding a task") }
                }
            }
            EmptyState(list, phone, Modifier.padding(top = if (list == TaskList.Today) 36.dp else 20.dp))
        } else {
            Column(Modifier.padding(top = 20.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
                for (g in groups) {
                    Column {
                        GroupHeading(g.title, g.tasks.size, g.overdue)
                        for (t in g.tasks) TaskRow(t, state, actions, phone, today)
                        if (!g.overdue) AddTaskRow(Modifier.padding(top = 2.dp)) { onNotYet("Adding a task") }
                    }
                }
            }
        }
    }
}

@Composable
private fun AddFilter(modifier: Modifier, onClick: () -> Unit) {
    val p = pal()
    val shape = RoundedCornerShape(8.dp)
    Row(
        modifier
            .height(28.dp)
            .shadow(1.dp, shape, clip = false, ambientColor = p.shadow, spotColor = p.shadow)
            .background(p.bgElevated, shape)
            .border(1.dp, p.border, shape)
            .tappable(onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LIcon(Ic.plus, 15.dp, p.text)
        WText("Add filter", 13.5f, p.text, weight = 500, lineHeight = 1f)
    }
}

@Composable
private fun GroupHeading(title: String, count: Int?, overdue: Boolean) {
    val p = pal()
    Row(
        Modifier.fillMaxWidth().drawBehind {
            drawRect(p.border, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx()))
        }.padding(top = 8.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        WText(title, 13.5f, if (overdue) p.danger else p.text, weight = 650, lineHeight = 1.3f)
        if (count != null) WText("$count", 12f, p.textMuted, weight = 500, lineHeight = 1.3f)
    }
}

@Composable
private fun AddTaskRow(modifier: Modifier, onClick: () -> Unit) {
    val p = pal()
    Row(
        modifier.tappable(onClick).padding(vertical = 8.dp, horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LIcon(Ic.plus, 15.dp, p.textMuted)
        WText("Add task", 13.5f, p.textMuted, lineHeight = 1.4f)
    }
}

@Composable
private fun EmptyState(list: TaskList, phone: Boolean, modifier: Modifier) {
    val p = pal()
    if (list == TaskList.Today) {
        Column(modifier.fillMaxWidth().padding(vertical = 40.dp, horizontal = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("☀️", fontSize = 40.sp, maxLines = 1, softWrap = false)
            WText("You’re all caught up", 15f, p.text, Modifier.padding(top = 6.dp), weight = 700, lineHeight = 1.4f)
            WText(
                "Nothing due today. Enjoy it — or plan ahead in Upcoming.", if (phone) 15f else 14f, p.textMuted,
                Modifier.padding(top = 8.dp), lineHeight = if (phone) 1.5f else 1.4f, maxLines = 3, align = TextAlign.Center,
            )
        }
    } else {
        val msg = when (list) {
            TaskList.My -> "No tasks assigned to you."
            TaskList.Upcoming -> "Nothing scheduled."
            else -> "No tasks match these filters."
        }
        Box(modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { WText(msg, 14f, p.textMuted, lineHeight = 1.4f) }
    }
}

/** Today's stats card: done today, left, day streak, a week of bars, the progress line. */
@Composable
private fun StatsCard(done: Int, left: Int, modifier: Modifier) {
    val p = pal()
    val shape = RoundedCornerShape(12.dp)
    val total = maxOf(done + left, 1)
    val today = LocalToday.current
    val dow = today.dayOfWeek.value % 7 // Sunday 0
    val letters = listOf("S", "M", "T", "W", "T", "F", "S")
    Box(modifier.fillMaxWidth().background(p.bgElevated, shape).border(1.dp, p.border, shape).clip(shape)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Stat("$done", "done today")
            Stat("$left", "left")
            Stat(if (done > 0) "1" else "0", "day streak")
            Spacer(Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Bottom) {
                for (i in 0..6) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Box(Modifier.size(10.dp, 32.dp).background(if (i == 6) p.accent else p.bgHover, RoundedCornerShape(3.dp)))
                        WText(letters[((dow - (6 - i)) % 7 + 7) % 7], 10.5f, p.textMuted, lineHeight = 1.3f)
                    }
                }
            }
        }
        Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(done.toFloat() / total).height(3.dp).background(p.success))
    }
}

@Composable
private fun Stat(n: String, label: String) {
    val p = pal()
    Column {
        WText(n, 22f, p.text, weight = 700, lineHeight = 1.45f)
        WText(label, 12f, p.textMuted, lineHeight = 1.3f)
    }
}

/** A task row (src/components/TaskRow.tsx): circle, title, meta line, avatar. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TaskRow(task: Task, state: AppState, actions: ShellActions, phone: Boolean, today: java.time.LocalDate) {
    val p = pal()
    val done = task.done
    val priority = task.priority.toInt()
    val pageTitle = task.pageId?.let { id -> state.tree?.pages?.firstOrNull { it.id == id }?.title ?: state.otherPageTitles[id] }
    Row(
        Modifier
            .fillMaxWidth()
            .drawBehind { drawRect(p.border, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }
            .tappable { if (!task.locked) actions.openTask(task.id) }
            .padding(vertical = if (phone) 12.dp else 13.dp, horizontal = if (phone) 12.dp else 6.dp),
        horizontalArrangement = Arrangement.spacedBy(if (phone) 16.dp else 10.dp),
    ) {
        Box(Modifier.padding(top = 1.dp).tappable { if (!task.locked) actions.toggleTask(task.id) }) {
            TaskCircle(priority, done, p, if (phone) 22.dp else 18.dp)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (phone) 6.dp else 3.dp)) {
            Text(
                text = if (task.locked) "Locked task" else task.title,
                color = if (done) p.textMuted else p.text,
                style = WebType.style(14f, 400, if (phone) 1.45f else 1.4f).copy(textDecoration = if (done) TextDecoration.LineThrough else null),
                modifier = Modifier.heightIn(min = 19.6.dp),
            )
            val due = Due.words(task.dueDate, task.dueTime, today)
            if (due != null || priority < 4 || pageTitle != null) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(if (phone) 9.dp else 6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (due != null) {
                        val tone = toneColor(p, Due.tone(task.dueDate, today))
                        Row(Modifier.height(18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            LIcon(Ic.calendarDays, 13.dp, tone)
                            WText(due, 12f, tone, lineHeight = 1.3f)
                        }
                    }
                    if (priority < 4) {
                        Box(Modifier.height(18.dp), contentAlignment = Alignment.Center) { LIcon(Ic.flagFilled, 13.dp, com.notivelo.app.ui.page.priorityColor(p, priority)) }
                    }
                    if (pageTitle != null) {
                        Row(Modifier.heightIn(min = 18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            LIcon(Ic.fileText, 13.dp, p.textMuted)
                            WText(pageTitle, 12f, p.textMuted, lineHeight = 1.3f, maxLines = if (phone) 2 else 1)
                        }
                    }
                }
            }
        }
        val me = state.user
        if (me != null && task.assigneeId == me.id) Avatar(me, 20.dp)
    }
}
