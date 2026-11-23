package com.notivelo.app.look

import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import com.notivelo.app.R

/**
 * The Lucide icons the screens use, as vector drawables (apps/android-native/scripts/lucide-to-vector.py from
 * docs/rewrite/look/icons/). 24x24, stroke 2 in viewport units, so the line scales with the icon like the web's.
 * `*S23` etc. are the same shapes with the stroke the web uses for the active tab, the FAB plus and small checks.
 */
object Ic {
    val menu = R.drawable.ic_menu
    val bell = R.drawable.ic_bell
    val search = R.drawable.ic_search
    val searchS23 = R.drawable.ic_search_s23
    val bookOpen = R.drawable.ic_book_open
    val bookOpenS23 = R.drawable.ic_book_open_s23
    val listChecks = R.drawable.ic_list_checks
    val listChecksS23 = R.drawable.ic_list_checks_s23
    val calendarDays = R.drawable.ic_calendar_days
    val calendarDaysS23 = R.drawable.ic_calendar_days_s23
    val plus = R.drawable.ic_plus
    val plusS225 = R.drawable.ic_plus_s225
    val chevronRight = R.drawable.ic_chevron_right
    val chevronDown = R.drawable.ic_chevron_down
    val chevronLeft = R.drawable.ic_chevron_left
    val chevronUp = R.drawable.ic_chevron_up
    val lock = R.drawable.ic_lock
    val ellipsis = R.drawable.ic_ellipsis
    val clock = R.drawable.ic_clock
    val bookPlus = R.drawable.ic_book_plus
    val fileText = R.drawable.ic_file_text
    val filePlus = R.drawable.ic_file_plus
    val layoutTemplate = R.drawable.ic_layout_template
    val folderPlus = R.drawable.ic_folder_plus
    val upload = R.drawable.ic_upload
    val panelLeftClose = R.drawable.ic_panel_left_close
    val panelLeftOpen = R.drawable.ic_panel_left_open
    val circleCheck = R.drawable.ic_circle_check
    val check = R.drawable.ic_check
    val x = R.drawable.ic_x
    val logOut = R.drawable.ic_log_out
    val userRound = R.drawable.ic_user_round
    val settings = R.drawable.ic_settings
}

@Composable
fun LIcon(@DrawableRes id: Int, size: Dp, tint: Color, modifier: Modifier = Modifier) {
    Icon(painter = painterResource(id), contentDescription = null, modifier = modifier.size(size), tint = tint)
}
