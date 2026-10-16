package it.cdanet.cpeconfigurator.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import it.cdanet.cpeconfigurator.BuildConfig
import it.cdanet.cpeconfigurator.network.Ip
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import java.net.URL
import it.cdanet.cpeconfigurator.network.TestTls

private val Context.dataStore by preferencesDataStore(name = "settings")

/** Non-secret preferences only (last username, Home shortcuts). The server is built into the app. */
class Settings(private val context: Context) {
    private val usernameKey = stringPreferencesKey("last_username")

    /**
     * The server's certificate is checked always: its own CA is built into the app for its name
     * (network_security_config). The old «accept unverified certificate» switch is gone; a value
     * saved by an older version is ignored.
     */
    val insecureTls: Flow<Boolean> = flowOf(false)

    suspend fun insecureTlsNow(): Boolean = false

    /** The CDA Net server, fixed in the app (no longer shown or changed on the phone). */
    val backendUrl: Flow<String> = flowOf(BuildConfig.DEFAULT_BACKEND_URL)
    val lastUsername: Flow<String> = context.dataStore.data.map { it[usernameKey] ?: "" }

    suspend fun backendUrlNow(): String = backendUrl.first()

    suspend fun setLastUsername(value: String) {
        context.dataStore.edit { it[usernameKey] = value }
    }

    /**
     * Copy on this phone of the account's Home shortcuts (the server keeps them with the account),
     * in order; null: never customised, the defaults apply. One per server and username. [dirty]:
     * changed here and not yet saved on the server (no network): sent at the next sync.
     */
    fun homeShortcuts(account: String): Flow<List<String>?> = context.dataStore.data.map { p ->
        p[shortcutsKey(account)]?.let { v -> v.split(',').filter { it.isNotBlank() } }
    }

    suspend fun setHomeShortcuts(account: String, ids: List<String>?, dirty: Boolean) {
        context.dataStore.edit {
            if (ids == null) it.remove(shortcutsKey(account)) else it[shortcutsKey(account)] = ids.joinToString(",")
            it[shortcutsDirtyKey(account)] = dirty
        }
    }

    suspend fun homeShortcutsDirty(account: String): Boolean = context.dataStore.data.first()[shortcutsDirtyKey(account)] ?: false

    suspend fun markHomeShortcutsSaved(account: String) {
        context.dataStore.edit { it[shortcutsDirtyKey(account)] = false }
    }

    private fun shortcutsKey(account: String) = stringPreferencesKey("home_shortcuts:${account.lowercase()}")
    private fun shortcutsDirtyKey(account: String) = booleanPreferencesKey("home_shortcuts_dirty:${account.lowercase()}")

    companion object {
        /** HTTPS anywhere, plain HTTP only towards private/CGNAT/loopback hosts. */
        fun normalizeBackendUrl(raw: String): String {
            val v = raw.trim().trimEnd('/')
            val url = runCatching { URL(v) }.getOrNull() ?: throw IllegalArgumentException("URL non valido")
            val scheme = url.protocol.lowercase()
            if (scheme != "https" && scheme != "http") throw IllegalArgumentException("Usa http:// o https://")
            if (scheme == "http" && !Ip.isPrivateLiteralOrLocalName(url.host)) {
                throw IllegalArgumentException("HTTP consentito solo verso indirizzi privati: usa HTTPS")
            }
            return v
        }
    }
}
