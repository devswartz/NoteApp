package com.notivelo.app.edit

import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan
import android.text.style.ReplacementSpan
import android.text.style.StrikethroughSpan
import android.text.style.UnderlineSpan
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import com.notivelo.app.look.PagePalettes
import com.notivelo.app.ui.page.PageEnv
import com.notivelo.core.ViewLine
import com.notivelo.core.ViewMarkKind
import com.notivelo.core.ViewRender
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** How a block is dressed: what [BoxGeometry] draws behind its lines. */
enum class BlockKind { Plain, Heading, List, Quote, Callout, Code, Details, Table, Image, File, Rule, Task }

/** A run of lines drawn as one block: callouts and code get a box, quotes a bar. [top] and [bottom] are px in box coordinates. */
class BlockBox(val kind: BlockKind, val top: Float, val bottom: Float, val firstLine: Int, val lastLine: Int)

/** What sits in the margin of a list item's first line. */
enum class MarkerKind { None, Bullet, Ordered, Check }

/** One line of the view text laid out: [start]..[end] are its offsets, [top]/[height] px in box coordinates, [x] where its text starts. */
class LineBox(
    val index: Int,
    val line: ViewLine,
    val start: Int,
    val end: Int,
    val top: Float,
    val height: Float,
    val x: Float,
    val width: Int,
    /** Null for an object line (rule, image, file, task): drawn by kind. */
    val layout: StaticLayout?,
    /** The height of one text row, px. */
    val rowHeight: Int,
    val block: BlockKind,
    val marker: MarkerKind,
    val markerX: Float,
    val markerDepth: Int,
    val markerText: String,
    val checked: Boolean,
)

/** The box's lines in px, with the questions the view asks: where is the caret, what is at this point, what to highlight. */
class BoxGeometry(
    val lines: List<LineBox>,
    val blocks: List<BlockBox>,
    val height: Float,
    val textLength: Int,
) {
    /** The line holding [offset]: its end counts (the caret after the last character), the line feed belongs to no line. */
    fun lineAt(offset: Int): LineBox? {
        if (lines.isEmpty()) return null
        var lo = 0
        var hi = lines.size - 1
        while (lo < hi) {
            val mid = (lo + hi + 1) / 2
            if (lines[mid].start <= offset) lo = mid else hi = mid - 1
        }
        return lines[lo]
    }

    /** The caret's rectangle at [offset] (zero width), px in box coordinates. */
    fun caretRect(offset: Int): RectF {
        val l = lineAt(offset) ?: return RectF(0f, 0f, 0f, 20f)
        val lay = l.layout
        if (lay == null) return RectF(l.x, l.top, l.x, l.top + l.height)
        val local = (offset - l.start).coerceIn(0, lay.text.length)
        if (lay.text.isEmpty()) return RectF(l.x, l.top, l.x, l.top + l.rowHeight)
        val row = lay.getLineForOffset(local)
        val cx = l.x + lay.getPrimaryHorizontal(local)
        return RectF(cx, l.top + lay.getLineTop(row), cx, l.top + lay.getLineBottom(row))
    }

    /** The offset nearest the point (box coordinates, px). */
    fun offsetAt(x: Float, y: Float): Int {
        if (lines.isEmpty()) return 0
        var line = lines.last()
        for (l in lines) {
            if (y < l.top + l.height) {
                line = l
                break
            }
        }
        val lay = line.layout ?: return if (x > line.x + line.width / 2f && line.end > line.start) line.end else line.start
        if (lay.text.isEmpty()) return line.start
        val ly = (y - line.top).toInt().coerceIn(0, max(0, lay.height - 1))
        val row = lay.getLineForVertical(ly)
        val local = lay.getOffsetForHorizontal(row, x - line.x)
        return min(line.start + local, line.end)
    }

    /** The highlight for `from..to`: one rectangle per row, plus a stub where a line feed is covered. */
    fun selectionPath(from: Int, to: Int, lineFeedStub: Float): Path {
        val path = Path()
        if (from >= to) return path
        for (l in lines) {
            if (l.end < from || l.start > to) continue
            val lo = max(from, l.start) - l.start
            val hi = min(to, l.end) - l.start
            val lay = l.layout
            if (lay == null) {
                if (to > l.start && from <= l.start) path.addRect(l.x, l.top, l.x + l.width, l.top + l.height, Path.Direction.CW)
                continue
            }
            if (hi > lo && lay.text.isNotEmpty()) {
                val p = Path()
                lay.getSelectionPath(lo, hi, p)
                p.offset(l.x, l.top)
                path.addPath(p)
            }
            if (to > l.end && from <= l.end && l.index < lines.size - 1) {
                val c = caretRect(l.end)
                path.addRect(c.left, c.top, c.left + lineFeedStub, c.bottom, Path.Direction.CW)
            }
        }
        return path
    }

    /** One row up or down from [offset], keeping the x of the caret at [x] (null: where it is now). */
    fun moveVertical(offset: Int, down: Boolean, x: Float? = null): Int {
        val c = caretRect(offset)
        val y = if (down) c.bottom + 1f else c.top - 1f
        if (y < 0f) return 0
        if (y >= height) return textLength
        return offsetAt(x ?: c.left, y)
    }
}

private class ExactLineHeight(private val h: Int) : LineHeightSpan {
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        val cur = fm.descent - fm.ascent
        if (cur <= 0) return
        val extra = h - cur
        val up = extra / 2
        fm.ascent -= up
        fm.top = fm.ascent
        fm.descent += extra - up
        fm.bottom = fm.descent
    }
}

private class TypefaceRunSpan(private val tf: Typeface) : MetricAffectingSpan() {
    override fun updateDrawState(p: TextPaint) {
        p.typeface = tf
    }

    override fun updateMeasureState(p: TextPaint) {
        p.typeface = tf
    }
}

private class SizeRunSpan(private val px: Float) : MetricAffectingSpan() {
    override fun updateDrawState(p: TextPaint) {
        p.textSize = px
    }

    override fun updateMeasureState(p: TextPaint) {
        p.textSize = px
    }
}

/** A mention or page link: one U+FFFC in the text, drawn as its label (a pill for a mention). */
private class AtomSpan(
    private val label: String,
    private val fg: Int,
    private val bg: Int,
    private val underline: Boolean,
    private val padPx: Float,
    private val radiusPx: Float,
) : ReplacementSpan() {
    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int =
        ceil(paint.measureText(label) + 2 * padPx).toInt()

    override fun draw(canvas: android.graphics.Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val w = paint.measureText(label) + 2 * padPx
        val p = Paint(paint)
        if (bg != 0) {
            p.color = bg
            canvas.drawRoundRect(RectF(x, y + paint.ascent() - 1f, x + w, y + paint.descent() + 1f), radiusPx, radiusPx, p)
        }
        p.color = fg
        p.isUnderlineText = underline
        canvas.drawText(label, x + padPx, y.toFloat(), p)
    }
}

/** Builds [BoxGeometry] from the engine's frame. The metrics are Blocks.kt's, so an edited box reads like a still one. */
object BoxLayoutBuilder {
    private const val BULLET_COL = 25.6f
    private const val CHECK_COL = 3.2f + 15f + 8f

    private fun typeface(weight: Int, italic: Boolean, mono: Boolean): Typeface {
        val base = if (mono) Typeface.MONOSPACE else Typeface.SANS_SERIF
        return if (Build.VERSION.SDK_INT >= 28) {
            Typeface.create(base, weight, italic)
        } else {
            val style = when {
                weight >= 600 && italic -> Typeface.BOLD_ITALIC
                weight >= 600 -> Typeface.BOLD
                italic -> Typeface.ITALIC
                else -> Typeface.NORMAL
            }
            Typeface.create(base, style)
        }
    }

    private fun margins(kind: BlockKind, level: Int): Pair<Float, Float> = when (kind) {
        BlockKind.Heading -> when (level) {
            1 -> 33.6f to 8.4f
            2 -> 23.76f to 5.4f
            else -> 17.92f to 3.58f
        }
        BlockKind.List -> 4.8f to 4.8f
        BlockKind.Quote, BlockKind.Callout, BlockKind.Code, BlockKind.Image -> 9.6f to 9.6f
        BlockKind.Table -> 12.8f to 12.8f
        BlockKind.File -> 6.4f to 6.4f
        else -> 0f to 0f
    }

    private fun padding(kind: BlockKind): Pair<Float, Float> = when (kind) {
        BlockKind.Callout -> 13f to 13f
        BlockKind.Code -> 35f to 13f
        BlockKind.Quote -> 5.6f to 5.6f
        BlockKind.Table -> 6.5f to 6.5f
        else -> 0f to 0f
    }

    private val listContainers = setOf("bulletList", "orderedList", "taskList")

    fun blockKind(l: ViewLine): BlockKind = when (l.containers.firstOrNull()) {
        in listContainers -> BlockKind.List
        "blockquote" -> BlockKind.Quote
        "callout" -> BlockKind.Callout
        "details" -> BlockKind.Details
        "table" -> BlockKind.Table
        "taskRef" -> BlockKind.Plain
        else -> when (l.kind) {
            "heading" -> BlockKind.Heading
            "codeBlock" -> BlockKind.Code
            "image" -> BlockKind.Image
            "fileAttachment" -> BlockKind.File
            "horizontalRule" -> BlockKind.Rule
            "taskRef" -> BlockKind.Task
            "details", "detailsSummary" -> BlockKind.Details
            else -> BlockKind.Plain
        }
    }

    private fun sameBlock(a: ViewLine, first: ViewLine): Boolean =
        first.containers.isNotEmpty() && a.containers.firstOrNull() == first.containers.first()

    fun build(render: ViewRender, env: PageEnv, density: Float, widthPx: Int): BoxGeometry {
        val view = render.view
        val text = view.text
        val d = density
        val out = ArrayList<LineBox>(view.lines.size)
        val blocks = ArrayList<BlockBox>()
        var y = 0f
        var prevBottom = 0f
        var i = 0
        val lines = view.lines
        val marked = view.marked?.let { it.from.toInt() to it.to.toInt() }
        while (i < lines.size) {
            val first = lines[i]
            val kind = blockKind(first)
            var j = i + 1
            while (j < lines.size && sameBlock(lines[j], first)) j++
            val (mt, mb) = margins(kind, first.level.toInt())
            val gap = if (kind == BlockKind.Table) prevBottom + mt else max(prevBottom, mt)
            y += gap * d
            val blockTop = y
            val (pt, pb) = padding(kind)
            y += pt * d
            for (k in i until j) {
                val line = lines[k]
                val lb = lineBox(k, line, text, env, d, widthPx, y, kind, line.containers.contains("blockquote"), marked)
                out += lb
                y += lb.height
            }
            y += pb * d
            blocks += BlockBox(kind, blockTop, y, i, j - 1)
            prevBottom = mb
            i = j
        }
        y += prevBottom * d
        return BoxGeometry(out, blocks, y, text.length)
    }

    private fun lineBox(index: Int, line: ViewLine, text: String, env: PageEnv, d: Float, widthPx: Int, top: Float, kind: BlockKind, inQuote: Boolean, marked: Pair<Int, Int>?): LineBox {
        val p = env.palette
        // Indentation from the containers, from the box down.
        var x = 0f
        var rightPad = 0f
        var markerKind = MarkerKind.None
        var markerX = 0f
        var depthBefore = 0
        var bulletDepth = 0
        var innermost: String? = null
        for (c in line.containers) {
            when (c) {
                "bulletList", "orderedList" -> {
                    innermost = c
                    markerX = x
                    depthBefore = bulletDepth
                    bulletDepth++
                    x += BULLET_COL
                }
                "taskList" -> {
                    innermost = c
                    markerX = x
                    depthBefore = bulletDepth
                    x += CHECK_COL
                }
                "blockquote" -> x += 19f
                "callout" -> {
                    x += 51f
                    rightPad += 15f
                }
                "detailsContent" -> x += 26f
                "taskRef" -> x += 36f
                "tableCell", "tableHeader" -> x += 10f
            }
        }
        if (line.kind == "detailsSummary") x += 26f
        if (line.kind == "codeBlock") {
            x += 15f
            rightPad += 15f
        }
        if (line.marker != null || line.checked != null) {
            markerKind = when (innermost) {
                "bulletList" -> MarkerKind.Bullet
                "orderedList" -> MarkerKind.Ordered
                "taskList" -> MarkerKind.Check
                else -> MarkerKind.None
            }
        }
        val px = x * d
        val width = max(1, widthPx - (px + rightPad * d).roundToInt())
        val start = line.offset.toInt()
        val end = start + line.len.toInt()
        val body = env.body
        val level = line.level.toInt()

        if (!line.isText) {
            val h = when (line.kind) {
                "horizontalRule" -> 45.8f
                "fileAttachment" -> 52f
                "taskRef" -> 28f
                else -> body * 1.7f
            }
            return LineBox(index, line, start, end, top, h * d, px, width, null, (h * d).roundToInt(), kind, MarkerKind.None, 0f, 0, "", false)
        }

        var size = body
        var weight = 400
        var lh = 1.7f
        var tracking = 0f
        var isMono = false
        if (line.kind == "heading") {
            val base = when (level) { 1 -> 28f; 2 -> 21.6f; else -> 17.92f }
            size = base * body / 16f * (if (level == 1 && body > 16f) 1.045f else 1f)
            lh = when (level) { 1 -> 1.3f; 2 -> 1.35f; else -> 1.7f }
            tracking = when (level) { 1 -> -0.02f; 2 -> -0.01f; else -> 0f }
            weight = 700
        } else if (line.kind == "codeBlock") {
            size = 13.5f
            isMono = true
        } else if (line.kind == "detailsSummary") {
            weight = 500
        }
        val color = if (inQuote) p.text2 else p.text
        val checked = line.checked == true
        val rowH = (size * lh * d).roundToInt().coerceAtLeast(1)
        val seg = text.substring(start, end)
        val sp = styled(seg, line, env, d, size, weight, isMono, if (checked) p.textMuted else color, checked, rowH, marked?.let { (it.first - start) to (it.second - start) })
        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
        paint.textSize = size * d
        paint.color = (if (checked) p.textMuted else color).toArgb()
        paint.typeface = typeface(weight, false, isMono)
        paint.letterSpacing = tracking
        val layout = StaticLayout.Builder.obtain(sp, 0, sp.length, paint, width)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setIncludePad(false)
            .setLineSpacing(0f, 1f)
            .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
            .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
            .build()
        val h = if (seg.isEmpty()) rowH.toFloat() else max(layout.height, rowH).toFloat()
        val markerText = if (markerKind == MarkerKind.Ordered) line.marker ?: "" else ""
        return LineBox(index, line, start, end, top, h, px, width, layout, rowH, kind, markerKind, markerX * d, depthBefore, markerText, checked)
    }

    private fun argb(c: Color) = c.toArgb()

    private fun styled(
        seg: String, line: ViewLine, env: PageEnv, d: Float, size: Float, weight: Int, mono: Boolean, color: Color,
        checked: Boolean, rowH: Int, marked: Pair<Int, Int>?,
    ): SpannableStringBuilder {
        val p = env.palette
        val sp = SpannableStringBuilder(seg)
        if (seg.isEmpty()) return sp
        sp.setSpan(ExactLineHeight(rowH), 0, seg.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        for (run in line.runs) {
            val from = run.from.toInt().coerceIn(0, seg.length)
            val to = (from + run.len.toInt()).coerceIn(from, seg.length)
            if (to <= from) continue
            var w = weight
            var italic = false
            var code = mono
            var fg = color
            var bg: Color? = null
            var underline = false
            var strike = checked
            for (m in run.marks) when (m.kind) {
                ViewMarkKind.BOLD -> w = 700
                ViewMarkKind.ITALIC -> italic = true
                ViewMarkKind.CODE -> code = true
                ViewMarkKind.UNDERLINE -> underline = true
                ViewMarkKind.STRIKE -> strike = true
                ViewMarkKind.TEXT_COLOR -> m.value?.let { PagePalettes.textColor(p, it) }?.let { fg = it }
                ViewMarkKind.HIGHLIGHT -> bg = PagePalettes.highlight(p, m.value)
                ViewMarkKind.LINK -> {
                    fg = p.accent
                    underline = true
                }
                ViewMarkKind.COMMENT -> {
                    bg = Color(250 / 255f, 204 / 255f, 21 / 255f, 0.28f)
                    underline = true
                }
                else -> {}
            }
            if (code && !mono && bg == null) bg = p.bgHover
            if (w != weight || italic || code != mono) sp.setSpan(TypefaceRunSpan(typeface(w, italic, code)), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (code && !mono) sp.setSpan(SizeRunSpan(size * 0.88f * d), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (fg != color) sp.setSpan(ForegroundColorSpan(argb(fg)), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            bg?.let { sp.setSpan(BackgroundColorSpan(argb(it)), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
            if (underline) sp.setSpan(UnderlineSpan(), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (strike) sp.setSpan(StrikethroughSpan(), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        if (marked != null) {
            val lo = marked.first.coerceIn(0, seg.length)
            val hi = marked.second.coerceIn(lo, seg.length)
            if (hi > lo) sp.setSpan(UnderlineSpan(), lo, hi, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        for (a in line.atoms) {
            val at = a.offset.toInt()
            if (at !in 0 until seg.length) continue
            val span = when (a.kind) {
                "mention" -> {
                    val id = jsonField(a.attrsJson, "id")
                    val mine = id != null && id == env.meId
                    AtomSpan(
                        "@" + a.label, argb(if (mine) p.text else p.accent),
                        argb(if (mine) Color(250 / 255f, 204 / 255f, 21 / 255f, 0.35f) else p.accentSoft),
                        false, 4f * d, 4f * d,
                    )
                }
                "pageLink" -> {
                    val title = env.pageTitles[jsonField(a.attrsJson, "pageId") ?: ""] ?: a.label
                    AtomSpan(title, argb(p.text), 0, true, 1f * d, 0f)
                }
                else -> AtomSpan("◻", argb(p.textMuted), 0, false, 1f * d, 0f)
            }
            sp.setSpan(span, at, at + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return sp
    }

    /** A string field of a small JSON object, without a JSON parser (the attrs are flat: `{"id":"u1","label":"Sam"}`). */
    internal fun jsonField(json: String, name: String): String? {
        val m = Regex("\"" + Regex.escape(name) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(json) ?: return null
        return m.groupValues[1].replace("\\\"", "\"").replace("\\\\", "\\")
    }

}
