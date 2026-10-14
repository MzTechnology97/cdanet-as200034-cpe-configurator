package it.cdanet.cpeconfigurator.provisioning

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
) {
    val ssid: String get() = "CDA-NET-N$node-D${district.toString().padStart(2, '0')}" + (relay?.let { "-R$it" } ?: "")
    val customerName: String get() = Validation.customerName(pppoeUser)
    fun toRequest() = ProvisionRequest(model, Validation.normalizeMac(mac), serial.trim(), ssid, pppoeUser.trim(), pppoePassword.ifEmpty { null }, templateId, location, workOrderId)
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
    @Suppress("unused") private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(ProvisioningState())
    val state: StateFlow<ProvisioningState> = _state.asStateFlow()

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
            else api.replaceJob(old, ReplaceRequest(req.model, req.mac, req.serial, req.pppoePassword, req.templateId, req.location))
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

    suspend fun apply() {
        val pkg = _state.value.pkg ?: return
        _state.update { it.copy(phase = Phase.Applying, busy = true, error = null, stages = emptyList()) }
        val stages = mutableListOf<String>()
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
            }
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
        val list = store.savedList() ?: throw IOException("Elenco dei firmware non sul telefono: apri CPE collegata → Firmware con Internet")
        val open: suspend () -> SshConnection = {
            network.onWifi { SshConnection.connect(pkg.target.host, pkg.target.sshPort, pkg.credentials.username, pkg.credentials.password) }
        }
        val flasher = CpeFirmwareFlasher(onStage)
        onStage("Lettura della versione della CPE")
        val before = open().use { flasher.readVersion(it) } ?: throw IOException("Versione della CPE non leggibile")
        val img = list.items.firstOrNull { it.platform == before.platform }
            ?: throw IOException("Nessun firmware ${list.target} per la piattaforma ${before.platform}: chiedi all'amministratore di caricarlo")
        if (!store.has(img)) {
            throw IOException("Il firmware ${img.platform} ${img.version} non è sul telefono: torna su Internet, aprilo da CPE collegata → Firmware e scaricalo, poi riprova")
        }
        try {
            open().use { flasher.start(it, store.fileOf(img), img) }
        } catch (e: CpeFirmwareFlasher.AlreadyUpToDate) {
            return@withContext before.build to e.build.build
        }
        // a CPE that went back to its factory settings answers but refuses the package's credentials
        val after = try {
            flasher.waitBack(open, stopOn = { it.message.orEmpty().startsWith("Autenticazione") })
        } catch (e: IOException) {
            if (e.message.orEmpty().startsWith("Autenticazione")) throw FactoryReset(img.version) else throw e
        }
            ?: throw IOException("La CPE non è tornata raggiungibile entro 9 minuti: non toglierle alimentazione, ricollegati alla sua Wi-Fi e riprova la scrittura")
        if (after.version != img.version) throw IOException("La CPE è ripartita con ${after.version} invece di ${img.version}: aggiornamento non applicato")
        before.build to after.build
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
        /** CDA-NET-N{node}-D{district}, -R{n} for a relay ("rilancio") AP: node, district, relay. */
        val SSID_PARTS = Regex("""^CDA-NET-N(\d+)-D(\d+)(?:-R(\d+))?$""", RegexOption.IGNORE_CASE)
    }

    fun clearError() {
        _state.update { it.copy(error = null) }
    }
}
