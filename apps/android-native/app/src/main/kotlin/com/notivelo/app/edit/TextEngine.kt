package com.notivelo.app.edit

import com.notivelo.core.ClipboardData
import com.notivelo.core.EditorSession
import com.notivelo.core.ViewRender

/**
 * The part of the core's `EditorSession` a box's text view uses (EDITOR.md 10.2), in Int offsets of the view's text
 * (UTF-16 units). [CoreTextEngine] is the real one; the tests and the look scenes bring their own. Calls are local
 * (a mutex in the core) and cheap: they run on the UI thread.
 */
interface TextEngine {
    /** One frame: text, line table, selection, marked text, the open menu, undo state (`view_render`). */
    fun render(): ViewRender
    fun insertText(text: String)
    fun key(chord: String): Boolean
    fun command(name: String, argsJson: String): Boolean
    fun paste(html: String, text: String): Boolean
    fun copy(): ClipboardData
    fun cut(): ClipboardData
    fun undo(): Boolean
    fun redo(): Boolean
    fun setSelection(anchor: Int, head: Int)
    fun setComposition(text: String, selStart: Int, selEnd: Int)
    fun commitComposition(text: String)
    fun finishComposition()
    fun cancelComposition()
    fun replaceRange(from: Int, to: Int, text: String): Boolean
    fun moveHighlight(delta: Int): Boolean
    fun pickSuggestion(): Boolean
    fun dismissSuggestion(): Boolean
    fun close() {}
}

/** [TextEngine] over a core session (`EditorSession.openLive` on a box of the open page). */
class CoreTextEngine(private val session: EditorSession) : TextEngine {
    override fun render(): ViewRender = session.viewRender()
    override fun insertText(text: String) = session.insertText(text)
    override fun key(chord: String): Boolean = session.key(chord)
    override fun command(name: String, argsJson: String): Boolean = try {
        session.command(name, argsJson)
    } catch (e: Exception) {
        false
    }

    override fun paste(html: String, text: String): Boolean = session.paste(html, text)
    override fun copy(): ClipboardData = session.copy()
    override fun cut(): ClipboardData = session.cut()
    override fun undo(): Boolean = session.undo()
    override fun redo(): Boolean = session.redo()
    override fun setSelection(anchor: Int, head: Int) = session.setViewSelection(anchor.toUInt(), head.toUInt())
    override fun setComposition(text: String, selStart: Int, selEnd: Int) =
        session.setComposition(text, selStart.toUInt(), selEnd.toUInt())

    override fun commitComposition(text: String) = session.commitComposition(text)
    override fun finishComposition() = session.finishComposition()
    override fun cancelComposition() = session.cancelComposition()
    override fun replaceRange(from: Int, to: Int, text: String): Boolean = session.replaceViewRange(from.toUInt(), to.toUInt(), text)
    override fun moveHighlight(delta: Int): Boolean = session.moveSuggestionHighlight(delta)
    override fun pickSuggestion(): Boolean = session.pickSuggestion()
    override fun dismissSuggestion(): Boolean = session.dismissSuggestion()
    override fun close() {
        session.close()
    }
}

/** The box being edited: its id, the engine, and where the first tap landed (box-relative px) to put the caret there. */
class EditingBox(val boxId: String, val engine: TextEngine, val tapX: Float = -1f, val tapY: Float = -1f)
