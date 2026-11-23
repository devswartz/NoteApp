package com.notivelo.app.look

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * The web app's colour tokens (docs/rewrite/LOOK.md section 1.1, `src/styles.css`), light and dark.
 * Hybrid uses [Palettes.dark] for all chrome and [Palettes.light] on the note page. Accent: Blue (the default).
 * `--bg-active` is the accent at 9 % (light) / 15 % (dark), `--accent-soft` 10 % / 15 %.
 */
@Immutable
class Palette(
    val dark: Boolean,
    val bg: Color,
    val bgSubtle: Color,
    val bgSidebar: Color,
    val bgHover: Color,
    val bgPressed: Color,
    val bgActive: Color,
    val bgElevated: Color,
    val bgOverlay: Color,
    val bgInverse: Color,
    val border: Color,
    val borderStrong: Color,
    val text: Color,
    val text2: Color,
    val textMuted: Color,
    val textPlaceholder: Color,
    val textInverse: Color,
    val textOnAccent: Color,
    val accent: Color,
    val accentHover: Color,
    val accentSoft: Color,
    val accentSolid: Color,
    val accentSolidHover: Color,
    val accentInverse: Color,
    val danger: Color,
    val success: Color,
    val warn: Color,
    val p1: Color,
    val p2: Color,
    val p3: Color,
    /** The two layers of `--shadow` / the sign-in card (rgba of the shadow colour). */
    val shadow: Color,
    val shadowLg: Color,
)

private fun rgba(r: Int, g: Int, b: Int, a: Float) = Color(r / 255f, g / 255f, b / 255f, a)

object Palettes {
    private val blue = Color(0xFF4F46E5)
    private val blueDark = Color(0xFF8B95F9)

    val light = Palette(
        dark = false,
        bg = Color(0xFFFFFFFF),
        bgSubtle = Color(0xFFF9F9FB),
        bgSidebar = Color(0xFFF7F7F8),
        bgHover = rgba(15, 15, 30, .05f),
        bgPressed = rgba(15, 15, 30, .09f),
        bgActive = blue.copy(alpha = .09f),
        bgElevated = Color(0xFFFFFFFF),
        bgOverlay = rgba(10, 10, 20, .32f),
        bgInverse = Color(0xFF1F1F23),
        border = Color(0xFFE7E7EA),
        borderStrong = Color(0xFFD4D4D8),
        text = Color(0xFF1F1F23),
        text2 = Color(0xFF52525B),
        textMuted = Color(0xFF686871),
        textPlaceholder = Color(0xFF75757F),
        textInverse = Color(0xFFFAFAFA),
        textOnAccent = Color(0xFFFFFFFF),
        accent = blue,
        accentHover = Color(0xFF4338CA),
        accentSoft = blue.copy(alpha = .10f),
        accentSolid = blue,
        accentSolidHover = Color(0xFF4338CA),
        accentInverse = Color(0xFFA5B4FC),
        danger = Color(0xFFDC2626),
        success = Color(0xFF16A34A),
        warn = Color(0xFFD97706),
        p1 = Color(0xFFDC2626),
        p2 = Color(0xFFEA8C00),
        p3 = Color(0xFF2563EB),
        shadow = rgba(15, 15, 30, .08f),
        shadowLg = rgba(15, 15, 30, .18f),
    )

    val dark = Palette(
        dark = true,
        bg = Color(0xFF18181B),
        bgSubtle = Color(0xFF1D1D21),
        bgSidebar = Color(0xFF141416),
        bgHover = rgba(255, 255, 255, .06f),
        bgPressed = rgba(255, 255, 255, .10f),
        bgActive = blueDark.copy(alpha = .15f),
        bgElevated = Color(0xFF232328),
        bgOverlay = rgba(0, 0, 0, .5f),
        bgInverse = Color(0xFFF4F4F5),
        border = Color(0xFF2C2C32),
        borderStrong = Color(0xFF3A3A42),
        text = Color(0xFFECECEF),
        text2 = Color(0xFFB4B4BC),
        textMuted = Color(0xFF9D9DA6),
        textPlaceholder = Color(0xFF8E8E98),
        textInverse = Color(0xFF18181B),
        textOnAccent = Color(0xFFFFFFFF),
        accent = blueDark,
        accentHover = Color(0xFFA5B4FC),
        accentSoft = blueDark.copy(alpha = .15f),
        accentSolid = Color(0xFF5B5BD6),
        accentSolidHover = Color(0xFF4B4BC4),
        accentInverse = Color(0xFF4F46E5),
        danger = Color(0xFFF87171),
        success = Color(0xFF4ADE80),
        warn = Color(0xFFFBBF24),
        p1 = Color(0xFFF87171),
        p2 = Color(0xFFFB923C),
        p3 = Color(0xFF60A5FA),
        shadow = rgba(0, 0, 0, .4f),
        shadowLg = rgba(0, 0, 0, .55f),
    )
}

/** `#rrggbb` (a notebook, section or user colour) as a [Color]. */
fun parseHex(hex: String, fallback: Color = Color(0xFF6366F1)): Color {
    val h = hex.removePrefix("#")
    val v = if (h.length == 6) h.toLongOrNull(16) else null
    return if (v == null) fallback else Color(0xFF000000L or v)
}

/** White or black text, whichever contrasts more with [bg] (WCAG luminance), for avatar initials. */
fun initialsColor(bg: Color): Color {
    fun lin(c: Float) = if (c <= 0.03928f) c / 12.92f else Math.pow(((c + 0.055f) / 1.055f).toDouble(), 2.4).toFloat()
    val l = 0.2126f * lin(bg.red) + 0.7152f * lin(bg.green) + 0.0722f * lin(bg.blue)
    val white = 1.05f / (l + 0.05f)
    val black = (l + 0.05f) / 0.05f
    return if (white >= black) Color.White else Color.Black
}

/** "Demo User" -> "DU". */
fun initialsOf(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return when {
        parts.isEmpty() -> "?"
        parts.size == 1 -> parts[0].take(2).uppercase()
        else -> (parts.first().take(1) + parts.last().take(1)).uppercase()
    }
}
