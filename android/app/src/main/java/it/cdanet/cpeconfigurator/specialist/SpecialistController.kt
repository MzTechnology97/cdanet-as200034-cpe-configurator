package it.cdanet.cpeconfigurator.specialist

import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.ApiException
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.CpeIdDto
import it.cdanet.cpeconfigurator.data.CpeLocation
import it.cdanet.cpeconfigurator.data.CredentialsDto
import it.cdanet.cpeconfigurator.data.DetectedDto
import it.cdanet.cpeconfigurator.data.JobSummaryDto
import it.cdanet.cpeconfigurator.data.ProvisionPackage
import it.cdanet.cpeconfigurator.data.Session
import it.cdanet.cpeconfigurator.data.SpecAcceptanceDto
import it.cdanet.cpeconfigurator.data.SpecAskedDto
import it.cdanet.cpeconfigurator.data.SpecConnectorDto
import it.cdanet.cpeconfigurator.data.SpecCpeLoginDto
import it.cdanet.cpeconfigurator.data.SpecJobDto
import it.cdanet.cpeconfigurator.data.SpecJobRequest
import it.cdanet.cpeconfigurator.data.SpecLocationDto
import it.cdanet.cpeconfigurator.data.SpecPendingResult
import it.cdanet.cpeconfigurator.data.SpecRadioDto
import it.cdanet.cpeconfigurator.data.SpecReplacementDto
import it.cdanet.cpeconfigurator.data.SpecResultDto
import it.cdanet.cpeconfigurator.data.SpecTemplateDto
import it.cdanet.cpeconfigurator.data.SpecValuesDto
import it.cdanet.cpeconfigurator.data.TargetDto
import it.cdanet.cpeconfigurator.data.specConnectors
import it.cdanet.cpeconfigurator.data.specCreateJob
import it.cdanet.cpeconfigurator.data.specPutAcceptance
import it.cdanet.cpeconfigurator.data.specSendResult
import it.cdanet.cpeconfigurator.data.specTemplates
import it.cdanet.cpeconfigurator.data.specValues
import it.cdanet.cpeconfigurator.field.AirosAuthException
import it.cdanet.cpeconfigurator.field.AirosClient
import it.cdanet.cpeconfigurator.field.AirosStatus
import it.cdanet.cpeconfigurator.firmware.AirosBuild
import it.cdanet.cpeconfigurator.firmware.AirosImage
import it.cdanet.cpeconfigurator.firmware.CpeFirmwareFlasher
import it.cdanet.cpeconfigurator.firmware.FirmwareStore
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.network.NetworkHelper
import it.cdanet.cpeconfigurator.provisioning.CpeProvisioner
import it.cdanet.cpeconfigurator.provisioning.DeviceCheck
import it.cdanet.cpeconfigurator.provisioning.DiscoveryCheck
import it.cdanet.cpeconfigurator.provisioning.ProvisioningFailure
import it.cdanet.cpeconfigurator.provisioning.Validation
import it.cdanet.cpeconfigurator.security.SecureStore
import it.cdanet.cpeconfigurator.ssh.SshConnection
import it.cdanet.cpeconfigurator.tools.UbntDevice
import it.cdanet.cpeconfigurator.tools.UbntDiscovery
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import java.io.IOException
import java.net.InetSocketAddress
import java.time.Instant

/*
 * The Specialist's flow (owner, 17/10/2026), apart from CDA Net's installation, which stays as it
 * is: the CPE found by the Ubiquiti discovery whatever its IP, read over SSH (MAC, serial, model,
 * firmware, board: nothing to scan, no warehouse), its firmware updated here when needed, the
 * configuration made from one of his templates with what he types for this CPE (the Wi-Fi key of
 * his APs, the PPPoE, the CPE's credentials: memory only), written, then the optional check and
 * acceptance test (no NOC) and the authorization in the company's UISP.
 */

/** The CPE on the phone's Wi-Fi, read over SSH before anything is written. Its login stays in memory. */
data class SpecCpe(
    val ip: String,
    val sshPort: Int,
    /** A model the templates are made for (null: not supported). */
    val model: String?,
    val product: String,
    /** The MAC the configuration is written for (one of those the CPE reports). */
    val mac: String,
    val macs: List<String>,
    val serial: String,
    /** /etc/version as read (the write compares it as it is). */
    val firmware: String?,
    val build: AirosBuild?,
    val board: String?,
    val hostname: String?,
    val factory: Boolean?,
    val login: CredentialsDto,
    val loginLabel: String,
) {
    override fun toString(): String = "SpecCpe(ip=$ip, mac=$mac, model=$model)"
}

/** What the specialist types, in memory only: the secrets of a CPE never go anywhere but into it. */
data class SpecForm(
    val connectorId: Int? = null,
    val company: String = "",
    val templateId: Int? = null,
    val values: Map<String, String> = emptyMap(),
    /** The CPE's admin credentials after the configuration. */
    val cpeUser: String = "",
    val cpePassword: String = "",
    /** The CPE's credentials as they are now, for a CPE configured by someone else. */
    val currentUser: String = "",
    val currentPassword: String = "",
    val customer: String = "",
    val notes: String = "",
    val location: CpeLocation? = null,
    val locationLabel: String = "",
) {
    override fun toString(): String = "SpecForm(templateId=$templateId, connectorId=$connectorId)"

    val current: CredentialsDto? get() = if (currentUser.isNotBlank() && currentPassword.isNotEmpty()) CredentialsDto(currentUser.trim(), currentPassword) else null
    val newLogin: CredentialsDto? get() = if (cpeUser.isNotBlank() && cpePassword.isNotEmpty()) CredentialsDto(cpeUser.trim(), cpePassword) else null
}

/** A configuration written (or tried): what the steps after it need. The new credentials stay in memory. */
data class SpecDone(
    val jobId: String,
    val summary: JobSummaryDto,
    val ok: Boolean,
    val login: CredentialsDto,
    val lanIp: String?,
    val connectorId: Int?,
) {
    override fun toString(): String = "SpecDone(jobId=$jobId, ok=$ok)"
}

data class SpecState(
    /** What is running: search, read, download, firmware, prepare, write, verify, acceptance. */
    val busy: String? = null,
    val error: String? = null,
    /** The step [error] belongs to (shown under its card). */
    val errorAt: String? = null,
    /** Several devices answered the discovery: the specialist picks the CPE. */
    val candidates: List<UbntDevice> = emptyList(),
    val searched: Boolean = false,
    val device: UbntDevice? = null,
    val cpe: SpecCpe? = null,
    /** The CPE refused every credential tried: its current ones are needed. */
    val authFailed: Boolean = false,
    val firmwareStages: List<String> = emptyList(),
    /** The update done in this flow (it goes into the history with the write). */
    val firmwareNote: String? = null,
    /** He keeps the firmware the CPE has: the configuration is written on it. */
    val keepFirmware: Boolean = false,
    val connectors: List<SpecConnectorDto>? = null,
    val templates: List<SpecTemplateDto>? = null,
    val asked: SpecValuesDto? = null,
    /** Template and connector [asked] was read for. */
    val askedFor: Pair<Int, Int?>? = null,
    /** The configuration prepared (secrets: memory, and encrypted on the phone until written). */
    val pkg: ProvisionPackage? = null,
    val stages: List<String> = emptyList(),
    val done: SpecDone? = null,
    val writeError: String? = null,
    val verify: AirosStatus? = null,
    /** The installation as the server has it after the acceptance test. */
    val job: SpecJobDto? = null,
    /**
     * He is on the CPE's Wi-Fi already and reads it before the configuration (else: first the
     * configuration, then the CPE). Back to false with the next CPE.
     */
    val readFirst: Boolean = false,
) {
    /** A CPE is being configured (Home offers to go back to it). */
    val inProgress: Boolean get() = pkg != null || (cpe != null && done == null) || done?.ok == true
}

/** A template open in the editor of the app (new: [id] null; made from the CPE: what became a placeholder). */
data class SpecEditorOpen(
    val model: String,
    val id: Int? = null,
    val name: String = "",
    val notes: String = "",
    val template: String? = null,
    val boardMatch: String? = null,
    val snmpSet: Boolean = false,
    val sha256: String = "",
    val updatedAt: String = "",
    val replacements: List<SpecReplacementDto> = emptyList(),
    val warnings: List<String> = emptyList(),
) {
    override fun toString(): String = "SpecEditorOpen(model=$model, id=$id)"
}

/** Pure rules of the flow (unit-tested on the JVM). */
object SpecialistRules {
    private val WPA2 = Regex("""^[\x20-\x7e]{8,63}$""")
    private val WPA2_HEX = Regex("""^[0-9A-Fa-f]{64}$""")
    private val LOGIN = Regex("""^[\x21-\x7e]+$""")

    /** Values of the customer of one CPE: not kept for the next one (with the secrets). */
    val PER_CPE = setOf("DEVICE_NAME", "PPPOE_USER", "SNMP_LOCATION")

    fun isWpa2Key(v: String): Boolean = WPA2.matches(v) || WPA2_HEX.matches(v)

    fun isSsid(v: String): Boolean = v.isNotEmpty() && v.toByteArray(Charsets.UTF_8).size <= 32 && v.none { it == '\r' || it == '\n' || it == '\u0000' }

    /** The firmware may be written on: the required one, or the one he chose to keep. */
    fun firmwareReady(cpe: SpecCpe?, target: String, keep: Boolean): Boolean {
        val version = cpe?.build?.version
        return keep || version == null || version == target
    }

    /** Placeholders the server fills from the CPE read: a template with them needs the CPE before the preparation. */
    val FROM_CPE = setOf("EXPECTED_MAC", "EXPECTED_SERIAL")

    /**
     * What stops the preparation, in plain words (empty: ready). [cpe] null: prepared before
     * connecting to the CPE (owner, 17/10/2026), the model is the template's and the firmware is
     * seen at the write; [placeholders]: the template's (one filled from the CPE needs it read first).
     */
    fun problems(
        f: SpecForm,
        cpe: SpecCpe?,
        template: SpecTemplateDto?,
        asked: List<SpecAskedDto>?,
        firmwareReady: Boolean,
        placeholders: List<String> = emptyList(),
    ): List<String> = buildList {
        val model = cpe?.model
        val templateModel = template?.model
        if (cpe != null && model == null) add("Modello della CPE non supportato (${cpe.product})")
        if (cpe != null && !firmwareReady) add("Firmware: aggiornalo o scegli di tenerlo")
        if (templateModel == null) add("Scegli il template")
        else if (model != null && templateModel != model) add("Il template è per $templateModel, la CPE è una $model")
        if (cpe == null && placeholders.any { it in FROM_CPE }) add("Il template usa il MAC o il seriale della CPE: collegati alla CPE e leggila prima")
        if (templateModel != null && asked == null) add("Valori del template non ancora letti: serve Internet")
        asked.orEmpty().forEach { a ->
            val v = f.values[a.name].orEmpty()
            val label = a.label.ifBlank { a.name }
            when {
                v.isBlank() -> add("Manca: $label")
                v.any { it == '\n' || it == '\r' } -> add("$label: una sola riga")
                a.name == "WPA2_PSK" && !isWpa2Key(v) -> add("Chiave Wi-Fi: da 8 a 63 caratteri, o 64 cifre esadecimali")
                a.name == "SSID" && !isSsid(v) -> add("SSID: da 1 a 32 caratteri")
                else -> Unit
            }
        }
        val user = f.cpeUser.trim()
        if (user.isEmpty()) add("Scrivi l'utente admin della CPE")
        else if (!LOGIN.matches(user)) add("Utente admin della CPE: senza spazi né lettere accentate")
        if (f.cpePassword.isEmpty()) add("Scrivi la password admin della CPE")
        else if (f.cpePassword == CpeProvisioner.FACTORY.password) add("La password admin non può restare quella di fabbrica")
        else if (f.cpePassword.any { it == '\n' || it == '\r' }) add("Password admin della CPE: una sola riga")
    }

    /** What stops writing a configuration prepared before connecting to the CPE (empty: ready). */
    fun writeProblems(pkg: ProvisionPackage, cpe: SpecCpe?, firmwareReady: Boolean): List<String> {
        if (!pkg.needsCpe) return emptyList()
        val problem = when {
            cpe == null -> "Collegati alla Wi-Fi di management della CPE: l'app la trova e la legge"
            cpe.model != pkg.summary.model -> "La CPE collegata è una ${cpe.model ?: cpe.product}: la configurazione è per ${pkg.summary.model}"
            !firmwareReady -> "Firmware: aggiornalo o scegli di tenerlo"
            else -> null
        }
        return listOfNotNull(problem)
    }

    /**
     * A configuration prepared before connecting to the CPE, for the CPE read: its address, MAC
     * and serial (they go to the server with the outcome). The text stays the one prepared.
     */
    fun bind(pkg: ProvisionPackage, cpe: SpecCpe): ProvisionPackage = pkg.copy(
        target = TargetDto(cpe.ip, cpe.sshPort),
        checks = pkg.checks.copy(mac = cpe.mac),
        summary = pkg.summary.copy(mac = cpe.mac, serial = cpe.serial),
        scannedOnSite = true,
    )

    /** For the next CPE: the values that are not of this CPE's customer and not secret stay (VLAN, SSID…). */
    fun keepForNext(values: Map<String, String>, asked: List<SpecAskedDto>): Map<String, String> {
        val secret = asked.filter { it.secret }.map { it.name }.toSet()
        return values.filterKeys { k -> k !in secret && k !in PER_CPE && !SECRET_NAME.containsMatchIn(k) }
    }

    /** Names that read as a secret (as the server marks them). */
    val SECRET_NAME = Regex("PASS|PSK|SECRET|KEY|COMMUNITY")

    /** The MAC the configuration is written for: the one of the discovery when the CPE reports it, else the first read. */
    fun macFor(discovered: String?, read: Set<String>): String? {
        val d = discovered?.let { DeviceCheck.normalizeMac(it) }
        return d?.takeIf { it in read } ?: read.firstOrNull() ?: d
    }
}

/**
 * The outcomes of the writes, until the server has them (on the CPE's Wi-Fi there is often no
 * Internet): encrypted on the phone, sent at login, every two minutes and when the phone is back online.
 */
class SpecialistResults(private val store: SecureStore?, private val api: ApiClient, private val session: Session, private val scope: CoroutineScope) {
    private val mutex = Mutex()
    private val serializer = ListSerializer(SpecPendingResult.serializer())
    private val _pending = MutableStateFlow(load())
    val pending: StateFlow<List<SpecPendingResult>> = _pending.asStateFlow()

    /** Outcomes the server refused for good: shown in the history until dismissed. */
    private val _refused = MutableStateFlow<List<String>>(emptyList())
    val refused: StateFlow<List<String>> = _refused.asStateFlow()

    private fun load(): List<SpecPendingResult> {
        val text = store?.get(KEY) ?: return emptyList()
        return runCatching { AppJson.decodeFromString(serializer, text) }.getOrDefault(emptyList())
    }

    private fun persist(items: List<SpecPendingResult>) {
        runCatching { if (items.isEmpty()) store?.remove(KEY) else store?.put(KEY, AppJson.encodeToString(serializer, items)) }
        _pending.value = items
    }

    suspend fun enqueue(item: SpecPendingResult) = mutex.withLock {
        persist((_pending.value.filterNot { it.jobId == item.jobId } + item).takeLast(100))
    }

    /** Sends what is waiting; keeps what failed for the network (401, 429, 5xx too). Returns how many went. */
    suspend fun sync(): Int = mutex.withLock {
        if (session.token == null || _pending.value.isEmpty()) return@withLock 0
        var sent = 0
        val left = mutableListOf<SpecPendingResult>()
        val rejected = mutableListOf<String>()
        for (item in _pending.value) {
            try {
                api.specSendResult(item.jobId, item.result)
                sent++
            } catch (e: ApiException) {
                when {
                    e.status == 401 || e.status == 429 || e.status >= 500 -> left += item
                    // already recorded with the same outcome: nothing to send
                    e.status == 409 -> Unit
                    else -> rejected += "Esito di ${item.label} rifiutato dal server: ${e.message ?: e.code}"
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                left += item
            }
        }
        persist(left)
        if (rejected.isNotEmpty()) _refused.value = (_refused.value + rejected).takeLast(10)
        sent
    }

    fun syncInBackground() {
        scope.launch { runCatching { sync() } }
    }

    fun dismissRefused() {
        _refused.value = emptyList()
    }

    companion object {
        private const val KEY = "specialist-results"
    }
}

class SpecialistController(
    private val api: ApiClient,
    private val network: NetworkHelper,
    private val scope: CoroutineScope,
    private val store: SecureStore?,
    session: Session,
) {
    private val _state = MutableStateFlow(SpecState())
    val state: StateFlow<SpecState> = _state.asStateFlow()
    private val _form = MutableStateFlow(SpecForm())
    val form: StateFlow<SpecForm> = _form.asStateFlow()
    val results = SpecialistResults(store, api, session, scope)

    init {
        restore()
    }

    fun updateForm(f: (SpecForm) -> SpecForm) = _form.update(f)

    /** The template open in the editor (a screen of its own: it survives the way back and forth). */
    private val _editing = MutableStateFlow<SpecEditorOpen?>(null)
    val editing: StateFlow<SpecEditorOpen?> = _editing.asStateFlow()

    fun openEditor(open: SpecEditorOpen?) {
        _editing.value = open
    }

    /** A template saved or deleted: the flow reads his templates (and what they ask) again. */
    fun templatesChanged() {
        _state.update { it.copy(asked = null, askedFor = null) }
        scope.launch { loadLists() }
    }

    fun clearError() = _state.update { it.copy(error = null, errorAt = null) }

    /** Runs a step: [what] is busy meanwhile, a failure becomes its error (in Italian). */
    private suspend fun <T> work(what: String, block: suspend () -> T): T? {
        _state.update { it.copy(busy = what, error = null, errorAt = null) }
        return try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(error = e.message ?: e.toString(), errorAt = what) }
            null
        } finally {
            _state.update { it.copy(busy = null) }
        }
    }

    // ---- his lists (with Internet) ---------------------------------------------------------------

    suspend fun loadLists() {
        runCatching { api.specTemplates() }.onSuccess { t -> _state.update { it.copy(templates = t) } }
        runCatching { api.specConnectors() }.onSuccess { l -> _state.update { it.copy(connectors = l) } }
    }

    /** What is typed for the chosen template (and company): read again when either changes. */
    suspend fun loadAsked() {
        val f = _form.value
        val t = f.templateId ?: return
        val key = t to f.connectorId
        if (_state.value.askedFor == key && _state.value.asked != null) return
        runCatching { api.specValues(t, f.connectorId) }
            .onSuccess { v -> _state.update { it.copy(asked = v, askedFor = key) } }
            .onFailure { e -> _state.update { it.copy(asked = null, askedFor = null, error = e.message, errorAt = "prepare") } }
    }

    // ---- 1 · the CPE ------------------------------------------------------------------------------

    /** One search at a time (the screen's own and «Cerca di nuovo»). */
    private val searching = Mutex()

    /** The CPEs on this Wi-Fi, whatever their IP: one is read at once, several wait for a choice. */
    suspend fun search() {
        if (!searching.tryLock()) return
        try {
            val found = work("search") {
                UbntDiscovery.discover(network, 2_500).filter { d -> !d.unifi && d.ip?.let { Ip.isPrivate(it) } == true }
            } ?: return
            _state.update { it.copy(searched = true, candidates = if (found.size > 1) found else emptyList()) }
            found.singleOrNull()?.let { read(it) }
        } finally {
            searching.unlock()
        }
    }

    /** «Cerca di nuovo»: forgets the CPE read (a new one on the Wi-Fi, or after a reset); the search goes on. */
    fun forgetCpe() {
        _state.update {
            it.copy(
                device = null, cpe = null, candidates = emptyList(), searched = false, authFailed = false, keepFirmware = false,
                firmwareStages = emptyList(), firmwareNote = null, error = null, errorAt = null,
                // looking for a CPE again: the screen stays on the CPE
                readFirst = it.readFirst || it.cpe != null || it.device != null,
            )
        }
    }

    /** The CPE before the configuration ([on]), or back to the configuration first, without the CPE. */
    fun readFirst(on: Boolean) {
        if (!on) forgetCpe()
        _state.update { it.copy(readFirst = on) }
    }

    /** Reads the CPE over SSH (the current credentials typed, the factory ones, the new ones): MACs, firmware, board. */
    suspend fun read(d: UbntDevice) {
        val ip = d.ip ?: return
        _state.update { it.copy(device = d, candidates = emptyList(), cpe = null, authFailed = false) }
        val f = _form.value
        val cpe = work("read") {
            withContext(Dispatchers.IO) {
                val port = d.sshPort?.takeIf { it in 1..65535 } ?: 22
                val (ssh, cr) = open(ip, port, loginsFor(f))
                ssh.use { s ->
                    val rb = DeviceCheck.parse(s.exec(DeviceCheck.READBACK_COMMAND, 8_000).stdout)
                    val hex = SpecialistRules.macFor(d.mac, rb.macs) ?: throw IOException("MAC della CPE non leggibile")
                    SpecCpe(
                        ip = ip,
                        sshPort = port,
                        model = Validation.modelFromDiscovery(d.model, d.fullModel) ?: Validation.modelFromDiscovery(rb.board, null),
                        product = d.product ?: d.fullModel ?: d.model ?: rb.board ?: "Ubiquiti",
                        mac = DeviceCheck.formatMac(hex),
                        macs = rb.macs.map { DeviceCheck.formatMac(it) },
                        serial = d.serial?.takeIf { it.isNotBlank() }?.uppercase() ?: hex.uppercase(),
                        firmware = rb.firmware,
                        build = rb.firmware?.let { AirosImage.parseBuild(it) },
                        board = rb.board,
                        hostname = d.hostname,
                        factory = d.factoryDefault,
                        login = cr,
                        loginLabel = labelOf(cr, f),
                    )
                }
            }
        }
        if (cpe == null) {
            if (_state.value.error.orEmpty().startsWith("Autenticazione")) _state.update { it.copy(authFailed = true) }
            return
        }
        _state.update { it.copy(cpe = cpe, authFailed = false) }
    }

    /** The current ones typed, the factory ones, the new ones (also of the configuration kept on the phone). */
    private fun loginsFor(f: SpecForm): List<CredentialsDto> = listOfNotNull(f.current, CpeProvisioner.FACTORY, f.newLogin, _state.value.pkg?.credentials).distinct()

    private fun labelOf(cr: CredentialsDto, f: SpecForm): String = when (cr) {
        CpeProvisioner.FACTORY -> "credenziali di fabbrica"
        f.current -> "credenziali attuali scritte qui"
        else -> "credenziali nuove (già nella CPE)"
    }

    /** SSH on the CPE with the first of [logins] it accepts (the process bound to the Wi-Fi while connecting). */
    private suspend fun open(host: String, port: Int, logins: List<CredentialsDto>): Pair<SshConnection, CredentialsDto> = network.onWifi {
        var refused: IOException? = null
        for (cr in logins) {
            try {
                return@onWifi SshConnection.connect(host, port, cr.username, cr.password) to cr
            } catch (e: IOException) {
                if (!e.message.orEmpty().startsWith("Autenticazione")) throw e
                refused = e
            }
        }
        throw IOException(REFUSED, refused)
    }

    // ---- 2 · the firmware -------------------------------------------------------------------------

    fun keepFirmware(keep: Boolean) = _state.update { it.copy(keepFirmware = keep) }

    /** The image for the CPE's platform, downloaded with Internet (then the update works without). */
    suspend fun downloadFirmware(store: FirmwareStore, onProgress: (Float) -> Unit) {
        val build = _state.value.cpe?.build ?: return
        work("download") {
            val list = runCatching { api.firmwareList() }.getOrNull()?.also { store.saveList(it) } ?: store.savedList()
                ?: throw IOException("Elenco dei firmware non disponibile: serve Internet")
            val img = list.items.firstOrNull { it.platform == build.platform } ?: throw IOException("Nessun firmware ${list.target} per la piattaforma ${build.platform}")
            store.download(api, img, onProgress)
        }
    }

    /** Flashes the CPE with the image on the phone, waits for it to come back and reads it again. */
    suspend fun updateFirmware(store: FirmwareStore) {
        val cpe = _state.value.cpe ?: return
        val build = cpe.build ?: return
        val stages = mutableListOf<String>()
        val stage: (String) -> Unit = { s ->
            stages += s
            _state.update { it.copy(firmwareStages = stages.toList()) }
        }
        _state.update { it.copy(firmwareStages = emptyList(), firmwareNote = null) }
        val logins = (listOf(cpe.login) + loginsFor(_form.value)).distinct()
        val after = work("firmware") {
            withContext(Dispatchers.IO) {
                val list = store.savedList() ?: throw IOException("Elenco dei firmware non sul telefono: aprilo una volta con Internet")
                val img = list.items.firstOrNull { it.platform == build.platform } ?: throw IOException("Nessun firmware ${list.target} per la piattaforma ${build.platform}")
                if (!store.has(img)) throw IOException("Il firmware ${img.platform} ${img.version} non è sul telefono: scaricalo con Internet")
                val flasher = CpeFirmwareFlasher(stage)
                val connect: suspend () -> SshConnection = { open(cpe.ip, cpe.sshPort, logins).first }
                try {
                    connect().use { flasher.start(it, store.fileOf(img), img) }
                } catch (e: CpeFirmwareFlasher.AlreadyUpToDate) {
                    return@withContext e.build
                }
                val back = flasher.waitBack(connect)
                    ?: throw IOException("La CPE non è tornata raggiungibile entro 9 minuti: non toglierle alimentazione, ricollegati alla sua Wi-Fi e cercala di nuovo")
                if (back.version != img.version) throw IOException("La CPE è ripartita con ${back.version} invece di ${img.version}: aggiornamento non applicato")
                back
            }
        } ?: return
        _state.update { it.copy(firmwareNote = "Firmware aggiornato da ${build.version} a ${after.version}") }
        // read again: the new firmware (and the credentials it answers with now)
        _state.value.device?.let { read(it) }
    }

    // ---- 3 · the configuration ----------------------------------------------------------------------

    /**
     * Prepares the configuration on the server (Internet: mobile data is enough on the CPE's Wi-Fi).
     * Without a CPE read (owner, 17/10/2026: first the configuration, then the CPE) the model is
     * the template's, and MAC, serial and address are the ones read at the write.
     */
    suspend fun prepare() {
        val s = _state.value
        val f = _form.value
        val cpe = s.cpe
        val tpl = s.templates?.firstOrNull { it.id == f.templateId } ?: return
        val model: String = if (cpe == null) tpl.model else (cpe.model ?: return)
        val asked = s.asked?.asked ?: return
        val location = f.location
        val req = SpecJobRequest(
            templateId = tpl.id,
            connectorId = f.connectorId,
            company = if (f.connectorId == null) f.company.trim().take(80).ifBlank { null } else null,
            model = model,
            mac = cpe?.mac,
            serial = cpe?.serial?.take(128)?.ifBlank { null },
            firmware = cpe?.firmware?.take(80),
            host = cpe?.ip,
            sshPort = cpe?.sshPort,
            cpe = SpecCpeLoginDto(f.cpeUser.trim(), f.cpePassword),
            values = asked.associate { a -> a.name to f.values[a.name].orEmpty() },
            customer = f.customer.trim().take(120).ifBlank { null },
            notes = f.notes.trim().take(1000).ifBlank { null },
            location = location?.let { l ->
                SpecLocationDto(l.latitude, l.longitude, l.accuracy?.coerceIn(0.0, 100_000.0), if (l.source == "address" || l.source == "manual") l.source else "gps")
            },
        )
        val pkg = work("prepare") { api.specCreateJob(req) } ?: return
        _state.update { it.copy(pkg = pkg, stages = emptyList(), done = null, writeError = null, verify = null, job = null) }
        save(pkg)
    }

    /** Back to the configuration (the prepared one stays in the history as never written). */
    fun cancelPackage() {
        _state.update { it.copy(pkg = null, stages = emptyList(), done = null, writeError = null) }
        save(null)
    }

    // ---- 4 · the write ------------------------------------------------------------------------------

    /**
     * Writes the configuration into the CPE over SSH, then queues the outcome for the server. One
     * prepared before connecting to the CPE goes on the CPE read now, whose MAC and serial go with
     * the outcome.
     */
    suspend fun write() {
        val s = _state.value
        val prepared = s.pkg ?: return
        val cpe = s.cpe
        SpecialistRules.writeProblems(prepared, cpe, firmwareReady = true).firstOrNull()?.let { p ->
            _state.update { it.copy(error = p, errorAt = "write") }
            return
        }
        val pkg = if (prepared.needsCpe && cpe != null) SpecialistRules.bind(prepared, cpe) else prepared
        val site = if (pkg.scannedOnSite) CpeIdDto(pkg.summary.mac, pkg.summary.serial) else null
        val f = _form.value
        val prior = listOfNotNull(s.firmwareNote)
        _state.update { it.copy(busy = "write", error = null, errorAt = null, writeError = null, stages = prior) }
        val stages = prior.toMutableList()
        // written on the firmware he chose to keep (the exact string read); else the required one
        val allow = if (s.keepFirmware) cpe?.firmware else null
        val extra = listOfNotNull(cpe?.login, f.current).distinct()
        val result = withContext(Dispatchers.IO) {
            try {
                val detected = network.onWifi {
                    CpeProvisioner { st ->
                        stages += st
                        _state.update { it.copy(stages = stages.toList()) }
                    }.provision(pkg, allow, extra, REFUSED)
                }
                SpecResultDto("success", stages.toList(), detected = detected, completedAt = Instant.now().toString(), cpe = site)
            } catch (e: ProvisioningFailure) {
                SpecResultDto("failed", stages.toList(), error = e.message.orEmpty(), detected = e.detected ?: DetectedDto(), completedAt = Instant.now().toString(), cpe = site)
            } catch (e: Exception) {
                SpecResultDto("failed", stages.toList(), error = e.message ?: e.toString(), completedAt = Instant.now().toString(), cpe = site)
            }
        }
        results.enqueue(SpecPendingResult(pkg.jobId, result, "${pkg.summary.deviceName.ifBlank { pkg.summary.model }} · ${pkg.summary.mac}"))
        results.syncInBackground()
        val ok = result.result == "success"
        _state.update {
            it.copy(
                busy = null,
                // a failed write may be tried again with the same configuration (on the CPE read then)
                pkg = if (ok) null else prepared,
                done = SpecDone(pkg.jobId, pkg.summary, ok, pkg.credentials, pkg.afterApply.lanIp, f.connectorId),
                writeError = if (ok) null else result.error,
            )
        }
        if (ok) save(null)
    }

    // ---- 5 · after the write ------------------------------------------------------------------------

    /** The CPE after its reboot, with the new credentials: link, signal and AP (the Wi-Fi of the CPE or of the router). */
    suspend fun verify() {
        val d = _state.value.done ?: return
        val status = work("verify") {
            withContext(Dispatchers.IO) {
                val wifi = network.wifiNetwork() ?: throw IllegalStateException("Collegati alla Wi-Fi della CPE o del router del cliente")
                val found = runCatching { UbntDiscovery.discover(network, 2_500) }.getOrDefault(emptyList())
                    .filter { x -> !x.unifi && x.ip?.let { Ip.isPrivate(it) } == true }
                val dev = found.firstOrNull { x -> DiscoveryCheck.sameDevice(x, d.summary.mac) } ?: found.singleOrNull()
                val hosts = listOfNotNull(dev?.ip, d.lanIp, network.wifiLink()?.gateway).distinct().filter { Ip.isPrivate(it) }
                var last: Exception? = null
                for (host in hosts) {
                    for (url in AirosClient.candidates(host)) {
                        val port = url.substringAfterLast(':').toIntOrNull() ?: if (url.startsWith("https")) 443 else 80
                        val reachable = runCatching { wifi.socketFactory.createSocket().use { sock -> sock.connect(InetSocketAddress(host, port), 700) } }.isSuccess
                        if (!reachable) continue
                        try {
                            val client = AirosClient(url, wifi.socketFactory)
                            client.login(d.login.username, d.login.password)
                            return@withContext client.status()
                        } catch (e: AirosAuthException) {
                            last = IOException("La CPE su $host rifiuta le credenziali nuove: forse la configurazione non è stata applicata", e)
                            break
                        } catch (e: Exception) {
                            last = e
                        }
                    }
                }
                throw last ?: IOException("CPE non trovata: dopo il riavvio (circa un minuto) collegati alla sua Wi-Fi o a quella del router del cliente e riprova")
            }
        } ?: return
        _state.update { it.copy(verify = status) }
    }

    /** The optional acceptance test: his verdict, with the readings of the check when there are. */
    suspend fun saveAcceptance(verdict: String, heightM: Double?, notes: String) {
        val d = _state.value.done ?: return
        val s = _state.value.verify
        val radio = s?.let { x ->
            SpecRadioDto(
                signal = x.signal,
                noise = x.noise,
                capacityDown = x.dlCapacityMbps,
                capacityUp = x.ulCapacityMbps,
                distanceM = x.distanceM,
                frequency = x.frequencyMhz,
                channelWidth = x.channelWidthMhz,
                ssid = x.essid?.take(64),
                apName = x.apName?.take(120),
                apMac = x.apMac?.take(40),
            )
        }
        val body = SpecAcceptanceDto(verdict = verdict, radio = radio, heightM = heightM, notes = notes.trim().take(1000).ifBlank { null })
        val job = work("acceptance") {
            // the outcome of the write first: the server takes the test only of a written CPE
            results.sync()
            api.specPutAcceptance(d.jobId, body)
        } ?: return
        _state.update { it.copy(job = job) }
    }

    /** «Configura un'altra CPE»: company, template, CPE credentials and the values not of this customer stay. */
    fun nextCpe() {
        val asked = _state.value.asked?.asked.orEmpty()
        _state.update { SpecState(connectors = it.connectors, templates = it.templates, asked = it.asked, askedFor = it.askedFor) }
        _form.update { f ->
            f.copy(values = SpecialistRules.keepForNext(f.values, asked), currentUser = "", currentPassword = "", customer = "", notes = "", location = null, locationLabel = "")
        }
        save(null)
    }

    /** Another account on the phone: nothing of this one stays. */
    fun reset() {
        _state.value = SpecState()
        _form.value = SpecForm()
        _editing.value = null
        save(null)
    }

    // ---- 6 · a template from the CPE ----------------------------------------------------------------

    /**
     * The running configuration of the CPE (/tmp/system.cfg), for a new template: the CPE read in
     * the flow, else the only one on this Wi-Fi. Its secrets become placeholders on the server.
     */
    suspend fun runningConfig(user: String, password: String): String = withContext(Dispatchers.IO) {
        val known = _state.value.cpe
        val typed = if (user.isNotBlank() && password.isNotEmpty()) listOf(CredentialsDto(user.trim(), password)) else emptyList()
        val host: String
        val port: Int
        val logins: List<CredentialsDto>
        if (known != null) {
            host = known.ip
            port = known.sshPort
            logins = typed + known.login
        } else {
            val found = UbntDiscovery.discover(network, 2_500).filter { d -> !d.unifi && d.ip?.let { Ip.isPrivate(it) } == true }
            val d = found.singleOrNull()
                ?: throw IOException(if (found.isEmpty()) "Nessuna CPE Ubiquiti risponde su questa Wi-Fi" else "Rispondono ${found.size} apparati: leggi prima la CPE in «Nuova CPE»")
            host = d.ip ?: throw IOException("La CPE non ha un indirizzo IPv4")
            port = d.sshPort?.takeIf { it in 1..65535 } ?: 22
            logins = typed
        }
        val (ssh, _) = open(host, port, (logins + loginsFor(_form.value)).distinct())
        ssh.use { s ->
            val r = s.exec("cat /tmp/system.cfg", 15_000)
            if (r.exitCode != 0 || r.stdout.length < 64) throw IOException("Configurazione della CPE non leggibile (/tmp/system.cfg)")
            r.stdout
        }
    }

    // ---- the configuration kept on the phone ----------------------------------------------------------

    private fun save(pkg: ProvisionPackage?) {
        val s = store ?: return
        runCatching { if (pkg == null) s.remove(SAVED) else s.put(SAVED, AppJson.encodeToString(ProvisionPackage.serializer(), pkg)) }
    }

    /** A configuration prepared and not written (the app was closed on the roof): back, until it expires. */
    private fun restore() {
        val s = store ?: return
        val pkg = runCatching { AppJson.decodeFromString(ProvisionPackage.serializer(), s.get(SAVED) ?: return) }.getOrNull()
        if (pkg == null || runCatching { Instant.parse(pkg.expiresAt).isBefore(Instant.now()) }.getOrDefault(true)) {
            runCatching { s.remove(SAVED) }
            return
        }
        _state.value = SpecState(pkg = pkg)
    }

    companion object {
        private const val SAVED = "specialist-package"

        /** Every credential refused (it starts with «Autenticazione»: the flow then asks for the current ones). */
        const val REFUSED = "Autenticazione SSH rifiutata con tutte le credenziali provate (di fabbrica, quelle attuali e quelle nuove): scrivi le credenziali attuali della CPE e riprova"
    }
}
