package com.notivelo.app.edit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.Palette
import com.notivelo.app.look.WText
import com.notivelo.app.look.parseHex
import com.notivelo.core.EditorSuggestion
import com.notivelo.core.SuggestionTrigger
import com.notivelo.core.WorkspaceMember

/** A page the `[[` menu can link: its title and where it lives ("Notebook / Section"). */
class PageChoice(val id: String, val title: String, val crumb: String)

/** A row of a suggestion menu. [dot] is a person's colour (ARGB), [icon] a Lucide name. */
class MenuRow(val id: String, val title: String, val detail: String, val icon: String?, val dot: Int?)

/** The open menu as the view hands it to the popup: rows, the highlighted one, and the caret it hangs from (px in the view). */
class MenuModel(
    val kind: SuggestionTrigger,
    val rows: List<MenuRow>,
    val highlighted: Int?,
    val empty: String?,
    val caretX: Float,
    val caretTop: Float,
    val caretBottom: Float,
    /** Room above the caret line and below it on screen, px (the keyboard's top is the floor). */
    val spaceAbove: Float,
    val spaceBelow: Float,
) {
    val header: String
        get() = when (kind) {
            SuggestionTrigger.SLASH -> "INSERT BLOCK"
            SuggestionTrigger.PAGE_LINK -> "LINK TO PAGE"
            SuggestionTrigger.MENTION -> "MENTION"
        }
}

object Suggestions {
    /** Pages for `[[`: prefix, word prefix, then substring, at most 8 (the web menu's order). */
    fun pageRows(query: String, pages: List<PageChoice>): List<MenuRow> {
        val q = query.trim().lowercase()
        val scored = ArrayList<Triple<Int, Int, PageChoice>>()
        pages.forEachIndexed { n, p ->
            val t = p.title.ifEmpty { "Untitled" }.lowercase()
            val score = when {
                q.isEmpty() -> 1
                t.startsWith(q) -> 0
                t.split(' ').any { it.startsWith(q) } -> 1
                t.contains(q) -> 2
                else -> -1
            }
            if (score >= 0) scored += Triple(score, n, p)
        }
        scored.sortWith(compareBy({ it.first }, { it.second }))
        return scored.take(8).map { MenuRow(it.third.id, it.third.title.ifEmpty { "Untitled" }, it.third.crumb, "file-text", null) }
    }

    /** People for `@`: name or email contains the query, at most 8. */
    fun peopleRows(query: String, people: List<WorkspaceMember>): List<MenuRow> {
        val q = query.trim().lowercase()
        return people.filter { q.isEmpty() || it.name.lowercase().contains(q) || it.email.lowercase().contains(q) }
            .take(8)
            .map { MenuRow(it.id, it.name, it.email, null, parseHex(it.color).toArgb()) }
    }

    /** The rows and highlight for an open suggestion: the engine's items for `/` (it owns that highlight), the app's for the others. */
    fun model(
        s: EditorSuggestion, pages: List<PageChoice>, people: List<WorkspaceMember>, ownHighlight: Int,
        caretX: Float, caretTop: Float, caretBottom: Float, spaceAbove: Float, spaceBelow: Float,
    ): MenuModel? {
        val rows: List<MenuRow>
        var highlighted: Int?
        var empty: String? = null
        when (s.trigger) {
            SuggestionTrigger.SLASH -> {
                rows = s.items.map { MenuRow(it.id, it.label, it.description, it.icon, null) }
                highlighted = s.highlighted?.toInt()
                if (rows.isEmpty()) return null
            }
            SuggestionTrigger.PAGE_LINK -> {
                rows = pageRows(s.query, pages)
                highlighted = if (rows.isEmpty()) null else ownHighlight.coerceIn(0, rows.size - 1)
                empty = "Type a page title…"
            }
            SuggestionTrigger.MENTION -> {
                rows = peopleRows(s.query, people)
                highlighted = if (rows.isEmpty()) null else ownHighlight.coerceIn(0, rows.size - 1)
                empty = "No matching people"
            }
        }
        return MenuModel(s.trigger, rows, highlighted, empty, caretX, caretTop, caretBottom, spaceAbove, spaceBelow)
    }

    /** What running a row means for the engine: the command and its JSON arguments (`pickSlash {title}` and so on). */
    fun pickCommand(kind: SuggestionTrigger, row: MenuRow): Pair<String, String> = when (kind) {
        SuggestionTrigger.SLASH -> "pickSlash" to "{\"title\":${jsonString(row.id)}}"
        SuggestionTrigger.PAGE_LINK -> "pickPage" to "{\"pageId\":${jsonString(row.id)}}"
        SuggestionTrigger.MENTION -> "pickMention" to "{\"id\":${jsonString(row.id)},\"label\":${jsonString(row.title)}}"
    }

    fun jsonString(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) when {
            c == '"' -> b.append("\\\"")
            c == '\\' -> b.append("\\\\")
            c == '\n' -> b.append("\\n")
            c == '\r' -> b.append("\\r")
            c == '\t' -> b.append("\\t")
            c < ' ' -> b.append(String.format("\\u%04x", c.code))
            else -> b.append(c)
        }
        return b.append('"').toString()
    }
}

/** Where the popup goes: below the caret line (6 dp), above it when it does not fit below and there is more room above; kept on screen. */
object MenuPlacement {
    fun place(
        areaLeft: Int, areaTop: Int, model: MenuModel, menuW: Int, menuH: Int, windowW: Int, gapPx: Int, marginPx: Int,
    ): IntOffset {
        val below = model.spaceBelow >= menuH + gapPx || model.spaceBelow >= model.spaceAbove
        val x = (areaLeft + model.caretX.toInt()).coerceIn(marginPx, maxOf(marginPx, windowW - menuW - marginPx))
        val y = if (below) areaTop + model.caretBottom.toInt() + gapPx else areaTop + model.caretTop.toInt() - menuH - gapPx
        return IntOffset(x, y)
    }
}

internal fun menuIcon(name: String?): Int? = when (name) {
    "circle-check", "check-circle" -> Ic.circleCheck
    "type" -> Ic.type
    "heading-1" -> Ic.heading1
    "heading-2" -> Ic.heading2
    "heading-3" -> Ic.heading3
    "square-check-big", "check-square", "square-check" -> Ic.squareCheckBig
    "list-plus" -> Ic.listPlus
    "list" -> Ic.list
    "list-ordered" -> Ic.listOrdered
    "chevron-right" -> Ic.chevronRight
    "table" -> Ic.table
    "image" -> Ic.image
    "paperclip" -> Ic.paperclip
    "link-2", "link" -> Ic.link2
    "file-symlink" -> Ic.fileSymlink
    "file-text" -> Ic.fileText
    "quote" -> Ic.quote
    "message-square-quote" -> Ic.messageSquareQuote
    "code-xml", "code-2", "code" -> Ic.codeXml
    "minus" -> Ic.minus
    "at-sign" -> Ic.atSign
    else -> null
}

/** The menu's card (LOOK.md 4.7): 290 wide, 320 high at most, padding 6, radius 12, `--bg-elevated`, `--shadow-lg`. */
@Composable
fun SuggestionMenu(model: MenuModel, p: Palette, onPick: (Int) -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(12.dp)
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    val rowPitch = with(density) { 52.dp.toPx() }
    LaunchedEffect(model.highlighted) {
        val h = model.highlighted ?: return@LaunchedEffect
        val top = (h * rowPitch).toInt()
        val view = with(density) { 300.dp.toPx() }.toInt()
        if (top < scroll.value) scroll.scrollTo(top) else if (top + rowPitch > scroll.value + view) scroll.scrollTo((top + rowPitch - view).toInt())
    }
    Column(
        modifier
            .width(290.dp)
            .shadow(12.dp, shape, ambientColor = p.shadowLg, spotColor = p.shadowLg)
            .background(p.bgElevated, shape)
            .border(1.dp, p.border, shape)
            .heightIn(max = 320.dp)
            .verticalScroll(scroll)
            .padding(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        WText(model.header, 11.5f, p.textMuted, Modifier.padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 2.dp), weight = 600, lineHeight = 1.3f, tracking = 0.06f)
        if (model.rows.isEmpty()) {
            WText(model.empty ?: "", 13f, p.textMuted, Modifier.padding(horizontal = 8.dp, vertical = 8.dp), lineHeight = 1.4f)
        }
        model.rows.forEachIndexed { i, row ->
            val active = i == model.highlighted
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(if (active) p.bgHover else Color.Transparent, RoundedCornerShape(7.dp))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onPick(i) }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                val icon = menuIcon(row.icon)
                if (row.dot != null) {
                    Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) {
                        Box(Modifier.size(22.dp).background(Color(row.dot), CircleShape))
                    }
                } else {
                    Box(
                        Modifier.size(36.dp).background(p.bg, RoundedCornerShape(8.dp)).border(1.dp, p.border, RoundedCornerShape(8.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (icon != null) LIcon(icon, 18.dp, p.text2)
                    }
                }
                Column(Modifier.weight(1f)) {
                    WText(row.title, 14f, p.text, weight = 500, lineHeight = 1.3f)
                    if (row.detail.isNotEmpty()) {
                        Spacer(Modifier.height(1.dp))
                        WText(row.detail, 12f, p.textMuted, lineHeight = 1.3f)
                    }
                }
            }
        }
    }
}
