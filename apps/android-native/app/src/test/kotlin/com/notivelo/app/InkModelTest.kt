package com.notivelo.app

import com.notivelo.app.ink.InkAction
import com.notivelo.app.ink.InkGate
import com.notivelo.app.ink.InkKind
import com.notivelo.app.ink.InkSettings
import com.notivelo.app.ink.InkSpace
import com.notivelo.app.ink.StrokeCollector
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InkModelTest {
    @Test
    fun aStylusDrawsAFingerOnlyWhenAskedAndTheEraserEndErases() {
        assertEquals(InkAction.Draw, InkGate.action(InkGate.STYLUS, finger = false))
        assertEquals(InkAction.Draw, InkGate.action(InkGate.MOUSE, finger = false))
        assertEquals(InkAction.None, InkGate.action(InkGate.FINGER, finger = false))
        assertEquals(InkAction.None, InkGate.action(InkGate.UNKNOWN, finger = false))
        assertEquals(InkAction.Draw, InkGate.action(InkGate.FINGER, finger = true))
        assertEquals(InkAction.EraseWhole, InkGate.action(InkGate.ERASER, finger = false))
        assertEquals(true, InkGate.hasPressure(InkGate.STYLUS))
        assertEquals(false, InkGate.hasPressure(InkGate.FINGER))
    }

    @Test
    fun samplesAreSixNumbersWithTimeFromTheFirstAndNeverGoingBack() {
        val c = StrokeCollector(pressureDevice = true)
        c.add(10f, 20f, 0.25f, 1000)
        c.add(12f, 21f, 0.5f, 1008)
        c.add(12f, 21f, 0.6f, 1010) // not moved: dropped
        c.add(15f, 25f, 1.5f, 1005) // an out-of-order clock is held at the last time; pressure is clamped
        assertEquals(3, c.count)
        val s = c.samples()
        assertEquals(18, s.size)
        val half = Math.PI / 2
        assertArrayEquals(doubleArrayOf(10.0, 20.0, 0.25, half, 0.0, 0.0), s.copyOfRange(0, 6), 1e-9)
        assertArrayEquals(doubleArrayOf(12.0, 21.0, 0.5, half, 0.0, 8.0), s.copyOfRange(6, 12), 1e-9)
        assertArrayEquals(doubleArrayOf(15.0, 25.0, 1.0, half, 0.0, 10.0), s.copyOfRange(12, 18), 1e-9)
        assertArrayEquals(floatArrayOf(10f, 20f, 12f, 21f, 15f, 25f), c.xy(), 0f)
    }

    @Test
    fun aFingerOrMouseStrokeHasAConstantPressure() {
        val c = StrokeCollector(pressureDevice = false)
        c.add(0f, 0f, 0.9f, 5)
        c.add(1f, 1f, 0.1f, 6)
        assertEquals(0.5, c.samples()[2], 0.0)
        assertEquals(0.5, c.samples()[8], 0.0)
    }

    @Test
    fun theBufferGrowsAndBadPointsAreSkipped() {
        val c = StrokeCollector(true)
        for (i in 0 until 500) c.add(i.toFloat(), 0f, 0.5f, i.toLong())
        c.add(Float.NaN, 0f, 0.5f, 600)
        assertEquals(500, c.count)
        assertEquals(499f, c.lastX, 0f)
    }

    @Test
    fun pointsAreInPagePointsFromThePageOrigin() {
        // 2x density, origin 40 dp: a touch at 180 px is 50 points.
        assertEquals(50f, InkSpace.point(180f, 2f, 40f), 0f)
    }

    @Test
    fun theBarsStylesFollowTheWebsPalettes() {
        val s = InkSettings(open = true)
        assertEquals(Triple(0, 0x1F2328FFL, 2.5f), s.style())
        val h = s.copy(kind = InkKind.Highlighter)
        // Yellow at the web's 0x59 alpha, medium width.
        assertEquals(Triple(1, 0xFACC1559L, 18f), h.style())
        assertNull(s.copy(kind = InkKind.Eraser).style())
        assertNull(s.copy(kind = InkKind.PartialEraser).style())
        assertEquals(true, s.copy(kind = InkKind.PartialEraser).erasing)
        assertEquals(8f, InkSettings.ERASER_RADIUS, 0f)
    }
}
