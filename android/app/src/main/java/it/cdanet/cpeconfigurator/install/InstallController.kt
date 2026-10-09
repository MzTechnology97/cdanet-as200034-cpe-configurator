package it.cdanet.cpeconfigurator.install

import it.cdanet.cpeconfigurator.data.PointingCache
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.CpeLocation
import it.cdanet.cpeconfigurator.data.JobDto
import it.cdanet.cpeconfigurator.data.PointingDto
import it.cdanet.cpeconfigurator.field.CompassTarget
import it.cdanet.cpeconfigurator.field.FieldController
import it.cdanet.cpeconfigurator.field.SurveyAp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class InstallMode(val title: String) {
    New("Nuova installazione"),
    Repoint("Ripuntamento o cambio AP"),
}

enum class InstallStep(val title: String) {
    Config("Configurazione"),
    Write("Scrittura nella CPE"),
    Verify("Verifica della CPE"),
    Link("Aggancio all'AP"),
    Aim("Puntamento"),
    Final("Verifica finale e collaudo"),
    ;

    companion object {
        fun of(mode: InstallMode): List<InstallStep> = if (mode == InstallMode.New) entries else listOf(Verify, Link, Aim, Final)
    }
}

data class RelinkProgress(val target: ApChoice, val stages: List<String> = emptyList(), val running: Boolean = true, val error: String? = null, val done: Boolean = false)

data class InstallState(
    val mode: InstallMode? = null,
    val step: InstallStep = InstallStep.Config,
    /** Phone position (GPS) and the nearby APs with distance, azimuth, tilt and expected signal. */
    val position: CpeLocation? = null,
    val pointing: PointingDto? = null,
    val pointingError: String? = null,
    /** Set when [pointing] comes from the phone's cache (no network): what and from where. */
    val pointingSaved: String? = null,
    /** CPE site survey of the "Aggancio" step. */
    val survey: List<SurveyAp>? = null,
    val surveyError: String? = null,
    val relink: RelinkProgress? = null,
    /** Installation job the acceptance test is saved into (provisioned now, or found by MAC). */
    val job: JobDto? = null,
    /** Repointing: the CPE MACs were looked up (job may still be null: unknown to the app). */
    val jobLooked: Boolean = false,
    /** SSID the CPE must be on (provisioned or chosen in the "Aggancio" step). */
    val expectedSsid: String? = null,
)

/**
 * Guided installation: the steps and what they share (position, chosen AP, job). Kept outside
 * the screen so the wizard survives opening the AR sight, the compass or the acceptance test.
 * Secrets (WPA2 key of a new AP) never live here: they go straight from the server to the CPE.
 */
class InstallController(
    private val api: ApiClient,
    private val field: FieldController,
    private val cache: it.cdanet.cpeconfigurator.data.PointingCache,
    private val session: it.cdanet.cpeconfigurator.data.Session,
) {
    private val _state = MutableStateFlow(InstallState())
    val state: StateFlow<InstallState> = _state.asStateFlow()

    fun start(mode: InstallMode) {
        _state.value = InstallState(mode = mode, step = InstallStep.of(mode).first())
    }

    fun go(step: InstallStep) = _state.update { it.copy(step = step) }

    fun next() = _state.update { s ->
        val steps = InstallStep.of(s.mode ?: return@update s)
        s.copy(step = steps.getOrElse(steps.indexOf(s.step) + 1) { s.step })
    }

    fun close() {
        _state.value = InstallState()
    }

    fun provisioned(job: JobDto) = _state.update { it.copy(job = job, jobLooked = true, expectedSsid = job.ssid) }

    fun expectSsid(ssid: String?) = _state.update { it.copy(expectedSsid = ssid) }

    /** Nearby APs from the phone position (module "compass": UISP, DEM tilt, expected signal). */
    suspend fun locate(location: CpeLocation) {
        _state.update { it.copy(position = location, pointingError = null, pointingSaved = null) }
        val user = session.state.value?.user?.id
        runCatching { api.pointing(location.latitude, location.longitude, null) }
            .onSuccess { p ->
                user?.let { cache.put(it, p) }
                _state.update { it.copy(pointing = p) }
            }
            .onFailure { e ->
                // no network on the roof: the APs saved for this place (or downloaded with the work order)
                val saved = cache.near(user, location.latitude, location.longitude)
                if (saved != null) {
                    _state.update { it.copy(pointing = saved.first.data, pointingSaved = PointingCache.describe(saved.first, saved.second)) }
                } else {
                    _state.update { it.copy(pointingError = e.message) }
                }
            }
    }

    /** Repointing: the job of the CPE, so the new acceptance test and photos go with it. */
    suspend fun lookupJob(macs: List<String>) {
        if (_state.value.jobLooked || macs.isEmpty()) return
        val job = runCatching { api.cpeJob(macs) }.getOrNull()
        _state.update { it.copy(job = job ?: it.job, jobLooked = true) }
    }

    suspend fun survey() {
        _state.update { it.copy(surveyError = null) }
        runCatching { field.siteSurvey() }
            .onSuccess { list -> _state.update { it.copy(survey = list) } }
            .onFailure { e -> _state.update { it.copy(surveyError = e.message) } }
    }

    /** Moves the CPE to [target]: WPA2 key from the server, new SSID written over SSH, reboot. */
    suspend fun relink(target: ApChoice, cpeMac: String?, fromSsid: String?, lockToAp: Boolean) {
        _state.update { it.copy(relink = RelinkProgress(target)) }
        val stages = mutableListOf<String>()
        try {
            val key = api.relink(target.ssid, cpeMac, fromSsid)
            field.relink(key.ssid, key.psk, if (lockToAp) target.bssid else null, key.sshPort) { s ->
                stages += s
                _state.update { it.copy(relink = it.relink?.copy(stages = stages.toList())) }
            }
            _state.update { it.copy(relink = it.relink?.copy(running = false, done = true), expectedSsid = target.ssid, survey = null) }
        } catch (e: Exception) {
            _state.update { it.copy(relink = it.relink?.copy(running = false, error = e.message ?: e.toString())) }
        }
    }

    fun clearRelink() = _state.update { it.copy(relink = null) }

    /** Target for the AR sight and the compass: the AP of [ssid] seen from the phone position. */
    fun aimTarget(ssid: String?): CompassTarget? {
        val p = _state.value.pointing ?: return null
        val ap = p.aps.firstOrNull { ssid != null && it.ssid.equals(ssid, ignoreCase = true) } ?: return null
        return CompassTarget(
            name = ap.name.ifBlank { ap.ssid ?: "AP" },
            bearing = ap.bearing,
            distanceM = ap.distanceM,
            fromLatitude = p.from.lat,
            fromLongitude = p.from.lon,
            tiltDeg = ap.tiltDeg,
            altitude = ap.altitude,
            fromAltitude = p.from.altitude,
        )
    }
}
