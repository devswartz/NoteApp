package com.notivelo.app.ui.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.ShellActions
import com.notivelo.app.data.TreeIndex
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.LocalPhone
import com.notivelo.app.look.WText
import com.notivelo.app.look.pal
import com.notivelo.app.ui.NotYetToast
import com.notivelo.app.ui.hairline
import com.notivelo.app.ui.tappable
import androidx.compose.runtime.CompositionLocalProvider

/**
 * Phones (<= 760 dp, LOOK.md 3.2, `MobileChrome.tsx`): a top bar, the screen, a tab bar with the floating
 * "Add task" button; the sidebar is a drawer. Notes drill down notebook, section, page.
 */
@Composable
fun PhoneShell(
    state: AppState,
    actions: ShellActions,
    drawerOpen: Boolean,
    onDrawerChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = pal()
    val index = remember(state.tree) { state.tree?.let(::TreeIndex) }
    var toast by remember { mutableStateOf<String?>(null) }
    val notYet: (String) -> Unit = { toast = "$it is not in the native preview yet." }
    val onPage = state.pageId != null
    val inSection = state.sectionId != null && !onPage

    CompositionLocalProvider(LocalPhone provides true) {
        Box(modifier.fillMaxSize().background(p.bg)) {
            Column(Modifier.fillMaxSize()) {
                TopBar(
                    title = state.workspace?.name ?: "Notes",
                    subtitled = inSection,
                    back = onPage || inSection || state.phoneNotebookId != null,
                    onMenu = { onDrawerChange(true) },
                    onBack = actions::back,
                    onNotYet = notYet,
                )
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    NotesContent(state, index, actions, notYet)
                    if (!onPage) Fab(Modifier.align(Alignment.BottomEnd)) { notYet("Adding a task") }
                }
                TabBar(onNotYet = notYet)
            }
            if (drawerOpen) {
                Box(Modifier.fillMaxSize().background(p.bgOverlay).tappable { onDrawerChange(false) })
                PhoneDrawer(
                    state = state, index = index, actions = actions,
                    onClose = { onDrawerChange(false) }, onNotYet = notYet,
                    modifier = Modifier.align(Alignment.CenterStart),
                )
            }
            NotYetToast(toast, { toast = null }, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 76.dp))
        }
    }
}

@Composable
private fun TopBar(
    title: String,
    subtitled: Boolean,
    back: Boolean,
    onMenu: () -> Unit,
    onBack: () -> Unit,
    onNotYet: (String) -> Unit,
) {
    val p = pal()
    Box(
        Modifier
            .fillMaxWidth()
            .background(p.bg.copy(alpha = 0.92f))
            .hairline(p.border)
            .statusBarsPadding(),
    ) {
        Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(88.dp), contentAlignment = Alignment.CenterStart) {
                if (back) {
                    IconButton44(Ic.chevronLeft, 22, onBack)
                } else {
                    IconButton44(Ic.menu, 21, onMenu)
                }
            }
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                if (subtitled) {
                    WText("Notes", 15f, p.text, weight = 600, lineHeight = 1.25f)
                    WText(title, 15f, p.text2, lineHeight = 1.25f)
                } else {
                    WText(title, 15f, p.text, weight = 600)
                }
            }
            Row(Modifier.width(88.dp), horizontalArrangement = Arrangement.End) {
                IconButton44(Ic.bell, 20) { onNotYet("Notifications") }
                IconButton44(Ic.search, 20) { onNotYet("Search") }
            }
        }
    }
}

@Composable
private fun IconButton44(icon: Int, size: Int, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).tappable(onClick), contentAlignment = Alignment.Center) {
        LIcon(icon, size.dp, pal().text2)
    }
}

@Composable
private fun TabBar(onNotYet: (String) -> Unit) {
    val p = pal()
    Row(
        Modifier
            .fillMaxWidth()
            .background(p.bg.copy(alpha = 0.9f))
            .hairline(p.border, top = true)
            .navigationBarsPadding()
            .height(60.dp),
    ) {
        Tab("Notes", Ic.bookOpen, Ic.bookOpenS23, active = true, Modifier.weight(1f)) {}
        Tab("Tasks", Ic.listChecks, Ic.listChecksS23, active = false, Modifier.weight(1f)) { onNotYet("Tasks") }
        Tab("Calendar", Ic.calendarDays, Ic.calendarDaysS23, active = false, Modifier.weight(1f)) { onNotYet("Calendar") }
        Tab("Search", Ic.search, Ic.searchS23, active = false, Modifier.weight(1f)) { onNotYet("Search") }
    }
}

@Composable
private fun Tab(label: String, icon: Int, activeIcon: Int, active: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val p = pal()
    val color = if (active) p.accent else p.textMuted
    Column(
        modifier.fillMaxHeight().tappable(onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        LIcon(if (active) activeIcon else icon, 22.dp, color)
        Box(Modifier.height(3.dp))
        WText(label, 10.5f, color, weight = 500, lineHeight = 1f)
    }
}

/** The "Add task" button: 56 dp circle, 16 dp from the right and above the tab bar (LOOK.md 3.2). */
@Composable
private fun Fab(modifier: Modifier, onClick: () -> Unit) {
    val p = pal()
    Box(
        modifier
            .padding(end = 16.dp, bottom = 16.dp)
            .shadow(12.dp, CircleShape, clip = false, ambientColor = p.accentSolid, spotColor = p.accentSolid)
            .size(56.dp)
            .background(p.accentSolid, CircleShape)
            .tappable(onClick),
        contentAlignment = Alignment.Center,
    ) {
        LIcon(Ic.plusS225, 26.dp, Color.White)
    }
}
