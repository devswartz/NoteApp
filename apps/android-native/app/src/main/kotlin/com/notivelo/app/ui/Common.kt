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

/** A page opened from the tree. Editing arrives with the next step; this shows what the tree knows. */
@Composable
fun PagePlaceholder(page: PageMeta, modifier: Modifier = Modifier) {
    val p = pal()
    val phone = LocalPhone.current
    val now = LocalNow.current
    Column(
        modifier
            .verticalScroll(rememberScrollState())
            .padding(start = if (phone) 20.dp else 51.dp, end = if (phone) 20.dp else 40.dp, top = if (phone) 12.dp else 32.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val icon = page.icon
        if (!icon.isNullOrEmpty()) WText(icon, if (phone) 44f else 56f, p.text, lineHeight = 1.1f)
        WText(
            page.title.ifEmpty { "Untitled" }, if (phone) 28f else 36f, p.text,
            weight = 700, lineHeight = 1.2f, tracking = -0.025f, maxLines = 3,
        )
        WText("Edited ${relativeTime(page.updatedAt, now)}", 12.5f, p.textMuted, lineHeight = 1.5f)
        WText(
            "Page editing is not in the native preview yet.", 14f, p.text2,
            Modifier.fillMaxWidth().padding(top = 16.dp), lineHeight = 1.5f, maxLines = 3,
        )
    }
}
