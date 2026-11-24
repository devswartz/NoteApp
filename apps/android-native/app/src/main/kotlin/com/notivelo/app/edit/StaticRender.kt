package com.notivelo.app.edit

import com.notivelo.core.ClipboardData
import com.notivelo.core.EditorSuggestion
import com.notivelo.core.SuggestionItem
import com.notivelo.core.SuggestionTrigger
import com.notivelo.core.ViewActive
import com.notivelo.core.ViewLine
import com.notivelo.core.ViewMarked
import com.notivelo.core.ViewRange
import com.notivelo.core.ViewRender
import com.notivelo.core.ViewState

/** A line of a frame built by hand (the look scenes and the tests have no native core). */
class LineSpec(
    val text: String,
    val kind: String = "paragraph",
    val level: Int = 0,
    val containers: List<String> = emptyList(),
    val marker: String? = null,
    val checked: Boolean? = null,
)

/** Frames as the core would return them for simple boxes. Positions are the offsets: nothing here maps them. */
object StaticRender {
    fun of(
        lines: List<LineSpec>,
        anchor: Int,
        head: Int = anchor,
        revision: Long = 1,
        textRevision: Long = 1,
        marked: IntRange? = null,
        suggestion: EditorSuggestion? = null,
    ): ViewRender {
        val text = lines.joinToString("\n") { it.text }
        var offset = 0
        val view = lines.map { l ->
            val line = ViewLine(
                offset = offset.toUInt(), len = l.text.length.toUInt(), pos = offset.toUInt(), isText = true, kind = l.kind,
                level = l.level.toUByte(), containers = l.containers, marker = l.marker, checked = l.checked, taskId = null,
                runs = if (l.text.isEmpty()) emptyList() else listOf(com.notivelo.core.ViewRun(0u, l.text.length.toUInt(), emptyList())),
                atoms = emptyList(), attrsJson = null,
            )
            offset += l.text.length + 1
            line
        }
        return ViewRender(
            revision = revision.toULong(),
            textRevision = textRevision.toULong(),
            view = ViewState(
                text = text, len = text.length.toUInt(), lines = view,
                selection = ViewRange(anchor.toUInt(), head.toUInt()),
                marked = marked?.let { ViewMarked(it.first.toUInt(), (it.last + 1).toUInt(), (it.last + 1).toUInt(), (it.last + 1).toUInt()) },
            ),
            suggestion = suggestion, focusTaskId = null, remoteCursors = emptyList(), canUndo = false, canRedo = false,
            active = ViewActive(emptyList(), "paragraph", 0.toUByte(), null, false, false),
        )
    }

    /** The slash menu's items (docs/rewrite/LOOK.md 4.7) with the first highlighted, as the engine reports them for `/`. */
    fun slash(query: String = "", viewFrom: Int = 0, highlighted: Int = 0): EditorSuggestion {
        val items = listOf(
            SuggestionItem("Task", "Task", "A real task, synced to your dashboard", "circle-check"),
            SuggestionItem("Text", "Text", "Plain paragraph", "type"),
            SuggestionItem("Heading 1", "Heading 1", "Large section heading", "heading-1"),
            SuggestionItem("Heading 2", "Heading 2", "Medium section heading", "heading-2"),
            SuggestionItem("Heading 3", "Heading 3", "Small section heading", "heading-3"),
            SuggestionItem("Checklist", "Checklist", "Simple checkboxes (not tracked as tasks)", "square-check-big"),
            SuggestionItem("Bulleted list", "Bulleted list", "Simple bulleted list", "list"),
            SuggestionItem("Numbered list", "Numbered list", "List with numbering", "list-ordered"),
            SuggestionItem("Toggle", "Toggle", "Collapsible section with hidden content", "chevron-right"),
            SuggestionItem("Table", "Table", "Rows and columns", "table"),
            SuggestionItem("Image", "Image", "Upload an image", "image"),
            SuggestionItem("Quote", "Quote", "Capture a quotation", "quote"),
            SuggestionItem("Code block", "Code block", "Code with syntax highlighting", "code-xml"),
            SuggestionItem("Divider", "Divider", "Horizontal line", "minus"),
        )
        return EditorSuggestion(
            trigger = SuggestionTrigger.SLASH, query = query, from = viewFrom.toUInt(), to = (viewFrom + 1 + query.length).toUInt(),
            viewFrom = viewFrom.toUInt(), viewTo = (viewFrom + 1 + query.length).toUInt(), slashItems = items.map { it.id },
            items = items, highlighted = highlighted.toUInt(),
        )
    }
}

/** An engine that always answers the same frame and does nothing: what the look scenes edit. */
class StaticEngine(private val frame: ViewRender) : TextEngine {
    override fun render(): ViewRender = frame
    override fun insertText(text: String) {}
    override fun key(chord: String): Boolean = false
    override fun command(name: String, argsJson: String): Boolean = false
    override fun paste(html: String, text: String): Boolean = false
    override fun copy(): ClipboardData = ClipboardData("", "")
    override fun cut(): ClipboardData = ClipboardData("", "")
    override fun undo(): Boolean = false
    override fun redo(): Boolean = false
    override fun setSelection(anchor: Int, head: Int) {}
    override fun setComposition(text: String, selStart: Int, selEnd: Int) {}
    override fun commitComposition(text: String) {}
    override fun finishComposition() {}
    override fun cancelComposition() {}
    override fun replaceRange(from: Int, to: Int, text: String): Boolean = false
    override fun moveHighlight(delta: Int): Boolean = false
    override fun pickSuggestion(): Boolean = false
    override fun dismissSuggestion(): Boolean = false
}
