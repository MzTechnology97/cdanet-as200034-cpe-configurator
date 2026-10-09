package it.cdanet.cpeconfigurator.field

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.math.abs
import kotlin.math.roundToInt

/** Thresholds decided by the server (the NOC can tune them without a new app). */
@Serializable
data class FieldThresholds(
    val signalGood: Int = -65,
    val signalMin: Int = -75,
    val cinrMin: Int = 20,
    val chainDelta: Int = 6,
    val capacityMinMbps: Int = 100,
    val ethMinMbps: Int = 100,
)

data class EthStatus(val plugged: Boolean, val speedMbps: Int, val fullDuplex: Boolean, val cableLenM: Int?)

/**
 * The parts of airOS 8 `/status.cgi` a field technician needs. Every field is optional:
 * models and firmware builds differ, and a missing value must never crash the tool.
 */
data class AirosStatus(
    val hostname: String?,
    val model: String?,
    val firmware: String?,
    val uptimeSec: Long?,
    val temperatureC: Int?,
    val netRole: String?,
    val associated: Boolean,
    val essid: String?,
    val apMac: String?,
    val apName: String?,
    val frequencyMhz: Int?,
    val channelWidthMhz: Int?,
    val distanceM: Int?,
    val signal: Int?,
    val noise: Int?,
    /** Per-chain received signal in dBm (chain 0, chain 1), when reported. */
    val chains: List<Int>,
    /** Signal the AP receives from this CPE (uplink). */
    val remoteSignal: Int?,
    /** airMAX estimate of the signal this link should have. */
    val expectedSignal: Int?,
    val cinrRx: Int?,
    val cinrTx: Int?,
    val dlCapacityMbps: Double?,
    val ulCapacityMbps: Double?,
    val linkScore: Int?,
    val linkUptimeSec: Long?,
    val eth: EthStatus?,
    val pppoeEnabled: Boolean?,
    val pppoeIp: String?,
    /** MAC addresses of the CPE's own interfaces (to find its installation job). */
    val macs: List<String> = emptyList(),
    /** 802.11ac MCS index (0-9) and spatial streams of the link, when reported. */
    val rxMcs: Int? = null,
    val txMcs: Int? = null,
    val rxNss: Int? = null,
    val txNss: Int? = null,
) {
    val chainImbalance: Int? get() = if (chains.size >= 2) abs(chains[0] - chains[1]) else null
    val snr: Int? get() = if (signal != null && noise != null) signal - noise else null
    /** "256QAM 5/6 ×2" for the downlink (what the CPE receives). */
    val rxModulation: String? get() = modulation(rxMcs, rxNss)
    val txModulation: String? get() = modulation(txMcs, txNss)

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun parse(text: String): AirosStatus = parse(json.parseToJsonElement(text.substringAfter("\r\n\r\n", text).trim()) as JsonObject)

        fun parse(root: JsonObject): AirosStatus {
            val host = root.obj("host")
            val wireless = root.obj("wireless")
            val sta = (wireless?.get("sta") as? JsonArray)?.firstOrNull() as? JsonObject
            val remote = sta?.obj("remote")
            val airmax = sta?.obj("airmax")
            val interfaces = (root["interfaces"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            val eth0 = interfaces.firstOrNull { it.str("ifname") == "eth0" }?.obj("status")
            val ppp = interfaces.firstOrNull { it.str("ifname")?.startsWith("ppp") == true }?.obj("status")
            // chainrssi is RSSI (dB above -96): convert to dBm; 0 means the chain is absent.
            val chains = (sta?.get("chainrssi") as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.intOrNull }.filter { it > 0 }.map { it - 96 }
            val capacity = { key: String -> (airmax?.num(key) ?: wireless?.obj("polling")?.num(key))?.let { it / 1000.0 } }
            return AirosStatus(
                hostname = host?.str("hostname"),
                model = host?.str("devmodel"),
                firmware = host?.str("fwversion"),
                uptimeSec = host?.long("uptime"),
                temperatureC = host?.int("temperature")?.takeIf { it > 0 },
                netRole = host?.str("netrole"),
                associated = sta != null,
                essid = wireless?.str("essid"),
                apMac = sta?.str("mac") ?: wireless?.str("apmac"),
                apName = remote?.str("hostname"),
                frequencyMhz = wireless?.int("frequency"),
                channelWidthMhz = wireless?.int("chanbw"),
                distanceM = sta?.int("distance") ?: wireless?.int("distance"),
                signal = sta?.int("signal"),
                noise = sta?.int("noisefloor") ?: wireless?.int("noisef"),
                chains = chains,
                remoteSignal = remote?.int("signal"),
                expectedSignal = sta?.int("dl_signal_expect"),
                cinrRx = airmax?.obj("rx")?.int("cinr"),
                cinrTx = airmax?.obj("tx")?.int("cinr"),
                dlCapacityMbps = capacity("dl_capacity"),
                ulCapacityMbps = capacity("ul_capacity"),
                linkScore = sta?.int("dl_linkscore"),
                linkUptimeSec = sta?.long("uptime"),
                eth = eth0?.let { EthStatus(it.bool("plugged") ?: false, it.int("speed") ?: 0, it.bool("duplex") ?: true, it.int("cable_len")) },
                pppoeEnabled = root.obj("services")?.bool("pppoe"),
                pppoeIp = ppp?.str("ipaddr")?.takeIf { it.isNotBlank() && it != "0.0.0.0" },
                macs = interfaces.mapNotNull { it.str("hwaddr")?.uppercase() }.filter { it.matches(Regex("([0-9A-F]{2}:){5}[0-9A-F]{2}")) && it != "00:00:00:00:00:00" }.distinct(),
                rxMcs = sta?.int("rx_idx")?.takeIf { it in 0..11 },
                txMcs = sta?.int("tx_idx")?.takeIf { it in 0..11 },
                rxNss = sta?.int("rx_nss")?.takeIf { it in 1..4 },
                txNss = sta?.int("tx_nss")?.takeIf { it in 1..4 },
            )
        }

        private val MCS = listOf("BPSK 1/2", "QPSK 1/2", "QPSK 3/4", "16QAM 1/2", "16QAM 3/4", "64QAM 2/3", "64QAM 3/4", "64QAM 5/6", "256QAM 3/4", "256QAM 5/6", "1024QAM 3/4", "1024QAM 5/6")

        /** Modulation of an 802.11ac MCS index, with the number of streams ("×2" = MIMO 2x2). */
        fun modulation(mcs: Int?, nss: Int?): String? = mcs?.let { MCS.getOrNull(it) }?.let { m -> if (nss != null && nss > 1) "$m ×$nss" else m }

        private fun JsonObject.obj(k: String) = this[k] as? JsonObject
        private fun JsonObject.prim(k: String) = this[k] as? JsonPrimitive
        private fun JsonObject.str(k: String) = prim(k)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
        private fun JsonObject.int(k: String) = prim(k)?.let { it.intOrNull ?: it.doubleOrNull?.roundToInt() }
        private fun JsonObject.long(k: String) = prim(k)?.longOrNull
        private fun JsonObject.num(k: String) = prim(k)?.doubleOrNull
        private fun JsonObject.bool(k: String) = prim(k)?.let { it.booleanOrNull ?: it.intOrNull?.let { n -> n != 0 } }
    }
}

enum class Verdict { Ok, Warn, Bad, Info }

data class Check(val title: String, val verdict: Verdict, val detail: String)

/** Turns a status into the checklist a technician reads on a roof (Italian, actionable). */
object FieldDiagnosis {
    fun signalVerdict(signal: Int?, t: FieldThresholds): Verdict = when {
        signal == null -> Verdict.Bad
        signal >= t.signalGood -> Verdict.Ok
        signal >= t.signalMin -> Verdict.Warn
        else -> Verdict.Bad
    }

    fun checks(s: AirosStatus, t: FieldThresholds, targetFirmware: String?): List<Check> = buildList {
        if (!s.associated) {
            add(Check("Collegamento all'AP", Verdict.Bad, "La CPE non è agganciata a nessun AP${s.essid?.let { " (SSID configurato: $it)" } ?: ""}: verifica puntamento, SSID e chiave WPA2."))
        } else {
            add(Check("Collegamento all'AP", Verdict.Ok, listOfNotNull(s.apName ?: s.apMac, s.essid, s.distanceM?.let { "${formatDistance(it)}" }, s.linkUptimeSec?.let { "connessa da ${formatDuration(it)}" }).joinToString(" · ")))

            val sig = s.signal
            val expected = s.expectedSignal?.let { e -> sig?.let { " · atteso $e dBm (${signed(it - e)} dB)" } }.orEmpty()
            add(
                Check(
                    "Segnale ricevuto",
                    signalVerdict(sig, t),
                    when (signalVerdict(sig, t)) {
                        Verdict.Ok -> "$sig dBm: ottimo$expected"
                        Verdict.Warn -> "$sig dBm: accettabile, sotto ${t.signalGood} dBm conviene migliorare il puntamento$expected"
                        else -> "${sig ?: "—"} dBm: insufficiente (minimo ${t.signalMin} dBm). Rivedi puntamento, ostacoli o AP scelto$expected"
                    },
                ),
            )
            s.remoteSignal?.let { r ->
                add(Check("Segnale lato AP", if (r >= t.signalMin) Verdict.Ok else Verdict.Warn, "L'AP riceve la CPE a $r dBm" + if (r < t.signalMin) ": uplink debole, controlla puntamento e potenza" else ""))
            }
            s.chainImbalance?.let { d ->
                add(
                    if (d > t.chainDelta) Check("Catene (polarizzazioni)", Verdict.Warn, "Differenza di $d dB tra le catene (${s.chains.joinToString(" / ")} dBm): possibile ostacolo, riflessione o antenna non allineata in elevazione")
                    else Check("Catene (polarizzazioni)", Verdict.Ok, "Bilanciate (${s.chains.joinToString(" / ")} dBm)"),
                )
            }
            s.cinrRx?.let { c ->
                add(Check("CINR (qualità)", if (c >= t.cinrMin) Verdict.Ok else Verdict.Warn, "$c dB" + if (c < t.cinrMin) ": interferenze sul canale, segnalalo al NOC" else ""))
            }
            s.dlCapacityMbps?.let { dl ->
                val ul = s.ulCapacityMbps?.let { " / ${it.roundToInt()} up" }.orEmpty()
                add(Check("Capacità airMAX", if (dl >= t.capacityMinMbps) Verdict.Ok else Verdict.Warn, "${dl.roundToInt()} down$ul Mbit/s" + if (dl < t.capacityMinMbps) " (minimo ${t.capacityMinMbps})" else ""))
            }
        }
        s.eth?.let { e ->
            add(
                when {
                    !e.plugged -> Check("Porta LAN (cavo)", Verdict.Bad, "Nessun collegamento sulla porta LAN: cavo scollegato, interrotto o router spento")
                    e.speedMbps < t.ethMinMbps || !e.fullDuplex ->
                        Check("Porta LAN (cavo)", Verdict.Warn, "${e.speedMbps} Mbit/s ${if (e.fullDuplex) "full" else "half"} duplex: tipico di cavo o connettore danneggiato, rifai i plug o cambia cavo")
                    else -> Check("Porta LAN (cavo)", Verdict.Ok, "${e.speedMbps} Mbit/s full duplex" + (e.cableLenM?.takeIf { it > 0 }?.let { " · cavo ~$it m" } ?: ""))
                },
            )
        }
        when (s.pppoeEnabled) {
            true -> add(
                s.pppoeIp?.let { Check("PPPoE", Verdict.Ok, "Sessione attiva · IP $it") }
                    ?: Check("PPPoE", Verdict.Bad, "Sessione non attiva: controlla utente/password PPPoE o lo stato dell'abbonamento"),
            )
            false -> add(Check("PPPoE", Verdict.Info, "PPPoE non attivo sulla CPE (modalità ${s.netRole ?: "sconosciuta"})"))
            null -> Unit
        }
        if (targetFirmware != null && s.firmware != null) {
            val ok = Regex("""(^|[^0-9.])v?${Regex.escape(targetFirmware)}(?![0-9])""").containsMatchIn(s.firmware)
            add(Check("Firmware", if (ok) Verdict.Ok else Verdict.Warn, s.firmware + if (ok) "" else " (standard: $targetFirmware)"))
        }
        s.uptimeSec?.let { u ->
            add(if (u < 600) Check("Accesa da", Verdict.Warn, "${formatDuration(u)}: riavvio recente, verifica alimentazione/PoE se succede spesso") else Check("Accesa da", Verdict.Info, formatDuration(u)))
        }
        s.temperatureC?.let { add(Check("Temperatura", if (it >= 75) Verdict.Warn else Verdict.Info, "$it °C")) }
    }

    fun summary(checks: List<Check>): Verdict = when {
        checks.any { it.verdict == Verdict.Bad } -> Verdict.Bad
        checks.any { it.verdict == Verdict.Warn } -> Verdict.Warn
        else -> Verdict.Ok
    }

    /** Plain-text report, to share with the NOC (no credentials, no customer data). */
    fun report(s: AirosStatus, checks: List<Check>): String = buildString {
        appendLine("Diagnosi CPE ${s.hostname ?: ""} (${s.model ?: "?"}, ${s.firmware ?: "?"})".trim())
        checks.forEach { appendLine("${mark(it.verdict)} ${it.title}: ${it.detail}") }
    }

    fun mark(v: Verdict) = when (v) {
        Verdict.Ok -> "✔"
        Verdict.Warn -> "⚠"
        Verdict.Bad -> "✖"
        Verdict.Info -> "•"
    }

    /** Tone pitch for the alignment beep: higher signal, higher pitch (300 Hz at -90 dBm, 2000 Hz at -40). */
    fun toneHz(signal: Int?): Int {
        val s = (signal ?: -95).coerceIn(-90, -40)
        return 300 + (s + 90) * 34
    }

    fun signed(v: Int) = if (v >= 0) "+$v" else "$v"

    fun formatDistance(m: Int) = if (m >= 1000) "%.1f km".format(java.util.Locale.ITALY, m / 1000.0) else "$m m"

    fun formatDuration(sec: Long): String {
        val d = sec / 86_400
        val h = (sec % 86_400) / 3600
        val m = (sec % 3600) / 60
        return when {
            d > 0 -> "${d}g ${h}h"
            h > 0 -> "${h}h ${m}m"
            else -> "${m}m ${sec % 60}s"
        }
    }
}
