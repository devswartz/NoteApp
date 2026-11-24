package com.notivelo.app.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.ShellActions
import com.notivelo.app.data.TreeIndex
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.parseHex
import com.notivelo.app.look.pal
import com.notivelo.app.ui.InitialTile
import com.notivelo.app.ui.LocalNow
import com.notivelo.app.ui.SectionTree
import com.notivelo.app.ui.TreeMetrics
import com.notivelo.app.ui.hairline
import com.notivelo.app.ui.relativeTime
import com.notivelo.app.ui.rightRule
import com.notivelo.app.ui.tappable
import com.notivelo.core.Notebook
import com.notivelo.core.PageMeta
import com.notivelo.core.Section

/** The one sidebar panel (216 dp): notebook picker, RECENT, SECTIONS with the pages folded into the tree. */
@Composable
fun TabletSidebar(state: AppState, index: TreeIndex?, actions: ShellActions, onNotYet: (String) -> Unit) {
    val p = pal()
    val notebook = index?.resolveNotebook(state.notebookId)
    Column(
        Modifier
            .width(217.dp)
            .fillMaxHeight()
            .background(p.bgSidebar)
            .rightRule(p.border),
    ) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
            if (notebook == null || index == null) {
                Row(
                    Modifier.fillMaxWidth().height(52.dp).padding(start = 22.dp, end = 14.dp, top = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    LIcon(Ic.bookPlus, 14.dp, p.text2)
                    Spacer(Modifier.width(9.dp))
                    WText("Notebooks", 14f, p.text, Modifier.weight(1f), weight = 650)
                    LIcon(Ic.chevronDown, 14.dp, p.textMuted)
                    Spacer(Modifier.width(2.dp))
                }
                Row(Modifier.padding(start = 18.dp, top = 2.dp)) {
                    WText("No notebooks yet. ", 12.5f, p.textMuted)
                    WText("Create one", 12.5f, p.accent, Modifier.tappable { onNotYet("New notebook") }, weight = 500)
                }
            } else {
                NotebookHead(index, notebook, actions, onNotYet)
                Spacer(Modifier.height(3.dp))
                Row(
                    Modifier.padding(start = 18.dp).height(26.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    LIcon(Ic.clock, 12.dp, p.textMuted)
                    WText("RECENT", 11.5f, p.textMuted, weight = 600, tracking = 0.04f)
                    LIcon(Ic.chevronRight, 12.dp, p.textMuted)
                }
                Spacer(Modifier.height(12.dp))
                Row(Modifier.fillMaxWidth().height(26.dp).padding(start = 18.dp, end = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    WText("SECTIONS", 11.5f, p.textMuted, Modifier.weight(1f), weight = 600, tracking = 0.04f)
                    Box(Modifier.size(24.dp).tappable { onNotYet("New section") }, contentAlignment = Alignment.Center) {
                        LIcon(Ic.plus, 15.dp, p.text2)
                    }
                }
                Spacer(Modifier.height(1.dp))
                Box(Modifier.padding(horizontal = 8.dp)) {
                    SectionTree(
                        index = index, notebook = notebook,
                        selectedSectionId = state.sectionId, selectedPageId = state.pageId,
                        taskCounts = state.taskCounts, metrics = TreeMetrics.Tablet,
                        onSection = { actions.openSection(it.id) },
                        onPage = { actions.openPage(it.id) },
                        onNotYet = onNotYet,
                    )
                }
            }
        }
    }
}

@Composable
private fun NotebookHead(index: TreeIndex, notebook: Notebook, actions: ShellActions, onNotYet: (String) -> Unit) {
    val p = pal()
    var open by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().height(52.dp).padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f)) {
            Row(
                Modifier.fillMaxWidth().height(36.dp).tappable { open = true }.padding(start = 8.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                InitialTile(notebook.name, parseHex(notebook.color), 22.dp, 6.dp, 12f)
                Spacer(Modifier.width(8.dp))
                WText(notebook.name, 14f, p.text, Modifier.weight(1f), weight = 650)
                if (notebook.visibility == "private") {
                    LIcon(Ic.lock, 12.dp, p.textMuted)
                    Spacer(Modifier.width(6.dp))
                }
                LIcon(Ic.chevronDown, 14.dp, p.textMuted)
            }
            Menu(open, { open = false }) {
                for (nb in index.notebooks) MenuRow(nb.name, nb.id == notebook.id) {
                    open = false
                    actions.selectNotebook(nb.id)
                }
            }
        }
        Spacer(Modifier.width(6.dp))
        Box(Modifier.size(24.dp).tappable { onNotYet("Notebook options") }, contentAlignment = Alignment.Center) {
            LIcon(Ic.ellipsis, 15.dp, p.text2)
        }
    }
}

// Notes overview ---------------------------------------------------------------------------------------------

/** "Notes": recently edited cards, then every notebook with its sections and pages (`empty-no-page.png`). */
@Composable
fun NotesOverview(index: TreeIndex?, mainWidth: Dp, actions: ShellActions) {
    val p = pal()
    val now = LocalNow.current
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(start = 40.dp, end = 40.dp, top = 40.dp, bottom = 40.dp),
    ) {
        WText("Notes", 26f, p.text, weight = 700, lineHeight = 1.3f, tracking = -0.02f)
        if (index == null || index.notebooks.isEmpty()) return@Column
        Spacer(Modifier.height(9.dp))
        Row(Modifier.fillMaxWidth().height(26.dp).hairline(p.border), verticalAlignment = Alignment.CenterVertically) {
            WText("Recently edited", 13f, p.text, weight = 700)
        }
        Spacer(Modifier.height(11.dp))
        RecentGrid(index.recent(8), now, actions)
        for (nb in index.notebooks) {
            Spacer(Modifier.height(30.dp))
            Row(Modifier.fillMaxWidth().height(30.dp).hairline(p.border), verticalAlignment = Alignment.CenterVertically) {
                InitialTile(nb.name, parseHex(nb.color), 18.dp, 5.dp, 10f)
                Spacer(Modifier.width(8.dp))
                WText(nb.name, 14f, p.text, weight = 700)
            }
            for (s in index.sections(nb)) OverviewSection(index, s, now, actions)
        }
    }
}

@Composable
private fun RecentGrid(pages: List<PageMeta>, now: java.time.Instant, actions: ShellActions) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val gap = 10.dp
        val cols = maxOf(1, ((maxWidth + gap) / (180.dp + gap)).toInt())
        Column(verticalArrangement = Arrangement.spacedBy(gap)) {
            for (row in pages.chunked(cols)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    for (page in row) RecentCard(page, now, Modifier.weight(1f)) { actions.openPage(page.id) }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun RecentCard(page: PageMeta, now: java.time.Instant, modifier: Modifier, onClick: () -> Unit) {
    val p = pal()
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier
            .heightIn(min = 100.dp)
            .background(p.bg, shape)
            .border(1.dp, p.border, shape)
            .tappable(onClick)
            .padding(14.dp),
    ) {
        Box(Modifier.height(18.dp), contentAlignment = Alignment.CenterStart) {
            val icon = page.icon
            if (!icon.isNullOrEmpty()) WText(icon, 14f, p.text, lineHeight = 1f) else LIcon(Ic.fileText, 16.dp, p.text2)
        }
        Spacer(Modifier.height(8.dp))
        WText(page.title.ifEmpty { "Untitled" }, 13.5f, p.text, weight = 700, lineHeight = 1.5f)
        Spacer(Modifier.height(8.dp))
        WText(relativeTime(page.updatedAt, now), 12f, p.textMuted, lineHeight = 1.4f)
    }
}

@Composable
private fun OverviewSection(index: TreeIndex, section: Section, now: java.time.Instant, actions: ShellActions) {
    val p = pal()
    Row(Modifier.fillMaxWidth().height(28.dp).padding(top = 0.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(width = 3.dp, height = 14.dp).background(parseHex(section.color), RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(9.dp))
        WText(section.name, 12.5f, p.text2, weight = 600)
    }
    for (page in index.pages(section)) {
        Row(
            Modifier.fillMaxWidth().height(42.dp).hairline(p.border).tappable { actions.openPage(page.id) }.padding(start = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
                val icon = page.icon
                if (!icon.isNullOrEmpty()) WText(icon, 14f, p.text, lineHeight = 1f) else LIcon(Ic.fileText, 16.dp, p.text2)
            }
            Spacer(Modifier.width(9.dp))
            WText(page.title.ifEmpty { "Untitled" }, 14f, p.text, Modifier.weight(1f))
            WText(relativeTime(page.updatedAt, now), 12.5f, p.textMuted, Modifier.padding(end = 5.dp))
        }
    }
    for (child in index.sections(section)) OverviewSection(index, child, now, actions)
}
