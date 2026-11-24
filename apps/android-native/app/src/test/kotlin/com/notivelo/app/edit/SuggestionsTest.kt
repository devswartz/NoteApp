package com.notivelo.app.edit

import androidx.compose.ui.unit.IntOffset
import com.notivelo.core.EditorSuggestion
import com.notivelo.core.SuggestionTrigger
import com.notivelo.core.WorkspaceMember
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SuggestionsTest {
    private val pages = listOf(
        PageChoice("p1", "Weekly sync", "Product / Meetings"),
        PageChoice("p2", "Q4 roadmap", "Product / Roadmap"),
        PageChoice("p3", "Sync notes", "Product / Meetings"),
        PageChoice("p4", "", "Misc"),
    )

    @Test
    fun pageRowsRankPrefixThenWordThenSubstring() {
        assertEquals(listOf("p3", "p1"), Suggestions.pageRows("sync", pages).map { it.id })
        assertEquals(listOf("p2"), Suggestions.pageRows("road", pages).map { it.id })
        assertEquals(listOf("p1"), Suggestions.pageRows("eekl", pages).map { it.id })
        assertEquals(4, Suggestions.pageRows("", pages).size)
        assertEquals("Untitled", Suggestions.pageRows("", pages).last().title)
    }

    @Test
    fun peopleRowsMatchNameOrEmail() {
        val people = listOf(
            WorkspaceMember("u1", "Sam Rivera", "sam@example.com", "#ef4444", "member"),
            WorkspaceMember("u2", "Alex", "alex@corp.test", "#10b981", "owner"),
        )
        assertEquals(listOf("u1"), Suggestions.peopleRows("riv", people).map { it.id })
        assertEquals(listOf("u2"), Suggestions.peopleRows("corp", people).map { it.id })
        assertEquals(2, Suggestions.peopleRows("", people).size)
    }

    @Test
    fun slashModelUsesTheEnginesRowsAndHighlight() {
        val m = Suggestions.model(StaticRender.slash(highlighted = 2), emptyList(), emptyList(), 0, 10f, 20f, 48f, 100f, 400f)!!
        assertEquals(SuggestionTrigger.SLASH, m.kind)
        assertEquals(14, m.rows.size)
        assertEquals(2, m.highlighted)
        assertEquals("INSERT BLOCK", m.header)
    }

    @Test
    fun ownHighlightIsClampedToTheRows() {
        val base = StaticRender.slash()
        val s = EditorSuggestion(
            SuggestionTrigger.PAGE_LINK, "road", base.from, base.to, base.viewFrom, base.viewTo, emptyList(), emptyList(), null,
        )
        val m = Suggestions.model(s, pages, emptyList(), 5, 0f, 0f, 0f, 0f, 0f)!!
        assertEquals(1, m.rows.size)
        assertEquals(0, m.highlighted)
        val none = Suggestions.model(s, emptyList(), emptyList(), 3, 0f, 0f, 0f, 0f, 0f)!!
        assertNull(none.highlighted)
        assertEquals("Type a page title…", none.empty)
    }

    @Test
    fun pickCommandsAreTheEnginesNames() {
        assertEquals("pickSlash" to "{\"title\":\"Heading 1\"}", Suggestions.pickCommand(SuggestionTrigger.SLASH, MenuRow("Heading 1", "Heading 1", "", null, null)))
        assertEquals("pickPage" to "{\"pageId\":\"p1\"}", Suggestions.pickCommand(SuggestionTrigger.PAGE_LINK, MenuRow("p1", "Weekly sync", "", null, null)))
        assertEquals(
            "pickMention" to "{\"id\":\"u1\",\"label\":\"Sam \\\"S\\\"\"}",
            Suggestions.pickCommand(SuggestionTrigger.MENTION, MenuRow("u1", "Sam \"S\"", "", null, null)),
        )
    }

    private fun model(top: Float, bottom: Float, above: Float, below: Float) =
        MenuModel(SuggestionTrigger.SLASH, emptyList(), null, null, 40f, top, bottom, above, below)

    @Test
    fun theMenuHangsBelowTheCaretLineWhenItFits() {
        val at = MenuPlacement.place(100, 200, model(30f, 58f, 300f, 600f), 290, 320, 800, 6, 8)
        assertEquals(IntOffset(140, 200 + 58 + 6), at)
    }

    @Test
    fun itFlipsAboveWhenThereIsMoreRoomThere() {
        val at = MenuPlacement.place(100, 500, model(300f, 328f, 600f, 120f), 290, 320, 800, 6, 8)
        assertEquals(IntOffset(140, 500 + 300 - 320 - 6), at)
    }

    @Test
    fun itStaysOnScreenAtTheRightEdge() {
        val at = MenuPlacement.place(700, 0, model(0f, 20f, 0f, 900f), 290, 320, 800, 6, 8)
        assertEquals(800 - 290 - 8, at.x)
    }

    @Test
    fun jsonStringsAreEscaped() {
        assertEquals("\"a\\\\b\\n\"", Suggestions.jsonString("a\\b\n"))
    }
}
