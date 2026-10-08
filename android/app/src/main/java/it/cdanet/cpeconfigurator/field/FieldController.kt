package it.cdanet.cpeconfigurator.field

import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.CredentialsDto
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.network.NetworkHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.net.InetSocketAddress
import java.net.Socket
import java.time.Instant

@Serializable
data class FieldAccess(
    val credentials: CredentialsDto,
    val hosts: List<String>,
    val targetFirmware: String? = null,
    val thresholds: FieldThresholds = FieldThresholds(),
    val expiresAt: String,
)

enum class FieldMode { Alignment, Diagnosis }

data class FieldState(
    val running: Boolean = false,
    val connecting: Boolean = false,
    val target: String? = null,
    val status: AirosStatus? = null,
    val checks: List<Check> = emptyList(),
    /** Last signals (oldest first), for the trend line. */
    val history: List<Int> = emptyList(),
    val peak: Int? = null,
    val updatedAt: Long? = null,
    val error: String? = null,
)

/**
 * Talks to an already provisioned CPE from the field (alignment, diagnosis, acceptance).
 * CPE credentials come from the server and live only in memory; they are fetched while
 * online (login) so the tools also work later on a roof without Internet.
 */
class FieldController(private val api: ApiClient, private val network: NetworkHelper, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(FieldState())
    val state: StateFlow<FieldState> = _state.asStateFlow()

    @Volatile private var access: FieldAccess? = null
    private var client: AirosClient? = null
    private var job: Job? = null
    var onSample: ((AirosStatus) -> Unit)? = null

    val thresholds: FieldThresholds get() = access?.thresholds ?: FieldThresholds()
    val targetFirmware: String? get() = access?.targetFirmware

    /** Fetches (or reuses) the CPE credentials. Called after login and before each session. */
    suspend fun prefetch(purpose: String = "diagnosis"): Boolean {
        val a = access
        if (a != null && runCatching { Instant.parse(a.expiresAt).isAfter(Instant.now()) }.getOrDefault(false)) return true
        return runCatching { api.fieldAccess(purpose) }.onSuccess { access = it }.isSuccess
    }

    fun forget() {
        stop()
        access = null
        client = null
    }

    fun start(mode: FieldMode, manualHost: String? = null) {
        stop()
        _state.value = FieldState(running = true, connecting = true)
        job = scope.launch(Dispatchers.IO) {
            val period = if (mode == FieldMode.Alignment) 1_000L else 3_000L
            while (isActive) {
                try {
                    val c = client?.takeIf { manualHost == null || it.baseUrl.contains("//$manualHost") } ?: connect(manualHost).also { client = it }
                    val s = try {
                        c.status()
                    } catch (e: AirosAuthException) {
                        client = null
                        throw e
                    }
                    onSample?.invoke(s)
                    val checks = FieldDiagnosis.checks(s, thresholds, targetFirmware)
                    _state.update { st ->
                        val hist = (st.history + listOfNotNull(s.signal)).takeLast(90)
                        st.copy(
                            connecting = false,
                            target = c.baseUrl,
                            status = s,
                            checks = checks,
                            history = hist,
                            peak = listOfNotNull(st.peak, s.signal).maxOrNull(),
                            updatedAt = System.currentTimeMillis(),
                            error = null,
                        )
                    }
                } catch (e: Exception) {
                    if (e is AirosAuthException) client = null
                    _state.update { it.copy(connecting = false, error = e.message ?: e.toString()) }
                    delay(1_500)
                }
                delay(period)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        _state.update { it.copy(running = false, connecting = false) }
    }

    fun resetPeak() = _state.update { it.copy(peak = null, history = emptyList()) }

    /** Gateway of the current Wi-Fi first (CPE in router mode or its management Wi-Fi), then the configured IPs. */
    private suspend fun connect(manualHost: String?): AirosClient = withContext(Dispatchers.IO) {
        val a = access ?: throw IllegalStateException("Credenziali CPE non disponibili: apri lo strumento una volta con Internet attivo (dopo l'accesso)")
        val wifi = network.wifiNetwork() ?: throw IllegalStateException("Collegati alla Wi-Fi della CPE o del router del cliente")
        val link = network.wifiLink()
        val hosts = (listOfNotNull(manualHost) + listOfNotNull(link?.gateway) + a.hosts).distinct().filter { Ip.isPrivate(it) }
        _state.update { it.copy(connecting = true) }
        var authError: Exception? = null
        for (host in hosts) {
            for (url in AirosClient.candidates(host)) {
                val port = url.substringAfterLast(':').toIntOrNull() ?: if (url.startsWith("https")) 443 else 80
                val open = runCatching { wifi.socketFactory.createSocket().use { s: Socket -> s.connect(InetSocketAddress(host, port), 700) } }.isSuccess
                if (!open) continue
                try {
                    return@withContext AirosClient(url, wifi.socketFactory).apply { login(a.credentials.username, a.credentials.password) }
                } catch (e: AirosAuthException) {
                    authError = e
                    break // same host, other port: same credentials
                } catch (_: Exception) {
                    continue
                }
            }
        }
        throw authError ?: IllegalStateException("Nessuna CPE airOS trovata su ${hosts.joinToString()}: verifica la Wi-Fi a cui sei collegato")
    }
}
