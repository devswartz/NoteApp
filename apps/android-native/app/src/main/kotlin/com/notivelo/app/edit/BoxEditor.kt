package com.notivelo.app.edit

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalConfiguration
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
    var origin by remember { mutableStateOf(Offset.Zero) }
    val density = LocalDensity.current
    Box(modifier.onGloballyPositioned { origin = it.positionInRoot() }) {
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
                    } else {
                        v.post { v.updateMenu(force = true) }
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
        val m = menu
        if (m != null) {
            val gap = with(density) { 6.dp.roundToPx() }
            val margin = with(density) { 8.dp.roundToPx() }
            val card: @Composable (Modifier) -> Unit = { mod -> SuggestionMenu(m, env.palette, { i -> view?.pickRow(i) }, mod) }
            if (look) {
                val screenW = with(density) { LocalConfiguration.current.screenWidthDp.dp.roundToPx() }
                card(
                    Modifier.layout { measurable, _ ->
                        val pl = measurable.measure(Constraints())
                        val at = MenuPlacement.place(origin.x.toInt(), origin.y.toInt(), m, pl.width, pl.height, screenW, gap, margin)
                        layout(0, 0) { pl.place(at.x - origin.x.toInt(), at.y - origin.y.toInt()) }
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
}
