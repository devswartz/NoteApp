package com.notivelo.app.look

import com.notivelo.core.Attr
import com.notivelo.core.AttrValue
import com.notivelo.core.BoxContent
import com.notivelo.core.ContentNode
import com.notivelo.core.Mark
import com.notivelo.core.NodeKind
import com.notivelo.core.PageBox
import com.notivelo.core.PageInfo
import com.notivelo.core.PageKind
import com.notivelo.core.PageSettings
import com.notivelo.core.TextRun

/** A page for the look scenes, in the core's own types (`PageInfo.boxes`, `.content`). */
internal class LookPage(
    val boxes: List<PageBox>,
    val content: List<BoxContent>,
    val color: String = "none",
    val rules: String = "none",
) {
    fun info(): PageInfo = PageInfo(
        kind = if (boxes.isEmpty()) PageKind.DOCUMENT else PageKind.CANVAS,
        formatVersion = 2u,
        newerFormat = false,
        settings = PageSettings(color = color, rules = rules),
        boxes = boxes,
        headings = emptyList(),
        text = "",
        taskIds = emptyList(),
        mentionIds = emptyList(),
        hasInk = false,
        content = content,
    )
}

internal fun a(name: String, v: Any?): Attr = Attr(
    name,
    when (v) {
        null -> AttrValue.Null
        is Boolean -> AttrValue.Bool(v)
        is Number -> AttrValue.Number(v.toDouble())
        else -> AttrValue.Text(v.toString())
    },
)

internal fun el(kind: NodeKind, attrs: List<Attr> = emptyList(), children: List<ContentNode> = emptyList(), markers: List<String> = emptyList()) =
    ContentNode(kind, attrs, emptyList(), children, markers)

internal fun txt(vararg runs: TextRun) = ContentNode(NodeKind.Text, emptyList(), runs.toList(), emptyList(), emptyList())

internal fun r(text: String, vararg marks: Mark) = TextRun(text, marks.toList())

// The demo seed's builders (server/demoContent.ts)

internal fun p(vararg parts: Any) = el(NodeKind.Paragraph, children = inl(*parts))
internal fun h(level: Int, s: String) = el(NodeKind.Heading, listOf(a("level", level)), listOf(txt(r(s))))
internal fun bold(s: String) = r(s, Mark.Bold)
internal fun italic(s: String) = r(s, Mark.Italic)
internal fun commented(s: String, thread: String) = r(s, Mark.Comment(thread))
internal fun pageLink(id: String) = el(NodeKind.PageLink, listOf(a("pageId", id)))
internal fun taskRef(id: String) = el(NodeKind.TaskRef, listOf(a("taskId", id)))
internal fun bullets(vararg items: List<Any>) =
    el(NodeKind.BulletList, children = items.map { el(NodeKind.ListItem, children = listOf(p(*it.toTypedArray()))) })

internal fun numbered(vararg items: List<Any>) = el(
    NodeKind.OrderedList, listOf(a("start", 1)),
    items.map { el(NodeKind.ListItem, children = listOf(p(*it.toTypedArray()))) }, items.indices.map { "${it + 1}." },
)

internal fun quote(vararg parts: Any) = el(NodeKind.Blockquote, children = listOf(p(*parts)))
internal fun callout(emoji: String, vararg blocks: ContentNode) = el(NodeKind.Callout, listOf(a("emoji", emoji)), blocks.toList())
internal fun toggle(summary: String, vararg blocks: ContentNode) = el(
    NodeKind.Details, emptyList(),
    listOf(el(NodeKind.DetailsSummary, children = listOf(txt(r(summary)))), el(NodeKind.DetailsContent, children = blocks.toList())),
)

internal fun table(vararg rows: List<String>) = el(
    NodeKind.Table,
    children = rows.mapIndexed { i, row ->
        el(NodeKind.TableRow, children = row.map { c -> el(if (i == 0) NodeKind.TableHeader else NodeKind.TableCell, children = listOf(p(c))) })
    },
)

/** Strings and runs and inline nodes, one text node per stretch of runs. */
internal fun inl(vararg parts: Any): List<ContentNode> {
    val out = mutableListOf<ContentNode>()
    val runs = mutableListOf<TextRun>()
    fun flush() {
        if (runs.isNotEmpty()) out.add(ContentNode(NodeKind.Text, emptyList(), runs.toList(), emptyList(), emptyList()))
        runs.clear()
    }
    for (x in parts) when (x) {
        is String -> runs.add(TextRun(x, emptyList()))
        is TextRun -> runs.add(x)
        is ContentNode -> {
            flush()
            out.add(x)
        }
    }
    flush()
    return out
}
