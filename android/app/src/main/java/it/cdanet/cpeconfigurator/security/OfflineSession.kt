package it.cdanet.cpeconfigurator.security

import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.SessionState
import it.cdanet.cpeconfigurator.data.UserDto
import kotlinx.serialization.Serializable
import java.time.Instant

/**
 * The session of the last contact with the server, kept encrypted on the phone (keystore) for the
 * hours the admin allows (Impostazioni server, 24 by default): if the app is closed, the phone
 * switches off or Internet is missing, the account goes on working with what is on the phone (the
 * CPE tools with the saved credentials). No token is kept: the server is asked again once online.
 */
class OfflineSessions(private val store: SecureStore) {
    @Serializable
    data class Snapshot(val backend: String, val user: UserDto, val modules: Map<String, Boolean> = emptyMap(), val until: String)

    /** After each contact with the server: the hours start again from now ([hours] 0 = not allowed). */
    fun save(backend: String, user: UserDto, modules: Map<String, Boolean>, hours: Int) {
        if (hours <= 0) return clear()
        val until = Instant.now().plusSeconds(hours * 3600L).toString()
        runCatching { store.put(NAME, AppJson.encodeToString(Snapshot.serializer(), Snapshot(backend, user, modules, until))) }
    }

    /** The saved session of this server, while it is still valid. */
    fun valid(backend: String): Snapshot? {
        val s = runCatching { store.get(NAME)?.let { AppJson.decodeFromString(Snapshot.serializer(), it) } }.getOrNull() ?: return null
        val ok = s.backend == backend && runCatching { Instant.parse(s.until).isAfter(Instant.now()) }.getOrDefault(false)
        if (!ok) clear()
        return s.takeIf { ok }
    }

    fun session(s: Snapshot) = SessionState(token = "", user = s.user, expiresAt = s.until, offline = true)

    fun clear() = store.remove(NAME)

    private companion object {
        const val NAME = "offline_session"
    }
}
