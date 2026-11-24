package com.notivelo.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** What survives a restart: the server, the refresh token (encrypted), the last workspace and the theme. */
interface SessionStore {
    var server: String
    var refreshToken: String?
    var workspaceId: String?
    var theme: String?
}

/** [SessionStore] on EncryptedSharedPreferences (AES-256, key in the Android Keystore). */
class EncryptedSessionStore(context: Context) : SessionStore {
    private val prefs: SharedPreferences = open(context.applicationContext)

    private fun put(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }

    override var server: String
        get() = prefs.getString("server", null) ?: DEFAULT_SERVER
        set(v) = put("server", v)
    override var refreshToken: String?
        get() = prefs.getString("refreshToken", null)
        set(v) = put("refreshToken", v)
    override var workspaceId: String?
        get() = prefs.getString("workspaceId", null)
        set(v) = put("workspaceId", v)
    override var theme: String?
        get() = prefs.getString("theme", null)
        set(v) = put("theme", v)

    private companion object {
        const val FILE = "notivelo_session"

        fun create(context: Context): SharedPreferences {
            val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            return EncryptedSharedPreferences.create(
                context,
                FILE,
                key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }

        /** A keystore that lost its key (a restored device, wiped credentials) cannot open the old file: start fresh, signed out. */
        fun open(context: Context): SharedPreferences = try {
            create(context)
        } catch (e: Exception) {
            context.deleteSharedPreferences(FILE)
            create(context)
        }
    }
}
