package it.cdanet.cpeconfigurator.install

import it.cdanet.cpeconfigurator.ui.screens.toBeacon
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
    Roof("Fine lavori sul tetto"),
    Router("Router e velocità"),
    Final("Verifica finale e collaudo"),
    ;

    companion object {
        fun of(mode: InstallMode): List<InstallStep> = if (mode == InstallMode.New) entries else listOf(Verify, Link, Aim, Roof, Router, Final)
    }
}

/** A photo taken on the roof, kept for the acceptance test until it is sent. */
class RoofPhoto(val caption: String, val jpeg: ByteArray, val thumb: android.graphics.Bitmap?)

/**
 * «Fine lavori sul tetto», right after the pointing: everything the acceptance test needs from the
 * roof, so the technician comes down once. The acceptance test takes it as it is (and can redo it).
 */
data class RoofCheck(
    /** The ten radio readings, taken while the phone is still on the CPE's Wi-Fi. */
    val radio: List<it.cdanet.cpeconfigurator.field.AirosStatus>? = null,
    /** The technician left the radio readings to the acceptance test. */
    val radioSkipped: Boolean = false,
    /** Height of the CPE above the ground, as typed («7,5»). */
    val heightText: String = "",
    val photos: List<RoofPhoto> = emptyList(),
) {
    /** Down from the roof: the readings taken (or left to the acceptance test). */
    val done: Boolean get() = radio != null || radioSkipped
}

/**
 * The «Router e velocità» step: router ready, its Wi-Fi as seen by the phone (and what was changed),
 * the speed tests against the plan. [gaveUp] is the technician's reason for going on under the minimum.
 */
data class RouterCheck(
    val ready: Boolean = false,
    val wifi: it.cdanet.cpeconfigurator.tools.speedtest.RouterWifi? = null,
    val changed: String? = null,
    val last: it.cdanet.cpeconfigurator.tools.speedtest.SpeedResult? = null,
    val target: it.cdanet.cpeconfigurator.tools.speedtest.SpeedTarget? = null,
    val passed: Boolean? = null,
    val attempts: Int = 0,
    val gaveUp: String? = null,
) {
    /** The final step may start: a test that passed, or one without a plan to compare, or the technician gave up. */
    val done: Boolean get() = last != null && (passed != false || gaveUp != null)

    fun speedtest(): it.cdanet.cpeconfigurator.field.AcceptanceSpeedtest? = last?.let { r ->
        it.cdanet.cpeconfigurator.field.AcceptanceSpeedtest(
            downMbps = Math.round(r.downMbps * 10) / 10.0,
            upMbps = Math.round(r.upMbps * 10) / 10.0,
            pingMs = Math.round(r.pingMs * 10) / 10.0,
            jitterMs = Math.round(r.jitterMs * 10) / 10.0,
            server = r.server,
            attempts = attempts.coerceAtLeast(1),
            target = target,
            passed = passed,
        )
    }

    fun wifiReport(): it.cdanet.cpeconfigurator.field.AcceptanceWifi? = wifi?.let { w ->
        it.cdanet.cpeconfigurator.field.AcceptanceWifi(
            ssid = w.ssid, rssi = w.rssi, band = w.band, channel = w.channel, widthMhz = w.widthMhz, linkMbps = w.linkMbps,
            neighborsSameChannel = w.neighborsSameChannel, neighborsOverlapping = w.neighborsOverlapping,
            congested = w.neighborsSameChannel?.let { it >= 3 }, suggestedChannel = w.suggestedChannel, changed = changed,
        )
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
    /** The lookup could not reach the server (no Internet here): not the same as «not found». */
    val jobLookupFailed: Boolean = false,
    /** SSID the CPE must be on (provisioned or chosen in the "Aggancio" step). */
    val expectedSsid: String? = null,
    /** The acceptance test was opened by itself at the last step (only once: back from it, the summary stays). */
    val acceptanceOpened: Boolean = false,
    /** What is done on the roof after the pointing: radio readings, height, photos of the antenna. */
    val roof: RoofCheck = RoofCheck(),
    /** Customer's router and the speed test (before the final step). */
    val router: RouterCheck = RouterCheck(),
    /** The work order this installation comes from (speed test target and context). */
    val workOrderId: Long? = null,
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

    fun acceptanceOpened() = _state.update { it.copy(acceptanceOpened = true) }

    fun router(f: (RouterCheck) -> RouterCheck) = _state.update { it.copy(router = f(it.router)) }

    fun roof(f: (RoofCheck) -> RoofCheck) = _state.update { it.copy(roof = f(it.roof)) }

    fun workOrder(id: Long?) = _state.update { it.copy(workOrderId = id) }

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
    suspend fun lookupJob(macs: List<String>, again: Boolean = false) {
        if ((_state.value.jobLooked && !again) || macs.isEmpty() || _state.value.job != null) return
        val job = try {
            api.cpeJob(macs)
        } catch (e: kotlinx.coroutines.CancellationException) {
            // the step was left before the answer: not «looked», the next step tries again
            throw e
        } catch (_: Exception) {
            // no answer (customer's Wi-Fi without Internet, weak mobile data): asked again when online
            _state.update { it.copy(jobLooked = true, jobLookupFailed = true) }
            return
        }
        _state.update { it.copy(job = job ?: it.job, jobLooked = true, jobLookupFailed = false) }
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
            apId = ap.id,
            heightM = p.from.height,
            beacons = p.aps.map { it.toBeacon() },
        )
    }
}
