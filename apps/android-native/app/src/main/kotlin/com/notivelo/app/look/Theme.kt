package com.notivelo.app.look

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp

/** Light, Dark, Hybrid (dark chrome, light page; the web's default) or System (LOOK.md 0.3). */
enum class ThemeMode { Light, Dark, Hybrid, System }

val LocalPalette = staticCompositionLocalOf { Palettes.light }

/** Phone sizes (LOOK.md 3.2): body 15 instead of 14, which the web's em-sized text follows. */
val LocalPhone = compositionLocalOf { false }

/** The palette of the chrome (rail, sidebar, drawer, bars, sign-in): dark in Hybrid. */
@Composable
@ReadOnlyComposable
fun pal(): Palette = LocalPalette.current

@Composable
fun NotiveloTheme(mode: ThemeMode = ThemeMode.Hybrid, content: @Composable () -> Unit) {
    val system = isSystemInDarkTheme()
    val p = when (mode) {
        ThemeMode.Light -> Palettes.light
        ThemeMode.Dark, ThemeMode.Hybrid -> Palettes.dark
        ThemeMode.System -> if (system) Palettes.dark else Palettes.light
    }
    val scheme = if (p.dark) {
        darkColorScheme(primary = p.accentSolid, background = p.bg, surface = p.bg, onSurface = p.text, onBackground = p.text)
    } else {
        lightColorScheme(primary = p.accentSolid, background = p.bg, surface = p.bg, onSurface = p.text, onBackground = p.text)
    }
    CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

/**
 * Text as the web sets it (LOOK.md 2): size in dp, a line-height multiplier, weight, tracking in em.
 * The font is the system sans (Roboto): LOOK.md's `--font` stack lists Roboto after SF Pro, Inter and Segoe UI,
 * and none of those ship on Android, so glyph shapes and widths differ a little from the references (Segoe UI).
 */
object WebType {
    val family: FontFamily = FontFamily.SansSerif
    val mono: FontFamily = FontFamily.Monospace

    fun style(size: Float, weight: Int = 400, lineHeight: Float = 1.3f, tracking: Float = 0f): TextStyle = TextStyle(
        fontFamily = family,
        fontSize = size.sp,
        fontWeight = FontWeight(weight),
        lineHeight = (size * lineHeight).sp,
        letterSpacing = (tracking * size).sp,
        lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
    )
}

@Composable
fun WText(
    text: String,
    size: Float,
    color: Color,
    modifier: Modifier = Modifier,
    weight: Int = 400,
    lineHeight: Float = 1.3f,
    tracking: Float = 0f,
    maxLines: Int = 1,
    align: TextAlign? = null,
    underline: Boolean = false,
    strike: Boolean = false,
) {
    Text(
        text = text,
        modifier = modifier,
        color = color,
        style = WebType.style(size, weight, lineHeight, tracking),
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        textAlign = align,
        textDecoration = when {
            underline && strike -> TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
            underline -> TextDecoration.Underline
            strike -> TextDecoration.LineThrough
            else -> null
        },
    )
}
