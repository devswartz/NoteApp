package com.notivelo.app.ui.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.notivelo.app.ui.SecondaryButton
import com.notivelo.app.ui.hairline
import com.notivelo.app.ui.relativeTime
import com.notivelo.app.ui.tappable
import com.notivelo.core.Notebook
import com.notivelo.core.PageMeta
import com.notivelo.core.Section

/** The Notes tab: notebooks, then a notebook's sections, then a section's pages, then the page. */
@Composable
fun NotesContent(state: AppState, index: TreeIndex?, actions: ShellActions, onNotYet: (String) -> Unit, scrollPx: Int = 0) {
    val page = index?.page(state.pageId)
    val notebook = index?.notebook(state.phoneNotebookId)
    // The drill-down is phoneNotebookId; sectionId alone (the drawer's highlight) leaves the list behind the drawer.
    val section = if (notebook != null) index?.section(state.sectionId) else null
    when {
        page != null && index != null -> com.notivelo.app.ui.page.PageScreen(state, page, index, phone = true, scrollPx = scrollPx)
        section != null && index != null -> SectionScreen(index, section, state, actions, onNotYet)
        notebook != null && index != null -> NotebookScreen(index, notebook, actions, onNotYet)
        else -> NotebooksScreen(index, state.treeLoading, actions)
    }
}

/** The list shell of a Notes screen: 16 dp gutters, scrolls, room for the Add task button. */
@Composable
private fun Screen(content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 96.dp),
    ) { content() }
}

@Composable
private fun NotebooksScreen(index: TreeIndex?, loading: Boolean, actions: ShellActions) {
    val p = pal()
    Screen {
        WText("Notes", 24f, p.text, weight = 700, lineHeight = 1.25f, tracking = -0.02f)
        Spacer(Modifier.height(22.dp))
        val notebooks = index?.notebooks.orEmpty()
        if (notebooks.isEmpty()) {
            if (!loading) WText("No notebooks yet.", 15f, p.textMuted, lineHeight = 1.5f)
        } else {
            WText("My notebooks", 15f, p.text, weight = 700, lineHeight = 1.45f)
            Spacer(Modifier.height(4.dp))
            Column(Modifier.fillMaxWidth().hairline(p.border, top = true)) {
                for (nb in notebooks) NotebookRow(nb) { actions.openPhoneNotebook(nb.id) }
            }
        }
    }
}

@Composable
private fun NotebookRow(nb: Notebook, onClick: () -> Unit) {
    val p = pal()
    Row(
        Modifier
            .fillMaxWidth()
            .height(44.dp)
            .hairline(p.border)
            .tappable(onClick)
            .padding(start = 12.dp, end = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        InitialTile(nb.name, parseHex(nb.color), 22.dp, 6.dp, 12f)
        Spacer(Modifier.width(12.dp))
        WText(nb.name, 16f, p.text, Modifier.weight(1f))
        if (nb.visibility == "private") {
            LIcon(Ic.lock, 14.dp, p.textMuted)
            Spacer(Modifier.width(12.dp))
        }
        LIcon(Ic.chevronRight, 16.dp, p.textMuted)
    }
}

@Composable
private fun BackLink(onClick: () -> Unit) {
    val p = pal()
    Row(
        Modifier.height(36.dp).tappable(onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        LIcon(Ic.chevronLeft, 16.dp, p.accent)
        WText("Back", 15f, p.accent, weight = 500)
    }
}

@Composable
private fun NotebookScreen(index: TreeIndex, notebook: Notebook, actions: ShellActions, onNotYet: (String) -> Unit) {
    val p = pal()
    Column(Modifier.fillMaxSize().padding(top = 20.dp).padding(horizontal = 16.dp)) {
        BackLink { actions.back() }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            InitialTile(notebook.name, parseHex(notebook.color), 28.dp, 7.dp, 14f)
            Spacer(Modifier.width(10.dp))
            WText(notebook.name, 22f, p.text, Modifier.weight(1f), weight = 700, tracking = -0.02f)
            SecondaryButton("New section", Ic.plus, { onNotYet("New section") })
        }
        Spacer(Modifier.height(18.dp))
        val sections = index.sections(notebook)
        if (sections.isEmpty()) {
            WText("No sections in this notebook.", 15f, p.textMuted, lineHeight = 1.5f)
        } else {
            Column(Modifier.fillMaxWidth().hairline(p.border, top = true).verticalScroll(rememberScrollState())) {
                for (s in sections) SectionRow(s, index, 0) { actions.openSection(it.id) }
            }
        }
    }
}

@Composable
private fun SectionRow(section: Section, index: TreeIndex, depth: Int, onClick: (Section) -> Unit) {
    val p = pal()
    Row(
        Modifier
            .fillMaxWidth()
            .height(44.dp)
            .hairline(p.border)
            .tappable { onClick(section) }
            .padding(start = (12 + 16 * depth).dp, end = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(width = 4.dp, height = 16.dp).background(parseHex(section.color), RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(12.dp))
        WText(section.name, 16f, p.text, Modifier.weight(1f))
        LIcon(Ic.chevronRight, 16.dp, p.textMuted)
    }
    for (child in index.sections(section)) SectionRow(child, index, depth + 1, onClick)
}

@Composable
private fun SectionScreen(index: TreeIndex, section: Section, state: AppState, actions: ShellActions, onNotYet: (String) -> Unit) {
    val p = pal()
    val now = LocalNow.current
    val pages = index.pages(section)
    val children = index.sections(section)
    Column(Modifier.fillMaxSize().padding(top = 20.dp).padding(horizontal = 16.dp)) {
        BackLink { actions.back() }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(width = 4.dp, height = 22.dp).background(parseHex(section.color), RoundedCornerShape(2.dp)))
            Spacer(Modifier.width(8.dp))
            WText(section.name, 22f, p.text, Modifier.weight(1f), weight = 700, tracking = -0.02f)
            SecondaryButton("New page", Ic.plus, { onNotYet("New page") })
        }
        Spacer(Modifier.height(18.dp))
        if (pages.isEmpty() && children.isEmpty()) {
            WText("No pages in this section yet.", 15f, p.textMuted, lineHeight = 1.5f)
        } else {
            Column(Modifier.fillMaxWidth().hairline(p.border, top = true).verticalScroll(rememberScrollState())) {
                for (child in children) SectionRow(child, index, 0) { actions.openSection(it.id) }
                for (page in pages) PageListRow(page, state.taskCounts[page.id] ?: 0, relativeTime(page.updatedAt, now)) { actions.openPage(page.id) }
            }
        }
    }
}

@Composable
private fun PageListRow(page: PageMeta, openTasks: Int, edited: String, onClick: () -> Unit) {
    val p = pal()
    Row(
        Modifier
            .fillMaxWidth()
            .height(44.dp)
            .hairline(p.border)
            .tappable(onClick)
            .padding(start = 12.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
            val icon = page.icon
            if (!icon.isNullOrEmpty()) WText(icon, 15f, p.text, lineHeight = 1f) else LIcon(Ic.fileText, 16.dp, p.textMuted)
        }
        Spacer(Modifier.width(12.dp))
        WText(page.title.ifEmpty { "Untitled" }, 16f, p.text, Modifier.weight(1f))
        if (openTasks > 0) {
            LIcon(Ic.circleCheck, 11.dp, p.textMuted)
            WText(" $openTasks", 11f, p.textMuted, lineHeight = 1f)
            Spacer(Modifier.width(10.dp))
        }
        WText(edited, 12.5f, p.textMuted)
    }
}
