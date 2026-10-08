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
)

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
    ): AcceptanceReport {
        require(samples.isNotEmpty()) { "Nessuna lettura della CPE" }
        val last = samples.last()
        val signals = samples.mapNotNull { it.signal }
        val avg = signals.takeIf { it.isNotEmpty() }?.average()?.roundToInt()
        // Checks on the averaged signal: a single lucky/unlucky reading must not decide the outcome.
        val ref = last.copy(signal = avg ?: last.signal)
        val checks = FieldDiagnosis.checks(ref, t, targetFirmware).toMutableList()
        checks += when {
            internet.tested -> Check(
                "Internet dal lato cliente",
                Verdict.Ok,
                "↓ %.1f · ↑ %.1f Mbit/s · ping %.0f ms".format(java.util.Locale.ITALY, internet.downloadMbps ?: 0.0, internet.uploadMbps ?: 0.0, internet.pingMs ?: 0.0),
            )
            else -> Check("Internet dal lato cliente", Verdict.Warn, internet.note ?: "Non misurato")
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
            internet = internet,
            checks = checks.take(30).map { AcceptanceCheck(it.title, it.verdict.name.lowercase(), it.detail.take(400)) },
            notes = notes.trim().take(1000),
        )
    }
}
