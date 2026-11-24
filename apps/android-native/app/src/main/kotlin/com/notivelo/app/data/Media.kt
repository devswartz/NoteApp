package com.notivelo.app.data

/** A file the server stored (what `Core.uploadFile` answers): [url] is the plain `/uploads/...` path documents keep. */
class Uploaded(val url: String, val name: String, val mime: String, val size: Long)

/** A stored file's bytes and the type it was served as. */
class Downloaded(val bytes: ByteArray, val mime: String)

/** A downloaded file written to the cache, ready for an `ACTION_VIEW` intent (through the FileProvider). */
data class OpenFile(val path: String, val name: String, val mime: String)

/** What the view model needs from the device for media: a place for downloads to open, and the picture cache. */
interface MediaHooks {
    /** Write a download to the cache folder the FileProvider shares; null when it can't be written. */
    fun saveForOpen(name: String, mime: String, bytes: ByteArray): OpenFile?

    /** An uploaded picture is in hand: show it without fetching it back. */
    fun remember(src: String, bytes: ByteArray)
}

object NoMediaHooks : MediaHooks {
    override fun saveForOpen(name: String, mime: String, bytes: ByteArray): OpenFile? = null
    override fun remember(src: String, bytes: ByteArray) {}
}
