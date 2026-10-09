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
    val sshPort: Int = 22,
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
    /** The CPE rejected every credential tried: the technician can type the right ones. */
    val authFailed: Boolean = false,
    /** Which credentials opened the CPE ("CDA Net", "di fabbrica", "inserite a mano"). */
    val credentialsUsed: String? = null,
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
    /** Typed by the technician for a CPE with non-standard credentials: memory only, never saved or sent. */
    @Volatile private var manual: CredentialsDto? = null
    /** Credentials the CPE accepted on the last connection (SSH uses the same ones). */
    @Volatile private var working: CredentialsDto? = null

    fun useManualCredentials(username: String, password: String) {
        manual = CredentialsDto(username.trim(), password).takeIf { it.username.isNotBlank() && it.password.isNotEmpty() }
        client = null
    }
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
        working = null
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
                    // every credential rejected: stop instead of hammering the CPE with logins
                    if (_state.value.authFailed) {
                        _state.update { it.copy(running = false) }
                        return@launch
                    }
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

    /** APs heard by the CPE (site survey), on the current or a new airOS session. */
    suspend fun siteSurvey(): List<SurveyAp> = withContext(Dispatchers.IO) {
        val c = client ?: connect(null).also { client = it }
        try {
            c.survey()
        } catch (e: AirosAuthException) {
            client = null
            connect(null).also { client = it }.survey()
        }
    }

    /**
     * Moves the CPE to another AP (new SSID and WPA2 key), over SSH with the credentials that
     * opened its web UI. The CPE reboots: polling stops and the caller restarts it afterwards.
     */
    suspend fun relink(ssid: String, psk: String, lockMac: String?, sshPort: Int?, onStage: (String) -> Unit) = withContext(Dispatchers.IO) {
        val c = client ?: connect(null).also { client = it }
        val cr = working ?: throw IllegalStateException("Credenziali della CPE non disponibili: ricollegati alla CPE")
        val host = c.baseUrl.substringAfter("://").substringBefore('/').substringBefore(':')
        stop()
        try {
            network.onWifi { it.cdanet.cpeconfigurator.install.CpeRelinker(onStage).relink(host, listOfNotNull(sshPort, access?.sshPort, 22), cr.username, cr.password, ssid, psk, lockMac) }
        } finally {
            client = null
        }
    }

    /**
     * SSH on the CPE the phone is on, with the credentials that opened its web UI (field tools
     * stop meanwhile). [block] gets a way to open sessions: also after a reboot of the CPE.
     */
    suspend fun <T> withCpeSsh(block: suspend (open: suspend () -> it.cdanet.cpeconfigurator.ssh.SshConnection) -> T): T = withContext(Dispatchers.IO) {
        val c = client ?: connect(null).also { client = it }
        val cr = working ?: throw IllegalStateException("Credenziali della CPE non disponibili: ricollegati alla CPE")
        val host = c.baseUrl.substringAfter("://").substringBefore('/').substringBefore(':')
        val ports = listOfNotNull(access?.sshPort, 22).distinct()
        stop()
        try {
            block {
                // the Wi-Fi may be a new network after a reboot: bind to the current one each time
                network.onWifi {
                    var last: Exception? = null
                    for (p in ports) {
                        try {
                            return@onWifi it.cdanet.cpeconfigurator.ssh.SshConnection.connect(host, p, cr.username, cr.password)
                        } catch (e: java.io.IOException) {
                            if (e.message.orEmpty().startsWith("Autenticazione")) throw e
                            last = e
                        }
                    }
                    throw last ?: java.io.IOException("SSH non raggiungibile su $host")
                }
            }
        } finally {
            client = null
        }
    }

    /** Gateway of the current Wi-Fi first (CPE in router mode or its management Wi-Fi), then the configured IPs. */
    private suspend fun connect(manualHost: String?): AirosClient = withContext(Dispatchers.IO) {
        val a = access
        val m = manual
        if (a == null && m == null) throw IllegalStateException("Credenziali CPE non disponibili: apri lo strumento una volta con Internet attivo (dopo l'accesso) oppure inseriscile a mano")
        val wifi = network.wifiNetwork() ?: throw IllegalStateException("Collegati alla Wi-Fi della CPE o del router del cliente")
        val link = network.wifiLink()
        val hosts = (listOfNotNull(manualHost) + listOfNotNull(link?.gateway) + (a?.hosts ?: listOf("192.168.1.20"))).distinct().filter { Ip.isPrivate(it) }
        // typed by hand first, then the CDA Net standard ones, then factory airOS (ubnt/ubnt)
        val creds = listOfNotNull(
            m?.let { it to "inserite a mano" },
            a?.credentials?.let { it to "CDA Net" },
            CredentialsDto("ubnt", "ubnt") to "di fabbrica",
        ).distinctBy { it.first }
        _state.update { it.copy(connecting = true) }
        var authError: Exception? = null
        for (host in hosts) {
            for (url in AirosClient.candidates(host)) {
                val port = url.substringAfterLast(':').toIntOrNull() ?: if (url.startsWith("https")) 443 else 80
                val open = runCatching { wifi.socketFactory.createSocket().use { s: Socket -> s.connect(InetSocketAddress(host, port), 700) } }.isSuccess
                if (!open) continue
                var rejected = false
                for ((cr, label) in creds) {
                    try {
                        val cl = AirosClient(url, wifi.socketFactory).apply { login(cr.username, cr.password) }
                        working = cr
                        _state.update { it.copy(authFailed = false, credentialsUsed = label) }
                        return@withContext cl
                    } catch (e: AirosAuthException) {
                        authError = e
                        rejected = true
                    } catch (_: Exception) {
                        break // not an airOS web UI on this port
                    }
                }
                if (rejected) break // same host, other port: same answers
            }
        }
        if (authError != null) {
            _state.update { it.copy(authFailed = true) }
            throw AirosAuthException(
                if (m != null) "La CPE rifiuta anche le credenziali inserite: controllale e riprova"
                else "La CPE rifiuta le credenziali CDA Net e quelle di fabbrica (ubnt/ubnt): inserisci quelle della CPE",
            )
        }
        throw IllegalStateException("Nessuna CPE airOS trovata su ${hosts.joinToString()}: verifica la Wi-Fi a cui sei collegato")
    }
}
