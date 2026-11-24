package com.notivelo.app.look

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import com.notivelo.app.ink.InkBar
import com.notivelo.app.ink.InkKind
import com.notivelo.app.ink.InkSettings
import org.junit.Rule
import org.junit.Test

/** The pen bar (draw mode) on a phone-width strip: the pen with its colours and widths, and the eraser. Not a reference state, so collect-shots.py leaves them out of the pairs. */
class InkBarShots {
    @get:Rule
    val paparazzi = Paparazzi(
        deviceConfig = DeviceConfig.PIXEL_5.copy(screenWidth = 780, screenHeight = 120, xdpi = 320, ydpi = 320, density = Density.XHIGH, softButtons = false),
        theme = "android:Theme.Material.Light.NoActionBar",
    )

    private fun bar(ink: InkSettings) = paparazzi.snapshot {
        NotiveloTheme(ThemeMode.Light) {
            Box(Modifier.background(pal().bg)) { InkBar(ink, pal(), {}, {}) }
        }
    }

    @Test fun ink_bar_pen() = bar(InkSettings(open = true))
    @Test fun ink_bar_highlighter_finger() = bar(InkSettings(open = true, kind = InkKind.Highlighter, finger = true))
    @Test fun ink_bar_eraser() = bar(InkSettings(open = true, kind = InkKind.PartialEraser))
}
