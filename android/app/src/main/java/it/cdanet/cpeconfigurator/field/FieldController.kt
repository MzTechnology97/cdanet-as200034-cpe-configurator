package it.cdanet.cpeconfigurator.field

import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.security.SecureStore
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
import kotlinx.coroutines.sync.withLock
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

/** Name of the CPE credentials in the [SecureStore]. */
private const val SAVED_ACCESS = "field-access"

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
    /** The CPE was not at the usual addresses: the Ubiquiti discovery found it at this one. */
    val discoveredHost: String? = null,
    /** A device answers the discovery but not its web interface: probably stuck (reboot it). */
    val stuck: it.cdanet.cpeconfigurator.tools.UbntDevice? = null,
)

/**
 * Talks to an already provisioned CPE from the field (alignment, diagnosis, acceptance).
 * CPE credentials come from the server and live only in memory; they are fetched while
 * online (login) so the tools also work later on a roof without Internet.
 */
class FieldController(private val api: ApiClient, private val network: NetworkHelper, private val scope: CoroutineScope,
    private val store: SecureStore? = null,
) {
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
        get() = field?.takeIf { network.isAlive(clientNet) }.also { if (it == null && field != null) field = null }
    /** The Wi-Fi [client] was made on: when it goes (CPE Wi-Fi joined again), a new client on the current one. */
    @Volatile private var clientNet: android.net.Network? = null
    private var job: Job? = null
    var onSample: ((AirosStatus) -> Unit)? = null

    val thresholds: FieldThresholds get() = access?.thresholds ?: FieldThresholds()
    val targetFirmware: String? get() = access?.targetFirmware

    private fun valid(a: FieldAccess?) = a != null && runCatching { Instant.parse(a.expiresAt).isAfter(Instant.now()) }.getOrDefault(false)

    /**
     * Fetches (or reuses) the CPE credentials. Called after login and before each session. They are
     * kept encrypted on the phone until they expire: on the CPE's Wi-Fi without Internet, even after
     * Android closed the app, the field tools still reach the CPE.
     */
    suspend fun prefetch(purpose: String = "diagnosis"): Boolean {
        if (valid(access)) return true
        val fresh = runCatching { api.fieldAccess(purpose) }.getOrNull()
        if (fresh != null) {
            access = fresh
            runCatching { store?.put(SAVED_ACCESS, AppJson.encodeToString(FieldAccess.serializer(), fresh)) }
            return true
        }
        val saved = runCatching { store?.get(SAVED_ACCESS)?.let { AppJson.decodeFromString(FieldAccess.serializer(), it) } }.getOrNull()
        if (valid(saved)) {
            access = saved
            return true
        }
        return false
    }

    /**
     * Reboots the CPE that answers the discovery but not its web interface ([FieldState.stuck]),
     * with the protocol's challenge: the credentials typed by hand, else the CDA Net ones.
     */
    suspend fun rebootStuck() {
        val d = _state.value.stuck ?: throw IllegalStateException("Nessuna CPE da riavviare")
        val cr = manual ?: working ?: access?.credentials ?: throw IllegalStateException("Credenziali CPE non disponibili: inseriscile a mano")
        it.cdanet.cpeconfigurator.tools.UbntDiscovery.reboot(network, d.mac!!, cr.username, cr.password)
        _state.update { it.copy(stuck = null, error = "Riavvio richiesto: la CPE torna raggiungibile in circa un minuto") }
    }

    /** The CDA Net CPE credentials on the phone (after [prefetch]), for tools outside the field session. */
    fun savedCredentials(): CredentialsDto? = access?.takeIf { valid(it) }?.credentials

    fun forget() {
        forgetSelection()
        stop()
        access = null
        store?.remove(SAVED_ACCESS)
        client = null
        working = null
    }

    /** Called at each start of a tool on the CPE (the app logs the ones done without Internet). */
    var onStart: ((FieldMode, String?) -> Unit)? = null

    /**
     * The CPE every tool of «CPE collegata» works on (diagnosis, alignment, acceptance, firmware,
     * AP change), found by the Ubiquiti discovery on the phone's Wi-Fi or picked from its list.
     */
    private val _selected = MutableStateFlow<it.cdanet.cpeconfigurator.tools.UbntDevice?>(null)
    val selected: StateFlow<it.cdanet.cpeconfigurator.tools.UbntDevice?> = _selected.asStateFlow()
    /** Several CPEs answered the discovery: the technician picks the one to work on. */
    private val _candidates = MutableStateFlow<List<it.cdanet.cpeconfigurator.tools.UbntDevice>>(emptyList())
    val candidates: StateFlow<List<it.cdanet.cpeconfigurator.tools.UbntDevice>> = _candidates.asStateFlow()
    private val _searching = MutableStateFlow(false)
    val searching: StateFlow<Boolean> = _searching.asStateFlow()
    /** The discovery ran for the current choice (not again at every reconnection). */
    @Volatile private var searched = false
    private val discoveryLock = kotlinx.coroutines.sync.Mutex()
    private val discoveredSshPort: Int? get() = _selected.value?.sshPort

    /**
     * The CPEs on this Wi-Fi (UniFi devices of the customer are not CPEs): one is selected at once,
     * several wait for the technician's choice. Two callers at the same time share one search.
     */
    suspend fun discoverCpes(): List<it.cdanet.cpeconfigurator.tools.UbntDevice> = discoveryLock.withLock {
        if (searched) return@withLock listOfNotNull(_selected.value).ifEmpty { _candidates.value }
        _searching.value = true
        try {
            val found = runCatching { it.cdanet.cpeconfigurator.tools.UbntDiscovery.discover(network, 2_500) }.getOrDefault(emptyList())
                .filter { d -> !d.unifi && d.ip?.let { Ip.isPrivate(it) } == true }
            searched = true
            _candidates.value = if (found.size > 1) found else emptyList()
            found.singleOrNull()?.let { select(it) }
            found
        } finally {
            _searching.value = false
        }
    }

    /** The CPE to work on (from the list of the discovery): the next connection goes there. */
    fun select(d: it.cdanet.cpeconfigurator.tools.UbntDevice) {
        _selected.value = d
        _candidates.value = emptyList()
        searched = true
        client = null
    }

    /** «Cerca di nuovo»: forgets the chosen CPE, the next connection (or [discoverCpes]) searches again. */
    fun forgetSelection() {
        _selected.value = null
        _candidates.value = emptyList()
        searched = false
        client = null
    }

    fun start(mode: FieldMode, manualHost: String? = null) {
        onStart?.invoke(mode, manualHost)
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
                    // several CPEs answer the discovery: the loop waits for the technician's choice
                    if (e is ChooseCpe) {
                        _state.update { it.copy(connecting = false, running = false, error = null) }
                        return@launch
                    }
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
            network.onWifi { it.cdanet.cpeconfigurator.install.CpeRelinker(onStage).relink(host, listOfNotNull(sshPort, discoveredSshPort, access?.sshPort, 22).distinct(), cr.username, cr.password, ssid, psk, lockMac) }
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
        val ports = listOfNotNull(discoveredSshPort, access?.sshPort, 22).distinct()
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

    private class ChooseCpe : Exception("Scegli la CPE")

    /**
     * The CPE to work on: the IP typed by hand; else the Ubiquiti discovery on this Wi-Fi (one CPE:
     * that one, whatever its IP; several: the technician picks one); then, as a fallback, the
     * gateway of the Wi-Fi and the usual CPE addresses.
     */
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
        val tried = mutableSetOf<String>()
        fun tryHost(host: String): AirosClient? {
            tried += host
            for (url in AirosClient.candidates(host)) {
                val port = url.substringAfterLast(':').toIntOrNull() ?: if (url.startsWith("https")) 443 else 80
                val open = runCatching { wifi.socketFactory.createSocket().use { s: Socket -> s.connect(InetSocketAddress(host, port), 700) } }.isSuccess
                if (!open) continue
                var rejected = false
                for ((cr, label) in creds) {
                    try {
                        val cl = AirosClient(url, wifi.socketFactory).apply { login(cr.username, cr.password) }
                        clientNet = wifi
                        working = cr
                        _state.update { it.copy(authFailed = false, credentialsUsed = label, stuck = null) }
                        return cl
                    } catch (e: AirosAuthException) {
                        authError = e
                        rejected = true
                    } catch (_: Exception) {
                        break // not an airOS web UI on this port
                    }
                }
                if (rejected) break // same host, other port: same answers
            }
            return null
        }
        // first the discovery: the CPE answers whatever its IP; several CPEs: the technician
        // chooses (no guess). Then the chosen CPE, then the usual addresses as a fallback
        if (manualHost == null && _selected.value == null) {
            if (discoverCpes().size > 1) throw ChooseCpe()
        }
        if (manualHost == null) _selected.value?.let { d ->
            tryHost(d.ip!!)?.let { cl ->
                _state.update { it.copy(discoveredHost = d.ip, stuck = null) }
                return@withContext cl
            }
            // it answers the discovery, its web interface does not: stuck, a reboot may help
            if (authError == null && d.mac != null) _state.update { it.copy(stuck = d) }
        }
        for (host in hosts) {
            if (host in tried) continue
            tryHost(host)?.let { return@withContext it }
        }
        if (authError != null) {
            _state.update { it.copy(authFailed = true) }
            throw AirosAuthException(
                if (m != null) "La CPE rifiuta anche le credenziali inserite: controllale e riprova"
                else "La CPE rifiuta le credenziali CDA Net e quelle di fabbrica (ubnt/ubnt): inserisci quelle della CPE",
            )
        }
        throw IllegalStateException("Nessuna CPE trovata: né la discovery Ubiquiti né ${hosts.joinToString()} rispondono. Verifica la Wi-Fi a cui sei collegato o usa «IP manuale»")
    }
}
