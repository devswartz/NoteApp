package com.notivelo.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.initialsColor
import com.notivelo.app.look.initialsOf
import com.notivelo.app.look.parseHex
import com.notivelo.app.look.pal
import com.notivelo.core.User
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** "Today" for due dates; the look scenes pin it too. */
val LocalToday = compositionLocalOf { LocalDate.now() }

/** "Now" for relative times; the look scenes pin it so their screenshots are the same every run. */
val LocalNow = compositionLocalOf { Instant.now() }

/** A tap target without a ripple (the web's pressed state is a flat fill; rows do not ripple). */
@Composable
fun Modifier.tappable(onClick: () -> Unit): Modifier {
    val source = remember { MutableInteractionSource() }
    return clickable(interactionSource = source, indication = null, onClick = onClick)
}

/** The notebook / workspace tile: a rounded square in [color] with the initial. */
@Composable
fun InitialTile(name: String, color: Color, size: Dp, radius: Dp, fontSize: Float, modifier: Modifier = Modifier) {
    Box(
        modifier.size(size).background(color, RoundedCornerShape(radius)),
        contentAlignment = Alignment.Center,
    ) {
        WText(
            text = name.trim().take(1).uppercase().ifEmpty { "?" },
            size = fontSize, weight = 700, color = Color.White, lineHeight = 1f,
        )
    }
}

/** The workspace logo (LOOK.md 1.1: 135 degree gradient #6366f1 to #8b5cf6, initial in white). */
@Composable
fun WorkspaceLogo(name: String, size: Dp, radius: Dp, fontSize: Float, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(size)
            .background(
                Brush.linearGradient(listOf(Color(0xFF6366F1), Color(0xFF8B5CF6))),
                RoundedCornerShape(radius),
            ),
        contentAlignment = Alignment.Center,
    ) {
        WText(text = name.trim().take(1).uppercase().ifEmpty { "?" }, size = fontSize, weight = 700, color = Color.White, lineHeight = 1f)
    }
}

/** A user's avatar: their colour, initials in white or black (whichever contrasts), 42 % of the size. */
@Composable
fun Avatar(user: User?, size: Dp, modifier: Modifier = Modifier) {
    val color = parseHex(user?.color ?: "#6366f1")
    Box(modifier.size(size).background(color, CircleShape), contentAlignment = Alignment.Center) {
        WText(
            text = initialsOf(user?.name ?: ""),
            size = size.value * 0.42f, weight = 600, color = initialsColor(color), lineHeight = 1f, tracking = -0.02f,
        )
    }
}

/** A 1 dp hairline across the bottom or top edge. */
fun Modifier.hairline(color: Color, top: Boolean = false): Modifier = drawBehind {
    val y = if (top) 0.5.dp.toPx() else size.height - 0.5.dp.toPx()
    drawLine(color, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
}

/** A 1 dp rule down the left edge. */
fun Modifier.leftRule(color: Color): Modifier = drawBehind {
    drawLine(color, Offset(0.5.dp.toPx(), 0f), Offset(0.5.dp.toPx(), size.height), strokeWidth = 1.dp.toPx())
}

/** A 1 dp rule down the right edge. */
fun Modifier.rightRule(color: Color): Modifier = drawBehind {
    drawLine(color, Offset(size.width - 0.5.dp.toPx(), 0f), Offset(size.width - 0.5.dp.toPx(), size.height), strokeWidth = 1.dp.toPx())
}

/** A secondary button as the web draws it (`.btn`, small): elevated fill, 1 dp border, radius 8, 28 high. */
@Composable
fun SecondaryButton(
    label: String,
    iconRes: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    textSize: Float = 13f,
) {
    val p = pal()
    val shape = RoundedCornerShape(8.dp)
    Row(
        modifier
            .height(28.dp)
            .background(p.bgElevated, shape)
            .border(1.dp, p.border, shape)
            .tappable(onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LIcon(iconRes, 14.dp, p.text)
        WText(label, textSize, p.text, weight = 500, lineHeight = 1f)
    }
}

/** "just now", "3m ago", "2h ago", "4d ago", then a short date (LOOK.md 6). */
fun relativeTime(iso: String, now: Instant): String {
    val then = try {
        Instant.parse(iso)
    } catch (e: Exception) {
        return ""
    }
    val d = Duration.between(then, now)
    val minutes = d.toMinutes()
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        d.toHours() < 24 -> "${d.toHours()}h ago"
        d.toDays() < 7 -> "${d.toDays()}d ago"
        else -> {
            val date = then.atZone(ZoneId.systemDefault()).toLocalDate()
            val fmt = if (date.year == LocalDate.now(ZoneId.systemDefault()).year) "d MMM" else "d MMM yyyy"
            DateTimeFormatter.ofPattern(fmt, Locale.UK).format(date)
        }
    }
}
