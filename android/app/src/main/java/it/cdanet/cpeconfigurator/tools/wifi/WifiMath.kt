package it.cdanet.cpeconfigurator.tools.wifi

import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToInt

enum class WifiBand(val label: String, val fromMhz: Int, val toMhz: Int) {
    B24("2.4 GHz", 2401, 2495),
    B5("5 GHz", 5150, 5895),
    B6("6 GHz", 5925, 7125),
}

/** One access point (BSSID) seen by the scan. */
data class WifiAp(
    val bssid: String,
    val ssid: String,
    /** Primary 20 MHz channel frequency. */
    val freq: Int,
    /** Center of the whole channel (differs from [freq] for 40/80/160 MHz). */
    val centerFreq: Int,
    val widthMhz: Int,
    val rssi: Int,
    val security: String,
    /** "Wi-Fi 4"…"Wi-Fi 7", "" if unknown. */
    val standard: String,
    val connected: Boolean = false,
    val vendor: String? = null,
) {
    val band: WifiBand get() = WifiMath.band(freq)
    val channel: Int get() = WifiMath.channel(freq)
    val lowMhz: Int get() = centerFreq - widthMhz / 2
    val highMhz: Int get() = centerFreq + widthMhz / 2
}

data class ChannelScore(
    val channel: Int,
    val freq: Int,
    /** Networks overlapping this 20 MHz channel. */
    val networks: Int,
    /** Sum of the overlapping signals, dBm (null = free). */
    val interferenceDbm: Int?,
    /** 0 (crowded) … 10 (free). */
    val rating: Int,
    val dfs: Boolean,
)

/** Wi-Fi analyzer math (pure, unit-tested): channels, bands, spectrum overlap, channel rating. */
object WifiMath {
    fun band(f: Int): WifiBand = when {
        f < 3000 -> WifiBand.B24
        f < 5925 -> WifiBand.B5
        else -> WifiBand.B6
    }

    fun channel(f: Int): Int = when {
        f == 2484 -> 14
        f in 2412..2472 -> (f - 2407) / 5
        f in 5000..5900 -> (f - 5000) / 5
        f in 5950..7125 -> (f - 5950) / 5
        else -> 0
    }

    fun freqOf(band: WifiBand, ch: Int): Int = when (band) {
        WifiBand.B24 -> if (ch == 14) 2484 else 2407 + ch * 5
        WifiBand.B5 -> 5000 + ch * 5
        WifiBand.B6 -> 5950 + ch * 5
    }

    /** android.net.wifi.ScanResult.CHANNEL_WIDTH_* → MHz. */
    fun widthMhz(code: Int): Int = when (code) { 1 -> 40; 2 -> 80; 3 -> 160; 4 -> 160; 5 -> 320; else -> 20 }

    /** ScanResult.WIFI_STANDARD_* → marketing name (6 GHz Wi-Fi 6 is "Wi-Fi 6E"). */
    fun standard(code: Int, freq: Int): String = when (code) {
        4 -> "Wi-Fi 4"
        5 -> "Wi-Fi 5"
        6 -> if (freq >= 5925) "Wi-Fi 6E" else "Wi-Fi 6"
        8 -> "Wi-Fi 7"
        1 -> "legacy"
        else -> ""
    }

    fun security(caps: String): String = when {
        caps.contains("SAE") && (caps.contains("PSK") || caps.contains("WPA2")) -> "WPA2/WPA3"
        caps.contains("SAE") -> "WPA3"
        caps.contains("EAP") -> "WPA2 Enterprise"
        caps.contains("OWE") -> "OWE"
        caps.contains("WPA2") || caps.contains("RSN") -> "WPA2"
        caps.contains("WPA") -> "WPA"
        caps.contains("WEP") -> "WEP"
        else -> "Aperta"
    }

    /** Channels shown/rated in a band (2.4 GHz: 1-13; 5 GHz: EU channels; 6 GHz: 20 MHz grid). */
    fun channels(band: WifiBand): List<Int> = when (band) {
        WifiBand.B24 -> (1..13).toList()
        WifiBand.B5 -> listOf(36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 149, 153, 157, 161, 165)
        WifiBand.B6 -> (1..233 step 4).toList()
    }

    /** 5 GHz channels needing radar detection (DFS) in Europe. */
    fun isDfs(band: WifiBand, ch: Int) = band == WifiBand.B5 && ch in 52..144

    /** Rough distance from the signal (free space, indicative only). */
    fun distanceM(rssi: Int, freq: Int): Int = 10.0.pow((27.55 - 20 * log10(freq.toDouble()) + -rssi) / 20).roundToInt()

    fun quality(rssi: Int): String = when {
        rssi >= -55 -> "eccellente"
        rssi >= -67 -> "buono"
        rssi >= -75 -> "discreto"
        rssi >= -85 -> "scarso"
        else -> "insufficiente"
    }

    /** Occupancy of every channel of [band], from the APs whose span overlaps its 20 MHz slot. */
    fun rate(aps: List<WifiAp>, band: WifiBand): List<ChannelScore> = channels(band).map { ch ->
        val f = freqOf(band, ch)
        // 2.4 GHz channels are 22 MHz wide and 5 MHz apart: overlap is wider than the 20 MHz grid
        val half = if (band == WifiBand.B24) 11 else 10
        val over = aps.filter { it.band == band && !it.connected && it.lowMhz < f + half && it.highMhz > f - half }
        val mw = over.sumOf { 10.0.pow(it.rssi / 10.0) }
        val dbm = if (mw > 0) (10 * log10(mw)).roundToInt() else null
        // free (≤ -90 dBm) = 10, very busy (≥ -40 dBm) = 0
        val rating = if (dbm == null) 10 else (((-40 - dbm) / 5.0).roundToInt()).coerceIn(0, 10)
        ChannelScore(ch, f, over.size, dbm, rating, isDfs(band, ch))
    }

    /** Best channels to configure a router: 2.4 GHz only 1/6/11; non-DFS 5 GHz channels first. */
    fun recommend(aps: List<WifiAp>, band: WifiBand): List<ChannelScore> {
        val scores = rate(aps, band)
        val candidates = when (band) {
            WifiBand.B24 -> scores.filter { it.channel in setOf(1, 6, 11) }
            else -> scores
        }
        return candidates.sortedWith(compareByDescending<ChannelScore> { it.rating }.thenBy { it.dfs }.thenBy { it.networks }.thenBy { it.channel }).take(3)
    }
}
