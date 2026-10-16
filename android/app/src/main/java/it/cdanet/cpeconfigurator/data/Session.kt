package it.cdanet.cpeconfigurator.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * [offline]: the session of the last contact with the server, taken back from the phone without
 * Internet (no token: the tools on the phone and the CPE work, the server waits until online).
 */
data class SessionState(val token: String, val user: UserDto, val expiresAt: String, val offline: Boolean = false)

/** Bearer token kept in memory only; it is never written to disk. */
class Session {
    private val _state = MutableStateFlow<SessionState?>(null)
    val state: StateFlow<SessionState?> = _state.asStateFlow()

    /** The server refused the session (password changed, account blocked, "Esci ovunque"). */
    var onRevoked: (() -> Unit)? = null

    val token: String? get() = _state.value?.takeIf { !it.offline }?.token
    val isAdmin: Boolean get() = _state.value?.user?.role == "admin"
    val isOffline: Boolean get() = _state.value?.offline == true

    fun set(s: SessionState) {
        _state.value = s
    }

    fun clear() {
        _state.value = null
    }

    /** 401 from the server: the session ends and the copy kept for working offline goes too. */
    fun revoke() {
        clear()
        onRevoked?.invoke()
    }
}
