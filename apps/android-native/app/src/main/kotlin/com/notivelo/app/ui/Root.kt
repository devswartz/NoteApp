package com.notivelo.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.Phase
import com.notivelo.app.data.ShellActions
import com.notivelo.app.look.LocalPhone
import com.notivelo.app.look.pal
import com.notivelo.app.ui.phone.PhoneShell
import com.notivelo.app.ui.tablet.TabletShell

/** Above this width (dp) the app uses the tablet shell, as the web does (LOOK.md 0.1). */
const val TABLET_MIN_WIDTH = 761

/** The sidebar starts open from this width up, closed below (first run, LOOK.md 3.1). */
const val SIDEBAR_OPEN_MIN_WIDTH = 900

/**
 * Sign-in, or the shell for the width: phone (top bar, tab bar, drawer) or tablet (ribbon, rail, sidebar).
 * [handleBack] is off in the screenshot tests, which have no activity to back out of.
 */
@Composable
fun NotiveloRoot(
    state: AppState,
    actions: ShellActions,
    modifier: Modifier = Modifier,
    onSignIn: (server: String, email: String, password: String) -> Unit = { _, _, _ -> },
    initialDrawerOpen: Boolean = false,
    initialSidebarOpen: Boolean? = null,
    emailFocusedLook: Boolean = false,
    handleBack: Boolean = true,
    scrollPx: Int = 0,
) {
    val p = pal()
    BoxWithConstraints(modifier.fillMaxSize().background(p.bg)) {
        val tablet = maxWidth >= TABLET_MIN_WIDTH.dp
        CompositionLocalProvider(com.notivelo.app.edit.LocalPageActions provides actions) {
        when (state.phase) {
            Phase.Loading -> Box(Modifier.fillMaxSize().background(p.bg))
            Phase.SignedOut -> CompositionLocalProvider(LocalPhone provides !tablet) {
                SignInScreen(
                    server = state.server, busy = state.signingIn, error = state.error,
                    onSignIn = onSignIn, emailFocusedLook = emailFocusedLook,
                )
            }
            Phase.SignedIn -> if (tablet) {
                var sidebarOpen by rememberSaveable { mutableStateOf(initialSidebarOpen ?: (maxWidth >= SIDEBAR_OPEN_MIN_WIDTH.dp)) }
                TabletShell(state, actions, sidebarOpen, { sidebarOpen = it }, scrollPx = scrollPx)
            } else {
                var drawerOpen by rememberSaveable { mutableStateOf(initialDrawerOpen) }
                if (handleBack) {
                    val notes = state.tab == com.notivelo.app.data.Tab.Notes
                    val canGoBack = state.taskDetailId != null || (notes && (state.pageId != null || state.sectionId != null || state.phoneNotebookId != null))
                    BackHandler(enabled = drawerOpen || canGoBack) {
                        if (drawerOpen) drawerOpen = false else if (state.taskDetailId != null) actions.openTask(null) else actions.back()
                    }
                }
                PhoneShell(state, actions, drawerOpen, { drawerOpen = it }, scrollPx = scrollPx)
            }
        }
        }
    }
}
