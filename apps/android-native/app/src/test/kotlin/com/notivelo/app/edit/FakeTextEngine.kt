package com.notivelo.app.edit

import com.notivelo.core.ClipboardData
import com.notivelo.core.ViewRender

/**
 * A text engine on a plain string with the core's rules the input mapping depends on: set_composition marks text in place of the
 * selection, set_view_selection ends a composition, replace_range keeps the selection mapped, Backspace removes one unit. Every call
 * is written to [calls] so the tests can see what the input method's calls became.
 */
class FakeTextEngine(text: String = "", anchor: Int = text.length, head: Int = anchor) : TextEngine {
    var text: String = text
        private set
    var anchor = anchor
        private set
    var head = head
        private set
    private var markFrom = -1
    private var markTo = -1
    private var revision = 1L
    private var textRevision = 1L
    val calls = mutableListOf<String>()
    var refuseReplace = false
    var closed = false
    var suggestion: com.notivelo.core.EditorSuggestion? = null

    private val lo get() = minOf(anchor, head)
    private val hi get() = maxOf(anchor, head)

    private fun bump(textChanged: Boolean) {
        revision++
        if (textChanged) textRevision++
    }

    override fun render(): ViewRender = StaticRender.of(
        text.split("\n").map { LineSpec(it) }, anchor, head, revision, textRevision,
        marked = if (markFrom >= 0) markFrom until markTo else null, suggestion = suggestion,
    )

    private fun splice(from: Int, to: Int, s: String) {
        text = text.substring(0, from) + s + text.substring(to)
    }

    override fun insertText(text: String) {
        calls += "insert:$text"
        if (markFrom >= 0) {
            splice(markFrom, markTo, text)
            head = markFrom + text.length
            markFrom = -1
        } else {
            val l = lo
            splice(l, hi, text)
            head = l + text.length
        }
        anchor = head
        bump(true)
    }

    override fun key(chord: String): Boolean {
        calls += "key:$chord"
        when (chord) {
            "Backspace" -> if (lo != hi) {
                val l = lo
                splice(l, hi, "")
                head = l
                anchor = l
            } else if (head > 0) {
                splice(head - 1, head, "")
                head--
                anchor = head
            }
            "Enter" -> {
                val l = lo
                splice(l, hi, "\n")
                head = l + 1
                anchor = head
            }
        }
        bump(true)
        return true
    }

    override fun command(name: String, argsJson: String): Boolean {
        calls += "command:$name:$argsJson"
        return true
    }

    override fun paste(html: String, text: String): Boolean {
        calls += "paste:$html:$text"
        return true
    }

    override fun copy(): ClipboardData {
        calls += "copy"
        return ClipboardData("", text.substring(lo, hi))
    }

    override fun cut(): ClipboardData {
        calls += "cut"
        return ClipboardData("", text.substring(lo, hi))
    }

    override fun undo(): Boolean {
        calls += "undo"
        return true
    }

    override fun redo(): Boolean {
        calls += "redo"
        return true
    }

    override fun setSelection(anchor: Int, head: Int) {
        calls += "select:$anchor,$head"
        markFrom = -1
        this.anchor = anchor
        this.head = head
        bump(false)
    }

    override fun setComposition(text: String, selStart: Int, selEnd: Int) {
        calls += "compose:$text:$selStart:$selEnd"
        val from = if (markFrom >= 0) markFrom else lo
        val to = if (markFrom >= 0) markTo else hi
        splice(from, to, text)
        markFrom = from
        markTo = from + text.length
        anchor = from + selStart
        head = from + selEnd
        bump(true)
    }

    override fun commitComposition(text: String) {
        calls += "commit:$text"
        if (markFrom >= 0) {
            splice(markFrom, markTo, text)
            head = markFrom + text.length
            anchor = head
            markFrom = -1
        }
        bump(true)
    }

    override fun finishComposition() {
        calls += "finish"
        markFrom = -1
        bump(false)
    }

    override fun cancelComposition() {
        calls += "cancel"
        if (markFrom >= 0) {
            splice(markFrom, markTo, "")
            head = markFrom
            anchor = head
            markFrom = -1
        }
        bump(true)
    }

    override fun replaceRange(from: Int, to: Int, text: String): Boolean {
        calls += "replace:$from,$to,$text"
        if (refuseReplace || from < 0 || to > this.text.length || from > to) return false
        splice(from, to, text)
        fun map(o: Int) = if (o <= from) o else if (o >= to) o - (to - from) + text.length else from + text.length
        anchor = map(anchor)
        head = map(head)
        bump(true)
        return true
    }

    override fun moveHighlight(delta: Int): Boolean {
        calls += "highlight:$delta"
        return true
    }

    override fun pickSuggestion(): Boolean {
        calls += "pick"
        return true
    }

    override fun close() {
        closed = true
    }

    override fun dismissSuggestion(): Boolean {
        calls += "dismiss"
        return true
    }
}
