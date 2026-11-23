package com.notivelo.app.ui.page

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.notivelo.app.data.Due
import com.notivelo.app.data.DueTone
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.PagePalettes
import com.notivelo.app.look.Palette
import com.notivelo.app.look.WText
import com.notivelo.app.look.WebType
import com.notivelo.app.look.initialsColor
import com.notivelo.app.look.initialsOf
import com.notivelo.app.look.parseHex
import com.notivelo.core.AttrValue
import com.notivelo.core.ContentNode
import com.notivelo.core.Mark
import com.notivelo.core.NodeKind
import com.notivelo.core.Task
import java.time.LocalDate

/** What the blocks need besides their content: the page's palette, the layout (phone sizes), and who and what they refer to. */
@Immutable
class PageEnv(
    val palette: Palette,
    val phone: Boolean,
    val tasks: Map<String, Task> = emptyMap(),
    /** Page titles by id, for page links. */
    val pageTitles: Map<String, String> = emptyMap(),
    val meId: String? = null,
    val meName: String = "",
    val meColor: String = "#6366f1",
    val today: LocalDate = LocalDate.now(),
) {
    /** 16, phones 16.5 (LOOK.md 2.3); headings are em-based and scale with it. */
    val body: Float get() = if (phone) 16.5f else 16f
}

/** The inheritable bits of a block's surroundings. */
@Immutable
data class BlockCtx(
    val color: Color? = null,
    val checked: Boolean = false,
    val weight: Int = 400,
    val bulletDepth: Int = 0,
)

private fun ContentNode.attr(name: String): AttrValue? = attrs.firstOrNull { it.name == name }?.value
internal fun ContentNode.str(name: String): String? = (attr(name) as? AttrValue.Text)?.value
internal fun ContentNode.num(name: String): Double? = (attr(name) as? AttrValue.Number)?.value
internal fun ContentNode.bool(name: String): Boolean? = (attr(name) as? AttrValue.Bool)?.value

/** CSS margins (top, bottom) of a block at 16 px, as `BoxTextRenderer.margins`. */
internal fun margins(n: ContentNode, body: Float): Pair<Float, Float> = when (n.kind) {
    NodeKind.Heading -> when (n.num("level")?.toInt() ?: 1) {
        1 -> 33.6f to (if (body > 16f) 3.9f else 8.4f)
        2 -> 23.76f to (if (body > 16f) 0f else 5.4f)
        else -> 17.92f to 3.58f
    }
    NodeKind.BulletList, NodeKind.OrderedList, NodeKind.TaskList -> 4.8f to 4.8f
    NodeKind.Blockquote, NodeKind.Callout, NodeKind.CodeBlock, NodeKind.Image -> 9.6f to 9.6f
    NodeKind.Table -> 12.8f to 12.8f
    NodeKind.FileAttachment -> 6.4f to 6.4f
    else -> 0f to 0f
}

/** Blocks one under the other with CSS's collapsing margins (the larger of two neighbours' wins). */
@Composable
fun BlockList(
    nodes: List<ContentNode>,
    env: PageEnv,
    ctx: BlockCtx = BlockCtx(),
    modifier: Modifier = Modifier,
    trimBottom: Boolean = false,
) {
    Column(modifier) {
        var prevBottom = 0f
        for (n in nodes) {
            val (top, bottom) = margins(n, env.body)
            val gap = maxOf(prevBottom, top)
            if (gap > 0f) Spacer(Modifier.height(gap.dp))
            Block(n, env, ctx)
            prevBottom = bottom
        }
        if (!trimBottom && prevBottom > 0f) Spacer(Modifier.height(prevBottom.dp))
    }
}

@Composable
fun Block(n: ContentNode, env: PageEnv, ctx: BlockCtx) {
    val body = env.body
    when (n.kind) {
        NodeKind.Paragraph, NodeKind.DetailsSummary -> InlineText(n.children, env, ctx, body, if (n.kind == NodeKind.DetailsSummary) 500 else ctx.weight, 1.7f)
        NodeKind.Heading -> {
            val level = n.num("level")?.toInt() ?: 1
            val base = when (level) { 1 -> 28f; 2 -> 21.6f; else -> 17.92f }
            val size = base * body / 16f * (if (level == 1 && body > 16f) 1.045f else 1f)
            val lh = when (level) { 1 -> 1.3f; 2 -> 1.35f; else -> 1.7f }
            val tracking = when (level) { 1 -> -0.02f; 2 -> -0.01f; else -> 0f }
            InlineText(n.children, env, ctx, size, 700, lh, tracking)
        }
        NodeKind.Blockquote -> Quote(n, env, ctx)
        NodeKind.CodeBlock -> CodeBlock(n, env)
        NodeKind.HorizontalRule -> Box(Modifier.fillMaxWidth().height(45.8.dp).drawBehind {
            drawRect(env.palette.border, Offset(0f, 22.4.dp.toPx()), Size(size.width, 1.dp.toPx()))
        })
        NodeKind.BulletList -> BulletList(n, env, ctx)
        NodeKind.OrderedList -> OrderedList(n, env, ctx)
        NodeKind.TaskList -> CheckList(n, env, ctx)
        NodeKind.Callout -> Callout(n, env, ctx)
        NodeKind.Details -> Toggle(n, env, ctx)
        NodeKind.Table -> TableBlock(n, env)
        NodeKind.Image -> ImageBlock(n, env)
        NodeKind.FileAttachment -> FileCard(n, env)
        NodeKind.TaskRef -> TaskLine(n, env, ctx)
        else -> BlockList(n.children, env, ctx)
    }
}

// Inline -------------------------------------------------------------------------------------------------------

private const val PAGE_LINK_ICON = "pl"

internal fun inlineString(children: List<ContentNode>, env: PageEnv, ctx: BlockCtx, size: Float, weight: Int, mono: Boolean = false): AnnotatedString {
    val p = env.palette
    return buildAnnotatedString {
        for (node in children) {
            when (node.kind) {
                NodeKind.Text -> for (run in node.runs) {
                    var w = weight
                    var italic = false
                    var code = mono
                    var color: Color = ctx.color ?: p.text
                    var bg: Color = Color.Unspecified
                    var underline = false
                    var strike = false
                    if (ctx.checked) {
                        color = p.textMuted
                        strike = true
                    }
                    for (m in run.marks) when (m) {
                        is Mark.Bold -> w = 700
                        is Mark.Italic -> italic = true
                        is Mark.Code -> code = true
                        is Mark.Underline -> underline = true
                        is Mark.Strike -> strike = true
                        is Mark.TextColor -> PagePalettes.textColor(p, m.color)?.let { color = it }
                        is Mark.Highlight -> bg = PagePalettes.highlight(p, m.color)
                        is Mark.Link -> {
                            color = p.accent
                            underline = true
                        }
                        is Mark.Comment -> {
                            bg = Color(250 / 255f, 204 / 255f, 21 / 255f, 0.28f)
                            underline = true
                        }
                        else -> {}
                    }
                    if (code && !mono && bg == Color.Unspecified) bg = p.bgHover
                    val deco = when {
                        underline && strike -> TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
                        underline -> TextDecoration.Underline
                        strike -> TextDecoration.LineThrough
                        else -> null
                    }
                    withStyle(
                        SpanStyle(
                            color = color,
                            fontWeight = FontWeight(w),
                            fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
                            fontFamily = if (code) WebType.mono else WebType.family,
                            fontSize = if (code && !mono) (size * 0.88f).sp else size.sp,
                            background = bg,
                            textDecoration = deco,
                        ),
                    ) { append(run.text) }
                }
                NodeKind.HardBreak -> append("\n")
                NodeKind.Mention -> {
                    val mine = node.str("id") != null && node.str("id") == env.meId
                    withStyle(
                        SpanStyle(
                            color = if (mine) p.text else p.accent,
                            fontWeight = FontWeight.Medium,
                            background = if (mine) Color(250 / 255f, 204 / 255f, 21 / 255f, 0.35f) else p.accentSoft,
                        ),
                    ) { append(" @" + (node.str("label") ?: "") + " ") }
                }
                NodeKind.PageLink -> {
                    appendInlineContent(PAGE_LINK_ICON, "□")
                    withStyle(SpanStyle(color = p.text, fontWeight = FontWeight.Medium, textDecoration = TextDecoration.Underline)) {
                        append(" " + (env.pageTitles[node.str("pageId") ?: ""] ?: "Page"))
                    }
                }
                else -> withStyle(SpanStyle(color = p.textMuted)) { append("◻") }
            }
        }
    }
}

@Composable
fun InlineText(
    children: List<ContentNode>,
    env: PageEnv,
    ctx: BlockCtx,
    size: Float,
    weight: Int = 400,
    lineHeight: Float = 1.7f,
    tracking: Float = 0f,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
) {
    val p = env.palette
    if (children.isEmpty()) {
        // An empty line still takes its height.
        Spacer(modifier.height((size * lineHeight).dp))
        return
    }
    val text = inlineString(children, env, ctx, size, weight, mono)
    val icon = mapOf(
        PAGE_LINK_ICON to InlineTextContent(Placeholder((size * 0.95f).sp, (size * 0.95f).sp, PlaceholderVerticalAlign.TextCenter)) {
            LIcon(Ic.fileText, (size * 0.95f).dp, p.textMuted)
        },
    )
    Text(
        text = text,
        modifier = modifier,
        color = ctx.color ?: p.text,
        style = WebType.style(size, weight, lineHeight, tracking).let { if (mono) it.copy(fontFamily = WebType.mono) else it },
        inlineContent = icon,
    )
}

// Containers -----------------------------------------------------------------------------------------------------

@Composable
private fun Quote(n: ContentNode, env: PageEnv, ctx: BlockCtx) {
    val p = env.palette
    Box(Modifier.fillMaxWidth().drawBehind { drawRect(p.borderStrong, Offset.Zero, Size(3.dp.toPx(), size.height)) }) {
        BlockList(n.children, env, ctx.copy(color = p.text2), Modifier.padding(start = 19.dp, top = 5.6.dp, bottom = 5.6.dp))
    }
}

private val codeNames = mapOf(
    "ts" to "TypeScript", "typescript" to "TypeScript", "js" to "JavaScript", "javascript" to "JavaScript", "py" to "Python",
    "swift" to "Swift", "rust" to "Rust", "json" to "JSON", "html" to "HTML", "css" to "CSS", "sh" to "Shell", "bash" to "Bash",
    "sql" to "SQL", "go" to "Go", "java" to "Java",
)

@Composable
private fun CodeBlock(n: ContentNode, env: PageEnv) {
    val p = env.palette
    val shape = RoundedCornerShape(8.dp)
    val lang = n.str("language") ?: ""
    Box(Modifier.fillMaxWidth().background(p.bgSubtle, shape).border(1.dp, p.border, shape)) {
        Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 9.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            WText(if (lang.isEmpty()) "Plain text" else (codeNames[lang.lowercase()] ?: lang), 12f, p.text2, lineHeight = 1.3f)
            WText("Copy", 12f, p.text2, lineHeight = 1.3f)
        }
        InlineText(n.children, env, BlockCtx(), 13.5f, 400, 1.7f, mono = true, modifier = Modifier.padding(start = 15.dp, end = 15.dp, top = 35.dp, bottom = 13.dp))
    }
}

@Composable
private fun Callout(n: ContentNode, env: PageEnv, ctx: BlockCtx) {
    val p = env.palette
    val shape = RoundedCornerShape(8.dp)
    val emoji = n.str("emoji")?.takeIf { it.isNotEmpty() } ?: "💡"
    Box(Modifier.fillMaxWidth().background(p.bgSubtle, shape).border(1.dp, p.border, shape)) {
        Box(Modifier.padding(start = 13.dp, top = 13.dp).size(28.dp), contentAlignment = Alignment.Center) {
            Text(emoji, fontSize = 19.sp, maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
        }
        BlockList(n.children, env, ctx, Modifier.padding(start = 51.dp, end = 15.dp, top = 13.dp, bottom = 13.dp))
    }
}

@Composable
private fun Toggle(n: ContentNode, env: PageEnv, ctx: BlockCtx) {
    val p = env.palette
    val open = n.bool("open") ?: false
    val summary = n.children.firstOrNull { it.kind == NodeKind.DetailsSummary }
    val content = n.children.firstOrNull { it.kind == NodeKind.DetailsContent }
    val lineH = (env.body * 1.7f).dp
    Column {
        Row {
            Canvas(Modifier.width(26.dp).height(lineH)) {
                val cy = size.height / 2
                val path = Path()
                if (open) {
                    path.moveTo(6.5.dp.toPx(), cy - 1.5.dp.toPx())
                    path.lineTo(15.5.dp.toPx(), cy - 1.5.dp.toPx())
                    path.lineTo(11.dp.toPx(), cy + 4.5.dp.toPx())
                } else {
                    path.moveTo(9.dp.toPx(), cy - 4.5.dp.toPx())
                    path.lineTo(9.dp.toPx(), cy + 4.5.dp.toPx())
                    path.lineTo(15.dp.toPx(), cy)
                }
                path.close()
                drawPath(path, p.textMuted, style = Fill)
            }
            if (summary != null) InlineText(summary.children, env, ctx, env.body, 500, 1.7f, modifier = Modifier.weight(1f))
        }
        if (open && content != null) BlockList(content.children, env, ctx, Modifier.padding(start = 26.dp))
    }
}

// Lists ------------------------------------------------------------------------------------------------------------

@Composable
private fun BulletList(n: ContentNode, env: PageEnv, ctx: BlockCtx) {
    val p = env.palette
    val depth = ctx.bulletDepth
    val style = depth % 3
    val lineH = (env.body * 1.7f).dp
    Column {
        n.children.forEachIndexed { i, item ->
            Row {
                Canvas(Modifier.width(25.6.dp).height(lineH)) {
                    val cx = 13.1.dp.toPx()
                    val cy = size.height / 2 + 0.5.dp.toPx()
                    val r = 2.75.dp.toPx()
                    when (style) {
                        0 -> drawCircle(p.text, r, Offset(cx, cy))
                        1 -> drawCircle(p.text, r - 0.5.dp.toPx(), Offset(cx, cy), style = Stroke(1.dp.toPx()))
                        else -> drawRect(p.text, Offset(cx - r + 0.25.dp.toPx(), cy - r + 0.25.dp.toPx()), Size(2 * r - 0.5.dp.toPx(), 2 * r - 0.5.dp.toPx()))
                    }
                }
                BlockList(item.children, env, ctx.copy(bulletDepth = depth + 1), Modifier.weight(1f), trimBottom = i == n.children.lastIndex)
            }
        }
    }
}

@Composable
private fun OrderedList(n: ContentNode, env: PageEnv, ctx: BlockCtx) {
    val p = env.palette
    val depth = ctx.bulletDepth
    Column {
        n.children.forEachIndexed { i, item ->
            Row {
                Box(Modifier.width(25.6.dp).padding(end = 5.dp), contentAlignment = Alignment.TopEnd) {
                    WText(n.markers.getOrNull(i) ?: "${i + 1}.", env.body, p.text, lineHeight = 1.7f, maxLines = 1, align = androidx.compose.ui.text.style.TextAlign.End)
                }
                BlockList(item.children, env, ctx.copy(bulletDepth = depth + 1), Modifier.weight(1f), trimBottom = i == n.children.lastIndex)
            }
        }
    }
}

@Composable
private fun CheckList(n: ContentNode, env: PageEnv, ctx: BlockCtx) {
    val p = env.palette
    val lineH = env.body * 1.7f
    Column {
        n.children.forEachIndexed { i, item ->
            val checked = item.bool("checked") ?: false
            Row(Modifier.padding(start = 3.2.dp)) {
                Box(Modifier.padding(top = ((lineH - 15f) / 2f).dp).size(15.dp).drawBehind {
                    val r = CornerRadius(2.5.dp.toPx())
                    val inset = 0.5.dp.toPx()
                    val sz = Size(size.width - 2 * inset, size.height - 2 * inset)
                    if (checked) {
                        drawRoundRect(p.accent, Offset(inset, inset), sz, r)
                    } else {
                        drawRoundRect(p.bg, Offset(inset, inset), sz, r)
                        drawRoundRect(p.textMuted, Offset(inset, inset), sz, r, style = Stroke(1.dp.toPx()))
                    }
                }, contentAlignment = Alignment.Center) {
                    if (checked) LIcon(Ic.check, 11.dp, Color.White)
                }
                Spacer(Modifier.width(8.dp))
                BlockList(item.children, env, ctx.copy(checked = checked), Modifier.weight(1f), trimBottom = i == n.children.lastIndex)
            }
        }
    }
}

// Table, image, file --------------------------------------------------------------------------------------------------

@Composable
private fun TableBlock(n: ContentNode, env: PageEnv) {
    val p = env.palette
    val rows = n.children
    Column(Modifier.fillMaxWidth().border(1.dp, p.border)) {
        rows.forEachIndexed { r, row ->
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                row.children.forEachIndexed { c, cell ->
                    val header = cell.kind == NodeKind.TableHeader
                    val last = c == row.children.lastIndex
                    val lastRow = r == rows.lastIndex
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .background(if (header) p.bgSubtle else Color.Transparent)
                            .drawBehind {
                                if (!last) drawRect(p.border, Offset(size.width - 1.dp.toPx(), 0f), Size(1.dp.toPx(), size.height))
                                if (!lastRow) drawRect(p.border, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx()))
                            }
                            .padding(horizontal = 10.dp, vertical = 6.5.dp),
                    ) {
                        BlockList(cell.children, env, BlockCtx(weight = if (header) 600 else 400))
                    }
                }
            }
        }
    }
}

@Composable
private fun ImageBlock(n: ContentNode, env: PageEnv) {
    // Uploads need the session (a fetch with the access token): the native preview draws the alt text on a placeholder.
    val p = env.palette
    val alt = n.str("alt") ?: ""
    Row(Modifier.height(27.2.dp), verticalAlignment = Alignment.CenterVertically) {
        LIcon(Ic.image, 16.dp, p.textMuted)
        Spacer(Modifier.width(6.dp))
        WText(alt.ifEmpty { "Image" }, env.body, p.textMuted, lineHeight = 1.7f)
    }
}

@Composable
private fun FileCard(n: ContentNode, env: PageEnv) {
    val p = env.palette
    val shape = RoundedCornerShape(8.dp)
    val size = n.num("size")?.let { if (it >= 1_048_576) String.format("%.1f MB", it / 1_048_576) else "${Math.round(it / 1024)} KB" } ?: ""
    Row(
        Modifier.widthIn(max = 520.dp).fillMaxWidth().height(52.dp).background(p.bg, shape).border(1.dp, p.border, shape).padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(34.dp).background(p.accentSoft, RoundedCornerShape(7.dp)), contentAlignment = Alignment.Center) {
            LIcon(Ic.fileText, 18.dp, p.accent)
        }
        Spacer(Modifier.width(10.dp))
        WText(n.str("name") ?: "File", env.body, p.text, Modifier.weight(1f), weight = 500, lineHeight = 1.3f)
        WText(size, 12f, p.textMuted, lineHeight = 1.3f)
        Spacer(Modifier.width(8.dp))
        LIcon(Ic.download, 16.dp, p.text2)
        Spacer(Modifier.width(6.dp))
    }
}

// Task lines ---------------------------------------------------------------------------------------------------------

internal fun priorityColor(p: Palette, priority: Int): Color = when (priority) {
    1 -> p.p1
    2 -> p.p2
    3 -> p.p3
    else -> p.textMuted
}

internal fun toneColor(p: Palette, tone: DueTone): Color = when (tone) {
    DueTone.Overdue -> p.danger
    DueTone.Today -> p.success
    DueTone.Soon -> p.warn
    DueTone.Later -> p.text2
}

/** A task's circle (`.task-check`): the ring in the priority colour with a 10 % fill; done: filled with a white check. */
@Composable
fun TaskCircle(priority: Int, done: Boolean, p: Palette, size: Dp = 18.dp, modifier: Modifier = Modifier) {
    val ring = priorityColor(p, priority)
    Box(
        modifier.size(size).drawBehind {
            val sw = 1.6.dp.toPx()
            val c = Offset(this.size.width / 2, this.size.height / 2)
            val r = this.size.width / 2
            if (done) {
                drawCircle(if (priority < 4) ring else p.textMuted, r, c)
            } else {
                if (priority < 4) drawCircle(ring.copy(alpha = 0.10f), r - sw / 2, c)
                drawCircle(ring, r - sw / 2, c, style = Stroke(sw))
            }
        },
        contentAlignment = Alignment.Center,
    ) {
        if (done) LIcon(Ic.check, size * 0.6f, Color.White)
    }
}

@Composable
private fun Chip(p: Palette, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Row(
        modifier.height(22.dp).background(p.bgHover, RoundedCornerShape(6.dp)).padding(horizontal = 6.5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) { content() }
}

@Composable
private fun TaskLine(n: ContentNode, env: PageEnv, ctx: BlockCtx) {
    val p = env.palette
    val id = n.str("taskId") ?: ""
    val task = env.tasks[id]
    Column {
        if (task == null) {
            MissingTask(env)
            return@Column
        }
        val done = task.done
        val priority = task.priority.toInt()
        Box {
            if (n.children.isNotEmpty()) {
                LIcon(Ic.chevronDown, 14.dp, p.textMuted, Modifier.offset(x = (-20).dp, y = 10.dp))
            }
            Row(Modifier.fillMaxWidth().height(34.dp), verticalAlignment = Alignment.CenterVertically) {
                TaskCircle(priority, done, p, 18.dp)
                Spacer(Modifier.width(8.dp))
                Text(
                    text = task.title,
                    modifier = Modifier.weight(1f),
                    color = if (done) p.textMuted else p.text,
                    style = WebType.style(env.body, 400, 1.7f).copy(textDecoration = if (done) TextDecoration.LineThrough else null),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.width(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    val total = task.checklistTotal?.toInt() ?: 0
                    if (total > 0) {
                        val d = task.checklistDone?.toInt() ?: 0
                        val complete = d >= total
                        Chip(p) {
                            LIcon(Ic.squareCheck, 12.dp, if (complete) p.success else p.text2)
                            WText("$d/$total", 11.5f, if (complete) p.success else p.text2, weight = 500, lineHeight = 1f)
                        }
                    }
                    if (!env.phone || priority < 4) {
                        Chip(p, Modifier.width(26.dp)) {
                            if (priority < 4) LIcon(Ic.flagFilled, 13.dp, priorityColor(p, priority)) else LIcon(Ic.flag, 13.dp, p.text2)
                        }
                    }
                    val dueText = Due.words(task.dueDate, task.dueTime, env.today)
                    Chip(p) {
                        val tone = if (dueText == null) p.text2 else toneColor(p, Due.tone(task.dueDate, env.today))
                        LIcon(Ic.calendarDays, 13.dp, tone)
                        if (dueText != null) WText(dueText, 11.5f, tone, weight = 500, lineHeight = 1f)
                    }
                    if (!env.phone) {
                        if (task.assigneeId != null && task.assigneeId == env.meId) {
                            val c = parseHex(env.meColor)
                            Box(Modifier.size(20.dp).background(c, CircleShape), contentAlignment = Alignment.Center) {
                                WText(initialsOf(env.meName), 8.4f, initialsColor(c), weight = 600, lineHeight = 1f)
                            }
                        } else {
                            Box(Modifier.size(20.dp).drawBehind {
                                val sw = 1.5.dp.toPx()
                                drawCircle(
                                    p.borderStrong, size.width / 2 - sw / 2, Offset(size.width / 2, size.height / 2),
                                    style = Stroke(sw, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 2.dp.toPx()))),
                                )
                            })
                        }
                        Row(Modifier.height(22.dp), verticalAlignment = Alignment.CenterVertically) {
                            LIcon(Ic.listPlus, 13.dp, p.text2, Modifier.padding(start = 4.dp))
                            Spacer(Modifier.width(4.dp))
                            WText("Add checklist", 11.5f, p.text2, weight = 500, lineHeight = 1f)
                        }
                    } else {
                        Box(Modifier.size(25.dp, 22.dp), contentAlignment = Alignment.Center) { LIcon(Ic.listPlus, 13.dp, p.text2) }
                    }
                    Box(Modifier.size(24.dp, 22.dp), contentAlignment = Alignment.Center) { LIcon(Ic.maximize2, 13.dp, p.text2) }
                }
            }
        }
        if (n.children.isNotEmpty()) {
            val guide = p.border
            BlockList(
                n.children, env, ctx,
                Modifier
                    .drawBehind {
                        val x = 27.dp.toPx()
                        drawLine(
                            guide, Offset(x, -4.dp.toPx()), Offset(x, size.height + 4.dp.toPx()), strokeWidth = 2.dp.toPx(),
                            pathEffect = if (done) PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())) else null,
                        )
                    }
                    .padding(start = 38.dp),
            )
        }
    }
}

@Composable
private fun MissingTask(env: PageEnv) {
    val p = env.palette
    if (env.phone) {
        Column(Modifier.padding(top = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                LIcon(Ic.fileXCorner, 15.dp, p.textMuted, Modifier.padding(start = 4.dp))
                Spacer(Modifier.width(8.dp))
                WText("This task was deleted or is not visible to you.", 12.5f, p.textMuted, lineHeight = 1.3f, maxLines = 2)
            }
            WText("Remove from page", 13f, p.text2, Modifier.padding(start = 14.dp, top = 12.dp, bottom = 12.dp), weight = 500, lineHeight = 1.3f)
        }
    } else {
        Row(Modifier.height(40.dp), verticalAlignment = Alignment.CenterVertically) {
            LIcon(Ic.fileXCorner, 15.dp, p.textMuted)
            Spacer(Modifier.width(8.dp))
            WText("This task was deleted or is not visible to you.", 12.5f, p.textMuted, lineHeight = 1.3f)
            Spacer(Modifier.width(18.dp))
            WText("Remove from page", 13f, p.text2, weight = 500, lineHeight = 1.3f)
        }
    }
}
