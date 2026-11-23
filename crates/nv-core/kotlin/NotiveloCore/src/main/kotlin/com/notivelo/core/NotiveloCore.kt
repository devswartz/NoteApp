package com.notivelo.core

import android.content.Context

/**
 * Start-up for the Rust core on Android. Call [init] once from `Application.onCreate`, before any
 * network call: it gives the certificate verifier (rustls-platform-verifier) its handles into the JVM.
 * Without it the first TLS handshake fails.
 */
object NotiveloCore {
    init {
        System.loadLibrary("nv_core")
    }

    /** Implemented in Rust (crates/nv-core/src/android.rs). */
    private external fun initAndroid(context: Context)

    @Volatile
    private var started = false

    @Synchronized
    fun init(context: Context) {
        if (started) return
        initAndroid(context.applicationContext)
        started = true
    }
}
