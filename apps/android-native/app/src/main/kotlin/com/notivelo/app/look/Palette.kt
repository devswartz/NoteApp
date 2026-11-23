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

/** The page's palette variants (Theme.swift `hybridPage`, `tinted`): Hybrid's page is the light palette on #fcfcfa. */
object PagePalettes {
    fun hybrid(): Palette = Palettes.light.recolor(bg = Color(0xFFFCFCFA), bgSubtle = Color(0xFFF9F9F7))

    /** The page colour (none, yellow, green, blue, purple, pink, grey) replaces `--bg`; muted text becomes `--page-text-muted`. */
    fun tinted(base: Palette, name: String): Palette {
        val t = mapOf(
            "yellow" to (0xFDF8E3 to 0x221F1A), "green" to (0xEFF7F0 to 0x1A1F1C), "blue" to (0xEEF4FB to 0x1A1D24),
            "purple" to (0xF5F1FB to 0x1E1B24), "pink" to (0xFCF1F5 to 0x221B1F), "grey" to (0xF4F4F5 to 0x1F1F22),
        )[name] ?: return base
        val muted = if (base.dark) Color(0xFFA3A3AC) else Color(0xFF5C5C65)
        return base.recolor(bg = Color(0xFF000000L or (if (base.dark) t.second else t.first).toLong()), textMuted = muted, textPlaceholder = muted)
    }

    /** `--page-rule`: the rule lines and grid. */
    fun rule(base: Palette): Color = if (base.dark) Color(150 / 255f, 170 / 255f, 220 / 255f, .12f) else Color(70 / 255f, 110 / 255f, 180 / 255f, .15f)

    /** Text colours (`--tc-*`), src/styles/colors.css. */
    fun textColor(base: Palette, name: String): Color? {
        val t = mapOf(
            "gray" to (0x6B6B74 to 0xA3A3AD), "grey" to (0x6B6B74 to 0xA3A3AD), "red" to (0xC42B2B to 0xF47C7C), "orange" to (0xB4500C to 0xF5A05A),
            "yellow" to (0x8C6400 to 0xE9C53A), "green" to (0x22783A to 0x5FCF80), "blue" to (0x1F62C4 to 0x6EA8F7),
            "purple" to (0x7A3FD6 to 0xB893F5), "pink" to (0xBB2A75 to 0xF07FB6),
        )[name] ?: return null
        return Color(0xFF000000L or (if (base.dark) t.second else t.first).toLong())
    }

    /** Highlights (`--hl-*`); none is yellow. */
    fun highlight(base: Palette, name: String?): Color {
        val h = mapOf(
            "gray" to (0xE9E9EC to 0x3A3A41), "grey" to (0xE9E9EC to 0x3A3A41), "red" to (0xFDE0DE to 0x5B2727), "orange" to (0xFDE6CF to 0x563318),
            "yellow" to (0xFCF0B0 to 0x4F4313), "green" to (0xD9F2DC to 0x1F4529), "blue" to (0xDBE8FD to 0x1E3A5C),
            "purple" to (0xEBE2FC to 0x3C2B5E), "pink" to (0xFBDEEC to 0x552240),
        )
        val v = h[name ?: "yellow"] ?: h.getValue("yellow")
        return Color(0xFF000000L or (if (base.dark) v.second else v.first).toLong())
    }
}

fun Palette.recolor(
    bg: Color = this.bg,
    bgSubtle: Color = this.bgSubtle,
    textMuted: Color = this.textMuted,
    textPlaceholder: Color = this.textPlaceholder,
): Palette = Palette(
    dark, bg, bgSubtle, bgSidebar, bgHover, bgPressed, bgActive, bgElevated, bgOverlay, bgInverse, border, borderStrong,
    text, text2, textMuted, textPlaceholder, textInverse, textOnAccent, accent, accentHover, accentSoft, accentSolid,
    accentSolidHover, accentInverse, danger, success, warn, p1, p2, p3, shadow, shadowLg,
)
