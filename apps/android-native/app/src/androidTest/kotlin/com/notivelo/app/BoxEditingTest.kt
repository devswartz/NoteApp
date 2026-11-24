package com.notivelo.app

import android.view.KeyEvent
import android.view.inputmethod.InputConnection
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The offline page's box text view against the real core engine, through the app's UI. */
class BoxEditingTest : OfflineTestBase() {

    // Key events (a hardware keyboard) --------------------------------------------------------------------------------

    @Test
    fun keyEventsTypeEnterAndBackspace() {
        startEditing()
        typeKeys("Hello")
        waitForText("Hello")
        key(KeyEvent.KEYCODE_ENTER)
        waitForText("Hello\n")
        typeKeys("World")
        waitForText("Hello\nWorld")
        key(KeyEvent.KEYCODE_DEL)
        waitForText("Hello\nWorl")
        repeat(4) { key(KeyEvent.KEYCODE_DEL) }
        waitForText("Hello\n")
        // At the start of a line, Backspace joins it to the one above.
        key(KeyEvent.KEYCODE_DEL)
        waitForText("Hello")
        // The view shows what the engine holds.
        assertEquals("Hello", view().input.text)
    }

    // The input connection, as a keyboard drives it ------------------------------------------------------------------------

    @Test
    fun inputConnectionCommitComposeAndDelete() {
        startEditing()
        ime { ic, info ->
            assertTrue("a text editor", info.inputType != 0)
            ic.beginBatchEdit()
            ic.commitText("Hello ", 1)
            ic.endBatchEdit()
            ic.setComposingText("wor", 1)
        }
        waitForText("Hello wor")
        assertNotNull("composition is open in the engine", frame().view.marked)
        ime { ic, _ -> ic.setComposingText("world", 1) }
        waitForText("Hello world")
        ime { ic, _ -> ic.finishComposingText() }
        waitFor("composition closed") { frame().view.marked == null }
        assertEquals("world", imeRead { it.getTextBeforeCursor(5, 0).toString() })
        assertNull(imeRead { it.getSelectedText(0) })

        // Composition replaced by a commit (autocorrect).
        ime { ic, _ -> ic.commitText(" teh", 1) }
        ime { ic, _ -> ic.setComposingRegion(frame().view.text.length - 3, frame().view.text.length) }
        ime { ic, _ -> ic.commitText("the", 1) }
        waitForText("Hello world the")

        // Enter and Backspace as an IME sends them.
        ime { ic, _ -> ic.commitText("\n", 1) }
        waitForText("Hello world the\n")
        ime { ic, _ -> ic.commitText("x", 1) }
        ime { ic, _ -> ic.deleteSurroundingText(1, 0) }
        waitForText("Hello world the\n")
        ime { ic, _ -> ic.deleteSurroundingText(1, 0) }
        waitForText("Hello world the")
        ime { ic, _ ->
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL))
        }
        waitForText("Hello world th")
    }

    @Test
    fun inputConnectionSelection() {
        startEditing()
        ime { ic, _ -> ic.commitText("alpha beta gamma", 1) }
        waitForText("alpha beta gamma")
        ime { ic, _ -> ic.setSelection(6, 10) }
        waitFor("selection 6..10") { selection() == 6 to 10 }
        assertEquals("beta", imeRead { it.getSelectedText(0).toString() })
        // Typing over a selection replaces it.
        ime { ic, _ -> ic.commitText("BETA", 1) }
        waitForText("alpha BETA gamma")
        assertEquals(10 to 10, selection())
        assertEquals(" gamma", imeRead { it.getTextAfterCursor(6, 0).toString() })
    }

    // The / menu -------------------------------------------------------------------------------------------------------------

    @Test
    fun slashMenuPicksHeadingByTap() {
        startEditing()
        typeKeys("/")
        waitFor("the slash menu in the engine") { frame().suggestion?.items?.any { it.id == "Heading 1" } == true }
        // The popup shows the row; tap it.
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Heading 1").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Heading 1").performClick()
        waitFor("a heading block") { frame().active.block == "heading" }
        assertEquals(1, frame().active.headingLevel.toInt())
        assertEquals("the slash is gone", "", text().trimEnd('
'))
        assertNull("the menu closed", frame().suggestion)
        typeKeys("Title")
        waitFor("Title typed") { text().trimEnd('
') == "Title" }
        assertEquals("heading", frame().active.block)
    }

    @Test
    fun slashMenuFilterAndEnterPick() {
        startEditing()
        typeKeys("/bullet")
        waitFor("the menu filtered") { frame().suggestion?.items?.firstOrNull()?.id?.contains("Bullet", ignoreCase = true) == true }
        key(KeyEvent.KEYCODE_ENTER)
        waitFor("a bullet list") { frame().active.list == "bulletList" }
        assertEquals("", text())
        typeKeys("one")
        key(KeyEvent.KEYCODE_ENTER)
        typeKeys("two")
        waitForText("one\ntwo")
        assertEquals("bulletList", frame().active.list)
    }

    @Test
    fun slashMenuEscapeAndKeyboardNavigation() {
        startEditing()
        typeKeys("/")
        waitFor("the slash menu") { frame().suggestion != null }
        val first = frame().suggestion!!.highlighted
        key(KeyEvent.KEYCODE_DPAD_DOWN)
        waitFor("highlight moved") { frame().suggestion?.highlighted != first }
        key(KeyEvent.KEYCODE_ESCAPE)
        waitFor("menu dismissed") { frame().suggestion == null }
        assertEquals("/", text())
    }

    @Test
    fun markdownShortcutThroughTheEngine() {
        startEditing()
        typeKeys("- item")
        waitFor("a bullet list from '- '") { frame().active.list == "bulletList" }
        assertEquals("item", text())
    }

    // Selection ----------------------------------------------------------------------------------------------------------------

    @Test
    fun selectAllAndArrowKeys() {
        startEditing()
        typeKeys("one two")
        waitForText("one two")
        ctrl(KeyEvent.KEYCODE_A)
        waitFor("everything selected") { selection().let { (a, h) -> minOf(a, h) == 0 && maxOf(a, h) == 7 } }
        key(KeyEvent.KEYCODE_DPAD_LEFT)
        waitFor("caret at the start") { selection() == 0 to 0 }
        key(KeyEvent.KEYCODE_DPAD_RIGHT)
        waitFor("caret one right") { selection() == 1 to 1 }
        key(KeyEvent.KEYCODE_DPAD_RIGHT, android.view.KeyEvent.META_SHIFT_ON)
        waitFor("shift extends") { selection() == 1 to 2 }
    }

    @Test
    fun longPressSelectsAWord() {
        startEditing()
        typeKeys("alpha beta")
        waitForText("alpha beta")
        val d = density()
        // Inside the first word: 11 dp of padding, then a few glyphs, a line in.
        touch(11f * d + 14f * d, 7f * d + 10f * d, 900)
        waitFor("the word is selected") { selection().let { (a, h) -> minOf(a, h) == 0 && maxOf(a, h) == 5 } }
    }

    @Test
    fun tapPutsTheCaretInTheText() {
        startEditing()
        typeKeys("alpha beta")
        waitForText("alpha beta")
        val d = density()
        // The left edge of the first line: offset 0.
        touch(11f * d + 1f, 7f * d + 10f * d, 40)
        waitFor("caret at the start") { selection() == 0 to 0 }
        // Far right of the line: the end.
        touch(view().width - 12f * d, 7f * d + 10f * d, 40)
        waitFor("caret at the end") { selection() == 10 to 10 }
    }

    // Clipboard ----------------------------------------------------------------------------------------------------------------

    @Test
    fun copyPasteDuplicatesAndCutRemoves() {
        startEditing()
        typeKeys("copy me")
        waitForText("copy me")
        ctrl(KeyEvent.KEYCODE_A)
        waitFor("selected") { selection().let { (a, h) -> minOf(a, h) == 0 && maxOf(a, h) == 7 } }
        ctrl(KeyEvent.KEYCODE_C)
        waitFor("clipboard has the text") { clipboardText() == "copy me" }
        assertEquals("copy leaves the text", "copy me", text())

        key(KeyEvent.KEYCODE_DPAD_RIGHT)
        waitFor("caret at the end") { selection() == 7 to 7 }
        ctrl(KeyEvent.KEYCODE_V)
        waitForText("copy mecopy me")

        ctrl(KeyEvent.KEYCODE_A)
        ctrl(KeyEvent.KEYCODE_X)
        waitForText("")
        assertEquals("copy mecopy me", clipboardText())
        ctrl(KeyEvent.KEYCODE_V)
        waitForText("copy mecopy me")
    }

    @Test
    fun clipboardThroughTheContextMenuActions() {
        startEditing()
        ime { ic, _ -> ic.commitText("menu text", 1) }
        waitForText("menu text")
        ime { ic, _ -> ic.performContextMenuAction(android.R.id.selectAll) }
        waitFor("selected") { selection().let { (a, h) -> minOf(a, h) == 0 && maxOf(a, h) == 9 } }
        ime { ic, _ -> ic.performContextMenuAction(android.R.id.cut) }
        waitForText("")
        assertEquals("menu text", clipboardText())
        ime { ic, _ -> ic.performContextMenuAction(android.R.id.paste) }
        waitForText("menu text")
        ime { ic, _ -> ic.performContextMenuAction(android.R.id.paste) }
        waitForText("menu textmenu text")
    }

    // Undo and redo --------------------------------------------------------------------------------------------------------------

    private fun waitForUndoEnabled(tag: String, enabled: Boolean) {
        compose.waitUntil(15_000) {
            val has = compose.onNodeWithTag(tag).fetchSemanticsNode().config.contains(SemanticsActions.OnClick)
            has == enabled
        }
    }

    @Test
    fun undoAndRedoByTheBarButtons() {
        startEditing()
        typeKeys("undo me")
        waitForText("undo me")
        waitForUndoEnabled("page-undo", true)
        compose.onNodeWithTag("page-undo").performClick()
        waitForText("")
        // The view repaints from the engine too.
        waitFor("view in step with the engine") { view().input.text == "" }
        waitForUndoEnabled("page-redo", true)
        compose.onNodeWithTag("page-redo").performClick()
        waitForText("undo me")
        waitFor("view in step with the engine") { view().input.text == "undo me" }
    }

    @Test
    fun undoAndRedoByKeyboardShortcuts() {
        startEditing()
        typeKeys("first")
        waitForText("first")
        Thread.sleep(1200) // a later edit is its own undo step
        typeKeys(" second")
        waitForText("first second")
        ctrl(KeyEvent.KEYCODE_Z)
        waitForText("first")
        ctrl(KeyEvent.KEYCODE_Z)
        waitForText("")
        ctrl(KeyEvent.KEYCODE_Z, shift = true)
        waitForText("first")
        ctrl(KeyEvent.KEYCODE_Y)
        waitForText("first second")
    }

    @Test
    fun undoOfAStructuralChange() {
        startEditing()
        typeKeys("/")
        waitFor("menu") { frame().suggestion != null }
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Heading 1").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Heading 1").performClick()
        waitFor("heading") { frame().active.block == "heading" }
        typeKeys("T")
        waitFor("T typed") { text().contains("T") }
        ctrl(KeyEvent.KEYCODE_Z)
        waitFor("typed text undone") { !text().contains("T") }
    }

    // Switching boxes ------------------------------------------------------------------------------------------------------------

    @Test
    fun theSecondBoxIsAnotherSession() {
        startEditing()
        typeKeys("first box")
        waitForText("first box")
        // Leave this box (tap outside any box), then edit the other one.
        compose.onNodeWithTag("box-$SECOND").performClick()
        waitFor("the second box's text") { viewOrNull()?.input?.engine?.render()?.view?.text == "Second box" }
        typeKeys("!")
        waitForText("Second box!")
        assertFalse(text().contains("first"))
    }
}
