package com.notivelo.app

import com.notivelo.app.media.MediaSizing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaSizingTest {
    @Test
    fun aLoadedPictureKeepsItsAspectAndFitsTheRoom() {
        // Natural size, room to spare.
        assertEquals(400f to 300f, MediaSizing.imageSize(null, null, 400, 300, 700f))
        // Wider than the box: max-width 100%.
        assertEquals(500f to 250f, MediaSizing.imageSize(null, null, 1000, 500, 500f))
        // A saved width wins over the natural one, still capped.
        assertEquals(200f to 100f, MediaSizing.imageSize(200.0, 120.0, 1000, 500, 500f))
        assertEquals(300f to 150f, MediaSizing.imageSize(900.0, null, 1000, 500, 300f))
        // Heights round, as the web's layout does.
        assertEquals(333f to 250f, MediaSizing.imageSize(null, null, 1333, 1000, 333f))
    }

    @Test
    fun aPlaceholderHasTheSavedSizeOrADefault() {
        assertEquals(320f to 192f, MediaSizing.placeholderSize(null, null, 700f))
        assertEquals(200f to 100f, MediaSizing.placeholderSize(200.0, 100.0, 700f))
        // Capped to the room, aspect kept, never below 60 x 40.
        assertEquals(300f to 150f, MediaSizing.placeholderSize(600.0, 300.0, 300f))
        assertEquals(60f to 40f, MediaSizing.placeholderSize(10.0, 5.0, 700f))
    }

    @Test
    fun theWebsTypeRulePicksImagesFromFiles() {
        assertTrue(MediaSizing.isImage("image/png"))
        assertTrue(MediaSizing.isImage("IMAGE/JPEG"))
        assertFalse(MediaSizing.isImage("image/heic"))
        assertFalse(MediaSizing.isImage("image/svg+xml"))
        assertFalse(MediaSizing.isImage("application/pdf"))
        assertFalse(MediaSizing.isImage(""))
    }

    @Test
    fun insertCommandsCarryTheUploadsPathNameAndSize() {
        assertEquals("insertImage" to """{"src":"/uploads/a.png","alt":"a.png"}""", MediaSizing.insertCommand("/uploads/a.png", "a.png", "image/png", 10))
        assertEquals(
            "insertFile" to """{"url":"/uploads/b.pdf","name":"b \"x\".pdf","size":2048,"mime":"application/pdf"}""",
            MediaSizing.insertCommand("/uploads/b.pdf", "b \"x\".pdf", "application/pdf", 2048),
        )
        assertEquals("\"a\\nb\\\\\"", MediaSizing.quote("a\nb\\"))
    }

    @Test
    fun bigPicturesAreDecodedSmallerInPowersOfTwo() {
        assertEquals(1, MediaSizing.sampleSize(1000, 800, 2048))
        assertEquals(1, MediaSizing.sampleSize(3000, 2000, 2048))
        assertEquals(2, MediaSizing.sampleSize(4096, 3000, 2048))
        assertEquals(4, MediaSizing.sampleSize(8200, 6000, 2048))
    }

    @Test
    fun fileNamesAreSafeAndHaveAnExtension() {
        assertEquals("a-b.png", MediaSizing.cleanName("a/b", "image/png"))
        assertEquals("file.pdf", MediaSizing.cleanName("  ", "application/pdf"))
        assertEquals("notes.txt", MediaSizing.cleanName("notes.txt", "text/plain"))
        assertEquals("1.4 MB", MediaSizing.sizeText(1_500_000.0))
        assertEquals("2 KB", MediaSizing.sizeText(2048.0))
    }
}
