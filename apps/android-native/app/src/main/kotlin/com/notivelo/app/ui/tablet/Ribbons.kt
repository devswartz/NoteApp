package com.notivelo.app.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.ShellActions
import com.notivelo.app.data.Tab
import com.notivelo.app.data.TaskList
import com.notivelo.app.data.TreeIndex
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.pal
import com.notivelo.app.ui.hairline
import com.notivelo.app.ui.tappable

/** Ribbon sizes by window width (src/styles/toolbar.css, `RibbonMetrics` in the Apple app): up to 1023 dp the smallest buttons. */
class RibbonMetrics(width: Dp) {
    val small = width <= 1023.dp
    val height: Dp = if (small) 30.dp else 36.dp
    val minWidth: Dp = if (small) 25.dp else 36.dp
    val pad: Dp = if (small) 3.dp else 8.dp
    val icon: Dp = if (small) 16.dp else 18.dp
    val block: Dp = if (small) 84.dp else 124.dp
    val gap: Dp = if (small) 0.dp else 2.dp
    val sepMargin: Dp = if (small) 2.dp else 4.dp
    val padLeft: Dp = if (small) 6.dp else 12.dp
    val padRight: Dp = if (small) 4.dp else 10.dp
}

/**
 * The ribbon for what is on screen (LOOK.md 4.1): the note ribbon on a page, the Tasks ribbon on the task views, the
 * Notes ribbon otherwise. Buttons that need an editor are dimmed and say "not in the native preview yet" (this step
 * only reads pages).
 */
@Composable
fun Ribbon(width: Dp, state: AppState, actions: ShellActions, index: TreeIndex?, onNotYet: (String) -> Unit) {
    val p = pal()
    val m = RibbonMetrics(width)
    val onPage = state.tab == Tab.Notes && state.pageId != null && index?.page(state.pageId) != null
    Row(
        Modifier
            .fillMaxWidth()
            .background(p.bgSidebar)
            .hairline(p.border)
            .padding(start = m.padLeft, end = m.padRight, top = 5.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(m.gap),
    ) {
        when {
            state.tab == Tab.Tasks -> TasksRibbon(m, state, actions, onNotYet)
            onPage -> NoteRibbon(m, onNotYet)
            else -> NotesRibbon(m, index, state, onNotYet)
        }
        Spacer(Modifier.weight(1f))
        if (onPage && state.tab == Tab.Notes) {
            RbButton(Ic.listTree, m, pressed = true) { onNotYet("Hiding the outline") }
            RbButton(Ic.undo2, m, enabled = state.page?.canUndo == true) { actions.undoPage() }
            RbButton(Ic.redo2, m, enabled = state.page?.canRedo == true) { actions.redoPage() }
        }
        Box(Modifier.padding(start = 4.dp).size(28.dp).tappable { onNotYet("Collapsing the ribbon") }, contentAlignment = Alignment.Center) {
            LIcon(Ic.chevronUp, 16.dp, p.text2)
        }
    }
}

@Composable
private fun RbSeparator(m: RibbonMetrics) {
    Box(Modifier.padding(horizontal = m.sepMargin).width(1.dp).height(22.dp).background(pal().border))
}

/** One ribbon button (`.bm-btn.rb-btn`): icon, optional caret; pressed = accent on accent-soft; disabled = 0.4. */
@Composable
private fun RbButton(icon: Int, m: RibbonMetrics, enabled: Boolean = true, pressed: Boolean = false, caret: Boolean = false, onClick: () -> Unit) {
    val p = pal()
    val color = if (pressed) p.accent else p.text2
    Row(
        Modifier
            .height(m.height)
            .defaultMinSize(minWidth = m.minWidth)
            .alpha(if (enabled) 1f else 0.4f)
            .background(if (pressed) p.accentSoft else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(6.dp))
            .then(if (enabled) Modifier.tappable(onClick) else Modifier)
            .padding(horizontal = m.pad),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        LIcon(icon, m.icon, color)
        if (caret) {
            Spacer(Modifier.width(2.dp))
            LIcon(Ic.chevronDown, 12.dp, color, Modifier.alpha(0.7f))
        }
    }
}

@Composable
private fun NotesRibbon(m: RibbonMetrics, index: TreeIndex?, state: AppState, onNotYet: (String) -> Unit) {
    val hasNotebook = index?.notebooks?.isNotEmpty() == true && state.notebookId != null
    RbButton(Ic.filePlus, m, hasNotebook) { onNotYet("New page") }
    RbButton(Ic.layoutTemplate, m, hasNotebook, caret = true) { onNotYet("Page templates") }
    RbButton(Ic.folderPlus, m, hasNotebook) { onNotYet("New section") }
    RbButton(Ic.bookPlus, m) { onNotYet("New notebook") }
    RbSeparator(m)
    RbButton(Ic.upload, m, caret = true) { onNotYet("Import") }
}

/** Text, Lists, Insert, Page: the editing controls are dimmed (no box is being edited); Page colour, Rule lines and Print are on. */
@Composable
private fun NoteRibbon(m: RibbonMetrics, onNotYet: (String) -> Unit) {
    val p = pal()
    Row(
        Modifier
            .width(m.block)
            .height(m.height)
            .alpha(0.4f)
            .background(p.bg, RoundedCornerShape(6.dp))
            .border(1.dp, p.border, RoundedCornerShape(6.dp))
            .padding(start = if (m.small) 6.dp else 10.dp, end = if (m.small) 4.dp else 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WText("Normal", 13f, p.text, Modifier.weight(1f), weight = 500, lineHeight = 1.3f)
        LIcon(Ic.chevronDown, 14.dp, p.text)
    }
    for (icon in listOf(Ic.letterB, Ic.italic, Ic.underline, Ic.strikethrough, Ic.baseline, Ic.highlighter, Ic.removeFormatting)) {
        RbButton(icon, m, enabled = false) {}
    }
    RbSeparator(m)
    for (icon in listOf(Ic.list, Ic.listOrdered, Ic.listIndentDecrease, Ic.listIndentIncrease)) RbButton(icon, m, enabled = false) {}
    Row(Modifier.height(m.height).alpha(0.4f), verticalAlignment = Alignment.CenterVertically) {
        LIcon(Ic.circleCheck, m.icon, p.text2, Modifier.padding(start = m.pad, end = 4.dp))
        LIcon(Ic.chevronDown, 14.dp, p.text2, Modifier.padding(horizontal = 2.dp))
    }
    RbSeparator(m)
    for (icon in listOf(Ic.table, Ic.imagePlus, Ic.paperclip, Ic.link2, Ic.fileSymlink, Ic.minus)) RbButton(icon, m, enabled = false) {}
    RbSeparator(m)
    RbButton(Ic.paintBucket, m) { onNotYet("Page colour") }
    RbButton(Ic.rows3, m) { onNotYet("Rule lines") }
    RbButton(Ic.printer, m) { onNotYet("Printing") }
}

/** The Tasks ribbon (SectionRibbons.tsx): New | Show | Organise | Filter | Views | Print. */
@Composable
private fun TasksRibbon(m: RibbonMetrics, state: AppState, actions: ShellActions, onNotYet: (String) -> Unit) {
    val list = state.taskList
    val fixed = list == TaskList.Today
    RbButton(Ic.plus, m) { actions.newTask() }
    RbSeparator(m)
    RbButton(Ic.sun, m, pressed = list == TaskList.Today) { actions.selectTaskList(TaskList.Today) }
    RbButton(Ic.calendarRange, m, pressed = list == TaskList.Upcoming) { actions.selectTaskList(TaskList.Upcoming) }
    RbButton(Ic.inbox, m, pressed = list == TaskList.My) { actions.selectTaskList(TaskList.My) }
    RbButton(Ic.listChecks, m, pressed = list == TaskList.All) { actions.selectTaskList(TaskList.All) }
    RbSeparator(m)
    RbButton(Ic.layers, m, enabled = !fixed, caret = true) { onNotYet("Grouping") }
    RbButton(Ic.arrowUpDown, m, enabled = !fixed, caret = true) { onNotYet("Sorting") }
    RbSeparator(m)
    RbButton(Ic.eye, m, caret = true) { onNotYet("Filters") }
    RbButton(Ic.user, m, enabled = !fixed && list != TaskList.My, caret = true) { onNotYet("Filters") }
    RbButton(Ic.tag, m, caret = true) { onNotYet("Filters") }
    RbButton(Ic.usersRound, m, caret = true) { onNotYet("Filters") }
    RbButton(Ic.flag, m, caret = true) { onNotYet("Filters") }
    RbButton(Ic.slidersHorizontal, m, caret = true) { onNotYet("Filters") }
    RbButton(Ic.funnelX, m, enabled = false) {}
    RbSeparator(m)
    RbButton(Ic.bookmark, m, caret = true) { onNotYet("Saved views") }
    RbButton(Ic.bookmarkPlus, m, enabled = false) {}
    RbSeparator(m)
    RbButton(Ic.printer, m) { onNotYet("Printing") }
}
