package com.notivelo.app.edit

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.text.InputType
import android.text.Layout
import android.text.TextPaint
import android.text.TextUtils
import android.view.ActionMode
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.CursorAnchorInfo
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import com.notivelo.app.ui.page.PageEnv
import com.notivelo.core.SuggestionTrigger
import com.notivelo.core.ViewRender
import com.notivelo.core.WorkspaceMember
import java.text.BreakIterator
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * One text box of a live page, editable (EDITOR.md 10.5): the engine's frame (`view_render`) laid out with
 * `StaticLayout` per line ([BoxLayoutBuilder]) and drawn by this view with the same metrics the read-only blocks use,
 * plus caret, selection and handles. It owns no text: the IME talks to [BoxInput] through [BoxInputConnection], taps and
 * keys go to the engine, and the picture is read back from the engine after each call (`revision` moved: repaint,
 * `text_revision` moved: lay out again).
 */
class BoxTextView(context: Context, engine: TextEngine, env: PageEnv) : View(context) {
    var env: PageEnv = env
        set(value) {
            if (field !== value) {
                field = value
                builtEnv = null
                requestLayout()
                invalidate()
            }
        }

    var input: BoxInput = BoxInput(engine)
        private set

    /** Pages and people the `[[` and `@` menus offer. */
    var pages: List<PageChoice> = emptyList()
    var people: List<WorkspaceMember> = emptyList()

    /** The menu opened, changed or closed (null): the host shows the popup. */
    var onMenu: ((MenuModel?) -> Unit)? = null

    /** Draw as focused (caret, handles) without the keyboard: the look scenes. */
    var lookFocused: Boolean = false
        set(value) {
            field = value
            invalidate()
        }

    private val d = resources.displayMetrics.density
    private val padX = 11f * d
    private val padY = 7f * d
    private var geometry: BoxGeometry? = null
    private var builtRevision: ULong? = null
    private var builtWidth = -1
    private var builtEnv: PageEnv? = null

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG)

    // Caret blink and handle drag.
    private var caretOn = true
    private val blink = object : Runnable {
        override fun run() {
            caretOn = !caretOn
            invalidate()
            postDelayed(this, 530)
        }
    }
    private var dragging = 0 // 0 none, 1 start handle, 2 end handle
    private var dragFixed = 0
    private var actionMode: ActionMode? = null
    private var menuHighlight = 0
    private var menuKey = ""
    private var menuShown: MenuModel? = null
    private var connection: BoxInputConnection? = null
    private var cursorUpdates = 0
    private var extractedRequest: ExtractedTextRequest? = null
    private var lastMenuSig = ""

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        isLongClickable = false
        wire(input)
    }

    private val gestures = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean = true
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                tapAt(e.x, e.y)
                return true
            }

            override fun onDoubleTap(e: MotionEvent): Boolean {
                selectWordAt(e.x, e.y)
                return true
            }

            override fun onLongPress(e: MotionEvent) {
                selectWordAt(e.x, e.y)
            }
        },
    )

    private fun wire(i: BoxInput) {
        i.onChanged = { prev, next, fromIme -> changed(prev, next, fromIme) }
    }

    /** Hand the view another engine (a different box). */
    fun attach(engine: TextEngine) {
        input = BoxInput(engine)
        wire(input)
        builtRevision = null
        requestLayout()
        invalidate()
        syncIme()
    }

    /** Someone else changed the page, or the host wants a repaint: read the engine's frame again. */
    fun refresh() {
        input.refresh(false)
    }

    // Layout and drawing ------------------------------------------------------------------------------------------------

    private fun ensureGeometry(contentWidth: Int): BoxGeometry {
        val r = input.render
        val g = geometry
        if (g != null && builtRevision == r.textRevision && builtWidth == contentWidth && builtEnv === env) return g
        val built = BoxLayoutBuilder.build(r, env, d, contentWidth)
        geometry = built
        builtRevision = r.textRevision
        builtWidth = contentWidth
        builtEnv = env
        return built
    }

    private fun contentWidth(): Int = max(1, width - (2 * padX).roundToInt())

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val g = ensureGeometry(max(1, w - (2 * padX).roundToInt()))
        setMeasuredDimension(w, (g.height + 2 * padY).roundToInt())
    }

    private fun geo(): BoxGeometry = ensureGeometry(contentWidth())

    private fun px(c: Color) = c.toArgb()

    override fun onDraw(canvas: Canvas) {
        val g = geo()
        val p = env.palette
        val r = input.render
        canvas.save()
        canvas.translate(padX, padY)
        val w = (width - 2 * padX)

        // Block boxes behind the text.
        for (b in g.blocks) drawBlock(canvas, b, g, w)

        // Selection under the text.
        val sel = r.view.selection
        val a = min(sel.anchor.toInt(), sel.head.toInt())
        val z = max(sel.anchor.toInt(), sel.head.toInt())
        if (z > a) {
            fill.style = Paint.Style.FILL
            fill.color = px(p.accent.copy(alpha = 0.22f))
            canvas.drawPath(g.selectionPath(a, z, 6f * d), fill)
        }

        for (l in g.lines) drawLine(canvas, l, g)

        if (r.view.text.isEmpty() && g.lines.isNotEmpty()) {
            textPaint.reset()
            textPaint.isAntiAlias = true
            textPaint.textSize = env.body * d
            textPaint.color = px(p.textPlaceholder)
            val l = g.lines[0]
            canvas.drawText("Type '/' for commands…", l.x, l.top + (l.rowHeight - (textPaint.descent() - textPaint.ascent())) / 2f - textPaint.ascent(), textPaint)
        }

        // Remote carets.
        for (c in r.remoteCursors) {
            val rc = g.caretRect(min(c.head.toInt(), r.view.text.length))
            fill.color = remoteColor(c.userId)
            canvas.drawRect(rc.left - d, rc.top, rc.left + d, rc.bottom, fill)
        }

        val active = isFocused || lookFocused
        if (active) {
            if (a == z && (caretOn || lookFocused)) {
                val cr = g.caretRect(z)
                fill.style = Paint.Style.FILL
                fill.color = px(p.accent)
                canvas.drawRect(cr.left - 0.75f * d, cr.top + 2f * d, cr.left + 0.75f * d, cr.bottom - 2f * d, fill)
            }
            if (z > a) drawHandles(canvas, g, a, z)
        }
        canvas.restore()
    }

    private fun remoteColor(userId: String): Int {
        val palette = intArrayOf(0xFFEF4444.toInt(), 0xFF10B981.toInt(), 0xFFF59E0B.toInt(), 0xFF8B5CF6.toInt(), 0xFFEC4899.toInt(), 0xFF06B6D4.toInt())
        return palette[(userId.hashCode() and 0x7fffffff) % palette.size]
    }

    private fun drawBlock(c: Canvas, b: BlockBox, g: BoxGeometry, w: Float) {
        val p = env.palette
        when (b.kind) {
            BlockKind.Quote -> {
                fill.style = Paint.Style.FILL
                fill.color = px(p.borderStrong)
                c.drawRect(0f, b.top, 3f * d, b.bottom, fill)
            }
            BlockKind.Callout, BlockKind.Code, BlockKind.Table -> {
                val radius = if (b.kind == BlockKind.Table) 0f else 8f * d
                val rect = RectF(0.5f * d, b.top + 0.5f * d, w - 0.5f * d, b.bottom - 0.5f * d)
                if (b.kind != BlockKind.Table) {
                    fill.style = Paint.Style.FILL
                    fill.color = px(p.bgSubtle)
                    c.drawRoundRect(rect, radius, radius, fill)
                }
                stroke.strokeWidth = d
                stroke.color = px(p.border)
                c.drawRoundRect(rect, radius, radius, stroke)
                textPaint.reset()
                textPaint.isAntiAlias = true
                if (b.kind == BlockKind.Callout) {
                    textPaint.textSize = 19f * d
                    val cx = 13f * d + 14f * d
                    val cy = b.top + 13f * d + 14f * d
                    textPaint.textAlign = Paint.Align.CENTER
                    c.drawText("💡", cx, cy - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint)
                } else if (b.kind == BlockKind.Code) {
                    textPaint.textSize = 12f * d
                    textPaint.color = px(p.text2)
                    val base = b.top + 9f * d - textPaint.ascent() + (12f * 1.3f * d - (textPaint.descent() - textPaint.ascent())) / 2f
                    c.drawText("Plain text", 14f * d, base, textPaint)
                    textPaint.textAlign = Paint.Align.RIGHT
                    c.drawText("Copy", w - 14f * d, base, textPaint)
                }
            }
            else -> {}
        }
    }

    private fun drawLine(c: Canvas, l: LineBox, g: BoxGeometry) {
        val p = env.palette
        val lay = l.layout
        if (lay != null) {
            c.save()
            c.translate(l.x, l.top)
            lay.draw(c)
            c.restore()
            drawMarker(c, l, lay)
            if (l.line.kind == "detailsSummary") drawToggle(c, l, g)
            return
        }
        textPaint.reset()
        textPaint.isAntiAlias = true
        textPaint.textSize = env.body * d
        when (l.line.kind) {
            "horizontalRule" -> {
                fill.style = Paint.Style.FILL
                fill.color = px(p.border)
                c.drawRect(0f, l.top + 22.4f * d, width - 2 * padX, l.top + 23.4f * d, fill)
            }
            "taskRef" -> {
                val task = l.line.taskId?.let { env.tasks[it] }
                val cx = l.x + 9f * d + 3f * d
                val cy = l.top + l.height / 2f
                stroke.strokeWidth = 1.6f * d
                stroke.color = px(p.textMuted)
                if (task?.done == true) {
                    fill.style = Paint.Style.FILL
                    fill.color = px(p.success)
                    c.drawCircle(cx, cy, 9f * d, fill)
                } else {
                    c.drawCircle(cx, cy, 8.2f * d, stroke)
                }
                textPaint.color = px(if (task?.done == true) p.textMuted else p.text)
                textPaint.isStrikeThruText = task?.done == true
                c.drawText(task?.title ?: "Task", l.x + 36f * d, cy - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint)
            }
            "fileAttachment" -> {
                val rect = RectF(l.x, l.top + 0.5f * d, width - 2 * padX, l.top + l.height - 0.5f * d)
                fill.style = Paint.Style.FILL
                fill.color = px(p.bg)
                c.drawRoundRect(rect, 8f * d, 8f * d, fill)
                stroke.strokeWidth = d
                stroke.color = px(p.border)
                c.drawRoundRect(rect, 8f * d, 8f * d, stroke)
                textPaint.color = px(p.text)
                textPaint.typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
                val name = BoxLayoutBuilder.jsonField(l.line.attrsJson ?: "", "name") ?: "File"
                c.drawText(name, l.x + 55f * d, l.top + l.height / 2f - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint)
            }
            else -> {
                val alt = BoxLayoutBuilder.jsonField(l.line.attrsJson ?: "", "alt").orEmpty().ifEmpty { "Image" }
                textPaint.color = px(p.textMuted)
                c.drawText(alt, l.x + 22f * d, l.top + l.height / 2f - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint)
            }
        }
    }

    private fun drawToggle(c: Canvas, l: LineBox, g: BoxGeometry) {
        val p = env.palette
        val open = g.lines.getOrNull(l.index + 1)?.line?.containers?.contains("detailsContent") == true
        val cy = l.top + l.rowHeight / 2f
        val path = Path()
        if (open) {
            path.moveTo(l.x - 19.5f * d, cy - 1.5f * d)
            path.lineTo(l.x - 10.5f * d, cy - 1.5f * d)
            path.lineTo(l.x - 15f * d, cy + 4.5f * d)
        } else {
            path.moveTo(l.x - 17f * d, cy - 4.5f * d)
            path.lineTo(l.x - 17f * d, cy + 4.5f * d)
            path.lineTo(l.x - 11f * d, cy)
        }
        path.close()
        fill.style = Paint.Style.FILL
        fill.color = px(p.textMuted)
        c.drawPath(path, fill)
    }

    private fun drawMarker(c: Canvas, l: LineBox, lay: Layout) {
        val p = env.palette
        val cy = l.top + l.rowHeight / 2f
        when (l.marker) {
            MarkerKind.Bullet -> {
                val cx = l.markerX + 13.1f * d
                val y = cy + 0.5f * d
                val r = 2.75f * d
                when (l.markerDepth % 3) {
                    0 -> {
                        fill.style = Paint.Style.FILL
                        fill.color = px(p.text)
                        c.drawCircle(cx, y, r, fill)
                    }
                    1 -> {
                        stroke.strokeWidth = d
                        stroke.color = px(p.text)
                        c.drawCircle(cx, y, r - 0.5f * d, stroke)
                    }
                    else -> {
                        fill.style = Paint.Style.FILL
                        fill.color = px(p.text)
                        c.drawRect(cx - r + 0.25f * d, y - r + 0.25f * d, cx + r - 0.25f * d, y + r - 0.25f * d, fill)
                    }
                }
            }
            MarkerKind.Ordered -> {
                textPaint.reset()
                textPaint.isAntiAlias = true
                textPaint.textSize = env.body * d
                textPaint.color = px(p.text)
                textPaint.textAlign = Paint.Align.RIGHT
                c.drawText(l.markerText, l.markerX + 20.6f * d, l.top + lay.getLineBaseline(0), textPaint)
            }
            MarkerKind.Check -> {
                val left = l.markerX + 3.2f * d
                val top = l.top + (l.rowHeight - 15f * d) / 2f
                val rect = RectF(left + 0.5f * d, top + 0.5f * d, left + 14.5f * d, top + 14.5f * d)
                if (l.checked) {
                    fill.style = Paint.Style.FILL
                    fill.color = px(p.accent)
                    c.drawRoundRect(rect, 2.5f * d, 2.5f * d, fill)
                    stroke.strokeWidth = 1.6f * d
                    stroke.color = 0xFFFFFFFF.toInt()
                    stroke.strokeCap = Paint.Cap.ROUND
                    val path = Path()
                    path.moveTo(left + 4f * d, top + 7.8f * d)
                    path.lineTo(left + 6.5f * d, top + 10.3f * d)
                    path.lineTo(left + 11f * d, top + 4.8f * d)
                    c.drawPath(path, stroke)
                    stroke.strokeCap = Paint.Cap.BUTT
                } else {
                    fill.style = Paint.Style.FILL
                    fill.color = px(p.bg)
                    c.drawRoundRect(rect, 2.5f * d, 2.5f * d, fill)
                    stroke.strokeWidth = d
                    stroke.color = px(p.textMuted)
                    c.drawRoundRect(rect, 2.5f * d, 2.5f * d, stroke)
                }
            }
            MarkerKind.None -> {}
        }
    }

    // Selection handles: a drop under each end of a range ---------------------------------------------------------------

    private val handleR get() = 8f * d

    private fun handleCenter(g: BoxGeometry, offset: Int): Pair<Float, Float> {
        val r = g.caretRect(offset)
        return r.left to (r.bottom + handleR)
    }

    private fun drawHandles(c: Canvas, g: BoxGeometry, a: Int, z: Int) {
        fill.style = Paint.Style.FILL
        fill.color = px(env.palette.accentSolid)
        for (o in intArrayOf(a, z)) {
            val (x, y) = handleCenter(g, o)
            c.drawCircle(x, y, handleR, fill)
            val stem = Path()
            stem.moveTo(x - 1.5f * d, y - handleR + d)
            stem.lineTo(x + 1.5f * d, y - handleR + d)
            stem.lineTo(x, y - handleR - 5f * d)
            stem.close()
            c.drawPath(stem, fill)
        }
    }

    private fun handleAt(x: Float, y: Float): Int {
        val r = input.render.view.selection
        val a = min(r.anchor.toInt(), r.head.toInt())
        val z = max(r.anchor.toInt(), r.head.toInt())
        if (a == z) return 0
        val g = geo()
        val reach = 26f * d
        val (sx, sy) = handleCenter(g, a)
        val (ex, ey) = handleCenter(g, z)
        val ds = hypot(x - padX - sx, y - padY - sy)
        val de = hypot(x - padX - ex, y - padY - ey)
        return when {
            ds < reach && ds <= de -> 1
            de < reach -> 2
            else -> 0
        }
    }

    // Touch -------------------------------------------------------------------------------------------------------------

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val h = if (isFocused || lookFocused) handleAt(event.x, event.y) else 0
                if (h != 0) {
                    dragging = h
                    val s = input.render.view.selection
                    dragFixed = if (h == 1) max(s.anchor.toInt(), s.head.toInt()) else min(s.anchor.toInt(), s.head.toInt())
                    parent?.requestDisallowInterceptTouchEvent(true)
                    return true
                }
            }
            MotionEvent.ACTION_MOVE -> if (dragging != 0) {
                val g = geo()
                // The finger holds the drop, which hangs below the line: aim at the line above the finger.
                val o = g.offsetAt(event.x - padX, event.y - padY - handleR - 4f * d)
                input.setSelection(dragFixed, o)
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (dragging != 0) {
                dragging = 0
                showActionMode()
                return true
            }
        }
        return gestures.onTouchEvent(event)
    }

    /** A tap: focus, put the caret there (an object line's tap selects the node), show the keyboard. */
    fun tapAt(x: Float, y: Float) {
        stopActionMode()
        if (!isFocused) requestFocus()
        placeCaretAt(x, y)
        showKeyboard()
    }

    /** Put the caret at a point of this view (px). */
    fun placeCaretAt(x: Float, y: Float) {
        val g = geo()
        val o = g.offsetAt(x - padX, y - padY)
        val line = g.lineAt(o)
        if (line != null && line.layout == null && line.end > line.start) {
            input.setSelection(line.start, line.end)
        } else {
            input.setSelection(o, o)
        }
    }

    private fun selectWordAt(x: Float, y: Float) {
        if (!isFocused) requestFocus()
        val g = geo()
        val t = input.text
        val o = g.offsetAt(x - padX, y - padY)
        val line = g.lineAt(o)
        if (line != null && line.layout == null) {
            input.setSelection(line.start, line.end)
            showKeyboard()
            return
        }
        if (t.isEmpty()) return
        val bi = BreakIterator.getWordInstance()
        bi.setText(t)
        val probe = min(o, t.length - 1)
        var end = bi.following(probe)
        if (end == BreakIterator.DONE) end = t.length
        var start = bi.preceding(end)
        if (start == BreakIterator.DONE) start = 0
        input.setSelection(start, end)
        showKeyboard()
        showActionMode()
    }

    fun showKeyboard() {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
        imm.showSoftInput(this, 0)
    }

    // Floating Cut / Copy / Paste / Select all ----------------------------------------------------------------------------

    private fun showActionMode() {
        if (actionMode != null) {
            actionMode?.invalidateContentRect()
            return
        }
        actionMode = startActionMode(
            object : ActionMode.Callback2() {
                override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                    menu.add(0, android.R.id.cut, 0, android.R.string.cut)
                    menu.add(0, android.R.id.copy, 1, android.R.string.copy)
                    menu.add(0, android.R.id.paste, 2, android.R.string.paste)
                    menu.add(0, android.R.id.selectAll, 3, android.R.string.selectAll)
                    return true
                }

                override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
                    val has = input.selStart != input.selEnd
                    menu.findItem(android.R.id.cut)?.isVisible = has
                    menu.findItem(android.R.id.copy)?.isVisible = has
                    return true
                }

                override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
                    val done = contextAction(item.itemId)
                    if (item.itemId != android.R.id.selectAll) mode.finish()
                    return done
                }

                override fun onDestroyActionMode(mode: ActionMode) {
                    actionMode = null
                }

                override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
                    val g = geo()
                    val a = g.caretRect(input.selStart)
                    val z = g.caretRect(input.selEnd)
                    outRect.set(
                        (min(a.left, z.left) + padX).toInt(), (a.top + padY).toInt(),
                        (max(a.left, z.left) + padX).toInt() + 1, (z.bottom + padY).toInt(),
                    )
                }
            },
            ActionMode.TYPE_FLOATING,
        )
    }

    private fun stopActionMode() {
        actionMode?.finish()
        actionMode = null
    }

    // Clipboard and context menu actions --------------------------------------------------------------------------------------

    private fun clipboard(): ClipboardManager? = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager

    fun doCopy(): Boolean {
        val data = input.engine.copy()
        if (data.text.isEmpty() && data.html.isEmpty()) return false
        clipboard()?.setPrimaryClip(ClipData.newHtmlText("Notivelo", data.text, data.html))
        return true
    }

    fun doCut(): Boolean {
        val data = input.engine.cut()
        input.refresh(false)
        if (data.text.isEmpty() && data.html.isEmpty()) return false
        clipboard()?.setPrimaryClip(ClipData.newHtmlText("Notivelo", data.text, data.html))
        return true
    }

    fun doPaste(plain: Boolean = false): Boolean {
        val clip = clipboard()?.primaryClip ?: return false
        if (clip.itemCount == 0) return false
        val item = clip.getItemAt(0)
        val text = item.coerceToText(context)?.toString().orEmpty()
        val html = if (plain) "" else item.htmlText.orEmpty()
        if (text.isEmpty() && html.isEmpty()) return false
        if (input.composing) input.engine.finishComposition()
        val done = input.engine.paste(html, text)
        input.refresh(false)
        return done
    }

    /** `performContextMenuAction` and the floating menu: the engine's cut, copy, paste, select all, undo, redo. */
    fun contextAction(id: Int): Boolean = when (id) {
        android.R.id.selectAll -> input.sendChord("Mod+a").also { actionMode?.invalidateContentRect() } || true
        android.R.id.cut -> doCut()
        android.R.id.copy -> doCopy()
        android.R.id.paste -> doPaste()
        android.R.id.pasteAsPlainText -> doPaste(plain = true)
        android.R.id.undo -> input.engine.undo().also { input.refresh(false) }
        android.R.id.redo -> input.engine.redo().also { input.refresh(false) }
        else -> false
    }

    // Keys ------------------------------------------------------------------------------------------------------------------

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = handleKey(event) || super.onKeyDown(keyCode, event)

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean = super.onKeyUp(keyCode, event)

    /** A key down from the keyboard (hardware, or the IME's `sendKeyEvent`): clipboard chords, menu keys, caret keys, the engine's chords. */
    fun handleKey(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return false
        val code = event.keyCode
        val ctrl = event.isCtrlPressed || event.isMetaPressed
        if (ctrl && !event.isAltPressed) {
            when (code) {
                KeyEvent.KEYCODE_C -> return doCopy()
                KeyEvent.KEYCODE_X -> return doCut()
                KeyEvent.KEYCODE_V -> return doPaste(plain = event.isShiftPressed)
            }
        }
        if (menuShown != null && !ctrl && !event.isAltPressed && !event.isShiftPressed) {
            if (menuKeyDown(code)) return true
        }
        val chord = BoxInput.chordFor(code, event.metaState)
        val arrow = code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT || code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN
        if (arrow && !event.isAltPressed) return moveCaret(code, event)
        if (code == KeyEvent.KEYCODE_MOVE_HOME || code == KeyEvent.KEYCODE_MOVE_END) return moveCaret(code, event)
        if (chord != null) {
            val done = input.sendChord(chord)
            // Tab with nothing for the engine to do moves focus (to the next box) as usual.
            return done || chord != "Tab" && chord != "Shift+Tab"
        }
        // Printable keys with no IME attached (some emulators and test rigs): type them.
        val u = event.unicodeChar
        if (u != 0 && !ctrl && !event.isAltPressed && event.isPrintingKey) {
            input.commitText(String(Character.toChars(u)), 1)
            return true
        }
        return false
    }

    /** Arrow, Home and End keys: the caret moves by the layout (Shift extends, Ctrl goes by word). */
    private fun moveCaret(code: Int, event: KeyEvent): Boolean {
        val g = geo()
        val t = input.text
        val sel = input.render.view.selection
        val head = sel.head.toInt()
        val anchor = sel.anchor.toInt()
        val shift = event.isShiftPressed
        val word = event.isCtrlPressed
        val collapsed = anchor == head
        val lo = min(anchor, head)
        val hi = max(anchor, head)
        val target = when (code) {
            KeyEvent.KEYCODE_DPAD_LEFT -> when {
                !shift && !collapsed -> lo
                word -> wordBoundary(t, head, false)
                else -> prevChar(t, head)
            }
            KeyEvent.KEYCODE_DPAD_RIGHT -> when {
                !shift && !collapsed -> hi
                word -> wordBoundary(t, head, true)
                else -> nextChar(t, head)
            }
            KeyEvent.KEYCODE_DPAD_UP -> g.moveVertical(head, false)
            KeyEvent.KEYCODE_DPAD_DOWN -> g.moveVertical(head, true)
            KeyEvent.KEYCODE_MOVE_HOME -> g.lineAt(head)?.start ?: 0
            else -> g.lineAt(head)?.end ?: t.length
        }
        if (shift) input.setSelection(anchor, target) else input.setSelection(target, target)
        return true
    }

    private fun prevChar(t: String, o: Int): Int {
        if (o <= 0) return 0
        var i = o - 1
        if (i > 0 && Character.isLowSurrogate(t[i]) && Character.isHighSurrogate(t[i - 1])) i--
        return i
    }

    private fun nextChar(t: String, o: Int): Int {
        if (o >= t.length) return t.length
        var i = o + 1
        if (i < t.length && Character.isHighSurrogate(t[i - 1]) && Character.isLowSurrogate(t[i])) i++
        return i
    }

    private fun wordBoundary(t: String, o: Int, forward: Boolean): Int {
        if (t.isEmpty()) return 0
        val bi = BreakIterator.getWordInstance()
        bi.setText(t)
        var r = if (forward) bi.following(min(o, t.length)) else bi.preceding(max(o, 0))
        if (r == BreakIterator.DONE) r = if (forward) t.length else 0
        return r
    }

    // The input method -----------------------------------------------------------------------------------------------------------

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_ENTER_ACTION or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        outAttrs.initialSelStart = input.selStart
        outAttrs.initialSelEnd = input.selEnd
        outAttrs.initialCapsMode = capsMode(outAttrs.inputType)
        val c = BoxInputConnection(this)
        connection = c
        return c
    }

    internal fun capsMode(reqModes: Int): Int = TextUtils.getCapsMode(input.textBefore(64), input.textBefore(64).length, reqModes)

    internal fun inputState() = input

    /** The IME's `getExtractedText`. */
    internal fun extracted(request: ExtractedTextRequest?, flags: Int): ExtractedText {
        if (flags and InputConnection.GET_EXTRACTED_TEXT_MONITOR != 0) extractedRequest = request
        return ExtractedText().apply {
            text = input.text
            startOffset = 0
            partialStartOffset = -1
            partialEndOffset = -1
            selectionStart = input.selStart
            selectionEnd = input.selEnd
            this.flags = 0
        }
    }

    internal fun setCursorUpdates(mode: Int): Boolean {
        cursorUpdates = mode
        if (mode and InputConnection.CURSOR_UPDATE_IMMEDIATE != 0) sendCursorAnchor()
        return true
    }

    private fun sendCursorAnchor() {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
        val g = geo()
        val caret = g.caretRect(input.selEnd)
        val b = CursorAnchorInfo.Builder()
        b.setSelectionRange(input.selStart, input.selEnd)
        val m = input.render.view.marked
        if (m != null) b.setComposingText(m.from.toInt(), input.text.substring(m.from.toInt(), m.to.toInt()))
        b.setInsertionMarkerLocation(caret.left + padX, caret.top + padY, caret.bottom + padY - 4f * d, caret.bottom + padY, CursorAnchorInfo.FLAG_HAS_VISIBLE_REGION)
        val loc = IntArray(2)
        getLocationOnScreen(loc)
        val matrix = android.graphics.Matrix()
        matrix.setTranslate(loc[0].toFloat(), loc[1].toFloat())
        b.setMatrix(matrix)
        imm.updateCursorAnchorInfo(this, b.build())
    }

    /** `updateSelection` follows every change, the IME's own included; `restartInput` when text under a composition was swapped. */
    internal fun syncIme() {
        if (input.inBatch) return
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
        if (!imm.isActive(this)) return
        imm.updateSelection(this, input.selStart, input.selEnd, input.composingStart.takeIf { input.composing } ?: -1, input.composingEnd.takeIf { input.composing } ?: -1)
        if (extractedRequest != null) imm.updateExtractedText(this, extractedRequest!!.token, extracted(extractedRequest, 0))
        if (cursorUpdates and InputConnection.CURSOR_UPDATE_MONITOR != 0) sendCursorAnchor()
    }

    private fun changed(prev: ViewRender, next: ViewRender, fromIme: Boolean) {
        val relayout = next.textRevision != prev.textRevision
        if (relayout) {
            val old = geometry?.height
            geometry = null
            val g = geo()
            if (old == null || old != g.height) requestLayout()
        }
        caretOn = true
        if (isFocused) {
            removeCallbacks(blink)
            postDelayed(blink, 530)
        }
        invalidate()
        if (!fromIme && prev.view.marked != null && next.view.marked == null) {
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.restartInput(this)
        } else {
            syncIme()
        }
        updateMenu()
        actionMode?.let { m ->
            if (next.view.selection.anchor == next.view.selection.head) stopActionMode() else m.invalidateContentRect()
        }
        if (isFocused) {
            val c = geo().caretRect(next.view.selection.head.toInt())
            requestRectangleOnScreen(Rect(c.left.roundToInt(), (c.top - 8 * d).roundToInt(), c.left.roundToInt() + 2, (c.bottom + padY + 12 * d).roundToInt()), false)
        }
    }

    // Menus -------------------------------------------------------------------------------------------------------------------------

    /** Whether a `[[` or `@` menu with rows is open (their highlight and Enter / Tab are this view's). */
    internal fun ownMenuOpen(): Boolean {
        val m = menuShown ?: return false
        return m.kind != SuggestionTrigger.SLASH && m.rows.isNotEmpty()
    }

    internal fun pickOwnHighlight(): Boolean {
        val m = menuShown ?: return false
        val h = m.highlighted ?: return false
        pickRow(h)
        return true
    }

    private fun menuKeyDown(code: Int): Boolean {
        val m = menuShown ?: return false
        val up = code == KeyEvent.KEYCODE_DPAD_UP
        val down = code == KeyEvent.KEYCODE_DPAD_DOWN
        if (m.kind == SuggestionTrigger.SLASH) {
            // The engine owns the slash menu's highlight and takes Enter, Tab and Escape itself.
            return when {
                up -> input.sendChord("ArrowUp")
                down -> input.sendChord("ArrowDown")
                code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER -> input.sendChord("Enter")
                code == KeyEvent.KEYCODE_TAB -> input.sendChord("Tab")
                code == KeyEvent.KEYCODE_ESCAPE -> input.sendChord("Escape")
                else -> false
            }
        }
        if (m.rows.isEmpty()) return code == KeyEvent.KEYCODE_ESCAPE && dismissMenu()
        return when {
            up || down -> {
                menuHighlight = (menuHighlight + (if (down) 1 else m.rows.size - 1)) % m.rows.size
                updateMenu(force = true)
                true
            }
            code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER || code == KeyEvent.KEYCODE_TAB -> {
                pickRow(menuHighlight)
                true
            }
            code == KeyEvent.KEYCODE_ESCAPE -> dismissMenu()
            else -> false
        }
    }

    private fun dismissMenu(): Boolean {
        val done = input.engine.dismissSuggestion()
        input.refresh(false)
        return done
    }

    /** Run row [i] of the open menu (a tap, Enter, Tab). */
    fun pickRow(i: Int) {
        val m = menuShown ?: return
        val row = m.rows.getOrNull(i) ?: return
        val (name, args) = Suggestions.pickCommand(m.kind, row)
        if (input.composing) input.engine.finishComposition()
        input.engine.command(name, args)
        input.refresh(false)
    }

    /** Read the engine's open suggestion and hand the popup its model (or null when none). */
    fun updateMenu(force: Boolean = false) {
        val s = input.render.suggestion
        if (s == null || !(isFocused || lookFocused)) {
            if (menuShown != null || force) {
                menuShown = null
                lastMenuSig = ""
                onMenu?.invoke(null)
            }
            return
        }
        val key = "${s.trigger}|${s.query}"
        if (key != menuKey) {
            menuKey = key
            menuHighlight = 0
        }
        val g = geo()
        val caret = g.caretRect(min(s.viewFrom.toInt(), input.text.length))
        val loc = IntArray(2)
        val frame = Rect()
        getLocationOnScreen(loc)
        getWindowVisibleDisplayFrame(frame)
        val top = caret.top + padY
        val bottom = caret.bottom + padY
        // The look scenes have no window: room below.
        val above = if (lookFocused) 0f else (loc[1] + top) - frame.top
        val below = if (lookFocused) 100000f else frame.bottom - (loc[1] + bottom)
        val model = Suggestions.model(s, pages, people, menuHighlight, caret.left + padX, top, bottom, above, below)
        if (model == null) {
            if (menuShown != null) {
                menuShown = null
                lastMenuSig = ""
                onMenu?.invoke(null)
            }
            return
        }
        val sig = key + "|" + model.highlighted + "|" + model.rows.joinToString(",") { it.id } + "|" + model.caretX.roundToInt() + "," + model.caretBottom.roundToInt()
        if (!force && sig == lastMenuSig) return
        lastMenuSig = sig
        menuShown = model
        onMenu?.invoke(model)
    }

    // Lifecycle --------------------------------------------------------------------------------------------------------------------------

    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        removeCallbacks(blink)
        if (gainFocus) {
            caretOn = true
            postDelayed(blink, 530)
            input.refresh(false)
        } else {
            // Losing focus ends an open composition (EDITOR.md 10.2).
            if (input.composing) input.finishComposingText()
            stopActionMode()
            updateMenu(force = true)
        }
        invalidate()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // The drops hang under the last line, past the box: do not clip them to the box's parents.
        var p = parent
        var n = 0
        while (p is ViewGroup && n < 3) {
            p.clipChildren = false
            p = p.parent
            n++
        }
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(blink)
        stopActionMode()
        super.onDetachedFromWindow()
    }
}
