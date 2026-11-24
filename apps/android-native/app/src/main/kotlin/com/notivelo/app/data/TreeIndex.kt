package com.notivelo.app.data

import com.notivelo.core.Notebook
import com.notivelo.core.PageMeta
import com.notivelo.core.Section
import com.notivelo.core.Task
import com.notivelo.core.Tree

/** The tree in the server's order (`position`, then name), as the web and the Apple app list it. */
class TreeIndex(tree: Tree) {
    val notebooks: List<Notebook> = tree.notebooks.sortedWith(compareBy<Notebook>({ it.position }, { it.name }))
    val pages: List<PageMeta> = tree.pages
    private val sectionsByParent: Map<String, List<Section>> = tree.sections
        .groupBy { s -> s.parentId?.let { "s:$it" } ?: "n:${s.notebookId}" }
        .mapValues { (_, list) -> list.sortedWith(compareBy<Section>({ it.position }, { it.name })) }
    private val pagesBySection: Map<String, List<PageMeta>> = tree.pages
        .groupBy { it.sectionId }
        .mapValues { (_, list) -> list.sortedWith(compareBy<PageMeta>({ it.position }, { it.title })) }
    private val sectionById = tree.sections.associateBy { it.id }
    private val pageById = tree.pages.associateBy { it.id }
    private val notebookById = tree.notebooks.associateBy { it.id }

    fun notebook(id: String?): Notebook? = id?.let { notebookById[it] }
    fun section(id: String?): Section? = id?.let { sectionById[it] }
    fun page(id: String?): PageMeta? = id?.let { pageById[it] }

    fun sections(notebook: Notebook): List<Section> = sectionsByParent["n:${notebook.id}"].orEmpty()
    fun sections(parent: Section): List<Section> = sectionsByParent["s:${parent.id}"].orEmpty()
    fun pages(section: Section): List<PageMeta> = pagesBySection[section.id].orEmpty()

    /** The notebook a section (at any depth) belongs to. */
    fun notebookOf(section: Section): Notebook? = notebook(section.notebookId)

    /** The section a section is nested in, if any. */
    fun parentOf(section: Section): Section? = section(section.parentId)

    /** The most recently edited pages, newest first (the Notes overview shows eight). */
    fun recent(limit: Int): List<PageMeta> = pages.sortedByDescending { it.updatedAt }.take(limit)

    /** The notebook for a saved choice, or the first one. */
    fun resolveNotebook(wanted: String?): Notebook? = notebook(wanted) ?: notebooks.firstOrNull()
}

/** Open (not done) tasks per page, for the counts on page rows. */
fun openTaskCounts(tasks: List<Task>): Map<String, Int> =
    tasks.filter { !it.done && it.pageId != null }.groupingBy { it.pageId!! }.eachCount()
