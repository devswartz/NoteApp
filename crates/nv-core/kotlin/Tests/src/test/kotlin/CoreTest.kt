// The Core API from Kotlin on corpus pages: proves libnv_core loads through JNA and the uniffi bindings work.
// Run by crates/nv-core/test-kotlin-jvm.sh (CI: .github/workflows/android-core.yml); NV_CORPUS_DIR is tests/corpus.
import com.notivelo.core.*
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CoreTest {
    private fun corpus(name: String, file: String): File {
        val dir = System.getenv("NV_CORPUS_DIR") ?: error("NV_CORPUS_DIR is not set")
        return File(dir, "cases/$name/$file")
    }

    private fun page(name: String): ByteArray = corpus(name, "page.bin").readBytes()

    @Test
    fun coreVersionIsNotEmpty() {
        assertTrue(coreVersion().isNotEmpty())
        assertEquals(2u, pageFormatVersion())
    }

    @Test
    fun readsADocumentPage() {
        val info = readPage(page("document-page"))
        val expected = corpus("document-page", "expected.json").readText()
        val kind = Regex("\"kind\"\\s*:\\s*\"(\\w+)\"").find(expected)!!.groupValues[1]
        assertEquals(kind, info.kind.name.lowercase())
        assertFalse(info.newerFormat)
        assertEquals(corpus("document-page", "page.txt").readText(), info.text)
        // The first node is the heading "Heading one" (expected.json), whose text is the page's first line.
        assertEquals(NodeKind.Heading, info.content[0].nodes[0].kind)
        assertTrue(info.text.startsWith("Heading one"))
    }

    @Test
    fun readsACanvas() {
        val info = readPage(page("canvas-boxes"))
        assertEquals(PageKind.CANVAS, info.kind)
        assertEquals(listOf("top", "a", "b", "c", "empty", "blank"), info.boxes.map { it.id })
        assertEquals("Top box", info.headings.first().text)
    }

    @Test
    fun boxContent() {
        val content = pageContent(page("lists"))
        assertNull(content.first().boxId)
        assertEquals("b1", content.last().boxId)
        assertEquals(NodeKind.BulletList, content.last().nodes.first().kind)
        val ordered = content.last().nodes.first { it.kind == NodeKind.OrderedList }
        assertEquals(listOf("1.", "2.", "3."), ordered.markers)
        val info = readPage(page("document-page"))
        val runs = info.content[0].nodes.flatMap { it.children }.flatMap { it.runs }
        assertTrue(runs.any { it.text == "bold" && it.marks == listOf<Mark>(Mark.Bold) })
    }

    @Test
    fun errorsAndMarkers() {
        assertFailsWith<CoreException.InvalidPage> { readPage(byteArrayOf(1, 2, 3)) }
        assertEquals("MCMXCIV", listMarker("I", 1994L))
    }

    @Test
    fun coreNeedsASignIn() {
        Core("http://127.0.0.1:9").use { core ->
            assertNull(core.user())
            assertFailsWith<CoreException.SignedOut> { core.workspaces() }
        }
    }

    @Test
    fun coreWithAStore() {
        val dir = File(System.getProperty("java.io.tmpdir"), "nv-store-" + System.nanoTime())
        try {
            Core.withStore("http://127.0.0.1:9", File(dir, "store.db").path).use { core ->
                assertTrue(core.hasStore())
                assertNull(core.cachedWorkspaces())
                core.signOut()
            }
            assertTrue(File(dir, "store.db").exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    // A foreign trait implemented in Kotlin is called from a core thread (the page's own thread).
    private class Heard : LivePageListener {
        val statuses = ConcurrentLinkedQueue<LiveStatus>()
        val ended = CountDownLatch(1)
        override fun onStatus(status: LiveStatus) {
            statuses.add(status)
            if (status is LiveStatus.Ended) ended.countDown()
        }
        override fun onChange(page: PageInfo) {}
    }

    @Test
    fun aLivePageWithoutASessionEnds() {
        Core("http://127.0.0.1:9").use { core ->
            val heard = Heard()
            core.openLivePage("p1", heard).use { page ->
                assertTrue(heard.ended.await(10, TimeUnit.SECONDS))
                assertTrue(heard.statuses.first() is LiveStatus.Connecting)
                assertTrue(heard.statuses.last() is LiveStatus.Ended)
                assertEquals(0u, page.unsentUpdates())
                page.close()
            }
            assertTrue(core.unsentPages().isEmpty())
        }
    }
}
