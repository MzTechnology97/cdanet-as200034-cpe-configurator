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

/** What to set on the customer's router in one band. */
data class RouterAdvice(
    val band: WifiBand,
    /** The router's current channel in this band and how busy its span is (null = not seen). */
    val currentChannel: Int?,
    val currentWidthMhz: Int?,
    val currentRating: Int?,
    val best: ChannelScore,
    val widthMhz: Int,
    /** Moving is worth it: the suggested channel is clearly freer, or 2.4 GHz is off 1/6/11. */
    val move: Boolean,
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

    /**
     * The customer's router networks: the chosen SSID plus the other band's SSID of the same box
     * ("Casa" / "Casa_5G"), recognised by BSSIDs that differ only in the first or last octet.
     */
    fun routerSsids(aps: List<WifiAp>, ssid: String): Set<String> {
        val mine = aps.filter { it.ssid == ssid }.map { it.bssid.uppercase() }
        fun head(b: String) = b.substringBeforeLast(':')
        fun tail(b: String) = b.substringAfter(':')
        val heads = mine.map(::head).toSet()
        val tails = mine.map(::tail).toSet()
        return setOf(ssid) + aps.filter { a -> a.bssid.uppercase().let { head(it) in heads || tail(it) in tails } }.map { it.ssid }
    }

    /** 5 GHz 80 MHz blocks usable in Europe. */
    private val BLOCKS_80 = listOf(36..48, 52..64, 100..112, 116..128, 132..140, 149..161)

    /**
     * Channel and width to set on the customer's router, per band, computed without the router's
     * own networks. 2.4 GHz stays at 20 MHz on 1/6/11; 5 GHz goes to 80 MHz when a whole block is
     * free (non-DFS first: DFS makes the router jump channel when it hears a radar), else 40 or 20.
     */
    fun routerAdvice(aps: List<WifiAp>, routerSsids: Set<String>): List<RouterAdvice> {
        val others = aps.filter { it.ssid !in routerSsids }.map { it.copy(connected = false) }
        return listOf(WifiBand.B24, WifiBand.B5).mapNotNull { band ->
            val scores = rate(others, band)
            val byCh = scores.associateBy { it.channel }
            val (best, width) = if (band == WifiBand.B24) {
                (recommend(others, band).firstOrNull() ?: return@mapNotNull null) to 20
            } else {
                fun group(r: IntRange) = r.step(4).mapNotNull { byCh[it] }
                val pairs = BLOCKS_80.flatMap { b -> group(b).chunked(2).filter { it.size == 2 } }
                val order = compareBy<List<ChannelScore>> { g -> g.any { it.dfs } }.thenByDescending { g -> g.minOf { it.rating } }
                val free80 = BLOCKS_80.map(::group).filter { g -> g.size == 4 && g.all { it.rating >= 7 } }.sortedWith(order).firstOrNull()
                val free40 = pairs.filter { g -> g.all { it.rating >= 7 } }.sortedWith(order).firstOrNull()
                fun pick(g: List<ChannelScore>) = g.sortedWith(compareByDescending<ChannelScore> { it.rating }.thenBy { it.channel }).first()
                when {
                    free80 != null -> pick(free80) to 80
                    free40 != null -> pick(free40) to 40
                    else -> (recommend(others, band).firstOrNull() ?: return@mapNotNull null) to 20
                }
            }
            val mine = aps.filter { it.ssid in routerSsids && it.band == band }.maxByOrNull { it.rssi }
            // a wide 5 GHz channel is as good as the busiest 20 MHz slot it covers
            val currentRating = mine?.let { m ->
                if (band == WifiBand.B24) byCh[m.channel]?.rating
                else scores.filter { it.freq > m.lowMhz && it.freq < m.highMhz }.minOfOrNull { it.rating } ?: byCh[m.channel]?.rating
            }
            val move = mine != null && mine.channel != best.channel &&
                ((band == WifiBand.B24 && mine.channel !in setOf(1, 6, 11)) || best.rating - (currentRating ?: 0) >= 2)
            RouterAdvice(band, mine?.channel, mine?.widthMhz, currentRating, best, width, move)
        }
    }
}
