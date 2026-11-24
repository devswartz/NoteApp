package com.notivelo.app

import android.app.Application
import com.notivelo.app.data.Backend
import com.notivelo.app.data.CoreBackend
import com.notivelo.app.data.EncryptedSessionStore
import com.notivelo.app.data.SessionStore
import com.notivelo.app.media.AppMedia
import com.notivelo.core.NotiveloCore
import java.io.File

class NotiveloApp : Application() {
    lateinit var store: SessionStore
        private set
    lateinit var backend: Backend
        private set
    lateinit var media: AppMedia
        private set

    override fun onCreate() {
        super.onCreate()
        // The certificate verifier needs the Context before the first TLS handshake (docs/rewrite/status/core.md, "For android").
        NotiveloCore.init(this)
        store = EncryptedSessionStore(this)
        // The core's on-device store: one file in app-private storage, excluded from backups (the manifest).
        backend = CoreBackend(File(filesDir, "notivelo.db").path)
        // Pictures of pages and downloads to open: fetched with the session, kept in the cache folder.
        media = AppMedia(cacheDir) { src -> backend.downloadFile(src).bytes }
    }
}
