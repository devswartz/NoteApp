package com.notivelo.app

import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import com.notivelo.app.data.AppViewModel
import com.notivelo.app.data.MemorySessionStore
import com.notivelo.app.data.OfflineBackend
import com.notivelo.app.look.LookRoot
import com.notivelo.app.look.NotiveloTheme
import com.notivelo.app.look.ThemeMode
import com.notivelo.app.look.pal
import com.notivelo.app.media.LocalMedia
import com.notivelo.app.media.MediaPickers
import com.notivelo.app.media.openWithSystem
import com.notivelo.app.ui.NotiveloRoot

class MainActivity : ComponentActivity() {
    /** Debug builds only: `--es source offline` opens a sample page with no server (OfflineBackend; the UI tests use it). */
    private val offline: Boolean by lazy {
        applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 && intent.getStringExtra("source") == "offline"
    }

    private val model: AppViewModel by viewModels {
        val app = application as NotiveloApp
        if (offline) AppViewModel.Factory(OfflineBackend(), MemorySessionStore(refreshToken = "offline-token")) else AppViewModel.Factory(app.backend, app.store, app.media)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as NotiveloApp
        val mode = when (app.store.theme) {
            "light" -> ThemeMode.Light
            "dark" -> ThemeMode.Dark
            "system" -> ThemeMode.System
            else -> ThemeMode.Hybrid
        }
        // Debug builds can open a look scene without a server: adb shell am start -n <id>/com.notivelo.app.MainActivity --es lookState notes-home
        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        val look = if (debuggable) intent.getStringExtra("lookState") else null
        if (offline) {
            lifecycleScope.launch {
                model.state.first { it.tree != null }
                model.openPage(OfflineBackend.PAGE_ID)
            }
        }
        setContent {
            if (look != null) {
                LookRoot(look)
            } else {
                val state by model.state.collectAsStateWithLifecycle()
                NotiveloTheme(mode) {
                    SystemBars()
                    CompositionLocalProvider(LocalMedia provides (if (offline) null else app.media.cache)) {
                        NotiveloRoot(state = state, actions = model, onSignIn = model::signIn)
                        MediaPickers(state.pickRequest, model::clearPickRequest, model::uploadMedia)
                        val context = LocalContext.current
                        LaunchedEffect(state.openFile) {
                            val f = state.openFile ?: return@LaunchedEffect
                            if (!openWithSystem(context, f)) Toast.makeText(context, "No app can open this file.", Toast.LENGTH_SHORT).show()
                            model.clearOpenFile()
                        }
                    }
                }
            }
        }
    }
}

/** Dark icons on a light palette, light icons on a dark one. */
@Composable
private fun SystemBars() {
    val view = LocalView.current
    val dark = pal().dark
    SideEffect {
        val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
        val controller = WindowCompat.getInsetsController(window, view)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
    }
}
