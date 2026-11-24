package com.notivelo.app.edit

import android.view.KeyEvent
import com.notivelo.core.ViewRender

/**
 * What Android's input method asks of a box's text, as engine calls (EDITOR.md 10.5). No Android classes beyond
 * `KeyEvent`'s constants: [BoxInputConnection] is the thin `InputConnection` over it, and the unit tests drive it
 * with a fake [TextEngine].
 *
 * The engine owns text, selection and composition; this keeps the last [render] (offsets are UTF-16 units of
 * `render.view.text`) and the composing *region* an IME sets with `setComposingRegion` (the engine has no
 * composition then: the region is what the next `setComposingText` or `commitText` replaces).
 */
class BoxInput(var engine: TextEngine) {
    var render: ViewRender = engine.render()
        private set

    /** After every change that moved `revision`: the frame before, the frame now, and whether the IME's own call made it. */
    var onChanged: (prev: ViewRender, next: ViewRender, fromIme: Boolean) -> Unit = { _, _, _ -> }

    private var regionFrom = -1
    private var regionTo = -1
    private var batch = 0

    val text: String get() = render.view.text
    val selStart: Int get() = minOf(render.view.selection.anchor.toInt(), render.view.selection.head.toInt())
    val selEnd: Int get() = maxOf(render.view.selection.anchor.toInt(), render.view.selection.head.toInt())
    val composing: Boolean get() = render.view.marked != null
    val composingStart: Int get() = render.view.marked?.from?.toInt() ?: regionFrom
    val composingEnd: Int get() = render.view.marked?.to?.toInt() ?: regionTo

    /** Reads the engine's frame; reports a change. True when something to draw moved. */
    fun refresh(fromIme: Boolean = false): Boolean {
        val next = engine.render()
        val prev = render
        if (next.revision == prev.revision) return false
        render = next
        if (regionFrom >= 0 && (regionTo > next.view.text.length || next.textRevision != prev.textRevision)) clearRegion()
        onChanged(prev, next, fromIme)
        return true
    }

    private fun clearRegion() {
        regionFrom = -1
        regionTo = -1
    }

    private fun region(): IntRange? = if (regionFrom in 0..regionTo && regionFrom < regionTo && regionTo <= text.length) regionFrom until regionTo else null

    private fun clamp(o: Int): Int = o.coerceIn(0, text.length)

    // Editing ----------------------------------------------------------------------------------------------------------

    fun commitText(t: CharSequence, newCursor: Int): Boolean {
        val s = t.toString()
        val wasComposing = composing
        val region = if (wasComposing) null else region()
        clearRegion()
        when {
            s == "\n" -> {
                if (wasComposing) engine.finishComposition()
                engine.key("Enter")
            }
            s == "\t" -> {
                if (wasComposing) engine.finishComposition()
                engine.key("Tab")
            }
            s.contains('\n') -> {
                if (wasComposing) engine.finishComposition()
                s.split('\n').forEachIndexed { i, part ->
                    if (i > 0) engine.key("Enter")
                    if (part.isNotEmpty()) engine.insertText(part)
                }
            }
            wasComposing -> engine.commitComposition(s)
            region != null -> replace(region.first, region.last + 1, s)
            s.isEmpty() -> if (selStart != selEnd) engine.key("Backspace")
            else -> engine.insertText(s)
        }
        refresh(true)
        // A newCursorPosition other than 1 moves the caret afterwards: > 0 counts from the end of the text, <= 0 from its start.
        if (newCursor != 1 && s.isNotEmpty() && !s.contains('\n')) {
            val end = selEnd
            val target = clamp(if (newCursor > 0) end + newCursor - 1 else end - s.length + newCursor)
            if (target != end) {
                engine.setSelection(target, target)
                refresh(true)
            }
        }
        return true
    }

    /** Replace `from until to` (the engine's `replace_range`); when refused, type over it instead. */
    private fun replace(from: Int, to: Int, s: String) {
        if (!engine.replaceRange(from, to, s)) {
            engine.setSelection(from, to)
            if (s.isEmpty()) engine.key("Backspace") else engine.insertText(s)
        }
    }

    fun setComposingText(t: CharSequence, newCursor: Int): Boolean {
        val s = t.toString()
        if (s.isEmpty()) {
            if (composing) {
                engine.cancelComposition()
            } else {
                region()?.let { replace(it.first, it.last + 1, "") }
            }
            clearRegion()
            refresh(true)
            return true
        }
        if (!composing) {
            region()?.let { engine.setSelection(it.first, it.last + 1) }
        }
        clearRegion()
        // The caret inside the marked text: newCursor > 0 counts from its end (1 = after it), <= 0 from its start.
        val rel = (if (newCursor > 0) s.length + newCursor - 1 else newCursor).coerceIn(0, s.length)
        engine.setComposition(s, rel, rel)
        refresh(true)
        return true
    }

    fun setComposingRegion(start: Int, end: Int): Boolean {
        val a = clamp(minOf(start, end))
        val b = clamp(maxOf(start, end))
        val m = render.view.marked
        if (m != null) {
            if (m.from.toInt() == a && m.to.toInt() == b) return true
            engine.finishComposition()
            refresh(true)
        }
        if (a == b) {
            clearRegion()
        } else {
            regionFrom = a
            regionTo = b
        }
        return true
    }

    fun finishComposingText(): Boolean {
        if (composing) {
            engine.finishComposition()
            refresh(true)
        }
        clearRegion()
        return true
    }

    /** `deleteSurroundingText`, counting UTF-16 units, or code points when [inCodePoints]. */
    fun deleteSurrounding(before: Int, after: Int, inCodePoints: Boolean = false): Boolean {
        if (composing) {
            engine.finishComposition()
            refresh(true)
        }
        clearRegion()
        val t = text
        var b = before.coerceAtLeast(0)
        var a = after.coerceAtLeast(0)
        val s0 = selStart
        val s1 = selEnd
        if (inCodePoints) {
            b = s0 - offsetByCodePoints(t, s0, -b)
            a = offsetByCodePoints(t, s1, a) - s1
        }
        if (b == 1 && a == 0 && s0 == s1 && s0 > 0 && !Character.isLowSurrogate(t[s0 - 1])) {
            engine.key("Backspace")
        } else {
            // After the selection first, then before it, so the offsets of the second hold.
            val afterEnd = minOf(s1 + a, t.length)
            if (afterEnd > s1) replace(s1, afterEnd, "")
            val beforeStart = maxOf(s0 - b, 0)
            if (s0 > beforeStart) replace(beforeStart, s0, "")
        }
        refresh(true)
        return true
    }

    private fun offsetByCodePoints(t: String, from: Int, count: Int): Int = try {
        t.offsetByCodePoints(from, count)
    } catch (e: IndexOutOfBoundsException) {
        if (count < 0) 0 else t.length
    }

    fun setSelection(start: Int, end: Int): Boolean {
        val a = clamp(start)
        val b = clamp(end)
        clearRegion()
        val m = render.view.marked
        if (m != null) {
            val from = m.from.toInt()
            val to = m.to.toInt()
            if (a in from..to && b in from..to) {
                // Inside the marked text: the engine keeps the composition and moves the selection in it.
                engine.setComposition(text.substring(from, to), a - from, b - from)
                refresh(true)
                return true
            }
        }
        engine.setSelection(a, b)
        refresh(true)
        return true
    }

    // Reading ------------------------------------------------------------------------------------------------------

    fun textBefore(n: Int): String = text.substring(maxOf(0, selStart - n.coerceAtLeast(0)), selStart)
    fun textAfter(n: Int): String = text.substring(selEnd, minOf(text.length, selEnd + n.coerceAtLeast(0)))
    fun selectedText(): String? = if (selStart == selEnd) null else text.substring(selStart, selEnd)

    fun beginBatch() {
        batch++
    }

    /** True while more batches are open (the view holds its `updateSelection` until the last one ends). */
    fun endBatch(): Boolean {
        if (batch > 0) batch--
        return batch > 0
    }

    val inBatch: Boolean get() = batch > 0

    // Keys ---------------------------------------------------------------------------------------------------------------

    /** A chord for the engine, ending an open composition first (the engine's keys act on the text as it stands). */
    fun sendChord(chord: String): Boolean {
        if (composing) engine.finishComposition()
        clearRegion()
        val done = engine.key(chord)
        refresh(false)
        return done
    }

    companion object {
        /**
         * The engine's chord for a hardware key, or null when it isn't one: text arrives through the IME, so a plain
         * letter or digit isn't (only with Ctrl/Meta or Alt). Arrows come back as `ArrowUp`..: the engine uses them
         * for an open slash menu and with Alt+Shift; the view moves the caret with them otherwise.
         */
        fun chordFor(keyCode: Int, meta: Int): String? {
            val mod = meta and (KeyEvent.META_CTRL_ON or KeyEvent.META_META_ON) != 0
            val alt = meta and KeyEvent.META_ALT_ON != 0
            val shift = meta and KeyEvent.META_SHIFT_ON != 0
            val key: String = when (keyCode) {
                KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
                KeyEvent.KEYCODE_DEL -> "Backspace"
                KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
                KeyEvent.KEYCODE_TAB -> "Tab"
                KeyEvent.KEYCODE_ESCAPE -> "Escape"
                KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
                KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
                KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
                KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
                KeyEvent.KEYCODE_PERIOD -> "."
                in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> ('a' + (keyCode - KeyEvent.KEYCODE_A)).toString()
                in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> ('0' + (keyCode - KeyEvent.KEYCODE_0)).toString()
                else -> return null
            }
            val named = key.length > 1
            if (!named && !mod && !alt) return null
            val parts = ArrayList<String>(4)
            if (mod) parts += "Mod"
            if (alt) parts += "Alt"
            if (shift) parts += "Shift"
            parts += key
            return parts.joinToString("+")
        }
    }
}
