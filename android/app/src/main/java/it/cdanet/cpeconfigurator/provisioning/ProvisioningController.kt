package it.cdanet.cpeconfigurator.provisioning

import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.CpeIdDto
import it.cdanet.cpeconfigurator.security.SecureStore
import it.cdanet.cpeconfigurator.firmware.AirosBuild
import java.io.IOException
import it.cdanet.cpeconfigurator.ssh.SshConnection
import it.cdanet.cpeconfigurator.firmware.FirmwareStore
import it.cdanet.cpeconfigurator.firmware.CpeFirmwareFlasher
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.DetectedDto
import it.cdanet.cpeconfigurator.data.PendingResult
import it.cdanet.cpeconfigurator.data.PlanDto
import it.cdanet.cpeconfigurator.data.ProvisionPackage
import it.cdanet.cpeconfigurator.data.ProvisionRequest
import it.cdanet.cpeconfigurator.data.ProvisionResult
import it.cdanet.cpeconfigurator.data.ReplaceRequest
import it.cdanet.cpeconfigurator.data.ResultQueue
import it.cdanet.cpeconfigurator.network.NetworkHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import java.time.Instant

enum class Phase { Form, Prepared, Applying, Done }

/** Installer input. Kept here (not in the composable) so it survives navigation; the password is memory-only. */
data class ProvisionForm(
    val model: String = MODELS.first(),
    val mac: String = "",
    val serial: String = "",
    val node: Int = 2,
    val district: Int = 1,
    /** Relay ("rilancio") AP of the district: SSID …-R{n}; null = the district's own AP. */
    val relay: Int? = null,
    val pppoeUser: String = "",
    val pppoePassword: String = "",
    val templateId: Int? = null,
    val location: it.cdanet.cpeconfigurator.data.CpeLocation? = null,
    val locationLabel: String = "",
    /** Job of the broken CPE being replaced: customer, SSID, position and template come from it. */
    val replaces: String? = null,
    val replacesLabel: String = "",
    /** Work order of the office this installation comes from (PPPoE password from the server). */
    val workOrderId: Long? = null,
    val workOrderLabel: String = "",
    /** "Modifica e riprova": the failed or never written installation this one redoes. */
    val supersedes: String? = null,
    val supersedesLabel: String = "",
) {
    val ssid: String get() = "CDA-NET-N$node-D${district.toString().padStart(2, '0')}" + (relay?.let { "-R$it" } ?: "")
    val customerName: String get() = Validation.customerName(pppoeUser)
    fun toRequest() = ProvisionRequest(model, Validation.normalizeMac(mac), serial.trim(), ssid, pppoeUser.trim(), pppoePassword.ifEmpty { null }, templateId, location, workOrderId, supersedes)
    fun errors(): List<String> = Validation.formErrors(this)

    companion object {
        val MODELS = listOf("NanoStation Loco 5AC", "NanoStation 5AC", "NanoBeam 5AC", "LiteBeam 5AC", "PowerBeam 5AC")
    }
}

data class ProvisioningState(
    val phase: Phase = Phase.Form,
    val busy: Boolean = false,
    val plan: PlanDto? = null,
    val pkg: ProvisionPackage? = null,
    val stages: List<String> = emptyList(),
    val probe: String? = null,
    val success: Boolean? = null,
    val error: String? = null,
    /** Job written successfully (kept after the package and its secrets are dropped). */
    val doneJobId: String? = null,
    val doneSummary: it.cdanet.cpeconfigurator.data.JobSummaryDto? = null,
    /** The write stopped on the firmware: the version the CPE must have (it can be flashed right here). */
    val firmwareTarget: String? = null,
    /** The firmware read on the CPE when the write stopped on it. */
    val detectedFirmware: String? = null,
    /** Updates of the firmware that failed for this package: after [FIRMWARE_TRIES] it may be kept. */
    val firmwareFailures: Int = 0,
    /** The firmware the installer chose to keep: the write goes on with it. */
    val allowedFirmware: String? = null,
)

/** Failed firmware updates after which the configuration may be written on the firmware the CPE has. */
const val FIRMWARE_TRIES = 2

/**
 * Field workflow: prepare online -> join CPE Wi-Fi -> apply offline -> queue result.
 * The package (with secrets) exists only in this object's memory.
 */
class ProvisioningController(
    private val api: ApiClient,
    private val network: NetworkHelper,
    private val queue: ResultQueue,
    private val scope: CoroutineScope,
    private val store: SecureStore? = null,
) {
    private val _state = MutableStateFlow(ProvisioningState())
    val state: StateFlow<ProvisioningState> = _state.asStateFlow()

    init {
        restore()
        // the prepared configuration stays on the phone, encrypted, until it is written or expires:
        // on the roof without Internet the installation can be reopened even after Android closed the app
        scope.launch { _state.map { it.pkg }.distinctUntilChanged().drop(1).collect { save(it) } }
    }

    private fun save(pkg: ProvisionPackage?) {
        val s = store ?: return
        runCatching { if (pkg == null) s.remove(SAVED) else s.put(SAVED, AppJson.encodeToString(ProvisionPackage.serializer(), pkg)) }
    }

    private fun restore() {
        val s = store ?: return
        val pkg = runCatching { AppJson.decodeFromString(ProvisionPackage.serializer(), s.get(SAVED) ?: return) }.getOrNull()
        if (pkg == null || runCatching { Instant.parse(pkg.expiresAt).isBefore(Instant.now()) }.getOrDefault(true)) {
            s.remove(SAVED)
            return
        }
        _state.value = ProvisioningState(phase = Phase.Prepared, pkg = pkg)
    }

    private val _form = MutableStateFlow(ProvisionForm())
    val form: StateFlow<ProvisionForm> = _form.asStateFlow()

    fun updateForm(f: (ProvisionForm) -> ProvisionForm) {
        _form.update(f)
        _state.update { it.copy(plan = null) }
    }

    private suspend fun <T> busy(block: suspend () -> T): T? {
        _state.update { it.copy(busy = true, error = null) }
        return try {
            block()
        } catch (e: Exception) {
            _state.update { it.copy(error = e.message ?: e.toString()) }
            null
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    suspend fun plan(req: ProvisionRequest) {
        busy { api.plan(req) }?.let { p -> _state.update { it.copy(plan = p) } }
    }

    suspend fun prepare(req: ProvisionRequest) {
        val old = _form.value.replaces
        busy {
            if (old == null) api.createJob(req)
            else api.replaceJob(old, ReplaceRequest(req.model, req.mac.orEmpty(), req.serial.orEmpty(), req.pppoePassword, req.templateId, req.location))
        }?.let { pkg ->
            _form.update { it.copy(pppoePassword = "") }
            _state.update { it.copy(phase = Phase.Prepared, pkg = pkg, stages = emptyList(), success = null, probe = null) }
        }
    }

    suspend fun probe() {
        val pkg = _state.value.pkg ?: return
        busy {
            withContext(Dispatchers.IO) {
                network.onWifi {
                    val open = CpeProvisioner {}.probe(pkg.target.host)
                    if (open.isEmpty()) "Nessuna porta raggiungibile su ${pkg.target.host}: verifica di essere collegato alla Wi-Fi della CPE"
                    else "CPE raggiungibile su ${pkg.target.host} · porte aperte ${open.joinToString()}" +
                        if (22 !in open) " · SSH non ancora attivo: completa il primo avvio" else ""
                }
            }
        }?.let { msg -> _state.update { it.copy(probe = msg) } }
    }

    /**
     * MAC and serial of the CPE, scanned on site, for a configuration prepared before the visit
     * (they can be corrected until the write succeeds). Null when accepted, else what is wrong.
     */
    fun setSiteCpe(mac: String, serial: String): String? {
        val pkg = _state.value.pkg ?: return "Configurazione non più disponibile"
        if (!pkg.needsCpe && !pkg.scannedOnSite) return "La CPE di questa configurazione è già indicata"
        Validation.siteCpeErrors(mac, serial).firstOrNull()?.let { return it }
        val m = Validation.normalizeMac(mac)
        val s = serial.trim()
        _state.update {
            it.copy(pkg = pkg.copy(checks = pkg.checks.copy(mac = m), summary = pkg.summary.copy(mac = m, serial = s), scannedOnSite = true), error = null)
        }
        return null
    }

    suspend fun apply(prior: List<String> = emptyList()) {
        val pkg = _state.value.pkg ?: return
        if (pkg.needsCpe) {
            _state.update { it.copy(phase = Phase.Prepared, error = "Scansiona prima MAC e seriale della CPE") }
            return
        }
        _state.update { it.copy(phase = Phase.Applying, busy = true, error = null, stages = prior) }
        val stages = prior.toMutableList()
        val result = withContext(Dispatchers.IO) {
            try {
                val detected = network.onWifi {
                    CpeProvisioner { s ->
                        stages += s
                        _state.update { it.copy(stages = stages.toList()) }
                    }.provision(pkg, _state.value.allowedFirmware)
                }
                ProvisionResult("success", stages.toList(), detected = detected, completedAt = Instant.now().toString())
            } catch (e: ProvisioningFailure) {
                ProvisionResult("failed", stages.toList(), error = e.message ?: "", detected = e.detected ?: DetectedDto(), completedAt = Instant.now().toString())
            } catch (e: Exception) {
                ProvisionResult("failed", stages.toList(), error = e.message ?: e.toString(), completedAt = Instant.now().toString())
            }.let { r -> if (pkg.scannedOnSite) r.copy(cpe = CpeIdDto(pkg.summary.mac, pkg.summary.serial)) else r }
        }
        queue.enqueue(PendingResult(pkg.jobId, result, "${pkg.summary.deviceName} · ${pkg.summary.mac}"))
        queue.syncInBackground()
        val ok = result.result == "success"
        val firmware = result.detected.firmware
        _state.update {
            it.copy(
                phase = Phase.Done,
                busy = false,
                success = ok,
                firmwareTarget = pkg.checks.firmware.takeIf { !ok && firmware != null && !DeviceCheck.firmwareMatches(firmware, it) },
                detectedFirmware = firmware,
                error = if (ok) null else result.error,
                // Secrets are dropped after a successful write; a failed attempt may be retried.
                pkg = if (ok) null else pkg,
                doneJobId = if (ok) pkg.jobId else null,
                doneSummary = if (ok) pkg.summary else null,
            )
        }
    }

    /** A message for the write step (shown as its probe line), e.g. after a firmware update. */
    fun reportNote(text: String) {
        _state.update { it.copy(probe = text) }
    }

    /** An update of the firmware did not work (counted towards [FIRMWARE_TRIES]). */
    fun firmwareFailed() {
        _state.update { it.copy(firmwareFailures = it.firmwareFailures + 1) }
    }

    /** After [FIRMWARE_TRIES] failed updates: writes the configuration on the firmware the CPE has. */
    suspend fun applyKeepingFirmware() {
        val s = _state.value
        val keep = s.detectedFirmware ?: return
        if (s.firmwareFailures < FIRMWARE_TRIES || s.pkg?.checks?.firmwareBypass != true) return
        _state.update { it.copy(allowedFirmware = keep) }
        retry()
        apply()
    }

    fun retry() {
        _state.update { if (it.pkg != null) it.copy(phase = Phase.Prepared, stages = emptyList(), success = null, error = null, firmwareTarget = null) else it }
    }

    /**
     * Flashes the CPE of the prepared package with the required firmware (already on the phone),
     * with the package's own address and credentials, and waits for it to come back. Returns the
     * builds before and after; throws with an Italian message when it cannot or did not work.
     */
    /** The flash worked but the CPE is back to its factory settings: the airOS first access is needed again. */
    class FactoryReset(version: String) : Exception(
        "Firmware $version installato, ma la CPE è tornata alle impostazioni di fabbrica: rifai il primo avvio airOS (card «2 · Primo avvio airOS»), poi applica la configurazione.",
    )

    suspend fun updateFirmware(store: FirmwareStore, onStage: (String) -> Unit): Pair<String, String> = withContext(Dispatchers.IO) {
        val pkg = _state.value.pkg ?: throw IllegalStateException("Configurazione non più disponibile: preparala di nuovo")
        val open = opener(pkg, onStage)
        onStage("Lettura della versione della CPE")
        val before = open().use { CpeFirmwareFlasher(onStage).readVersion(it) } ?: throw IOException("Versione della CPE non leggibile")
        flash(pkg, store, before, open, onStage)
    }

    /**
     * The one-tap installation: brings the CPE to the required firmware when it has another one
     * (image already on the phone), then writes the configuration ([apply]). A firmware that cannot
     * be flashed here does not stop it: the write's own check then explains what to do.
     */
    suspend fun install(store: FirmwareStore) {
        val pkg = _state.value.pkg ?: return
        if (pkg.needsCpe) {
            _state.update { it.copy(error = "Scansiona prima MAC e seriale della CPE") }
            return
        }
        _state.update { it.copy(phase = Phase.Applying, busy = true, error = null, stages = emptyList(), firmwareTarget = null) }
        val stages = mutableListOf<String>()
        val stage: (String) -> Unit = { s ->
            stages += s
            _state.update { it.copy(stages = stages.toList()) }
        }
        var flashing = false
        withContext(Dispatchers.IO) {
            runCatching {
                val open = opener(pkg, stage)
                stage("Lettura del firmware della CPE")
                val before = open().use { CpeFirmwareFlasher(stage).readVersion(it) }
                when {
                    before == null -> Unit
                    before.version == pkg.checks.firmware -> stage("Firmware ${before.version}: è quello richiesto")
                    // the installer chose to keep it after failed updates: no new attempt
                    _state.value.allowedFirmware != null -> stage("Firmware ${before.version} tenuto: aggiornamento non riuscito in precedenza")
                    else -> {
                        stage("Firmware ${before.version}: va portato alla ${pkg.checks.firmware}")
                        flashing = true
                        flash(pkg, store, before, open, stage)
                        flashing = false
                        stage("Firmware ${pkg.checks.firmware} installato")
                    }
                }
            }.onFailure { e ->
                stage("Firmware non aggiornato: ${e.message ?: e}")
                // a failed update counts towards "Configura comunque" (FIRMWARE_TRIES)
                if (flashing) firmwareFailed()
            }
        }
        apply(stages.toList())
    }

    private fun opener(pkg: ProvisionPackage, onStage: (String) -> Unit): suspend () -> SshConnection = {
        network.onWifi { CpeProvisioner.connect(pkg, onStage) }
    }

    /** Flashes the image of [before]'s platform and waits for the CPE to come back with it. */
    private suspend fun flash(pkg: ProvisionPackage, store: FirmwareStore, before: AirosBuild, open: suspend () -> SshConnection, onStage: (String) -> Unit): Pair<String, String> {
        val list = store.savedList() ?: throw IOException("Elenco dei firmware non sul telefono: apri CPE collegata → Firmware con Internet")
        val img = list.items.firstOrNull { it.platform == before.platform }
            ?: throw IOException("Nessun firmware ${list.target} per la piattaforma ${before.platform}: chiedi all'amministratore di caricarlo")
        if (!store.has(img)) {
            throw IOException("Il firmware ${img.platform} ${img.version} non è sul telefono: torna su Internet, aprilo da CPE collegata → Firmware e scaricalo, poi riprova")
        }
        val flasher = CpeFirmwareFlasher(onStage)
        try {
            open().use { flasher.start(it, store.fileOf(img), img) }
        } catch (e: CpeFirmwareFlasher.AlreadyUpToDate) {
            return before.build to e.build.build
        }
        // the factory credentials are tried too: a CPE reset by the flash still answers
        val after = try {
            flasher.waitBack(open, stopOn = { it.message.orEmpty().startsWith("Autenticazione") })
        } catch (e: IOException) {
            if (e.message.orEmpty().startsWith("Autenticazione")) throw FactoryReset(img.version) else throw e
        }
            ?: throw IOException("La CPE non è tornata raggiungibile entro 9 minuti: non toglierle alimentazione, ricollegati alla sua Wi-Fi e riprova la scrittura")
        if (after.version != img.version) throw IOException("La CPE è ripartita con ${after.version} invece di ${img.version}: aggiornamento non applicato")
        // activity log on the server, best effort: on the CPE's Wi-Fi there is often no Internet
        runCatching { api.firmwareReport(pkg.summary.mac, before.build, img.version, true, null) }
        return before.build to after.build
    }

    /**
     * "Modifica e riprova" of a failed or never written installation: a new one with all its data
     * (MAC and serial can be corrected); the PPPoE password is typed again unless it comes from a
     * work order. The old one is closed by the server when the new one is prepared.
     */
    fun startRedo(j: it.cdanet.cpeconfigurator.data.JobDto) {
        val m = SSID_PARTS.find(j.ssid)
        _state.value = ProvisioningState()
        _form.value = ProvisionForm(
            model = j.model,
            mac = j.mac,
            serial = j.serial,
            node = m?.groupValues?.get(1)?.toIntOrNull() ?: 2,
            district = m?.groupValues?.get(2)?.toIntOrNull() ?: 1,
            relay = m?.groupValues?.get(3)?.toIntOrNull(),
            pppoeUser = j.pppoeUser,
            supersedes = j.id,
            supersedesLabel = "${j.deviceName.ifBlank { j.pppoeUser }} · ${j.mac}",
        )
    }

    /** Starts the replacement of the CPE of a completed job (History → Sostituisci CPE). */
    fun startReplacement(j: it.cdanet.cpeconfigurator.data.JobDto) {
        val m = SSID_PARTS.find(j.ssid)
        _state.value = ProvisioningState()
        _form.value = ProvisionForm(
            model = j.model,
            node = m?.groupValues?.get(1)?.toIntOrNull() ?: 2,
            district = m?.groupValues?.get(2)?.toIntOrNull() ?: 1,
            relay = m?.groupValues?.get(3)?.toIntOrNull(),
            pppoeUser = j.pppoeUser,
            replaces = j.id,
            replacesLabel = "${j.deviceName.ifBlank { j.pppoeUser }} · ${j.mac}",
        )
    }

    /**
     * Starts a new installation from a work order of the office: customer, PPPoE user, position and
     * model are filled in; the password stays on the server.
     */
    fun startWorkOrder(o: it.cdanet.cpeconfigurator.data.WorkOrderDto) {
        _state.value = ProvisioningState()
        _form.value = ProvisionForm(
            model = o.model.takeIf { it in ProvisionForm.MODELS } ?: ProvisionForm.MODELS.first(),
            pppoeUser = o.pppoeUser,
            location = if (o.lat != null && o.lon != null) it.cdanet.cpeconfigurator.data.CpeLocation(o.lat, o.lon, null, "address") else null,
            locationLabel = o.address,
            workOrderId = o.id,
            workOrderLabel = listOf(o.customer, o.address).filter { it.isNotBlank() }.joinToString(" · "),
        )
    }

    fun reset() {
        _state.value = ProvisioningState()
        _form.update { ProvisionForm(model = it.model, node = it.node, district = it.district, relay = it.relay) }
    }

    companion object {
        private const val SAVED = "provisioning-package"

        /** CDA-NET-N{node}-D{district}, -R{n} for a relay ("rilancio") AP: node, district, relay. */
        val SSID_PARTS = Regex("""^CDA-NET-N(\d+)-D(\d+)(?:-R(\d+))?$""", RegexOption.IGNORE_CASE)
    }

    fun clearError() {
        _state.update { it.copy(error = null) }
    }
}
