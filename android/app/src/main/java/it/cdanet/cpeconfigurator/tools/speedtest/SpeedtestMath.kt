package it.cdanet.cpeconfigurator.tools.speedtest

import it.cdanet.cpeconfigurator.tools.wifi.WifiAp
import it.cdanet.cpeconfigurator.tools.wifi.WifiBand
import it.cdanet.cpeconfigurator.tools.wifi.WifiMath
import kotlinx.serialization.Serializable

/** Speed test settings of the server (Impostazioni server → «Collaudo: speedtest e Wi-Fi»). */
@Serializable
data class SpeedtestConfig(
    val host: String = "speedtest.cda-net.it",
    val port: Int = 8080,
    val seconds: Int = 10,
    val streams: Int = 4,
    val minPct: Int = 80,
    val wifiWarnDbm: Int = -65,
    val wifiBlockDbm: Int = -70,
)

/** The speeds of the customer's plan: the test passes at [minPct]% of them. */
@Serializable
data class SpeedTarget(val profile: String = "", val downMbps: Double, val upMbps: Double, val minPct: Int = 80)

/** The customer's router Wi-Fi as the phone sees it, saved with the test and the acceptance. */
@Serializable
data class RouterWifi(
    val ssid: String? = null,
    val bssid: String? = null,
    val rssi: Int? = null,
    /** "2.4", "5" or "6". */
    val band: String? = null,
    val channel: Int? = null,
    val widthMhz: Int? = null,
    val linkMbps: Int? = null,
    val neighborsSameChannel: Int? = null,
    val neighborsOverlapping: Int? = null,
    val suggestedChannel: Int? = null,
    /** The test ran on a cable to the router's LAN (USB-C Ethernet adapter), not on its Wi-Fi. */
    val cable: Boolean? = null,
)

/** Rules of the speed test (pure, tested). */
object SpeedtestMath {
    enum class Signal { Ok, Weak, TooWeak }

    /** The phone's Wi-Fi signal against the server thresholds: too weak blocks the test, weak warns. */
    fun signal(rssi: Int?, cfg: SpeedtestConfig): Signal = when {
        rssi == null -> Signal.Ok
        rssi < cfg.wifiBlockDbm -> Signal.TooWeak
        rssi < cfg.wifiWarnDbm -> Signal.Weak
        else -> Signal.Ok
    }

    /** Passed: both ways at [SpeedTarget.minPct]% of the plan. Null without a target (no comparison). */
    fun passed(down: Double?, up: Double?, target: SpeedTarget?): Boolean? {
        target ?: return null
        if (down == null || up == null) return false
        return down >= target.downMbps * target.minPct / 100.0 && up >= target.upMbps * target.minPct / 100.0
    }

    /** The minimum each way, for the screen: «almeno 24 / 4,8 Mbit/s». */
    fun minimum(target: SpeedTarget): Pair<Double, Double> = target.downMbps * target.minPct / 100.0 to target.upMbps * target.minPct / 100.0

    fun bandLabel(band: WifiBand): String = when (band) {
        WifiBand.B24 -> "2.4"
        WifiBand.B5 -> "5"
        WifiBand.B6 -> "6"
    }

    /**
     * The router as the scan shows it: the access point the phone is on ([connectedBssid]), the other
     * networks on its very channel and those overlapping its span, and the channel to move to.
     */
    fun routerWifi(aps: List<WifiAp>, connectedBssid: String?, ssid: String?, linkMbps: Int?, rssi: Int?): RouterWifi {
        val mine = aps.firstOrNull { connectedBssid != null && it.bssid.equals(connectedBssid, ignoreCase = true) }
            ?: aps.filter { ssid != null && it.ssid == ssid }.maxByOrNull { it.rssi }
        if (mine == null) return RouterWifi(ssid = ssid, bssid = connectedBssid?.uppercase(), rssi = rssi, linkMbps = linkMbps)
        val router = WifiMath.routerSsids(aps, mine.ssid)
        val others = aps.filter { it.ssid !in router && it.band == mine.band }
        val same = others.count { it.channel == mine.channel }
        val overlapping = others.count { it.channel != mine.channel && it.lowMhz < mine.highMhz && it.highMhz > mine.lowMhz }
        val advice = WifiMath.routerAdvice(aps, router).firstOrNull { it.band == mine.band }
        return RouterWifi(
            ssid = mine.ssid,
            bssid = mine.bssid.uppercase(),
            rssi = rssi ?: mine.rssi,
            band = bandLabel(mine.band),
            channel = mine.channel,
            widthMhz = mine.widthMhz,
            linkMbps = linkMbps,
            neighborsSameChannel = same,
            neighborsOverlapping = overlapping,
            suggestedChannel = advice?.takeIf { it.move }?.best?.channel,
        )
    }

    /** What to change on the router, in words (empty: it is fine as it is). */
    fun advice(aps: List<WifiAp>, w: RouterWifi): List<String> {
        val out = mutableListOf<String>()
        val ssid = w.ssid ?: return out
        val router = WifiMath.routerSsids(aps, ssid)
        val all = WifiMath.routerAdvice(aps, router)
        val here = all.firstOrNull { it.band.let(::bandLabel) == w.band }
        if (here != null && here.move) out += "Sposta la rete ${here.band.label} sul canale ${here.best.channel}" + if (here.widthMhz != (w.widthMhz ?: 0)) " a ${here.widthMhz} MHz" else ""
        else if (here != null && w.band == "5" && (w.widthMhz ?: 0) < here.widthMhz) out += "Porta la rete 5 GHz a ${here.widthMhz} MHz: il canale ${here.best.channel} è libero"
        // only when the router has a 5 GHz network (seen by the scan)
        if (w.band == "2.4" && aps.any { it.ssid in router && it.band == WifiBand.B5 }) out += "Il telefono è sulla rete 2,4 GHz: collegalo alla rete 5 GHz del router, è più veloce"
        if (w.band == "2.4" && (w.widthMhz ?: 20) > 20) out += "Sulla 2,4 GHz usa 20 MHz: a 40 MHz disturba ed è disturbata"
        return out
    }

    /** Under the threshold: what to check before testing again (the order of the likely causes). */
    val CHECKLIST = listOf(
        "Puntamento della CPE: il segnale è quello del collaudo?",
        "Altri dispositivi collegati al router che stanno usando la linea (TV, download, aggiornamenti)",
        "Canale radio del router: occupato o sovrapposto ad altre reti",
        "Cavo e porta LAN tra CPE e router: velocità della porta, cavo danneggiato o troppo lungo",
    )
}
