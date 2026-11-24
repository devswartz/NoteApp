package com.notivelo.app.edit

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoxInputTest {
    private fun input(text: String = "", anchor: Int = text.length, head: Int = anchor): Pair<BoxInput, FakeTextEngine> {
        val e = FakeTextEngine(text, anchor, head)
        return BoxInput(e) to e
    }

    @Test
    fun compositionThenCommit() {
        val (i, e) = input("ab")
        i.setComposingText("c", 1)
        assertTrue(i.composing)
        assertEquals("abc", i.text)
        assertEquals(2, i.composingStart)
        assertEquals(3, i.composingEnd)
        i.setComposingText("cd", 1)
        i.commitText("cde", 1)
        assertFalse(i.composing)
        assertEquals("abcde", i.text)
        assertEquals(5, i.selStart)
        assertEquals(listOf("compose:c:1:1", "compose:cd:2:2", "commit:cde"), e.calls)
    }

    @Test
    fun finishComposingKeepsTheMarkedText() {
        val (i, e) = input("")
        i.setComposingText("hi", 1)
        i.finishComposingText()
        assertEquals("hi", i.text)
        assertFalse(i.composing)
        assertEquals("finish", e.calls.last())
    }

    @Test
    fun emptyComposingTextCancels() {
        val (i, e) = input("x")
        i.setComposingText("yz", 1)
        i.setComposingText("", 1)
        assertEquals("x", i.text)
        assertEquals("cancel", e.calls.last())
    }

    @Test
    fun newlineIsEnterAndTabIsTab() {
        val (i, e) = input("a")
        i.commitText("\n", 1)
        assertEquals("a\n", i.text)
        i.commitText("\t", 1)
        assertEquals(listOf("key:Enter", "key:Tab"), e.calls)
    }

    @Test
    fun textWithNewlinesSplitsIntoEnters() {
        val (i, e) = input("")
        i.commitText("a\nb", 1)
        assertEquals(listOf("insert:a", "key:Enter", "insert:b"), e.calls)
    }

    @Test
    fun deleteOneBeforeAnEmptySelectionIsBackspace() {
        val (i, e) = input("abc")
        i.deleteSurrounding(1, 0)
        assertEquals("ab", i.text)
        assertEquals(listOf("key:Backspace"), e.calls)
    }

    @Test
    fun deleteSurroundingCountsUtf16UnitsAndAnEmojiIsTwo() {
        val (i, e) = input("a😀b", 3) // a, a grinning face (two units), caret before b
        i.deleteSurrounding(2, 0)
        assertEquals("ab", i.text)
        assertEquals(listOf("replace:1,3,"), e.calls)
        assertEquals(1, i.selStart)
    }

    @Test
    fun deleteOneUnitAfterTheLowSurrogateStillTakesTheWholeEmoji() {
        val (i, e) = input("😀", 2)
        i.deleteSurrounding(1, 0)
        // Half a pair is never deleted with Backspace: the range goes through replace_range.
        assertEquals(listOf("replace:1,2,"), e.calls)
    }

    @Test
    fun deleteSurroundingInCodePoints() {
        val (i, e) = input("a😀b", 3)
        i.deleteSurrounding(1, 0, inCodePoints = true)
        assertEquals("ab", i.text)
        assertEquals(listOf("replace:1,3,"), e.calls)
    }

    @Test
    fun deleteAfterTheSelectionFirstThenBeforeIt() {
        val (i, e) = input("abcdef", 3)
        i.deleteSurrounding(2, 2)
        assertEquals("af", i.text)
        assertEquals(listOf("replace:3,5,", "replace:1,3,"), e.calls)
    }

    @Test
    fun deleteOverARangeWithTheSelectionNotEmpty() {
        val (i, e) = input("abcd", 1, 3)
        i.deleteSurrounding(1, 0)
        assertEquals(listOf("replace:0,1,"), e.calls)
        assertEquals("bcd", i.text)
    }

    @Test
    fun composingRegionIsHeldAndTheNextComposingTextReplacesIt() {
        val (i, e) = input("hello world")
        i.setComposingRegion(6, 11)
        assertTrue(e.calls.isEmpty())
        assertEquals(6, i.composingStart)
        i.setComposingText("there", 1)
        assertEquals("hello there", i.text)
        assertEquals(listOf("select:6,11", "compose:there:5:5"), e.calls)
    }

    @Test
    fun commitOverAComposingRegionIsReplaceRange() {
        val (i, e) = input("teh cat")
        i.setComposingRegion(0, 3)
        i.commitText("the", 1)
        assertEquals("the cat", i.text)
        assertEquals(listOf("replace:0,3,the"), e.calls)
    }

    @Test
    fun aRefusedReplaceTypesOverTheRange() {
        val (i, e) = input("abc")
        e.refuseReplace = true
        i.setComposingRegion(0, 2)
        i.commitText("x", 1)
        assertEquals("xc", i.text)
        assertEquals(listOf("replace:0,2,x", "select:0,2", "insert:x"), e.calls)
    }

    @Test
    fun finishComposingForgetsTheRegion() {
        val (i, e) = input("abc")
        i.setComposingRegion(0, 3)
        i.finishComposingText()
        i.commitText("z", 1)
        assertEquals("abcz", i.text)
        assertEquals(listOf("insert:z"), e.calls)
    }

    @Test
    fun newCursorPositionMovesTheCaretAfterTheCommit() {
        val (i, e) = input("")
        i.commitText("abc", 0) // before the text
        assertEquals(0, i.selStart)
        assertEquals("select:0,0", e.calls.last())
        val (j, _) = input("")
        j.commitText("abc", 2) // one past the end
        assertEquals(3, j.selStart) // clamped to the text
    }

    @Test
    fun selectionInsideTheMarkedTextKeepsTheComposition() {
        val (i, e) = input("")
        i.setComposingText("hello", 1)
        i.setSelection(2, 2)
        assertTrue(i.composing)
        assertEquals(2, i.selStart)
        assertEquals("compose:hello:2:2", e.calls.last())
    }

    @Test
    fun selectionOutsideTheMarkedTextEndsIt() {
        val (i, e) = input("ab")
        i.setComposingText("c", 1)
        i.setSelection(0, 0)
        assertFalse(i.composing)
        assertEquals("select:0,0", e.calls.last())
    }

    @Test
    fun readingTheTextAroundTheCaret() {
        val (i, _) = input("hello world", 2, 5)
        assertEquals("he", i.textBefore(10))
        assertEquals(" world", i.textAfter(10))
        assertEquals("llo", i.selectedText())
        val (j, _) = input("abc", 1)
        assertNull(j.selectedText())
    }

    @Test
    fun reportsEachChangeWithWhoMadeIt() {
        val (i, _) = input("")
        val seen = mutableListOf<Boolean>()
        i.onChanged = { _, _, fromIme -> seen += fromIme }
        i.commitText("a", 1)
        i.sendChord("Mod+b")
        assertEquals(listOf(true, false), seen)
    }

    @Test
    fun aChordEndsAnOpenCompositionFirst() {
        val (i, e) = input("")
        i.setComposingText("ab", 1)
        i.sendChord("Backspace")
        assertEquals(listOf("compose:ab:2:2", "finish", "key:Backspace"), e.calls)
    }

    @Test
    fun batchEditsHoldTheImeUpdateUntilTheLastEnds() {
        val (i, _) = input("")
        i.beginBatch()
        i.beginBatch()
        assertTrue(i.endBatch())
        assertTrue(i.inBatch)
        assertFalse(i.endBatch())
        assertFalse(i.inBatch)
    }

    @Test
    fun hardwareChords() {
        val ctrl = KeyEvent.META_CTRL_ON
        assertEquals("Mod+b", BoxInput.chordFor(KeyEvent.KEYCODE_B, ctrl))
        assertEquals("Mod+Shift+z", BoxInput.chordFor(KeyEvent.KEYCODE_Z, ctrl or KeyEvent.META_SHIFT_ON))
        assertEquals("Mod+z", BoxInput.chordFor(KeyEvent.KEYCODE_Z, ctrl))
        assertEquals("Mod+Alt+1", BoxInput.chordFor(KeyEvent.KEYCODE_1, ctrl or KeyEvent.META_ALT_ON))
        assertEquals("Enter", BoxInput.chordFor(KeyEvent.KEYCODE_ENTER, 0))
        assertEquals("Shift+Enter", BoxInput.chordFor(KeyEvent.KEYCODE_ENTER, KeyEvent.META_SHIFT_ON))
        assertEquals("Backspace", BoxInput.chordFor(KeyEvent.KEYCODE_DEL, 0))
        assertEquals("Delete", BoxInput.chordFor(KeyEvent.KEYCODE_FORWARD_DEL, 0))
        assertEquals("Shift+Tab", BoxInput.chordFor(KeyEvent.KEYCODE_TAB, KeyEvent.META_SHIFT_ON))
        assertEquals("Alt+Shift+ArrowUp", BoxInput.chordFor(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.META_ALT_ON or KeyEvent.META_SHIFT_ON))
        assertEquals("Mod+.", BoxInput.chordFor(KeyEvent.KEYCODE_PERIOD, ctrl))
        // Plain letters are text: they come through the input method.
        assertNull(BoxInput.chordFor(KeyEvent.KEYCODE_A, 0))
        assertNull(BoxInput.chordFor(KeyEvent.KEYCODE_A, KeyEvent.META_SHIFT_ON))
    }
}
