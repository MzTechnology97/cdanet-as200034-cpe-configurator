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

    /** Admins and specialists: the same security policy (two-step verification, screenshots). */
    val isStaff: Boolean get() = _state.value?.user?.role.let { it == "admin" || it == "specialist" }

    /**
     * The views of the NOC, CDA Net's data of everyone (issue #275): the admins and the specialists an
     * admin gave «visibilità piena». A specialist may be outside CDA Net: without it he sees his own
     * work and that of his work groups, like an installer. The server decides the same way.
     */
    val seesAll: Boolean get() = _state.value?.user?.let { it.role == "admin" || (it.role == "specialist" && it.fullView) } == true

    /**
     * CDA Net's own field work, with its Wi-Fi keys and the password of its CPEs: admins, installers
     * and the specialists with «visibilità piena». The others work for their companies only, in the
     * Specialist section (the server refuses the rest).
     */
    val doesCdaWork: Boolean get() = _state.value?.user?.let { it.role != "specialist" || it.fullView } != false

    /** The specialist's own section (his templates, connectors and installations for other companies). */
    val isSpecialist: Boolean get() = _state.value?.user?.role == "specialist"
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
