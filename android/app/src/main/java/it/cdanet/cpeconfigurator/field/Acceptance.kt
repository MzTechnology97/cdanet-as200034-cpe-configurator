package it.cdanet.cpeconfigurator.field

import kotlinx.serialization.Serializable
import java.time.Instant
import kotlin.math.roundToInt

@Serializable
data class AcceptanceCpe(
    val hostname: String? = null,
    val model: String? = null,
    val firmware: String? = null,
    val apName: String? = null,
    val apMac: String? = null,
    val essid: String? = null,
    val distanceM: Int? = null,
    val frequencyMhz: Int? = null,
    val channelWidthMhz: Int? = null,
)

@Serializable
data class AcceptanceRadio(
    val signal: Int? = null,
    val signalMin: Int? = null,
    val signalMax: Int? = null,
    val noise: Int? = null,
    val chains: List<Int> = emptyList(),
    val remoteSignal: Int? = null,
    val expectedSignal: Int? = null,
    val cinrRx: Int? = null,
    val cinrTx: Int? = null,
    val dlCapacityMbps: Double? = null,
    val ulCapacityMbps: Double? = null,
)

@Serializable
data class AcceptanceLan(val plugged: Boolean? = null, val speedMbps: Int? = null, val fullDuplex: Boolean? = null, val cableLenM: Int? = null)

@Serializable
data class AcceptancePppoe(val enabled: Boolean? = null, val ip: String? = null)

@Serializable
data class InternetTest(
    val tested: Boolean,
    val pingMs: Double? = null,
    val jitterMs: Double? = null,
    val downloadMbps: Double? = null,
    val uploadMbps: Double? = null,
    val note: String? = null,
)

@Serializable
data class AcceptanceCheck(val title: String, val verdict: String, val detail: String)

/** The last speed test of the acceptance (customer's router Wi-Fi, OoklaServer), with the tries. */
@Serializable
data class AcceptanceSpeedtest(
    val downMbps: Double? = null,
    val upMbps: Double? = null,
    val pingMs: Double? = null,
    val jitterMs: Double? = null,
    val server: String? = null,
    val attempts: Int = 1,
    val target: it.cdanet.cpeconfigurator.tools.speedtest.SpeedTarget? = null,
    val passed: Boolean? = null,
)

/** The customer's router Wi-Fi as the phone saw it, and what the technician changed on it. */
@Serializable
data class AcceptanceWifi(
    val ssid: String? = null,
    val rssi: Int? = null,
    val band: String? = null,
    val channel: Int? = null,
    val widthMhz: Int? = null,
    val linkMbps: Int? = null,
    val neighborsSameChannel: Int? = null,
    val neighborsOverlapping: Int? = null,
    val congested: Boolean? = null,
    val suggestedChannel: Int? = null,
    val changed: String? = null,
    /** The speed test ran on a cable to the router's LAN (USB-C Ethernet adapter), not on its Wi-Fi. */
    val cable: Boolean? = null,
)

/** Body of PUT /api/provisioning/jobs/{id}/acceptance. */
@Serializable
data class AcceptanceReport(
    val verdict: String,
    val measuredAt: String,
    val samples: Int,
    val cpe: AcceptanceCpe,
    val radio: AcceptanceRadio,
    val lan: AcceptanceLan? = null,
    val pppoe: AcceptancePppoe? = null,
    val internet: InternetTest,
    val checks: List<AcceptanceCheck>,
    val notes: String = "",
    /** Height of the installed CPE above the ground, metres (entered by the technician). */
    val cpeHeightM: Double? = null,
    /** Phone GPS when the test was saved: the server checks it against the work order's position. */
    val position: AcceptancePosition? = null,
    val speedtest: AcceptanceSpeedtest? = null,
    val wifi: AcceptanceWifi? = null,
    /** "repoint": a re-pointing or AP change, a new test kept next to the earlier ones (null: the installation's). */
    val kind: String? = null,
    /** The same id when the same test is sent again (queue, retry): one test, not two. */
    val testId: String? = null,
    /** The work order of the re-pointing (none: the server makes one, already done, and tells the NOC). */
    val workOrderId: Long? = null,
)

@Serializable
data class AcceptancePosition(val lat: Double, val lon: Double, val accuracyM: Double? = null)

/** CPE height typed by the technician ("6", "6,5"): metres above the ground, null if missing or not plausible. */
fun parseCpeHeight(text: String): Double? = text.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it in 0.5..100.0 }

/** Builds the acceptance report from several CPE readings (signal averaged) and the Internet test. */
object Acceptance {
    const val SAMPLES = 10

    fun build(
        samples: List<AirosStatus>,
        t: FieldThresholds,
        targetFirmware: String?,
        internet: InternetTest,
        notes: String,
        now: Instant = Instant.now(),
        cpeHeightM: Double? = null,
        speedtest: AcceptanceSpeedtest? = null,
        wifi: AcceptanceWifi? = null,
    ): AcceptanceReport {
        require(samples.isNotEmpty()) { "Nessuna lettura della CPE" }
        val last = samples.last()
        val signals = samples.mapNotNull { it.signal }
        val avg = signals.takeIf { it.isNotEmpty() }?.average()?.roundToInt()
        // Checks on the averaged signal: a single lucky/unlucky reading must not decide the outcome.
        val ref = last.copy(signal = avg ?: last.signal)
        val checks = FieldDiagnosis.checks(ref, t, targetFirmware).toMutableList()
        // the speed test on the customer's Wi-Fi is the Internet test when there is no other
        val net = if (!internet.tested && speedtest?.downMbps != null) {
            InternetTest(true, speedtest.pingMs, speedtest.jitterMs, speedtest.downMbps, speedtest.upMbps, note = "Speedtest")
        } else internet
        speedtest?.let { st -> checks += speedCheck(st) }
        checks += when {
            net.tested -> Check(
                "Internet dal lato cliente",
                Verdict.Ok,
                "↓ %.1f · ↑ %.1f Mbit/s · ping %.0f ms".format(java.util.Locale.ITALY, net.downloadMbps ?: 0.0, net.uploadMbps ?: 0.0, net.pingMs ?: 0.0),
            )
            else -> Check("Internet dal lato cliente", Verdict.Warn, net.note ?: "Non misurato")
        }
        val verdict = when (FieldDiagnosis.summary(checks)) {
            Verdict.Bad -> "bad"
            Verdict.Warn -> "warn"
            else -> "ok"
        }
        return AcceptanceReport(
            verdict = verdict,
            measuredAt = now.toString(),
            samples = samples.size,
            cpe = AcceptanceCpe(last.hostname, last.model, last.firmware, last.apName, last.apMac, last.essid, last.distanceM, last.frequencyMhz, last.channelWidthMhz),
            radio = AcceptanceRadio(
                signal = avg,
                signalMin = signals.minOrNull(),
                signalMax = signals.maxOrNull(),
                noise = last.noise,
                chains = last.chains,
                remoteSignal = last.remoteSignal,
                expectedSignal = last.expectedSignal,
                cinrRx = last.cinrRx,
                cinrTx = last.cinrTx,
                dlCapacityMbps = last.dlCapacityMbps,
                ulCapacityMbps = last.ulCapacityMbps,
            ),
            lan = last.eth?.let { AcceptanceLan(it.plugged, it.speedMbps, it.fullDuplex, it.cableLenM) },
            pppoe = last.pppoeEnabled?.let { AcceptancePppoe(it, last.pppoeIp) },
            internet = net,
            checks = checks.take(30).map { AcceptanceCheck(it.title, it.verdict.name.lowercase(), it.detail.take(400)) },
            notes = notes.trim().take(1000),
            cpeHeightM = cpeHeightM,
            speedtest = speedtest,
            wifi = wifi,
        )
    }

    /**
     * The plan's speed: passed, or under the minimum after the technician gave up (a reserve the NOC
     * can still accept); without a known plan the result is only shown.
     */
    fun speedCheck(st: AcceptanceSpeedtest): Check {
        val got = "↓ %.1f · ↑ %.1f Mbit/s".format(java.util.Locale.ITALY, st.downMbps ?: 0.0, st.upMbps ?: 0.0) +
            if (st.attempts > 1) " · ${st.attempts} prove" else ""
        val t = st.target ?: return Check("Velocità del profilo", Verdict.Info, "$got (profilo del cliente non noto: nessun confronto)")
        val (minDown, minUp) = it.cdanet.cpeconfigurator.tools.speedtest.SpeedtestMath.minimum(t)
        val need = "minimo ${t.minPct}%%: %.1f / %.1f Mbit/s".format(java.util.Locale.ITALY, minDown, minUp)
        return if (st.passed == true) Check("Velocità del profilo", Verdict.Ok, "$got · $need")
        else Check("Velocità del profilo", Verdict.Warn, "$got · $need: velocità sotto il minimo")
    }
}
