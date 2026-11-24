package com.notivelo.app.ink

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.Palette
import com.notivelo.app.look.WText
import com.notivelo.app.ui.hairline
import com.notivelo.app.ui.tappable

/** The stroke being drawn (or the eraser's disc), in page points, until the page shows the stored stroke. */
@Stable
class InkLive {
    var active by mutableStateOf(false)
        private set
    var points by mutableStateOf(FloatArray(0))
    var argb by mutableStateOf(0)
        private set
    var width by mutableStateOf(0f)
        private set
    var erase by mutableStateOf(false)
        private set

    fun begin(erase: Boolean, argb: Int, width: Float) {
        this.erase = erase
        this.argb = argb
        this.width = width
        points = FloatArray(0)
        active = true
    }

    fun clear() {
        active = false
        points = FloatArray(0)
    }
}

/** 0xRRGGBBAA as stored to ARGB. */
fun argbOf(rgba: Long): Int = (((rgba and 0xFF) shl 24) or ((rgba shr 8) and 0xFFFFFF)).toInt()

private fun toolType(t: PointerType): Int = when (t) {
    PointerType.Touch -> InkGate.FINGER
    PointerType.Stylus -> InkGate.STYLUS
    PointerType.Mouse -> InkGate.MOUSE
    PointerType.Eraser -> InkGate.ERASER
    else -> InkGate.UNKNOWN
}

/**
 * Draws on the page while the pen bar is open: a stylus (or a mouse) always, a finger only with "draw with finger" on, so a finger
 * otherwise still scrolls. The pointer is taken on the initial pass (and consumed), so boxes and the scroll below do not see it.
 * One stroke or one erase per gesture goes to [onStroke] / [onErase] (page points from the page origin: [originX] and [originY] in dp
 * are where that origin is on the surface); [live] shows it meanwhile.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun Modifier.inkInput(
    ink: InkSettings,
    live: InkLive,
    originX: Float,
    originY: Float,
    onStroke: (InkStrokeSpec) -> Unit,
    onErase: (track: FloatArray, partial: Boolean) -> Unit,
): Modifier {
    val stroke by rememberUpdatedState(onStroke)
    val erase by rememberUpdatedState(onErase)
    if (!ink.open) return this
    return pointerInput(ink.kind, ink.finger, ink.penColor, ink.penWidth, ink.highlighterColor, ink.highlighterWidth, originX, originY) {
        val d = density
        awaitPointerEventScope {
            while (true) {
                val ev = awaitPointerEvent(PointerEventPass.Initial)
                val down = ev.changes.firstOrNull { it.pressed && !it.previousPressed } ?: continue
                val type = toolType(down.type)
                val action = InkGate.action(type, ink.finger)
                if (action == InkAction.None) continue
                val erasing = action == InkAction.EraseWhole || ink.erasing
                val style = ink.style()
                if (!erasing && style == null) continue
                val partial = erasing && action != InkAction.EraseWhole && ink.kind == InkKind.PartialEraser
                down.consume()
                val collector = StrokeCollector(InkGate.hasPressure(type))
                fun feed(c: PointerInputChange) {
                    for (h in c.historical) {
                        collector.add(InkSpace.point(h.position.x, d, originX), InkSpace.point(h.position.y, d, originY), c.pressure, h.uptimeMillis)
                    }
                    collector.add(InkSpace.point(c.position.x, d, originX), InkSpace.point(c.position.y, d, originY), c.pressure, c.uptimeMillis)
                }
                live.begin(erasing, if (style != null) argbOf(style.second) else 0, style?.third ?: 0f)
                feed(down)
                live.points = collector.xy()
                var cancelled = false
                while (true) {
                    val e = awaitPointerEvent(PointerEventPass.Initial)
                    val c = e.changes.firstOrNull { it.id == down.id }
                    if (c == null) {
                        cancelled = true
                        break
                    }
                    c.consume()
                    feed(c)
                    live.points = collector.xy()
                    if (!c.pressed) break
                }
                if (cancelled || collector.count == 0) {
                    live.clear()
                } else if (erasing) {
                    val track = collector.xy()
                    live.clear()
                    erase(track, partial)
                } else if (style != null) {
                    stroke(InkStrokeSpec(style.first, style.second, style.third, InkGate.hasPressure(type), collector.samples()))
                }
            }
        }
    }
}

/** The live stroke or eraser disc, on the page's surface (same transform as the stored strokes). */
fun DrawScope.drawLiveInk(live: InkLive, originX: Float, originY: Float, discColor: Color) {
    if (!live.active) return
    val pts = live.points
    if (pts.size < 2) return
    val d = density
    val ox = originX.dp.toPx()
    val oy = originY.dp.toPx()
    withTransform({
        translate(ox, oy)
        scale(d, d, Offset.Zero)
    }) {
        val n = pts.size
        val last = Offset(pts[n - 2], pts[n - 1])
        if (live.erase) {
            drawCircle(discColor.copy(alpha = 0.18f), InkSettings.ERASER_RADIUS, last)
            drawCircle(discColor.copy(alpha = 0.6f), InkSettings.ERASER_RADIUS, last, style = Stroke(width = 1f))
        } else if (n == 2) {
            drawCircle(Color(live.argb), live.width / 2f, last)
        } else {
            val path = Path()
            path.moveTo(pts[0], pts[1])
            var i = 2
            while (i < n) {
                path.lineTo(pts[i], pts[i + 1])
                i += 2
            }
            drawPath(path, Color(live.argb), style = Stroke(width = live.width, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

/** The pen bar: tools, colours, widths, "draw with finger", close. Scrolls sideways when it does not fit (phones). */
@Composable
fun InkBar(ink: InkSettings, p: Palette, onChange: (InkSettings) -> Unit, onClose: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .testTag("ink-bar")
            .background(p.bgSubtle)
            .hairline(p.border)
            .height(44.dp)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        ToolButton("ink-tool-pen", Ic.pen, ink.kind == InkKind.Pen, p) { onChange(ink.copy(kind = InkKind.Pen)) }
        ToolButton("ink-tool-highlighter", Ic.highlighter, ink.kind == InkKind.Highlighter, p) { onChange(ink.copy(kind = InkKind.Highlighter)) }
        ToolButton("ink-tool-eraser", Ic.eraser, ink.kind == InkKind.Eraser, p) { onChange(ink.copy(kind = InkKind.Eraser)) }
        val partial = ink.kind == InkKind.PartialEraser
        Row(
            Modifier
                .testTag("ink-tool-partial")
                .height(32.dp)
                .background(if (partial) p.accentSoft else Color.Transparent, RoundedCornerShape(6.dp))
                .tappable { onChange(ink.copy(kind = InkKind.PartialEraser)) }
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            LIcon(Ic.eraser, 16.dp, if (partial) p.accent else p.text2)
            WText("Partial", 12f, if (partial) p.accent else p.text2, weight = 500, lineHeight = 1f)
        }
        if (!ink.erasing) {
            Divider(p)
            val highlighter = ink.kind == InkKind.Highlighter
            val colors = if (highlighter) InkSettings.HIGHLIGHTER_COLORS else InkSettings.PEN_COLORS
            val chosen = if (highlighter) ink.highlighterColor else ink.penColor
            for (c in colors) {
                Box(
                    Modifier
                        .testTag("ink-color-${c.name.lowercase()}")
                        .size(30.dp)
                        .then(if (c.rgb == chosen) Modifier.border(2.dp, p.accent, CircleShape) else Modifier)
                        .tappable { onChange(if (highlighter) ink.copy(highlighterColor = c.rgb) else ink.copy(penColor = c.rgb)) },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(20.dp).background(Color(0xFF000000.toInt() or c.rgb), CircleShape))
                }
            }
            Divider(p)
            val widths = if (highlighter) InkSettings.HIGHLIGHTER_WIDTHS else InkSettings.PEN_WIDTHS
            val width = if (highlighter) ink.highlighterWidth else ink.penWidth
            val dots = listOf(6.dp, 10.dp, 14.dp)
            widths.forEachIndexed { i, w ->
                Box(
                    Modifier
                        .testTag("ink-width-$i")
                        .size(30.dp)
                        .tappable { onChange(if (highlighter) ink.copy(highlighterWidth = w) else ink.copy(penWidth = w)) },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(dots[i]).background(if (w == width) p.accent else p.text2, CircleShape))
                }
            }
        }
        Divider(p)
        ToolButton("ink-finger", Ic.hand, ink.finger, p) { onChange(ink.copy(finger = !ink.finger)) }
        Spacer(Modifier.width(4.dp))
        ToolButton("ink-close", Ic.x, false, p) { onClose() }
    }
}

@Composable
private fun ToolButton(tag: String, icon: Int, pressed: Boolean, p: Palette, onClick: () -> Unit) {
    Box(
        Modifier
            .testTag(tag)
            .size(width = 36.dp, height = 32.dp)
            .background(if (pressed) p.accentSoft else Color.Transparent, RoundedCornerShape(6.dp))
            .tappable(onClick),
        contentAlignment = Alignment.Center,
    ) {
        LIcon(icon, 18.dp, if (pressed) p.accent else p.text2)
    }
}

@Composable
private fun Divider(p: Palette) {
    Box(Modifier.padding(horizontal = 6.dp).width(1.dp).height(20.dp).background(p.border))
}
