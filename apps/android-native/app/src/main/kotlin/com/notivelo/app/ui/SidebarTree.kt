package com.notivelo.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.notivelo.app.data.TreeIndex
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.parseHex
import com.notivelo.app.look.pal
import com.notivelo.core.Notebook
import com.notivelo.core.PageMeta
import com.notivelo.core.Section

/** Row sizes of the sections tree (LOOK.md 4.3): the phone drawer's are bigger and always show the row actions. */
class TreeMetrics(
    val sectionHeight: Dp,
    val pageHeight: Dp,
    val fontSize: Float,
    val actions: Boolean,
) {
    companion object {
        val Phone = TreeMetrics(44.dp, 40.dp, 15f, true)
        val Tablet = TreeMetrics(30.dp, 28.dp, 14f, false)
    }
}

/**
 * The sections of one notebook with their sub-sections and pages (the web's `SectionNode` / `PageRow`).
 * Sections start expanded; the chevron folds one. Read-only here: the + and ... actions say they are not in
 * the native preview yet.
 */
@Composable
fun SectionTree(
    index: TreeIndex,
    notebook: Notebook,
    selectedSectionId: String?,
    selectedPageId: String?,
    taskCounts: Map<String, Int>,
    metrics: TreeMetrics,
    onSection: (Section) -> Unit,
    onPage: (PageMeta) -> Unit,
    onNotYet: (String) -> Unit,
) {
    val collapsed = remember(notebook.id) { mutableStateMapOf<String, Boolean>() }
    Column {
        for (section in index.sections(notebook)) {
            SectionNode(index, section, 0, collapsed, selectedSectionId, selectedPageId, taskCounts, metrics, onSection, onPage, onNotYet)
        }
    }
}

@Composable
private fun SectionNode(
    index: TreeIndex,
    section: Section,
    depth: Int,
    collapsed: MutableMap<String, Boolean>,
    selectedSectionId: String?,
    selectedPageId: String?,
    taskCounts: Map<String, Int>,
    metrics: TreeMetrics,
    onSection: (Section) -> Unit,
    onPage: (PageMeta) -> Unit,
    onNotYet: (String) -> Unit,
) {
    val p = pal()
    val children = index.sections(section)
    val pages = index.pages(section)
    val isCollapsed = collapsed[section.id] == true
    val selected = section.id == selectedSectionId && selectedPageId == null
    val leaf = children.isEmpty() && pages.isEmpty()
    Row(
        Modifier
            .fillMaxWidth()
            .height(metrics.sectionHeight)
            .background(if (selected) p.bgActive else Color.Transparent, RoundedCornerShape(6.dp))
            .tappable { onSection(section) }
            .padding(start = (6 + 14 * depth).dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The chevron slot (14 wide); a leaf shows none but keeps the slot. A tap folds the section.
        Box(
            Modifier.size(14.dp).tappable { collapsed[section.id] = !isCollapsed },
            contentAlignment = Alignment.Center,
        ) {
            LIcon(Ic.chevronDown, 13.dp, p.textMuted, Modifier.rotate(if (isCollapsed) -90f else 0f))
        }
        Spacer(Modifier.width(6.dp))
        Box(Modifier.size(width = 4.dp, height = 14.dp).background(parseHex(section.color), RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(6.dp))
        WText(
            section.name, metrics.fontSize,
            if (selected) p.accent else p.text2,
            Modifier.weight(1f),
            weight = if (selected) 600 else 400,
        )
        if (metrics.actions) {
            RowAction(Ic.plus, 15.dp) { onNotYet("New page") }
            Spacer(Modifier.width(13.dp))
            RowAction(Ic.ellipsis, 15.dp) { onNotYet("Section options") }
            Spacer(Modifier.width(11.dp))
        }
    }
    if (!isCollapsed) {
        Row(
            Modifier
                .padding(start = 18.dp)
                .fillMaxWidth()
                .height(IntrinsicSize.Min),
        ) {
            Box(Modifier.width(1.dp).fillMaxHeight().background(p.border))
            Column(Modifier.padding(start = 4.dp).fillMaxWidth()) {
                for (child in children) {
                    SectionNode(index, child, depth + 1, collapsed, selectedSectionId, selectedPageId, taskCounts, metrics, onSection, onPage, onNotYet)
                }
                for (page in pages) {
                    PageRow(page, depth, page.id == selectedPageId, taskCounts[page.id] ?: 0, metrics, { onPage(page) }, onNotYet)
                }
                if (leaf) {
                    NewPageRow(depth, metrics) { onNotYet("New page") }
                }
            }
        }
    }
}

@Composable
private fun RowAction(icon: Int, size: Dp, onClick: () -> Unit) {
    val p = pal()
    Box(Modifier.size(24.dp).tappable(onClick), contentAlignment = Alignment.Center) {
        LIcon(icon, size, p.text2)
    }
}

@Composable
fun PageRow(
    page: PageMeta,
    depth: Int,
    selected: Boolean,
    openTasks: Int,
    metrics: TreeMetrics,
    onClick: () -> Unit,
    onNotYet: (String) -> Unit,
) {
    val p = pal()
    Row(
        Modifier
            .fillMaxWidth()
            .height(metrics.pageHeight)
            .background(if (selected) p.bgActive else Color.Transparent, RoundedCornerShape(6.dp))
            .tappable(onClick)
            .padding(start = (6 + 14 * (depth + 1) + 20).dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(14.dp), contentAlignment = Alignment.Center) {
            val icon = page.icon
            when {
                page.locked -> LIcon(Ic.lock, 14.dp, p.textMuted)
                !icon.isNullOrEmpty() -> WText(icon, 13f, p.text, lineHeight = 1f)
                else -> LIcon(Ic.fileText, 14.dp, p.textMuted)
            }
        }
        Spacer(Modifier.width(6.dp))
        WText(
            page.title.ifEmpty { "Untitled" }, metrics.fontSize,
            if (selected) p.accent else p.text2,
            Modifier.weight(1f),
            weight = if (selected) 500 else 400,
        )
        if (openTasks > 0) {
            Row(
                Modifier.alpha(0.8f).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                LIcon(Ic.circleCheck, 11.dp, p.textMuted)
                WText(openTasks.toString(), 11f, p.textMuted, lineHeight = 1f)
            }
        }
        if (metrics.actions) {
            RowAction(Ic.ellipsis, 15.dp) { onNotYet("Page options") }
            Spacer(Modifier.width(11.dp))
        }
    }
}

@Composable
private fun NewPageRow(depth: Int, metrics: TreeMetrics, onClick: () -> Unit) {
    val p = pal()
    Row(
        Modifier
            .fillMaxWidth()
            .height(metrics.pageHeight)
            .tappable(onClick)
            .padding(start = (6 + 14 * (depth + 1) + 20).dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LIcon(Ic.plus, 14.dp, p.textMuted)
        WText("New page", metrics.fontSize, p.textMuted)
    }
}
