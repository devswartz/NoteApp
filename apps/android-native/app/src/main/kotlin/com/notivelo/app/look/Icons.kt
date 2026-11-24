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
    val letterB = R.drawable.ic_letter_b
    val italic = R.drawable.ic_italic
    val underline = R.drawable.ic_underline
    val strikethrough = R.drawable.ic_strikethrough
    val baseline = R.drawable.ic_baseline
    val highlighter = R.drawable.ic_highlighter
    val removeFormatting = R.drawable.ic_remove_formatting
    val list = R.drawable.ic_list
    val listOrdered = R.drawable.ic_list_ordered
    val listIndentDecrease = R.drawable.ic_list_indent_decrease
    val listIndentIncrease = R.drawable.ic_list_indent_increase
    val table = R.drawable.ic_table
    val imagePlus = R.drawable.ic_image_plus
    val paperclip = R.drawable.ic_paperclip
    val link2 = R.drawable.ic_link_2
    val fileSymlink = R.drawable.ic_file_symlink
    val minus = R.drawable.ic_minus
    val paintBucket = R.drawable.ic_paint_bucket
    val rows3 = R.drawable.ic_rows_3
    val printer = R.drawable.ic_printer
    val listTree = R.drawable.ic_list_tree
    val undo2 = R.drawable.ic_undo_2
    val redo2 = R.drawable.ic_redo_2
    val sun = R.drawable.ic_sun
    val calendarRange = R.drawable.ic_calendar_range
    val inbox = R.drawable.ic_inbox
    val layers = R.drawable.ic_layers
    val arrowUpDown = R.drawable.ic_arrow_up_down
    val eye = R.drawable.ic_eye
    val user = R.drawable.ic_user
    val tag = R.drawable.ic_tag
    val usersRound = R.drawable.ic_users_round
    val users = R.drawable.ic_users
    val flag = R.drawable.ic_flag
    val flagFilled = R.drawable.ic_flag_filled
    val slidersHorizontal = R.drawable.ic_sliders_horizontal
    val funnelX = R.drawable.ic_funnel_x
    val bookmark = R.drawable.ic_bookmark
    val bookmarkPlus = R.drawable.ic_bookmark_plus
    val listTodo = R.drawable.ic_list_todo
    val messageSquare = R.drawable.ic_message_square
    val userPlus = R.drawable.ic_user_plus
    val faceSlightlySmilingPlus = R.drawable.ic_face_slightly_smiling_plus
    val squareCheck = R.drawable.ic_square_check
    val listPlus = R.drawable.ic_list_plus
    val maximize2 = R.drawable.ic_maximize_2
    val fileXCorner = R.drawable.ic_file_x_corner
    val image = R.drawable.ic_image
    val download = R.drawable.ic_download
    val trash = R.drawable.ic_trash
    val repeat = R.drawable.ic_repeat
    val arrowLeft = R.drawable.ic_arrow_left
    val type = R.drawable.ic_type
    val heading1 = R.drawable.ic_heading_1
    val heading2 = R.drawable.ic_heading_2
    val heading3 = R.drawable.ic_heading_3
    val squareCheckBig = R.drawable.ic_square_check_big
    val quote = R.drawable.ic_quote
    val messageSquareQuote = R.drawable.ic_message_square_quote
    val codeXml = R.drawable.ic_code_xml
    val atSign = R.drawable.ic_at_sign
}

@Composable
fun LIcon(@DrawableRes id: Int, size: Dp, tint: Color, modifier: Modifier = Modifier) {
    Icon(painter = painterResource(id), contentDescription = null, modifier = modifier.size(size), tint = tint)
}
