package com.notivelo.app.look

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import com.android.resources.ScreenOrientation
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

/** Portrait values; [landscape] turns the device (Paparazzi swaps the two), so 820x1180 becomes 1180x820. */
private fun tablet(landscape: Boolean) = DeviceConfig.PIXEL_5.copy(
    screenWidth = 820, screenHeight = 1180, xdpi = 160, ydpi = 160, density = Density.MEDIUM, softButtons = false,
    orientation = if (landscape) ScreenOrientation.LANDSCAPE else ScreenOrientation.PORTRAIT,
)

/** The states with a page or a task list: the same set in the three viewports where the web has a reference. */
abstract class DataShots(config: DeviceConfig) : ShotsBase(config) {
    @Test fun page_canvas_boxes() = shot("page-canvas-boxes")
    @Test fun page_canvas_boxes_2() = shot("page-canvas-boxes-2")
    @Test fun page_blocks() = shot("page-blocks")
    @Test fun page_blocks_2() = shot("page-blocks-2")
    @Test fun page_lists() = shot("page-lists")
    @Test fun page_lists_2() = shot("page-lists-2")
    @Test fun page_tasks() = shot("page-tasks")
    @Test fun page_tasks_2() = shot("page-tasks-2")
    @Test fun page_settings_and_ink() = shot("page-settings-and-ink")
    @Test fun page_meeting() = shot("page-meeting")
    @Test fun page_meeting_2() = shot("page-meeting-2")
    @Test fun page_roadmap() = shot("page-roadmap")
    @Test fun page_roadmap_2() = shot("page-roadmap-2")
    @Test fun tasks_today() = shot("tasks-today")
    @Test fun tasks_upcoming() = shot("tasks-upcoming")
    @Test fun tasks_my() = shot("tasks-my")
    @Test fun tasks_all() = shot("tasks-all")
    @Test fun empty_tasks_today() = shot("empty-tasks-today")
    @Test fun empty_tasks_all() = shot("empty-tasks-all")
    @Test fun task_detail() = shot("task-detail")
    @Test fun task_detail_edit() = shot("task-detail-edit")
    @Test fun edit_caret() = shot("edit-caret")
    @Test fun edit_selection() = shot("edit-selection")
    @Test fun slash_menu() = shot("slash-menu")
}

/** Dark and Hybrid variants (iphone and ipad-landscape have them). */
abstract class ThemedDataShots(config: DeviceConfig) : DataShots(config) {
    @Test fun dark_page_canvas_boxes() = shot("dark-page-canvas-boxes")
    @Test fun dark_page_meeting() = shot("dark-page-meeting")
    @Test fun dark_page_settings_and_ink() = shot("dark-page-settings-and-ink")
    @Test fun dark_tasks_today() = shot("dark-tasks-today")
    @Test fun hybrid_page_canvas_boxes() = shot("hybrid-page-canvas-boxes")
    @Test fun hybrid_page_meeting() = shot("hybrid-page-meeting")
    @Test fun hybrid_page_settings_and_ink() = shot("hybrid-page-settings-and-ink")
    @Test fun hybrid_tasks_today() = shot("hybrid-tasks-today")
    @Test fun dark_edit_caret() = shot("dark-edit-caret")
    @Test fun hybrid_edit_caret() = shot("hybrid-edit-caret")
}

class PhoneShots : ThemedDataShots(phone) {
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

class TabletPortraitShots : DataShots(tablet(false)) {
    @Test fun sign_in() = shot("sign-in")
    @Test fun empty_no_page() = shot("empty-no-page")
    @Test fun empty_section() = shot("empty-section")
    @Test fun empty_workspace_notes() = shot("empty-workspace-notes")
    @Test fun sidebar() = shot("sidebar")
}

class TabletLandscapeShots : ThemedDataShots(tablet(true)) {
    @Test fun sign_in() = shot("sign-in")
    @Test fun dark_sign_in() = shot("dark-sign-in")
    @Test fun hybrid_sign_in() = shot("hybrid-sign-in")
    @Test fun empty_no_page() = shot("empty-no-page")
    @Test fun empty_section() = shot("empty-section")
    @Test fun empty_workspace_notes() = shot("empty-workspace-notes")
    @Test fun sidebar() = shot("sidebar")
}
