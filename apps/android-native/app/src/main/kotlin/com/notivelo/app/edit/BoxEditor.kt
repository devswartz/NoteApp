package com.notivelo.app.edit

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.notivelo.app.data.NoActions
import com.notivelo.app.data.ShellActions
import com.notivelo.app.ui.page.PageEnv
import com.notivelo.core.WorkspaceMember

/** What the page's boxes need to be edited: the box being edited and the names the menus offer. */
@Immutable
class EditContext(
    val editing: EditingBox? = null,
    val pages: List<PageChoice> = emptyList(),
    val people: List<WorkspaceMember> = emptyList(),
    /** Changes when the page changed under the editor (others' edits): the view reads its frame again. */
    val tick: Any? = null,
)

val LocalEditContext = staticCompositionLocalOf { EditContext() }

/** The shell's actions for the page (start and stop editing a box). */
val LocalPageActions = staticCompositionLocalOf<ShellActions> { NoActions }

/** The look scenes draw the editor as focused, without a window or keyboard, and the menu inline instead of in a popup. */
val LocalLookEdit = staticCompositionLocalOf { false }

/**
 * A box being edited: [BoxTextView] in Compose, and the `/`, `[[` and `@` menu as a popup at the caret
 * (a popup that does not take focus, so the keyboard stays with the box).
 */
@Composable
fun BoxEditor(editing: EditingBox, env: PageEnv, ec: EditContext, modifier: Modifier = Modifier) {
    val look = LocalLookEdit.current
    var menu by remember { mutableStateOf<MenuModel?>(null) }
    var view by remember { mutableStateOf<BoxTextView?>(null) }
    val density = LocalDensity.current
    val content: @Composable (Int) -> Unit = { maxWidthPx ->
        AndroidView(
            factory = { ctx ->
                BoxTextView(ctx, editing.engine, env).also { v ->
                    v.onMenu = { menu = it }
                    v.pages = ec.pages
                    v.people = ec.people
                    v.lookFocused = look
                    view = v
                    if (!look) {
                        v.post {
                            v.requestFocus()
                            if (editing.tapX >= 0f) v.placeCaretAt(editing.tapX, editing.tapY)
                            v.showKeyboard()
                        }
                    }
                }
            },
            update = { v ->
                v.env = env
                v.pages = ec.pages
                v.people = ec.people
                if (v.input.engine !== editing.engine) v.attach(editing.engine)
                v.refresh()
            },
            modifier = Modifier.fillMaxWidth(),
        )
        // The look scenes have no window to post to: the menu is worked out here, from the width the box got.
        val m = if (look) lookMenu(editing, env, ec, maxWidthPx, density.density) else menu
        if (m != null) {
            val gap = with(density) { 6.dp.roundToPx() }
            val margin = with(density) { 8.dp.roundToPx() }
            val card: @Composable (Modifier) -> Unit = { mod -> SuggestionMenu(m, env.palette, { i -> view?.pickRow(i) }, mod) }
            if (look) {
                // Relative to the box (no window to ask for its place): below the caret line, not clamped to the screen.
                card(
                    Modifier.layout { measurable, _ ->
                        val pl = measurable.measure(Constraints())
                        val at = MenuPlacement.place(0, 0, m, pl.width, pl.height, Int.MAX_VALUE / 2, gap, margin)
                        layout(0, 0) { pl.place(at.x, at.y) }
                    },
                )
            } else {
                Popup(
                    popupPositionProvider = object : PopupPositionProvider {
                        override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset =
                            MenuPlacement.place(anchorBounds.left, anchorBounds.top, m, popupContentSize.width, popupContentSize.height, windowSize.width, gap, margin)
                    },
                    properties = PopupProperties(focusable = false),
                ) { card(Modifier) }
            }
        }
    }
    if (look) {
        BoxWithConstraints(modifier) { content(constraints.maxWidth) }
    } else {
        Box(modifier) { content(0) }
    }
}

/** The menu for the look scenes: the caret's place from the same layout the view makes, room above (as the reference, which has the box near the page end). */
private fun lookMenu(editing: EditingBox, env: PageEnv, ec: EditContext, widthPx: Int, density: Float): MenuModel? {
    val r = editing.engine.render()
    val s = r.suggestion ?: return null
    val padX = 11f * density
    val padY = 7f * density
    val g = BoxLayoutBuilder.build(r, env, density, maxOf(1, widthPx - (2 * padX).toInt()))
    val caret = g.caretRect(minOf(s.viewFrom.toInt(), r.view.text.length))
    return Suggestions.model(s, ec.pages, ec.people, 0, caret.left + padX, caret.top + padY, caret.bottom + padY, 100000f, 0f)
}
