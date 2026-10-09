package it.cdanet.cpeconfigurator.field

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/** An AP heard by the CPE's own radio (airOS site survey). */
data class SurveyAp(
    val mac: String,
    val essid: String,
    val frequencyMhz: Int?,
    val channel: Int?,
    val signal: Int?,
    val noise: Int?,
    val mode: String,
    val security: String,
    val airmax: Boolean?,
) {
    val snr: Int? get() = if (signal != null && noise != null) signal - noise else null
    /** CDA Net SSID "CDA-NET-N{node}-D{district}", also of a relay AP ("…-R{n}"). */
    val cdaNet: Pair<Int, Int>? get() = Regex("^CDA-NET-N(\\d+)-D(\\d+)(?:-R\\d+)?$", RegexOption.IGNORE_CASE).find(essid)?.let { it.groupValues[1].toInt() to it.groupValues[2].toInt() }
}

/**
 * Parser of the airOS site survey (`survey.json.cgi`). Field names differ between firmware
 * builds, so the common variants are read; anything unrecognised is skipped. Pure, unit-tested.
 */
object SiteSurvey {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun JsonObject.str(vararg keys: String): String? = keys.firstNotNullOfOrNull { k -> (this[k] as? JsonPrimitive)?.takeIf { it.isString || it.intOrNull != null }?.content?.ifBlank { null } }
    private fun JsonObject.int(vararg keys: String): Int? = keys.firstNotNullOfOrNull { k ->
        (this[k] as? JsonPrimitive)?.let { p -> p.intOrNull ?: p.doubleOrNull?.toInt() ?: p.content.trim().removeSuffix("dBm").trim().toIntOrNull() }
    }

    private fun channelOf(f: Int): Int? = when {
        f in 2412..2472 -> (f - 2407) / 5
        f in 4900..5900 -> (f - 5000) / 5
        else -> null
    }

    fun parse(text: String): List<SurveyAp> {
        val root: JsonElement = runCatching { json.parseToJsonElement(text) }.getOrNull() ?: return emptyList()
        val items: List<JsonElement> = when (root) {
            is JsonArray -> root
            is JsonObject -> (root["survey"] ?: root["results"] ?: root["aps"]) as? JsonArray ?: return emptyList()
            else -> return emptyList()
        }
        return items.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val mac = o.str("mac", "bssid")?.uppercase() ?: return@mapNotNull null
            val freq = o.int("frequency", "freq", "center1_freq")
            SurveyAp(
                mac = mac,
                essid = o.str("essid", "ssid").orEmpty(),
                frequencyMhz = freq,
                channel = o.int("channel") ?: freq?.let { channelOf(it) },
                signal = o.int("signal_level", "signal", "rssi"),
                noise = o.int("noise_level", "noise", "noisef"),
                mode = o.str("ieee_mode", "mode", "phy_mode").orEmpty(),
                security = o.str("encryption", "auth", "security").orEmpty(),
                airmax = (o["airmax"] as? JsonPrimitive)?.let { p -> p.intOrNull?.let { it != 0 } ?: p.content.toBooleanStrictOrNull() },
            )
        }.distinctBy { it.mac }.sortedByDescending { it.signal ?: -200 }
    }
}
