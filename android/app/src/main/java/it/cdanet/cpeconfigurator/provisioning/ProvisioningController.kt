package it.cdanet.cpeconfigurator.provisioning

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
    val pppoeUser: String = "",
    val pppoePassword: String = "",
    val templateId: Int? = null,
    val location: it.cdanet.cpeconfigurator.data.CpeLocation? = null,
    val locationLabel: String = "",
    /** Job of the broken CPE being replaced: customer, SSID, position and template come from it. */
    val replaces: String? = null,
    val replacesLabel: String = "",
) {
    val ssid: String get() = "CDA-NET-N$node-D${district.toString().padStart(2, '0')}"
    val customerName: String get() = Validation.customerName(pppoeUser)
    fun toRequest() = ProvisionRequest(model, Validation.normalizeMac(mac), serial.trim(), ssid, pppoeUser.trim(), pppoePassword, templateId, location)
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
)

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
            else api.replaceJob(old, ReplaceRequest(req.model, req.mac, req.serial, req.pppoePassword.ifEmpty { null }, req.templateId, req.location))
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
                    }.provision(pkg)
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
        _state.update {
            it.copy(
                phase = Phase.Done,
                busy = false,
                success = ok,
                error = if (ok) null else result.error,
                // Secrets are dropped after a successful write; a failed attempt may be retried.
                pkg = if (ok) null else pkg,
                doneJobId = if (ok) pkg.jobId else null,
                doneSummary = if (ok) pkg.summary else null,
            )
        }
    }

    fun retry() {
        _state.update { if (it.pkg != null) it.copy(phase = Phase.Prepared, stages = emptyList(), success = null, error = null) else it }
    }

    /** Starts the replacement of the CPE of a completed job (History → Sostituisci CPE). */
    fun startReplacement(j: it.cdanet.cpeconfigurator.data.JobDto) {
        val m = Regex("""^CDA-NET-N(\d+)-D(\d+)$""").find(j.ssid)
        _state.value = ProvisioningState()
        _form.value = ProvisionForm(
            model = j.model,
            node = m?.groupValues?.get(1)?.toIntOrNull() ?: 2,
            district = m?.groupValues?.get(2)?.toIntOrNull() ?: 1,
            pppoeUser = j.pppoeUser,
            replaces = j.id,
            replacesLabel = "${j.deviceName.ifBlank { j.pppoeUser }} · ${j.mac}",
        )
    }

    fun reset() {
        _state.value = ProvisioningState()
        _form.update { ProvisionForm(model = it.model, node = it.node, district = it.district) }
    }

    fun clearError() {
        _state.update { it.copy(error = null) }
    }
}
