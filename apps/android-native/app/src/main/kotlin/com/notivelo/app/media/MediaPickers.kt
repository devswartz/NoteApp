package com.notivelo.app.media

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import com.notivelo.app.data.OpenFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

object PickedFiles {
    /** The bytes and name of a picked or pasted content Uri; null when it can't be read. Blocking: IO thread. */
    fun read(resolver: ContentResolver, uri: Uri): PickedFile? = try {
        val mime = resolver.getType(uri).orEmpty()
        val shown = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
        var name = shown ?: uri.lastPathSegment ?: "file"
        if (!name.contains('.')) MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { name += ".$it" }
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
        if (bytes == null) null else PickedFile(MediaSizing.cleanName(name, mime), bytes)
    } catch (e: Exception) {
        null
    }
}

/**
 * The system pickers for the slash menu's Image and File attachment and the ribbon's Insert buttons. A [request] launches the
 * picker (then [onHandled] clears it); the chosen content is read off the main thread and given to [onPicked] (null when unreadable).
 */
@Composable
fun MediaPickers(request: MediaKind?, onHandled: () -> Unit, onPicked: (PickedFile?) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val picked by rememberUpdatedState(onPicked)
    val handled by rememberUpdatedState(onHandled)
    val result: (Uri?) -> Unit = { uri ->
        if (uri != null) {
            scope.launch {
                val file = withContext(Dispatchers.IO) { PickedFiles.read(context.contentResolver, uri) }
                picked(file)
            }
        }
    }
    val image = rememberLauncherForActivityResult(ActivityResultContracts.GetContent(), result)
    val file = rememberLauncherForActivityResult(ActivityResultContracts.GetContent(), result)
    LaunchedEffect(request) {
        when (request) {
            MediaKind.Image -> image.launch("image/*")
            MediaKind.File -> file.launch("*/*")
            null -> return@LaunchedEffect
        }
        handled()
    }
}

/** Open a downloaded file with the app the system picks (`ACTION_VIEW` over the FileProvider); false when nothing can open it. */
fun openWithSystem(context: Context, f: OpenFile): Boolean = try {
    val uri = FileProvider.getUriForFile(context, context.packageName + ".files", File(f.path))
    val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, f.mime.ifEmpty { "*/*" })
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
    true
} catch (e: Exception) {
    false
}
