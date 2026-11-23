package com.notivelo.app.ui.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import com.notivelo.app.data.AppState
import com.notivelo.app.data.ShellActions
import com.notivelo.app.data.TreeIndex
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.parseHex
import com.notivelo.app.look.pal
import com.notivelo.app.ui.Avatar
import com.notivelo.app.ui.InitialTile
import com.notivelo.app.ui.SectionTree
import com.notivelo.app.ui.TreeMetrics
import com.notivelo.app.ui.WorkspaceLogo
import com.notivelo.app.ui.hairline
import com.notivelo.app.ui.rightRule
import com.notivelo.app.ui.tappable

/** The phone's sidebar (LOOK.md 3.2): workspace switcher, notebook picker, sections tree, the user row. */
@Composable
fun PhoneDrawer(
    state: AppState,
    index: TreeIndex?,
    actions: ShellActions,
    onClose: () -> Unit,
    onNotYet: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = pal()
    val screen = LocalConfiguration.current.screenWidthDp.dp
    val width = min(screen * 0.86f, 320.dp)
    val notebook = index?.resolveNotebook(state.notebookId)
    Column(
        modifier
            .width(width)
            .fillMaxHeight()
            .shadow(24.dp, RectangleShape, clip = false, ambientColor = p.shadowLg, spotColor = p.shadowLg)
            .background(p.bgSidebar)
            .rightRule(p.border),
    ) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).statusBarsPadding()) {
            WorkspaceSwitcher(state, actions)
            Spacer(Modifier.height(8.5.dp))
            if (notebook == null || index == null) {
                NoNotebooks(onNotYet)
            } else {
                NotebookHead(state, index, notebook, actions, onNotYet)
                Spacer(Modifier.height(5.dp))
                RecentHeading()
                Spacer(Modifier.height(20.dp))
                SectionsHeading(onNotYet)
                Spacer(Modifier.height(5.dp))
                Box(Modifier.padding(horizontal = 8.dp)) {
                    SectionTree(
                        index = index, notebook = notebook,
                        selectedSectionId = state.sectionId, selectedPageId = state.pageId,
                        taskCounts = state.taskCounts, metrics = TreeMetrics.Phone,
                        onSection = { actions.openSection(it.id); onClose() },
                        onPage = { actions.openPage(it.id); onClose() },
                        onNotYet = onNotYet,
                    )
                }
            }
        }
        UserRow(state, actions)
    }
}

@Composable
private fun MenuSurface(expanded: Boolean, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val p = pal()
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        containerColor = p.bgElevated,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, p.border),
    ) { content() }
}

@Composable
private fun MenuRow(label: String, selected: Boolean = false, danger: Boolean = false, onClick: () -> Unit) {
    val p = pal()
    DropdownMenuItem(
        text = { WText(label, 15f, if (danger) p.danger else if (selected) p.accent else p.text, weight = if (selected) 600 else 400) },
        onClick = onClick,
    )
}

@Composable
private fun WorkspaceSwitcher(state: AppState, actions: ShellActions) {
    val p = pal()
    var open by remember { mutableStateOf(false) }
    Box(Modifier.padding(start = 16.dp, top = 10.dp)) {
        Row(
            Modifier.height(36.dp).tappable { open = true },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val name = state.workspace?.name ?: "Workspace"
            WorkspaceLogo(name, 24.dp, 7.dp, 13f)
            WText(name, 15f, p.text, weight = 600)
            LIcon(Ic.chevronDown, 16.dp, p.textMuted)
        }
        MenuSurface(open, { open = false }) {
            for (w in state.workspaces) MenuRow(w.name, selected = w.id == state.workspaceId) {
                open = false
                actions.selectWorkspace(w.id)
            }
        }
    }
}

@Composable
private fun NotebookHead(state: AppState, index: TreeIndex?, notebook: com.notivelo.core.Notebook, actions: ShellActions, onNotYet: (String) -> Unit) {
    val p = pal()
    var open by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().height(52.dp).padding(start = 14.dp, end = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f)) {
            Row(
                Modifier.fillMaxWidth().height(36.dp).tappable { open = true }.padding(start = 8.dp, end = 21.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                InitialTile(notebook.name, parseHex(notebook.color), 22.dp, 6.dp, 12f)
                Spacer(Modifier.width(8.dp))
                WText(notebook.name, 15f, p.text, Modifier.weight(1f), weight = 650)
                if (notebook.visibility == "private") {
                    LIcon(Ic.lock, 12.dp, p.textMuted)
                    Spacer(Modifier.width(6.dp))
                }
                LIcon(Ic.chevronDown, 14.dp, p.textMuted)
            }
            MenuSurface(open, { open = false }) {
                for (nb in index?.notebooks.orEmpty()) MenuRow(nb.name, selected = nb.id == notebook.id) {
                    open = false
                    actions.selectNotebook(nb.id)
                }
            }
        }
        Box(Modifier.size(24.dp).tappable { onNotYet("Notebook options") }, contentAlignment = Alignment.Center) {
            LIcon(Ic.ellipsis, 15.dp, p.text2)
        }
    }
}

@Composable
private fun NoNotebooks(onNotYet: (String) -> Unit) {
    val p = pal()
    Row(
        Modifier.fillMaxWidth().height(52.dp).padding(start = 24.dp, end = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LIcon(Ic.bookPlus, 14.dp, p.text2)
        Spacer(Modifier.width(10.dp))
        WText("Notebooks", 15f, p.text, Modifier.weight(1f), weight = 650)
        LIcon(Ic.chevronDown, 14.dp, p.textMuted)
        Spacer(Modifier.width(1.dp))
    }
    Row(Modifier.padding(start = 18.dp, top = 4.dp)) {
        WText("No notebooks yet. ", 13.5f, p.textMuted)
        WText("Create one", 13.5f, p.accent, Modifier.tappable { onNotYet("New notebook") }, weight = 500)
    }
}

@Composable
private fun RecentHeading() {
    val p = pal()
    Row(
        Modifier.padding(start = 18.dp).height(26.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LIcon(Ic.clock, 12.dp, p.textMuted)
        WText("RECENT", 11.5f, p.textMuted, weight = 600, tracking = 0.04f)
        LIcon(Ic.chevronRight, 12.dp, p.textMuted)
    }
}

@Composable
private fun SectionsHeading(onNotYet: (String) -> Unit) {
    val p = pal()
    Row(Modifier.fillMaxWidth().height(26.dp).padding(start = 18.dp, end = 18.dp), verticalAlignment = Alignment.CenterVertically) {
        WText("SECTIONS", 11.5f, p.textMuted, Modifier.weight(1f), weight = 600, tracking = 0.04f)
        Box(Modifier.size(24.dp).tappable { onNotYet("New section") }, contentAlignment = Alignment.Center) {
            LIcon(Ic.plus, 15.dp, p.text2)
        }
    }
}

@Composable
private fun UserRow(state: AppState, actions: ShellActions) {
    val p = pal()
    var open by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().hairline(p.border, top = true).navigationBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().height(60.dp).tappable { open = true }.padding(start = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Avatar(state.user, 22.dp)
            Spacer(Modifier.width(10.dp))
            WText(state.user?.name ?: "", 15f, p.text2)
        }
        MenuSurface(open, { open = false }) {
            val email = state.user?.email
            if (email != null) MenuRow(email, onClick = { open = false })
            MenuRow("Sign out", danger = true) {
                open = false
                actions.signOut()
            }
        }
    }
}
