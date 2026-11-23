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
import com.notivelo.app.ui.PagePlaceholder
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
) {
    val p = pal()
    val index = remember(state.tree) { state.tree?.let(::TreeIndex) }
    var toast by remember { mutableStateOf<String?>(null) }
    val notYet: (String) -> Unit = { toast = "$it is not in the native preview yet." }
    BoxWithConstraints(modifier.fillMaxSize().background(p.bg)) {
        val width = maxWidth
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            NotesRibbon(width, index, state, notYet)
            Row(Modifier.weight(1f).fillMaxWidth()) {
                Rail(state, actions, sidebarOpen, onSidebarChange, notYet)
                if (sidebarOpen) TabletSidebar(state, index, actions, notYet)
                Box(Modifier.weight(1f).fillMaxHeight().background(p.bg)) {
                    TabletMain(state, index, actions, width, sidebarOpen, notYet)
                }
            }
        }
        NotYetToast(toast, { toast = null }, Modifier.align(Alignment.BottomCenter).padding(bottom = 20.dp))
    }
}

// Ribbon -------------------------------------------------------------------------------------------------------

/** The Notes ribbon (LOOK.md 4.1): New page, From template, New section, New notebook, Import. One row, never wraps. */
@Composable
private fun NotesRibbon(width: Dp, index: TreeIndex?, state: AppState, onNotYet: (String) -> Unit) {
    val p = pal()
    val small = width <= 1023.dp
    val hasNotebooks = index?.notebooks?.isNotEmpty() == true
    val hasNotebook = hasNotebooks && state.notebookId != null
    Row(
        Modifier
            .fillMaxWidth()
            .background(p.bgSidebar)
            .hairline(p.border)
            .padding(start = if (small) 6.dp else 12.dp, end = if (small) 4.dp else 10.dp, top = 5.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        RibbonButton(Ic.filePlus, small, hasNotebook) { onNotYet("New page") }
        RibbonButton(Ic.layoutTemplate, small, hasNotebook, chevron = true) { onNotYet("Page templates") }
        RibbonButton(Ic.folderPlus, small, hasNotebook) { onNotYet("New section") }
        RibbonButton(Ic.bookPlus, small, true) { onNotYet("New notebook") }
        Box(Modifier.padding(horizontal = if (small) 2.dp else 4.dp).width(1.dp).height(22.dp).background(p.border))
        RibbonButton(Ic.upload, small, true, chevron = true) { onNotYet("Import") }
        Spacer(Modifier.weight(1f))
        Box(Modifier.size(28.dp).tappable { onNotYet("Collapsing the ribbon") }, contentAlignment = Alignment.Center) {
            LIcon(Ic.chevronUp, 16.dp, p.text2)
        }
    }
}

@Composable
private fun RibbonButton(icon: Int, small: Boolean, enabled: Boolean, chevron: Boolean = false, onClick: () -> Unit) {
    val p = pal()
    Row(
        Modifier
            .height(if (small) 30.dp else 36.dp)
            .width(if (chevron) (if (small) 36.dp else 48.dp) else (if (small) 25.dp else 36.dp))
            .alpha(if (enabled) 1f else 0.4f)
            .then(if (enabled) Modifier.tappable(onClick) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        LIcon(icon, if (small) 16.dp else 18.dp, p.text2)
        if (chevron) {
            Spacer(Modifier.width(1.dp))
            LIcon(Ic.chevronDown, 12.dp, p.text2, Modifier.alpha(0.7f))
        }
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
            RailButton("Notes", Ic.bookOpen, active = true) { actions.goNotes() }
            RailButton("Tasks", Ic.listChecks, active = false) { onNotYet("Tasks") }
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
        page != null && index != null -> Column(Modifier.fillMaxSize()) {
            PageTopBar(index, page)
            PagePlaceholder(page, Modifier.weight(1f).fillMaxWidth())
        }
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
private fun PageTopBar(index: TreeIndex, page: PageMeta) {
    val p = pal()
    val section: Section? = index.section(page.sectionId)
    val notebook = section?.let { index.notebookOf(it) }
    Row(
        Modifier.fillMaxWidth().height(48.dp).background(p.bg.copy(alpha = 0.88f)).hairline(p.border).padding(start = 20.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (notebook != null) {
            Box(Modifier.size(8.dp).background(parseHex(notebook.color), CircleShape))
            WText(notebook.name, 13f, p.text2, lineHeight = 1.5f)
            LIcon(Ic.chevronRight, 14.dp, p.textMuted)
        }
        if (section != null) WText(section.name, 13f, p.text2, lineHeight = 1.5f)
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
        Spacer(Modifier.height(8.dp))
        WText(section.name, 22f, p.text, weight = 700, lineHeight = 1.3f, tracking = -0.02f)
        Spacer(Modifier.height(8.dp))
        WText("This section has no pages yet.", 13f, p.textMuted, lineHeight = 1.5f)
        Spacer(Modifier.height(8.dp))
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
