package com.notivelo.app.ui.page

import com.notivelo.core.PageBox
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/** A box being dragged or resized: where it is shown (page px, as the core stores them) until the core's write comes back. */
class BoxDrag(val id: String, val x: Double, val y: Double, val w: Double, val moved: Boolean = false, val resized: Boolean = false)

/**
 * What the box frame needs to move or resize its box: the box's geometry now (page px), the page's ruled state (moves snap to
 * rule lines), and where to report: [onPreview] while a finger is down (null: forget the preview), [onCommit] once at the end.
 */
class BoxFrameHooks(
    val x: Double,
    val y: Double,
    val w: Double,
    val ruled: Boolean,
    val onPreview: (BoxDrag?) -> Unit,
    val onCommit: (BoxDrag) -> Unit,
)

/**
 * Box geometry maths, the web's `canvasGeom.ts`: positions are whole pixels in 0..20000, widths 120..2400, a new box starts
 * 12 above the tap with the width 360, a ruled page snaps moves to whole rule lines (28), and a tap on empty canvas
 * creates a box. Pure, so it is unit-tested.
 */
object BoxGeom {
    const val MIN_W = 120.0
    const val MAX_W = 2400.0
    const val DEFAULT_W = 360.0
    const val MAX_COORD = 20_000.0

    /** A new box starts this far above the tap, so the first line lands where it was tapped. */
    const val CLICK_OFFSET_Y = 12.0
    const val RULE_UNIT = 28.0

    /** Height assumed for a box that is not measured (the phone stack). */
    const val UNMEASURED_H = 48.0

    /** Room the selected box's frame needs outside it, dp: the drag bar above (26) and the width handle to the right (14). */
    const val FRAME_TOP = 26f
    const val FRAME_END = 14f

    private fun clamp(v: Double, lo: Double, hi: Double) = min(hi, max(lo, v))
    private fun round(v: Double) = v.roundToLong().toDouble()

    fun clampPos(x: Double, y: Double): Pair<Double, Double> = round(clamp(x, 0.0, MAX_COORD)) to round(clamp(y, 0.0, MAX_COORD))

    fun clampWidth(w: Double): Double = round(clamp(w, MIN_W, MAX_W))

    /** The nearest rule line, never above the page's top. */
    fun snapY(y: Double, unit: Double = RULE_UNIT): Double = max(0.0, round(y / unit) * unit)

    /** Rule lines are on (the web: `rules !== 'none'`). */
    fun ruled(rules: String?): Boolean = rules != null && rules != "none"

    /** The place of a box made by tapping at ([x], [y]) page px: 12 above the tap, snapped on a ruled page. */
    fun atClick(x: Double, y: Double, ruled: Boolean): Pair<Double, Double> {
        val (cx, cy) = clampPos(x, y - CLICK_OFFSET_Y)
        return cx to if (ruled) snapY(cy) else cy
    }

    /** A box moved by ([dx], [dy]) page px from where it started. */
    fun moved(startX: Double, startY: Double, dx: Double, dy: Double, ruled: Boolean): Pair<Double, Double> {
        val (x, y) = clampPos(startX + dx, startY + dy)
        return x to if (ruled) snapY(y) else y
    }

    /** A box widened by [dx] page px from the width it started with (a wide box keeps the width it is given). */
    fun resized(startW: Double, dx: Double): Double = clampWidth(startW + dx)

    /** Where a box added below the others goes (the phone's "Add a text box"): 24 under the lowest one, at the left. */
    fun below(boxes: List<PageBox>): Pair<Double, Double> {
        if (boxes.isEmpty()) return 0.0 to 0.0
        val bottom = boxes.maxOf { it.y + UNMEASURED_H }
        return clampPos(0.0, bottom + 24.0)
    }

    /** The box under a point of the surface (dp from the surface's top-left), the one in front when they overlap. */
    fun hit(placed: List<PlacedBox>, heights: Map<String, Float>, x: Float, y: Float): String? =
        placed.filter { x >= it.x && x <= it.x + it.width && y >= it.y && y <= it.y + (heights[it.id] ?: UNMEASURED_H.toFloat()) }
            .maxByOrNull { it.z }?.id
}
