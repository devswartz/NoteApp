package com.notivelo.app

import com.notivelo.app.look.p
import com.notivelo.app.ui.page.PageLayout
import com.notivelo.core.BoxContent
import com.notivelo.core.PageBox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PageLayoutTest {
    private fun box(id: String, x: Double, y: Double, w: Double, z: Double, wide: Boolean = false) = PageBox(id, x, y, w, z, wide)

    // canvas-boxes of the corpus, in reading order
    private val canvas = listOf(
        box("top", 900.0, -40.5, 686.0, 1.0, wide = true), box("a", 20.0, 300.0, 300.0, 2.0), box("b", 20.0, 300.0, 250.0, 5.0),
        box("c", 500.0, 300.0, 300.0, 3.0), box("empty", 0.0, 1000.0, 400.0, 4.0), box("blank", 0.0, 1200.0, 400.0, 6.0),
    )

    @Test
    fun boxesSitOnTheSurfaceFromItsOrigin() {
        val placed = PageLayout.place(canvas, 899f).associateBy { it.id }
        val a = placed.getValue("a")
        assertEquals(PageLayout.ORIGIN_X + 20f, a.x, 0.001f)
        assertEquals(PageLayout.ORIGIN_Y + 300f, a.y, 0.001f)
        assertEquals(300f, a.width, 0.001f)
        assertEquals(167.95f, PageLayout.ORIGIN_Y, 0.01f)
    }

    @Test
    fun wideBoxesSpanTheVisibleWidthMinusTheMargins() {
        val top = PageLayout.place(canvas, 899f).first { it.id == "top" }
        assertEquals(899f - 40f - 40f, top.width, 0.001f)
        // Never narrower than 120.
        assertEquals(120f, PageLayout.place(canvas, 100f).first { it.id == "top" }.width, 0.001f)
    }

    @Test
    fun higherZIsInFront() {
        val order = PageLayout.place(canvas, 899f).map { it.id }
        assertEquals(listOf("top", "a", "c", "empty", "b", "blank"), order)
    }

    @Test
    fun anIconMovesTheCanvasDown() {
        assertEquals(0f, PageLayout.iconShift(false, false), 0.001f)
        assertEquals(56f * 1.1f + 4f - 28f, PageLayout.iconShift(true, false), 0.001f)
        assertEquals(44f * 1.1f + 4f - 44f, PageLayout.iconShift(true, true), 0.001f)
        val plain = PageLayout.place(canvas, 899f).first { it.id == "a" }
        val iconed = PageLayout.place(canvas, 899f, hasIcon = true).first { it.id == "a" }
        assertEquals(PageLayout.iconShift(true, false), iconed.y - plain.y, 0.001f)
    }

    @Test
    fun surfaceReachesPastTheBoxes() {
        val placed = PageLayout.place(canvas, 899f)
        val (w, h) = PageLayout.surfaceSize(placed, mapOf("blank" to 40f), 899f, 700f)
        // The widest reach is the top box: 40 + 900 in, 819 wide.
        assertEquals(940f + 819f + 240f, w, 0.01f)
        assertEquals(PageLayout.ORIGIN_Y + 1200f + 40f + 320f, h, 0.01f)
    }

    @Test
    fun phonesStackTheBoxesInReadingOrderAndSkipEmptyOnes() {
        val content = listOf(BoxContent(null, emptyList()), BoxContent("empty", emptyList()), BoxContent("a", listOf(p("x"))))
        val stacked = PageLayout.stack(canvas, content)
        assertEquals(listOf("top", "a", "b", "c", "blank"), stacked.map { it.id })
    }

    @Test
    fun aDocumentPageIsOneWideBox() {
        val doc = PageLayout.withDefault(emptyList(), listOf(BoxContent(null, listOf(p("text")))))
        assertEquals(listOf("default"), doc.map { it.id })
        assertTrue(doc[0].wide)
        assertEquals(canvas, PageLayout.withDefault(canvas, emptyList()))
        assertTrue(PageLayout.withDefault(emptyList(), listOf(BoxContent(null, emptyList()))).isEmpty())
    }

    @Test
    fun theFirstOfSeveralStackedBoxesHasMoreRoom() {
        assertEquals(0f, PageLayout.phoneTopGap(1), 0f)
        assertEquals(9f, PageLayout.phoneTopGap(2), 0f)
    }
}
