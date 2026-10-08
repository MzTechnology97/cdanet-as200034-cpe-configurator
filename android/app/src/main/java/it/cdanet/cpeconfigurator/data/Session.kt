package it.cdanet.cpeconfigurator.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class SessionState(val token: String, val user: UserDto, val expiresAt: String)

/** Bearer token kept in memory only; it is never written to disk. */
class Session {
    private val _state = MutableStateFlow<SessionState?>(null)
    val state: StateFlow<SessionState?> = _state.asStateFlow()

    val token: String? get() = _state.value?.token
    val isAdmin: Boolean get() = _state.value?.user?.role == "admin"

    fun set(s: SessionState) {
        _state.value = s
    }

    fun clear() {
        _state.value = null
    }
}
