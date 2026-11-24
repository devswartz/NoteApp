package com.notivelo.app.ui.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.notivelo.app.data.AppState
import com.notivelo.app.data.Due
import com.notivelo.app.data.TaskEdit
import com.notivelo.app.data.asUser
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.WebType
import com.notivelo.app.look.parseHex
import com.notivelo.app.look.pal
import com.notivelo.app.ui.Avatar
import com.notivelo.app.ui.page.priorityColor
import com.notivelo.app.ui.tappable
import com.notivelo.core.TaskRecurrence
import com.notivelo.core.TaskTeam
import com.notivelo.core.User
import java.time.LocalDate
import java.time.YearMonth

/** A modal card with a title: the web's dropdown menus, as a dialog (they open from the task detail's rows). */
@Composable
fun PickerDialog(title: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val p = pal()
    val shape = RoundedCornerShape(12.dp)
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.widthIn(max = 340.dp).fillMaxWidth()
                .shadow(24.dp, shape, clip = false, ambientColor = p.shadowLg, spotColor = p.shadowLg)
                .background(p.bgElevated, shape).border(1.dp, p.border, shape)
                .padding(vertical = 8.dp),
        ) {
            WText(title, 13f, p.textMuted, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), weight = 600, lineHeight = 1.3f)
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), content = content)
        }
    }
}

/** One choice: [leading], the label, a check when it is the current one. */
@Composable
fun PickerRow(label: String, selected: Boolean, onClick: () -> Unit, muted: Boolean = false, leading: @Composable () -> Unit = {}) {
    val p = pal()
    Row(
        Modifier.fillMaxWidth().height(44.dp).tappable(onClick).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        leading()
        WText(label, 15f, if (muted) p.textMuted else p.text, Modifier.weight(1f), lineHeight = 1.3f)
        if (selected) LIcon(Ic.check, 16.dp, p.accent)
    }
}

@Composable
fun AssigneePicker(state: AppState, current: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    val people: List<User> = remember(state.members, state.user) {
        val list = state.members.map { it.asUser() }
        val me = state.user
        if (me != null && list.none { it.id == me.id }) listOf(me) + list else list
    }
    PickerDialog("Assignee", onDismiss) {
        for (u in people) {
            PickerRow(if (u.id == state.user?.id) "${u.name} (you)" else u.name, current == u.id, { onPick(u.id) }) { Avatar(u, 22.dp) }
        }
        PickerRow("Unassigned", current == null, { onPick(null) }, muted = true) { LIcon(Ic.user, 20.dp, pal().textMuted) }
    }
}

/** Teams in display order: each team followed by its subteams (the web's `orderedTeams`, by name: the core has no positions). */
fun orderedTeams(teams: List<TaskTeam>): List<TaskTeam> {
    val ids = teams.map { it.id }.toSet()
    val top = teams.filter { it.parentId == null || it.parentId !in ids }.sortedBy { it.name.lowercase() }
    return top.flatMap { t -> listOf(t) + teams.filter { it.parentId == t.id }.sortedBy { it.name.lowercase() } }
}

@Composable
fun TeamPicker(teams: List<TaskTeam>, current: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    PickerDialog("Team", onDismiss) {
        for (t in orderedTeams(teams)) {
            PickerRow(TaskEdit.teamLabel(t, teams), current == t.id, { onPick(t.id) }) {
                Box(Modifier.size(9.dp).background(parseHex(t.color), CircleShape))
            }
        }
        PickerRow("No team", current == null, { onPick(null) }, muted = true)
    }
}

@Composable
fun TagPicker(state: AppState, current: List<String>, onChange: (List<String>) -> Unit, onDismiss: () -> Unit) {
    val p = pal()
    PickerDialog("Tags", onDismiss) {
        if (state.tags.isEmpty()) WText("No tags in this workspace yet.", 14f, p.textMuted, Modifier.padding(horizontal = 16.dp, vertical = 12.dp), lineHeight = 1.4f)
        for (t in state.tags) {
            val on = t.id in current
            PickerRow(t.name, on, { onChange(if (on) current - t.id else current + t.id) }) {
                Box(Modifier.size(9.dp).background(parseHex(t.color), CircleShape))
            }
        }
    }
}

@Composable
fun PriorityPicker(current: Int, onPick: (Int) -> Unit, onDismiss: () -> Unit) {
    val p = pal()
    PickerDialog("Priority", onDismiss) {
        for (n in 1..4) {
            PickerRow(if (n == 4) "No priority" else "Priority $n", current == n, { onPick(n) }, muted = n == 4) {
                if (n < 4) LIcon(Ic.flagFilled, 16.dp, priorityColor(p, n)) else LIcon(Ic.flag, 16.dp, p.textMuted)
            }
        }
    }
}

@Composable
fun RepeatPicker(current: TaskRecurrence?, onPick: (TaskRecurrence?) -> Unit, onDismiss: () -> Unit) {
    val p = pal()
    val now = TaskEdit.describeRepeat(current)
    PickerDialog("Repeat", onDismiss) {
        for ((label, rule) in TaskEdit.repeatPresets) {
            PickerRow(label, label == now, { onPick(rule) }, muted = rule == null) { LIcon(Ic.repeat, 16.dp, p.text2) }
        }
        // A rule made elsewhere (every 3 days, on Mondays...) stays as it is until another is picked.
        if (current != null && TaskEdit.repeatPresets.none { it.first == now }) PickerRow(now, true, onDismiss) { LIcon(Ic.repeat, 16.dp, p.text2) }
    }
}

@Composable
fun TimePicker(current: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    val p = pal()
    var text by remember { mutableStateOf(current ?: "") }
    val parsed = TaskEdit.parseTime(text)
    PickerDialog("Time", onDismiss) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val shape = RoundedCornerShape(8.dp)
            BasicTextField(
                value = text, onValueChange = { text = it },
                textStyle = WebType.style(16f, 400, 1.3f).copy(color = p.text),
                cursorBrush = SolidColor(p.accent), singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (parsed != null) onPick(parsed) }),
                modifier = Modifier.fillMaxWidth().background(p.bgSubtle, shape).border(1.dp, if (text.isNotEmpty() && parsed == null) p.danger else p.border, shape).padding(12.dp),
                decorationBox = { inner ->
                    Box {
                        if (text.isEmpty()) WText("9:30, 14:00 or 3pm", 16f, p.textPlaceholder, lineHeight = 1.3f)
                        inner()
                    }
                },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                PickerButton("Clear", false) { onPick(null) }
                Spacer(Modifier.weight(1f))
                PickerButton("Set time", true, enabled = parsed != null) { parsed?.let(onPick) }
            }
        }
    }
}

@Composable
fun PickerButton(label: String, primary: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val p = pal()
    val shape = RoundedCornerShape(8.dp)
    Box(
        Modifier.height(36.dp)
            .background(if (primary) p.accentSolid else Color.Transparent, shape)
            .then(if (primary) Modifier else Modifier.border(1.dp, p.border, shape))
            .then(if (enabled) Modifier.tappable(onClick) else Modifier)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) { WText(label, 14f, if (!enabled) p.textMuted else if (primary) p.textOnAccent else p.text, weight = 500, lineHeight = 1f) }
}

/** The due-date menu: Today, Tomorrow, Next week, a month grid, No date (the web's `DueMenu`). */
@Composable
fun DuePicker(current: String?, today: LocalDate, onPick: (LocalDate?) -> Unit, onDismiss: () -> Unit) {
    val p = pal()
    val selected = Due.date(current)
    var month by remember { mutableStateOf(YearMonth.from(selected ?: today)) }
    PickerDialog("Due date", onDismiss) {
        for ((label, d) in TaskEdit.dueShortcuts(today)) {
            PickerRow(label, selected == d, { onPick(d) }) {
                LIcon(Ic.calendarDays, 16.dp, p.text2)
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).tappable { month = month.minusMonths(1) }, contentAlignment = Alignment.Center) { LIcon(Ic.chevronLeft, 18.dp, p.text2) }
            WText(Due.fmt(month.atDay(1), "MMMM yyyy"), 14f, p.text, Modifier.weight(1f), weight = 600, lineHeight = 1.3f, align = TextAlign.Center)
            Box(Modifier.size(40.dp).tappable { month = month.plusMonths(1) }, contentAlignment = Alignment.Center) { LIcon(Ic.chevronRight, 18.dp, p.text2) }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
            for (l in listOf("M", "T", "W", "T", "F", "S", "S")) {
                Box(Modifier.weight(1f).height(28.dp), contentAlignment = Alignment.Center) { WText(l, 12f, p.textMuted, lineHeight = 1f) }
            }
        }
        for (week in TaskEdit.monthCells(month.year, month.monthValue).chunked(7)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                for (d in week) {
                    Box(Modifier.weight(1f).height(40.dp), contentAlignment = Alignment.Center) {
                        if (d != null) {
                            val on = d == selected
                            Box(
                                Modifier.size(34.dp)
                                    .background(if (on) p.accentSolid else Color.Transparent, CircleShape)
                                    .then(if (d == today && !on) Modifier.border(1.dp, p.accent, CircleShape) else Modifier)
                                    .tappable { onPick(d) },
                                contentAlignment = Alignment.Center,
                            ) { WText("${d.dayOfMonth}", 14f, if (on) p.textOnAccent else p.text, lineHeight = 1f) }
                        }
                    }
                }
            }
        }
        PickerRow("No date", selected == null, { onPick(null) }, muted = true)
    }
}

/** The quick-add dialog (the web's QuickAdd: one line of natural language; `@`, `#`, `+`, `p1`, dates and repeats are read by the core). */
@Composable
fun QuickAddDialog(dueDate: String?, today: LocalDate, onAdd: (String) -> Unit, onDismiss: () -> Unit) {
    val p = pal()
    var text by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { try { focus.requestFocus() } catch (e: Exception) { } }
    PickerDialog("Quick add task", onDismiss) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val shape = RoundedCornerShape(8.dp)
            BasicTextField(
                value = text, onValueChange = { text = it },
                textStyle = WebType.style(16f, 400, 1.3f).copy(color = p.text),
                cursorBrush = SolidColor(p.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (text.isNotBlank()) onAdd(text) }),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).background(p.bgSubtle, shape).border(1.dp, p.border, shape).padding(12.dp),
                decorationBox = { inner ->
                    Box {
                        if (text.isEmpty()) WText("e.g. Call Sam tomorrow 3pm p1", 16f, p.textPlaceholder, lineHeight = 1.3f)
                        inner()
                    }
                },
            )
            val due = dueDate?.let { Due.words(it, null, today) }
            WText(
                if (due != null) "Due $due unless you say another date. @name, #tag, +team, p1 to p4." else "@name, #tag, +team, p1 to p4, dates and repeats (every week).",
                12.5f, p.textMuted, lineHeight = 1.4f, maxLines = 3,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Spacer(Modifier.weight(1f))
                PickerButton("Cancel", false, onClick = onDismiss)
                PickerButton("Add task", true, enabled = text.isNotBlank()) { onAdd(text) }
            }
        }
    }
}
