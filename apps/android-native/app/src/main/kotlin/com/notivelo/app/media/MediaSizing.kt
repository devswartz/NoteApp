package com.notivelo.app.media

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Which picker: the slash menu's Image and File attachment, the ribbon's Insert group. */
enum class MediaKind { Image, File }

/** A file the person picked or pasted, ready to upload. */
class PickedFile(val name: String, val bytes: ByteArray)

/** Sizes and node arguments for images and file cards: the web's `img` (max-width 100%, height auto) and `insertFiles`. All in dp. */
object MediaSizing {
    /** An image node once its picture is known: its own width (or the natural one) capped to the room, the picture's aspect. */
    fun imageSize(attrW: Double?, attrH: Double?, naturalW: Int, naturalH: Int, avail: Float): Pair<Float, Float> {
        if (naturalW <= 0 || naturalH <= 0) return placeholderSize(attrW, attrH, avail)
        val wanted = attrW?.takeIf { it > 0 }?.toFloat() ?: naturalW.toFloat()
        val w = max(min(wanted, avail), 1f)
        return w to (w * naturalH / naturalW).roundToInt().toFloat()
    }

    /** While the picture loads, or when it can't: a box of the saved size (320 wide by 0.6 when nothing is saved), at least 40 high. */
    fun placeholderSize(attrW: Double?, attrH: Double?, avail: Float): Pair<Float, Float> {
        val aw = attrW?.takeIf { it > 0 }
        val ah = attrH?.takeIf { it > 0 }
        val w = max(min(aw?.toFloat() ?: 320f, avail), 60f)
        var h = w * 0.6f
        if (aw != null && ah != null) h = (w * ah / aw).toFloat()
        return w to max(h.roundToInt().toFloat(), 40f)
    }

    /** The web draws image types except HEIC and SVG as images; anything else is a file card. */
    fun isImage(mime: String): Boolean {
        val m = mime.lowercase()
        return m.startsWith("image/") && m != "image/heic" && m != "image/heif" && !m.contains("svg")
    }

    /** The editor command and its JSON arguments for an uploaded file (`insertImage` / `insertFile`). */
    fun insertCommand(url: String, name: String, mime: String, size: Long): Pair<String, String> =
        if (isImage(mime)) {
            "insertImage" to """{"src":${quote(url)},"alt":${quote(name)}}"""
        } else {
            "insertFile" to """{"url":${quote(url)},"name":${quote(name)},"size":$size,"mime":${quote(mime)}}"""
        }

    /** A power-of-two `inSampleSize` that keeps the picture's longer side near [maxDim] without going below it. */
    fun sampleSize(w: Int, h: Int, maxDim: Int): Int {
        var s = 1
        var longest = max(w, h)
        while (longest / 2 >= maxDim) {
            s *= 2
            longest /= 2
        }
        return s
    }

    /** "1.4 MB" / "12 KB", as the file card writes sizes. */
    fun sizeText(bytes: Double): String =
        if (bytes >= 1_048_576) String.format(java.util.Locale.US, "%.1f MB", bytes / 1_048_576) else "${Math.round(bytes / 1024)} KB"

    /** A safe file name for the cache: no separators, and an extension (from the type when the name has none). */
    fun cleanName(name: String, mime: String): String {
        var n = name.replace('/', '-').replace('\\', '-').replace(':', '-').trim()
        if (n.isEmpty()) n = "file"
        if (!n.contains('.')) {
            val ext = when (mime.lowercase()) {
                "image/png" -> "png"
                "image/jpeg" -> "jpg"
                "image/gif" -> "gif"
                "image/webp" -> "webp"
                "application/pdf" -> "pdf"
                "text/plain" -> "txt"
                else -> null
            }
            if (ext != null) n += ".$ext"
        }
        return n
    }

    internal fun quote(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' -> b.append("\\\"")
                c == '\\' -> b.append("\\\\")
                c == '\n' -> b.append("\\n")
                c == '\r' -> b.append("\\r")
                c == '\t' -> b.append("\\t")
                c < ' ' -> b.append(String.format("\\u%04x", c.code))
                else -> b.append(c)
            }
        }
        return b.append('"').toString()
    }
}
