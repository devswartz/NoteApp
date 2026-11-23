package com.notivelo.app.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.ShellActions
import com.notivelo.app.data.TreeIndex
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.pal
import com.notivelo.app.ui.Avatar
import com.notivelo.app.ui.NotYetToast
import com.notivelo.app.data.Tab
import com.notivelo.app.ui.leftRule
import com.notivelo.app.ui.page.PageScreen
import com.notivelo.app.ui.tasks.TaskDetailContent
import com.notivelo.app.ui.tasks.TasksPanel
import com.notivelo.app.ui.tasks.TasksScreen
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.RectangleShape
import com.notivelo.app.ui.WorkspaceLogo
import com.notivelo.app.ui.hairline
import com.notivelo.app.ui.rightRule
import com.notivelo.app.ui.tappable
import com.notivelo.core.PageMeta
import com.notivelo.core.Section
import androidx.compose.foundation.BorderStroke
import com.notivelo.app.look.parseHex

/**
 * Tablets (> 760 dp wide, LOOK.md 3.1): the ribbon across the top, the rail, one sidebar panel with the
 * sections tree (pages folded in) and the content. The sidebar starts open from 900 dp up, closed below.
 */
@Composable
fun TabletShell(
    state: AppState,
    actions: ShellActions,
    sidebarOpen: Boolean,
    onSidebarChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    scrollPx: Int = 0,
) {
    val p = pal()
    val index = remember(state.tree) { state.tree?.let(::TreeIndex) }
    var toast by remember { mutableStateOf<String?>(null) }
    val notYet: (String) -> Unit = { toast = "$it is not in the native preview yet." }
    BoxWithConstraints(modifier.fillMaxSize().background(p.bg)) {
        val width = maxWidth
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Ribbon(width, state, actions, index, notYet)
            Row(Modifier.weight(1f).fillMaxWidth()) {
                Rail(state, actions, sidebarOpen, onSidebarChange, notYet)
                if (sidebarOpen) {
                    if (state.tab == Tab.Tasks) {
                        Column(Modifier.width(217.dp).fillMaxHeight().background(p.bgSidebar).rightRule(p.border)) {
                            TasksPanel(state, actions, notYet)
                        }
                    } else {
                        TabletSidebar(state, index, actions, notYet)
                    }
                }
                Box(Modifier.weight(1f).fillMaxHeight().background(p.bg)) {
                    TabletMain(scrollPx, state, index, actions, width, sidebarOpen, notYet)
                }
            }
        }
        if (state.taskDetailId != null) {
            Box(Modifier.fillMaxSize().background(p.bgOverlay).tappable { actions.openTask(null) })
            Box(
                Modifier.align(Alignment.CenterEnd).width(480.dp).fillMaxHeight()
                    .shadow(24.dp, RectangleShape, clip = false, ambientColor = p.shadowLg, spotColor = p.shadowLg)
                    .background(p.bg).leftRule(p.border),
            ) { TaskDetailContent(state, actions, phone = false) }
        }
        NotYetToast(state.notice ?: toast, { toast = null; actions.clearNotice() }, Modifier.align(Alignment.BottomCenter).padding(bottom = 20.dp))
    }
}

// Rail ---------------------------------------------------------------------------------------------------------

@Composable
private fun Rail(
    state: AppState,
    actions: ShellActions,
    sidebarOpen: Boolean,
    onSidebarChange: (Boolean) -> Unit,
    onNotYet: (String) -> Unit,
) {
    val p = pal()
    Column(
        Modifier
            .width(64.dp)
            .fillMaxHeight()
            .background(p.bgSidebar)
            .rightRule(p.border)
            .padding(top = 10.dp, bottom = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            RailButton("Notes", Ic.bookOpen, active = state.tab == Tab.Notes) { actions.goNotes() }
            RailButton("Tasks", Ic.listChecks, active = state.tab == Tab.Tasks) { actions.goTasks() }
            RailButton("Calendar", Ic.calendarDays, active = false) { onNotYet("Calendar") }
        }
        Spacer(Modifier.weight(1f))
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            FootIcon(if (sidebarOpen) Ic.panelLeftClose else Ic.panelLeftOpen) { onSidebarChange(!sidebarOpen) }
            FootIcon(Ic.search) { onNotYet("Search") }
            FootIcon(Ic.bell) { onNotYet("Notifications") }
            WorkspaceButton(state, actions)
            AccountButton(state, actions)
        }
    }
}

@Composable
private fun RailButton(label: String, icon: Int, active: Boolean, onClick: () -> Unit) {
    val p = pal()
    val color = if (active) p.accent else p.textMuted
    Box(Modifier.width(64.dp)) {
        Column(
            Modifier
                .align(Alignment.Center)
                .width(52.dp)
                .background(if (active) p.bgActive else Color.Transparent, RoundedCornerShape(9.dp))
                .tappable(onClick)
                .padding(top = 7.dp, bottom = 6.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            LIcon(icon, 20.dp, color)
            WText(label, 10.5f, color, weight = 600, lineHeight = 1f)
        }
        if (active) {
            // The 3 dp accent bar at the rail's left edge, 20 dp shorter than the button.
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .width(3.dp)
                    .height(27.dp)
                    .background(p.accent, RoundedCornerShape(topEnd = 3.dp, bottomEnd = 3.dp)),
            )
        }
    }
}

@Composable
private fun FootIcon(icon: Int, onClick: () -> Unit) {
    Box(Modifier.size(40.dp).tappable(onClick), contentAlignment = Alignment.Center) {
        LIcon(icon, 19.dp, pal().text2)
    }
}

@Composable
private fun WorkspaceButton(state: AppState, actions: ShellActions) {
    var open by remember { mutableStateOf(false) }
    Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.tappable { open = true }) {
            WorkspaceLogo(state.workspace?.name ?: "W", 28.dp, 8.dp, 14f)
        }
        Menu(open, { open = false }) {
            for (w in state.workspaces) MenuRow(w.name, w.id == state.workspaceId) {
                open = false
                actions.selectWorkspace(w.id)
            }
        }
    }
}

@Composable
private fun AccountButton(state: AppState, actions: ShellActions) {
    var open by remember { mutableStateOf(false) }
    Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.tappable { open = true }) { Avatar(state.user, 26.dp) }
        Menu(open, { open = false }) {
            state.user?.email?.let { MenuRow(it, false) { open = false } }
            MenuRow("Sign out", false, danger = true) {
                open = false
                actions.signOut()
            }
        }
    }
}

@Composable
internal fun Menu(expanded: Boolean, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val p = pal()
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        containerColor = p.bgElevated,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, p.border),
    ) { content() }
}

@Composable
internal fun MenuRow(label: String, selected: Boolean, danger: Boolean = false, onClick: () -> Unit) {
    val p = pal()
    DropdownMenuItem(
        text = { WText(label, 14f, if (danger) p.danger else if (selected) p.accent else p.text, weight = if (selected) 600 else 400) },
        onClick = onClick,
    )
}

// Main ---------------------------------------------------------------------------------------------------------

@Composable
private fun TabletMain(
    scrollPx: Int,
    state: AppState,
    index: TreeIndex?,
    actions: ShellActions,
    width: Dp,
    sidebarOpen: Boolean,
    onNotYet: (String) -> Unit,
) {
    val page = index?.page(state.pageId)
    val section = index?.section(state.sectionId)
    when {
        state.tab == Tab.Tasks -> TasksScreen(state, actions, phone = false, onNotYet = onNotYet)
        page != null && index != null -> PageScreen(state, page, index, phone = false, scrollPx = scrollPx)
        section != null && index != null && index.pages(section).isEmpty() && index.sections(section).isEmpty() ->
            EmptySection(section, onNotYet)
        else -> {
            // 64 rail + 216 sidebar (when open) + 1 border = 281
            val mainWidth = width - 64.dp - (if (sidebarOpen) 217.dp else 0.dp)
            NotesOverview(index, mainWidth, actions)
        }
    }
}

@Composable
private fun EmptySection(section: Section, onNotYet: (String) -> Unit) {
    val p = pal()
    Column(
        Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        LIcon(Ic.fileText, 28.dp, p.textMuted)
        Spacer(Modifier.height(19.dp))
        WText(section.name, 22f, p.text, weight = 700, lineHeight = 1.3f, tracking = -0.02f)
        Spacer(Modifier.height(23.dp))
        WText("This section has no pages yet.", 13f, p.textMuted, lineHeight = 1.5f)
        Spacer(Modifier.height(21.dp))
        Row(
            Modifier
                .height(32.dp)
                .background(p.accentSolid, RoundedCornerShape(8.dp))
                .tappable { onNotYet("New page") }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            LIcon(Ic.filePlus, 15.dp, p.textOnAccent)
            WText("New page", 13f, p.textOnAccent, weight = 700, lineHeight = 1f)
        }
    }
}
