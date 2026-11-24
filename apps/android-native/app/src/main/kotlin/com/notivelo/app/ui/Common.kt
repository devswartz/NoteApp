package com.notivelo.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.unit.dp
import com.notivelo.app.look.LocalPhone
import com.notivelo.app.look.WText
import com.notivelo.app.look.pal
import com.notivelo.core.PageMeta
import kotlinx.coroutines.delay

/** A transient message at the bottom (the web's toast: `--bg-inverse`, radius 12, 13.5). Clears itself after 2.5 s. */
@Composable
fun NotYetToast(message: String?, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    if (message == null) return
    val p = pal()
    LaunchedEffect(message) {
        delay(2500)
        onDismiss()
    }
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier
            .shadow(16.dp, shape, clip = false, ambientColor = p.shadowLg, spotColor = p.shadowLg)
            .background(p.bgInverse, shape)
            .padding(start = 16.dp, end = 16.dp, top = 11.dp, bottom = 11.dp),
    ) {
        WText(message, 13.5f, p.textInverse, lineHeight = 1.3f, maxLines = 2)
    }
}
