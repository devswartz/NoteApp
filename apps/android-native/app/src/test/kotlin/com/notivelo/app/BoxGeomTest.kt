package com.notivelo.app

import com.notivelo.app.ui.page.BoxGeom
import com.notivelo.app.ui.page.PlacedBox
import com.notivelo.core.PageBox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BoxGeomTest {
    @Test
    fun positionsAreWholeAndStayOnThePage() {
        assertEquals(0.0 to 0.0, BoxGeom.clampPos(-5.0, -0.4))
        assertEquals(13.0 to 8.0, BoxGeom.clampPos(12.6, 7.5))
        assertEquals(20_000.0 to 20_000.0, BoxGeom.clampPos(1e9, 25_000.0))
    }

    @Test
    fun widthsAreClamped() {
        assertEquals(120.0, BoxGeom.clampWidth(10.0), 0.0)
        assertEquals(2400.0, BoxGeom.clampWidth(9000.0), 0.0)
        assertEquals(361.0, BoxGeom.clampWidth(360.6), 0.0)
    }

    @Test
    fun aTapMakesABoxTwelveAboveTheTap() {
        assertEquals(100.0 to 188.0, BoxGeom.atClick(100.0, 200.0, ruled = false))
        // Near the page's top the box stays on the page.
        assertEquals(5.0 to 0.0, BoxGeom.atClick(5.0, 4.0, ruled = false))
    }

    @Test
    fun aRuledPageSnapsToRuleLines() {
        // 200 - 12 = 188: the nearest multiple of 28 is 196 (7 lines).
        assertEquals(100.0 to 196.0, BoxGeom.atClick(100.0, 200.0, ruled = true))
        assertEquals(0.0, BoxGeom.snapY(13.0), 0.0)
        assertEquals(28.0, BoxGeom.snapY(15.0), 0.0)
        assertEquals(0.0, BoxGeom.snapY(-40.0), 0.0)
    }

    @Test
    fun movingFollowsTheFingerAndClamps() {
        assertEquals(60.0 to 90.0, BoxGeom.moved(50.0, 100.0, 10.0, -10.0, ruled = false))
        assertEquals(0.0 to 0.0, BoxGeom.moved(50.0, 100.0, -500.0, -500.0, ruled = false))
        // 90 snaps to 84 (3 lines), the nearest.
        assertEquals(60.0 to 84.0, BoxGeom.moved(50.0, 100.0, 10.0, -10.0, ruled = true))
    }

    @Test
    fun resizingKeepsTheLimits() {
        assertEquals(460.0, BoxGeom.resized(360.0, 100.0), 0.0)
        assertEquals(120.0, BoxGeom.resized(360.0, -900.0), 0.0)
        assertEquals(2400.0, BoxGeom.resized(2000.0, 900.0), 0.0)
    }

    @Test
    fun rulesAreOnUnlessNone() {
        assertEquals(false, BoxGeom.ruled("none"))
        assertEquals(false, BoxGeom.ruled(null))
        assertEquals(true, BoxGeom.ruled("lines"))
        assertEquals(true, BoxGeom.ruled("grid"))
    }

    @Test
    fun aBoxAddedBelowGoesUnderTheLowestOne() {
        assertEquals(0.0 to 0.0, BoxGeom.below(emptyList()))
        val boxes = listOf(PageBox("a", 10.0, 100.0, 360.0, 1.0, false), PageBox("b", 200.0, 40.0, 360.0, 2.0, false))
        assertEquals(0.0 to 172.0, BoxGeom.below(boxes))
    }

    @Test
    fun aPointFindsTheBoxInFront() {
        val placed = listOf(PlacedBox("back", 0f, 0f, 200f, 1.0), PlacedBox("front", 100f, 0f, 200f, 2.0))
        val heights = mapOf("back" to 100f, "front" to 100f)
        assertEquals("back", BoxGeom.hit(placed, heights, 50f, 50f))
        assertEquals("front", BoxGeom.hit(placed, heights, 150f, 50f))
        assertNull(BoxGeom.hit(placed, heights, 150f, 400f))
    }
}
