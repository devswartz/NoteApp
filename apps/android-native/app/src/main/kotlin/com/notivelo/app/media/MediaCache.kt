package com.notivelo.app.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import androidx.compose.runtime.staticCompositionLocalOf
import com.notivelo.app.data.MediaHooks
import com.notivelo.app.data.OpenFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** A decoded picture with the size it has on the server ([bitmap] may be scaled down for memory; the natural size drives the layout). */
class MediaImage(val bitmap: Bitmap, val naturalW: Int, val naturalH: Int)

val LocalMedia = staticCompositionLocalOf<MediaCache?> { null }

/**
 * Pictures of the page: a memory cache of decoded bitmaps over a disk cache of the files, filled through [fetch] (the core's
 * authenticated `downloadFile`). Fetching and decoding run on the IO dispatcher; [peek] is for drawing and never blocks.
 */
class MediaCache(private val dir: File, private val fetch: (String) -> ByteArray, private val maxDim: Int = 2048) {
    private val memory = object : LruCache<String, MediaImage>((Runtime.getRuntime().maxMemory() / 8).toInt().coerceIn(8 shl 20, 96 shl 20)) {
        override fun sizeOf(key: String, value: MediaImage): Int = value.bitmap.byteCount
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val inflight = HashMap<String, Deferred<MediaImage?>>()
    private val failedAt = HashMap<String, Long>()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    /** The decoded picture if it is in memory. */
    fun peek(src: String): MediaImage? = memory.get(src)

    /** Start loading [src] if it isn't there (drawing code calls this and waits for a listener). */
    fun request(src: String) {
        if (src.isEmpty() || peek(src) != null) return
        scope.launch { load(src) }
    }

    /** The picture: from memory, the disk or the server. Null when it can't be fetched (tried again after 30 s) or decoded. */
    suspend fun load(src: String): MediaImage? {
        if (src.isEmpty()) return null
        peek(src)?.let { return it }
        val job: Deferred<MediaImage?>? = synchronized(this) {
            val t = failedAt[src]
            if (t != null && System.currentTimeMillis() - t < RETRY_MS) {
                null
            } else {
                inflight.getOrPut(src) {
                    scope.async {
                        try {
                            decodeFrom(src)
                        } finally {
                            synchronized(this@MediaCache) { inflight.remove(src) }
                        }
                    }
                }
            }
        }
        return job?.await()
    }

    /** Called (on the main thread) whenever a picture finished loading. Returns the call that removes the listener. */
    fun addListener(l: () -> Unit): () -> Unit {
        listeners.add(l)
        return { listeners.remove(l) }
    }

    /** A picture we just uploaded: keep its bytes and show it at once. */
    fun store(src: String, bytes: ByteArray) {
        scope.launch {
            try {
                dir.mkdirs()
                File(dir, fileName(src)).writeBytes(bytes)
            } catch (e: Exception) {
            }
            val img = decode(bytes) ?: return@launch
            memory.put(src, img)
            notifyLoaded()
        }
    }

    private fun decodeFrom(src: String): MediaImage? {
        val file = File(dir, fileName(src))
        var bytes: ByteArray? = try { if (file.isFile) file.readBytes() else null } catch (e: Exception) { null }
        if (bytes == null) {
            bytes = try {
                fetch(src)
            } catch (e: Exception) {
                synchronized(this) { failedAt[src] = System.currentTimeMillis() }
                return null
            }
            try {
                dir.mkdirs()
                file.writeBytes(bytes)
            } catch (e: Exception) {
            }
        }
        val img = decode(bytes)
        if (img == null) {
            try { file.delete() } catch (e: Exception) { }
            synchronized(this) { failedAt[src] = System.currentTimeMillis() }
            return null
        }
        memory.put(src, img)
        notifyLoaded()
        return img
    }

    private fun decode(bytes: ByteArray): MediaImage? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = MediaSizing.sampleSize(bounds.outWidth, bounds.outHeight, maxDim) }
        var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
        var w = bounds.outWidth
        var h = bounds.outHeight
        val degrees = try {
            when (android.media.ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) {
                6 -> 90f
                3 -> 180f
                8 -> 270f
                else -> 0f
            }
        } catch (e: Exception) {
            0f
        }
        if (degrees != 0f) {
            val m = Matrix().apply { postRotate(degrees) }
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
            if (degrees != 180f) {
                val t = w
                w = h
                h = t
            }
        }
        return MediaImage(bmp, w, h)
    }

    private fun notifyLoaded() {
        main.post { for (l in listeners) l() }
    }

    private fun fileName(src: String): String = src.replace(Regex("[^A-Za-z0-9._-]"), "_").takeLast(120)

    companion object {
        private const val RETRY_MS = 30_000L
    }
}

/** The device side of media for the view model and the views: the picture cache, and downloads written for the FileProvider. */
class AppMedia(cacheDir: File, fetch: (String) -> ByteArray) : MediaHooks {
    val cache = MediaCache(File(cacheDir, "media"), fetch)
    private val openDir = File(cacheDir, "open")
    private var counter = 0

    init {
        try { openDir.deleteRecursively() } catch (e: Exception) { }
    }

    override fun remember(src: String, bytes: ByteArray) = cache.store(src, bytes)

    @Synchronized
    override fun saveForOpen(name: String, mime: String, bytes: ByteArray): OpenFile? = try {
        val clean = MediaSizing.cleanName(name, mime)
        val folder = File(openDir, "${System.currentTimeMillis()}-${counter++}")
        folder.mkdirs()
        val file = File(folder, clean)
        file.writeBytes(bytes)
        OpenFile(file.path, clean, mime)
    } catch (e: Exception) {
        null
    }
}
