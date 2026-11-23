package com.notivelo.app.ui.page

import com.notivelo.core.BoxContent
import com.notivelo.core.PageBox

/** A box placed on the canvas surface (dp from the surface's top-left, which is the scroll area's). */
data class PlacedBox(val id: String, val x: Float, val y: Float, val width: Float, val z: Double)

/**
 * The page's geometry as the web and the Apple app lay it out (LOOK.md 4.5, `PageCanvasView.swift`): the title
 * and "Edited" line first, then the canvas surface, whose origin is [ORIGIN_X] in from the left (so a box at
 * x = 0 has its text under the title) and [originY] down. Wide boxes span the visible width minus 40 each side.
 * Phones stack the boxes in reading order, full width, with a hairline between.
 */
object PageLayout {
    const val ORIGIN_X = 40f

    /** Padding of the article above the canvas: 32 + icon row 28 + 4 + title 36 x 1.2 + 6 + "Edited" line 18.75 + 22 + 14. */
    const val ORIGIN_Y = 32f + 28f + 4f + 43.2f + 6f + 18.75f + 22f + 14f

    /** A box's inner padding (text starts this far in): 11 left, 7 top and bottom. */
    const val BOX_PAD_X = 11f
    const val BOX_PAD_Y = 7f

    /** Phone: article padding 12 20, icon row 44, title 28 x 1.2, the same sub-line. */
    const val PHONE_ORIGIN_Y = 12f + 44f + 4f + 33.6f + 6f + 18.75f + 22f + 6f

    /** The icon row is taller when the page has an icon (56 / 44 sp at 1.1) than its empty 28 / 44. */
    fun iconShift(hasIcon: Boolean, phone: Boolean): Float =
        if (!hasIcon) 0f else (if (phone) 44f * 1.1f + 4f else 56f * 1.1f + 4f) - (if (phone) 44f else 28f)

    /** Tablet: boxes at their saved places, in stacking order (higher z in front, later in the list). */
    fun place(boxes: List<PageBox>, visibleWidth: Float, hasIcon: Boolean = false): List<PlacedBox> {
        val oy = ORIGIN_Y + iconShift(hasIcon, false)
        return boxes
            .map { b ->
                val w = if (b.wide) maxOf(visibleWidth - ORIGIN_X - 40f, 120f) else b.w.toFloat()
                PlacedBox(b.id, ORIGIN_X + b.x.toFloat(), oy + b.y.toFloat(), w, b.z)
            }
            .sortedBy { it.z }
    }

    /** The surface's size: past the boxes by 240 right and 320 down, at least the visible area. */
    fun surfaceSize(placed: List<PlacedBox>, heights: Map<String, Float>, visibleWidth: Float, visibleHeight: Float, hasIcon: Boolean = false): Pair<Float, Float> {
        val oy = ORIGIN_Y + iconShift(hasIcon, false)
        val maxX = placed.maxOfOrNull { it.x + it.width } ?: 0f
        val maxY = placed.maxOfOrNull { it.y + (heights[it.id] ?: 0f) } ?: 0f
        return maxOf(maxX + 240f, visibleWidth) to maxOf(maxY + 320f, oy + 320f, visibleHeight)
    }

    /** Phone: the boxes in reading order (the core's order), without the ones with no content (they draw nothing). */
    fun stack(boxes: List<PageBox>, content: List<BoxContent>): List<PageBox> {
        val empty = content.filter { it.boxId != null && it.nodes.isEmpty() }.map { it.boxId }.toSet()
        return boxes.filter { it.id !in empty }
    }

    /** A document page (no boxes, text in `default`) is shown as one wide box. */
    fun withDefault(boxes: List<PageBox>, content: List<BoxContent>): List<PageBox> =
        if (boxes.isEmpty() && content.any { it.boxId == null && it.nodes.isNotEmpty() }) listOf(PageBox("default", 0.0, 0.0, 686.0, 1.0, true)) else boxes

    /** The first of several stacked boxes has 9 more above it than a lone box (a page's text). */
    fun phoneTopGap(count: Int): Float = if (count > 1) 9f else 0f
}
