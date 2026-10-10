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
import kotlinx.coroutines.flow.map
import java.net.URL
import it.cdanet.cpeconfigurator.network.TestTls

private val Context.dataStore by preferencesDataStore(name = "settings")

/** Non-secret preferences only (backend URL, last username, Home shortcuts). */
class Settings(private val context: Context) {
    private val backendKey = stringPreferencesKey("backend_url")
    private val usernameKey = stringPreferencesKey("last_username")
    private val insecureKey = booleanPreferencesKey("insecure_tls_test")

    /** TEST ONLY: accept the server's unverified (self-signed) certificate. */
    val insecureTls: Flow<Boolean> = context.dataStore.data.map { it[insecureKey] ?: false }

    suspend fun insecureTlsNow(): Boolean = insecureTls.first()

    suspend fun setInsecureTls(value: Boolean) {
        context.dataStore.edit { it[insecureKey] = value }
        TestTls.enabled = value
    }

    val backendUrl: Flow<String> = context.dataStore.data.map { it[backendKey] ?: BuildConfig.DEFAULT_BACKEND_URL }
    val lastUsername: Flow<String> = context.dataStore.data.map { it[usernameKey] ?: "" }

    suspend fun backendUrlNow(): String = backendUrl.first()

    suspend fun setBackendUrl(value: String) {
        val clean = normalizeBackendUrl(value)
        context.dataStore.edit { it[backendKey] = clean }
    }

    suspend fun setLastUsername(value: String) {
        context.dataStore.edit { it[usernameKey] = value }
    }

    /**
     * Home shortcuts chosen by an account on this phone, in order (null: never customised, the
     * defaults apply). One list per server and username, so two accounts on one phone keep theirs.
     */
    fun homeShortcuts(account: String): Flow<List<String>?> = context.dataStore.data.map { p ->
        p[shortcutsKey(account)]?.let { v -> v.split(',').filter { it.isNotBlank() } }
    }

    suspend fun setHomeShortcuts(account: String, ids: List<String>?) {
        context.dataStore.edit { if (ids == null) it.remove(shortcutsKey(account)) else it[shortcutsKey(account)] = ids.joinToString(",") }
    }

    private fun shortcutsKey(account: String) = stringPreferencesKey("home_shortcuts:${account.lowercase()}")

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
