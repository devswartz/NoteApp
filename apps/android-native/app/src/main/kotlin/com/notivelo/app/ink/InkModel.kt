package com.notivelo.app.ink

import androidx.compose.runtime.Immutable
import kotlin.math.max
import kotlin.math.min

/** The ink bar's tools (src/ink/inkTool.ts without the lasso and select tool, which the web's ink does not have either). */
enum class InkKind { Pen, Highlighter, Eraser, PartialEraser }

/** A colour of the bar: its name and 0xRRGGBB. */
class Swatch(val name: String, val rgb: Int)

/** One stroke to write: tool 0 pen / 1 highlighter, colour 0xRRGGBBAA, width in page points at pressure 0.5, six numbers per sample. */
class InkStrokeSpec(val tool: Int, val color: Long, val width: Float, val pressure: Boolean, val samples: DoubleArray)

/**
 * The pen bar's state: the open bar, the tool, the pen's and the highlighter's colour and width, and whether a finger draws
 * (off by default: a finger scrolls). The tool itself starts at the pen when the bar opens.
 */
@Immutable
data class InkSettings(
    val open: Boolean = false,
    val kind: InkKind = InkKind.Pen,
    val penColor: Int = PEN_COLORS[0].rgb,
    val penWidth: Float = PEN_WIDTHS[1],
    val highlighterColor: Int = HIGHLIGHTER_COLORS[0].rgb,
    val highlighterWidth: Float = HIGHLIGHTER_WIDTHS[1],
    val finger: Boolean = false,
) {
    /** The style a new stroke gets: tool, 0xRRGGBBAA, width; null for the erasers. */
    fun style(): Triple<Int, Long, Float>? = when (kind) {
        InkKind.Pen -> Triple(0, pack(penColor, 1.0), penWidth)
        InkKind.Highlighter -> Triple(1, pack(highlighterColor, HIGHLIGHTER_ALPHA), highlighterWidth)
        else -> null
    }

    val erasing: Boolean get() = kind == InkKind.Eraser || kind == InkKind.PartialEraser

    companion object {
        /** The web's pen colours; the first is "ink", drawn light in the dark theme. */
        val PEN_COLORS = listOf(Swatch("Black", 0x1F2328), Swatch("Blue", 0x1D4ED8), Swatch("Red", 0xDC2626), Swatch("Green", 0x15803D), Swatch("Purple", 0x7E22CE))
        val HIGHLIGHTER_COLORS = listOf(Swatch("Yellow", 0xFACC15), Swatch("Green", 0x4ADE80), Swatch("Blue", 0x60A5FA), Swatch("Pink", 0xF472B6))

        /** Base widths in page points at pressure 0.5 (Fine, Medium, Thick). */
        val PEN_WIDTHS = listOf(1.5f, 2.5f, 4f)
        val HIGHLIGHTER_WIDTHS = listOf(12f, 18f, 26f)

        /** The eraser's disc (page points). */
        const val ERASER_RADIUS = 8f

        /** Highlighters are see-through (0x59). */
        const val HIGHLIGHTER_ALPHA = 0.35

        /** `packColor`: 0xRRGGBB and an alpha to 0xRRGGBBAA. */
        fun pack(rgb: Int, alpha: Double): Long = ((rgb.toLong() and 0xFFFFFF) shl 8) or Math.round(min(max(alpha, 0.0), 1.0) * 255).toLong()
    }
}

/** What a pointer of a given type does on the page while the bar is open. */
enum class InkAction { None, Draw, EraseWhole }

object InkGate {
    // MotionEvent.TOOL_TYPE_*
    const val UNKNOWN = 0
    const val FINGER = 1
    const val STYLUS = 2
    const val MOUSE = 3
    const val ERASER = 4

    /**
     * The stylus draws whenever a tool is chosen, the mouse too; a finger only when "draw with finger" is on (otherwise it
     * scrolls); a stylus's eraser end erases whole strokes. Anything unknown is treated as a finger.
     */
    fun action(toolType: Int, finger: Boolean): InkAction = when (toolType) {
        STYLUS, MOUSE -> InkAction.Draw
        ERASER -> InkAction.EraseWhole
        else -> if (finger) InkAction.Draw else InkAction.None
    }

    /** True when the pointer carries pressure worth keeping (a stylus); a finger or a mouse is a constant 0.5, as the web. */
    fun hasPressure(toolType: Int): Boolean = toolType == STYLUS
}

/**
 * Collects a stroke's samples for the core (`addInkStrokeFromSamples`): six numbers each (x, y, pressure, altitude, azimuth, t ms), in
 * page points. Time runs from the first sample and never goes back; a point where the pointer did not move is dropped.
 */
class StrokeCollector(private val pressureDevice: Boolean) {
    private var data = DoubleArray(6 * 64)
    var count = 0
        private set
    private var t0 = Long.MIN_VALUE
    private var lastT = 0.0

    val lastX: Float get() = if (count == 0) 0f else data[(count - 1) * 6].toFloat()
    val lastY: Float get() = if (count == 0) 0f else data[(count - 1) * 6 + 1].toFloat()

    /** [timeMs] is any clock that only runs forwards. */
    fun add(x: Float, y: Float, pressure: Float, timeMs: Long) {
        if (!x.isFinite() || !y.isFinite()) return
        if (t0 == Long.MIN_VALUE) t0 = timeMs
        val t = max((timeMs - t0).toDouble(), lastT)
        if (count > 0 && lastX == x && lastY == y) {
            lastT = t
            return
        }
        lastT = t
        if ((count + 1) * 6 > data.size) data = data.copyOf(data.size * 2)
        val i = count * 6
        data[i] = x.toDouble()
        data[i + 1] = y.toDouble()
        data[i + 2] = if (pressureDevice) min(max(pressure, 0f), 1f).toDouble() else 0.5
        data[i + 3] = Math.PI / 2
        data[i + 4] = 0.0
        data[i + 5] = t
        count++
    }

    fun samples(): DoubleArray = data.copyOf(count * 6)

    /** The points so far as x, y pairs (for the live line). */
    fun xy(): FloatArray {
        val out = FloatArray(count * 2)
        for (i in 0 until count) {
            out[i * 2] = data[i * 6].toFloat()
            out[i * 2 + 1] = data[i * 6 + 1].toFloat()
        }
        return out
    }
}

/** Page points from the pointer's place on the surface: px over the density, less where the page's origin is (dp). */
object InkSpace {
    fun point(px: Float, density: Float, origin: Float): Float = px / density - origin
}
