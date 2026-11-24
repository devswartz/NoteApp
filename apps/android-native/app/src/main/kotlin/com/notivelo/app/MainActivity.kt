package com.notivelo.app

import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.notivelo.app.data.AppViewModel
import com.notivelo.app.look.LookRoot
import com.notivelo.app.look.NotiveloTheme
import com.notivelo.app.look.ThemeMode
import com.notivelo.app.look.pal
import com.notivelo.app.ui.NotiveloRoot

class MainActivity : ComponentActivity() {
    private val model: AppViewModel by viewModels {
        val app = application as NotiveloApp
        AppViewModel.Factory(app.backend, app.store)
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
        setContent {
            if (look != null) {
                LookRoot(look)
            } else {
                val state by model.state.collectAsStateWithLifecycle()
                NotiveloTheme(mode) {
                    SystemBars()
                    NotiveloRoot(state = state, actions = model, onSignIn = model::signIn)
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
