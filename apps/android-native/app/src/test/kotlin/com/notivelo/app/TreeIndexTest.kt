package com.notivelo.app

import com.notivelo.app.data.TreeIndex
import com.notivelo.core.Tree
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TreeIndexTest {
    private val tree = Tree(
        notebooks = listOf(notebook("b", "Beta", 2.0), notebook("a", "Alpha", 2.0), notebook("c", "Gamma", 1.0)),
        sections = listOf(
            section("s2", "a", "Second", 2.0),
            section("s1", "a", "First", 1.0),
            section("s1b", "a", "Nested b", 2.0, parent = "s1"),
            section("s1a", "a", "Nested a", 1.0, parent = "s1"),
            section("other", "b", "Other", 1.0),
        ),
        pages = listOf(
            page("p2", "s1", "Zebra", 2.0, "2026-11-21T10:00:00Z"),
            page("p1", "s1", "Apple", 2.0, "2026-11-21T11:00:00Z"),
            page("p0", "s1", "First", 1.0, "2026-11-21T09:00:00Z"),
            page("q", "s2", "Elsewhere", 1.0, "2026-11-21T12:00:00Z"),
        ),
    )
    private val index = TreeIndex(tree)

    @Test
    fun notebooksAreOrderedByPositionThenName() {
        assertEquals(listOf("c", "a", "b"), index.notebooks.map { it.id })
    }

    @Test
    fun sectionsNestUnderTheirParentAndAreOrdered() {
        val a = index.notebook("a")!!
        assertEquals(listOf("s1", "s2"), index.sections(a).map { it.id })
        assertEquals(listOf("s1a", "s1b"), index.sections(index.section("s1")!!).map { it.id })
        // Nested sections are not listed at the top level.
        assertEquals(listOf("other"), index.sections(index.notebook("b")!!).map { it.id })
    }

    @Test
    fun pagesAreOrderedByPositionThenTitle() {
        assertEquals(listOf("p0", "p1", "p2"), index.pages(index.section("s1")!!).map { it.id })
        assertEquals(emptyList<String>(), index.pages(index.section("other")!!).map { it.id })
    }

    @Test
    fun recentIsNewestFirst() {
        assertEquals(listOf("q", "p1"), index.recent(2).map { it.id })
    }

    @Test
    fun lookupsAndParents() {
        assertEquals("a", index.notebookOf(index.section("s1a")!!)?.id)
        assertEquals("s1", index.parentOf(index.section("s1a")!!)?.id)
        assertNull(index.parentOf(index.section("s1")!!))
        assertNull(index.page("nope"))
        assertNull(index.section(null))
    }

    @Test
    fun resolveNotebookFallsBackToTheFirst() {
        assertEquals("a", index.resolveNotebook("a")?.id)
        assertEquals("c", index.resolveNotebook("missing")?.id)
        assertEquals("c", index.resolveNotebook(null)?.id)
        assertNull(TreeIndex(Tree(emptyList(), emptyList(), emptyList())).resolveNotebook("x"))
    }
}
