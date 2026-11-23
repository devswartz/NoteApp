package com.notivelo.app.look

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import org.junit.Rule
import org.junit.Test

/**
 * The look screenshots (docs/rewrite/look/reference/): each test renders one state of [LookData] at a reference
 * size, with Paparazzi (JVM, no emulator). CI records them (`recordPaparazziDebug -Pshots`) and uploads the PNGs
 * (artifact android-shots); `scripts/collect-shots.py` names them like the references. The method name is the
 * state name with `_` for `-`.
 *
 * Sizes: phone 390x844 dp at 2x (780x1688 px, as the iphone references), tablets 820x1180 and 1180x820 dp at 1x.
 */
abstract class ShotsBase(config: DeviceConfig) {
    @get:Rule
    val paparazzi = Paparazzi(deviceConfig = config, theme = "android:Theme.Material.Light.NoActionBar")

    protected fun shot(state: String) {
        paparazzi.snapshot { LookRoot(state) }
    }
}

private val phone = DeviceConfig.PIXEL_5.copy(
    screenWidth = 780, screenHeight = 1688, xdpi = 320, ydpi = 320, density = Density.XHIGH, softButtons = false,
)

private fun tablet(w: Int, h: Int) = DeviceConfig.PIXEL_5.copy(
    screenWidth = w, screenHeight = h, xdpi = 160, ydpi = 160, density = Density.MEDIUM, softButtons = false,
)

class PhoneShots : ShotsBase(phone) {
    @Test fun sign_in() = shot("sign-in")
    @Test fun dark_sign_in() = shot("dark-sign-in")
    @Test fun hybrid_sign_in() = shot("hybrid-sign-in")
    @Test fun notes_home() = shot("notes-home")
    @Test fun sidebar_drawer() = shot("sidebar-drawer")
    @Test fun dark_sidebar_drawer() = shot("dark-sidebar-drawer")
    @Test fun hybrid_sidebar_drawer() = shot("hybrid-sidebar-drawer")
    @Test fun empty_workspace_notes() = shot("empty-workspace-notes")
    @Test fun empty_workspace_drawer() = shot("empty-workspace-drawer")
    @Test fun empty_section() = shot("empty-section")
}

class TabletPortraitShots : ShotsBase(tablet(820, 1180)) {
    @Test fun sign_in() = shot("sign-in")
    @Test fun empty_no_page() = shot("empty-no-page")
    @Test fun empty_section() = shot("empty-section")
    @Test fun empty_workspace_notes() = shot("empty-workspace-notes")
    @Test fun sidebar() = shot("sidebar")
}

class TabletLandscapeShots : ShotsBase(tablet(1180, 820)) {
    @Test fun sign_in() = shot("sign-in")
    @Test fun dark_sign_in() = shot("dark-sign-in")
    @Test fun hybrid_sign_in() = shot("hybrid-sign-in")
    @Test fun empty_no_page() = shot("empty-no-page")
    @Test fun empty_section() = shot("empty-section")
    @Test fun empty_workspace_notes() = shot("empty-workspace-notes")
    @Test fun sidebar() = shot("sidebar")
}
