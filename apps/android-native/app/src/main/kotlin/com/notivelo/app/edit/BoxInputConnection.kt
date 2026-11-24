package com.notivelo.app.edit

import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest

/**
 * The input method's door into a [BoxTextView] (EDITOR.md 10.5): no `Editable` mirror, every call goes to [BoxInput],
 * which turns it into engine calls. `updateSelection` follows from the view's change callback, held back inside a batch.
 */
class BoxInputConnection(private val view: BoxTextView) : BaseInputConnection(view, false) {
    private val input get() = view.inputState()

    override fun getTextBeforeCursor(n: Int, flags: Int): CharSequence = input.textBefore(n)
    override fun getTextAfterCursor(n: Int, flags: Int): CharSequence = input.textAfter(n)
    override fun getSelectedText(flags: Int): CharSequence? = input.selectedText()
    override fun getCursorCapsMode(reqModes: Int): Int = view.capsMode(reqModes)
    override fun getExtractedText(request: ExtractedTextRequest?, flags: Int): ExtractedText = view.extracted(request, flags)

    override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
        // Return or Tab on the software keyboard picks the row of an open `[[` or `@` menu.
        if ((text == "\n" || text == "\t") && !input.composing && view.ownMenuOpen() && view.pickOwnHighlight()) return true
        return input.commitText(text, newCursorPosition)
    }

    override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean = input.setComposingText(text, newCursorPosition)
    override fun setComposingRegion(start: Int, end: Int): Boolean = input.setComposingRegion(start, end)
    override fun finishComposingText(): Boolean = input.finishComposingText()
    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean = input.deleteSurrounding(beforeLength, afterLength)
    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
        input.deleteSurrounding(beforeLength, afterLength, inCodePoints = true)

    override fun setSelection(start: Int, end: Int): Boolean = input.setSelection(start, end)

    override fun beginBatchEdit(): Boolean {
        input.beginBatch()
        return true
    }

    override fun endBatchEdit(): Boolean {
        val more = input.endBatch()
        if (!more) view.syncIme()
        return more
    }

    override fun sendKeyEvent(event: KeyEvent?): Boolean {
        if (event != null && event.action == KeyEvent.ACTION_DOWN) view.handleKey(event)
        return true
    }

    override fun performEditorAction(editorAction: Int): Boolean {
        // IME_FLAG_NO_ENTER_ACTION keeps this for IMEs that send an action for their Enter key anyway.
        if (editorAction == EditorInfo.IME_ACTION_NONE || editorAction == EditorInfo.IME_ACTION_UNSPECIFIED) return false
        input.sendChord("Enter")
        return true
    }

    override fun performContextMenuAction(id: Int): Boolean = view.contextAction(id)
    override fun requestCursorUpdates(cursorUpdateMode: Int): Boolean = view.setCursorUpdates(cursorUpdateMode)
}
