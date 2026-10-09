package it.cdanet.cpeconfigurator.install

import it.cdanet.cpeconfigurator.data.PointingApDto
import it.cdanet.cpeconfigurator.field.FieldDiagnosis
import it.cdanet.cpeconfigurator.field.SurveyAp
import kotlin.math.roundToInt

/** A CDA Net AP the technician can choose, with what is known about it from here. */
data class ApChoice(
    val ssid: String,
    val name: String,
    /** Signal the CPE actually hears (site survey), dBm. */
    val measured: Int? = null,
    val snr: Int? = null,
    val bssid: String? = null,
    /** From UISP and the phone position: distance, direction and expected signal. */
    val ap: PointingApDto? = null,
    val current: Boolean = false,
    /** false = the WPA2 key of this SSID is not configured on the server. */
    val usable: Boolean = true,
    val recommended: Boolean = false,
) {
    val distanceM: Int? get() = ap?.distanceM
    val estimate: Int? get() = ap?.estimate?.signalDbm

    fun describe(): String = listOfNotNull(
        measured?.let { "$it dBm sentiti dalla CPE" },
        snr?.let { "SNR $it dB" },
        estimate?.takeIf { measured == null }?.let { "stima $it dBm" },
        ap?.let { "${FieldDiagnosis.formatDistance(it.distanceM)} · ${it.bearing}° ${it.direction}" },
        ap?.tiltDeg?.let { "tilt %+.1f°".format(java.util.Locale.ITALY, it) },
        if (!usable) "chiave WPA2 non configurata" else null,
    ).joinToString(" · ")
}

/**
 * Which AP to use. On the roof the signal the CPE really hears decides; signals within 3 dB are
 * equivalent and then the closer AP wins (more margin, less load on far sectors). Before the
 * installation only UISP is available: expected signal from the customers, then distance.
 * Pure, unit-tested.
 */
object ApAdvisor {
    /** Customer APs, relays included ("CDA-NET-N6-D02-R1"); same rule as the server. */
    private val CDA = Regex("^CDA-NET-N\\d+-D[A-Za-z0-9_-]+$", RegexOption.IGNORE_CASE)

    fun isCdaNet(ssid: String?) = ssid != null && CDA.matches(ssid)

    /** From the CPE site survey (CDA Net APs only), enriched with the nearby APs from UISP. */
    fun fromSurvey(survey: List<SurveyAp>, nearby: List<PointingApDto>, currentSsid: String?, configured: Set<String>?): List<ApChoice> {
        val byssid = nearby.filter { it.ssid != null }.associateBy { it.ssid!!.uppercase() }
        val choices = survey.filter { isCdaNet(it.essid) }
            .groupBy { it.essid.uppercase() }
            .map { (_, heard) -> heard.maxBy { it.signal ?: -200 } }
            .map { s ->
                val ap = byssid[s.essid.uppercase()]
                ApChoice(
                    ssid = s.essid.uppercase(),
                    name = ap?.name?.ifBlank { null } ?: s.essid,
                    measured = s.signal,
                    snr = s.snr,
                    bssid = s.mac,
                    ap = ap,
                    current = s.essid.equals(currentSsid, ignoreCase = true),
                    usable = configured?.contains(s.essid.uppercase()) ?: true,
                )
            }
            .sortedWith(compareByDescending<ApChoice> { it.usable }.thenByDescending { bucket(it.measured) }.thenBy { it.distanceM ?: Int.MAX_VALUE }.thenByDescending { it.measured ?: -200 })
        return markBest(choices)
    }

    /** Before installing (no CPE yet): nearby CDA Net APs by expected signal, then distance. */
    fun beforeInstall(nearby: List<PointingApDto>, configured: Set<String>?): List<ApChoice> {
        val choices = nearby.filter { isCdaNet(it.ssid) && it.status.ifBlank { "active" } == "active" }
            .map { ap ->
                ApChoice(
                    ssid = ap.ssid!!.uppercase(),
                    name = ap.name.ifBlank { ap.ssid!! },
                    ap = ap,
                    usable = configured?.contains(ap.ssid.uppercase()) ?: true,
                )
            }
            .sortedWith(compareByDescending<ApChoice> { it.usable }.thenByDescending { bucket(it.estimate) }.thenBy { it.distanceM ?: Int.MAX_VALUE })
        return markBest(choices)
    }

    /** Should the technician move the CPE? Only for a clear gain (6 dB) over the current AP. */
    fun betterThanCurrent(choices: List<ApChoice>): ApChoice? {
        val cur = choices.firstOrNull { it.current }?.measured ?: return choices.firstOrNull { it.usable && !it.current }
        return choices.firstOrNull { it.usable && !it.current && (it.measured ?: -200) >= cur + 6 }
    }

    /** 3 dB steps: readings within the same step are considered equal. */
    private fun bucket(dbm: Int?): Int = dbm?.let { (it / 3.0).roundToInt() } ?: Int.MIN_VALUE

    private fun markBest(list: List<ApChoice>): List<ApChoice> {
        val best = list.indexOfFirst { it.usable }
        return list.mapIndexed { i, a -> if (i == best) a.copy(recommended = true) else a }
    }
}
