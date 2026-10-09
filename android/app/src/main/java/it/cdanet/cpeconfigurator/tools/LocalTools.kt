package it.cdanet.cpeconfigurator.tools

import android.annotation.SuppressLint
import android.net.wifi.ScanResult
import android.os.Build
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.Session
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.network.NetworkHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Generic result rendered by the tools UI. */
data class ToolItem(val title: String, val subtitle: String = "", val trailing: String = "")
data class ToolResult(val rows: List<Pair<String, String>> = emptyList(), val items: List<ToolItem> = emptyList(), val note: String? = null)

/** Diagnostics executed from the phone, i.e. on the customer's / site LAN. */
class LocalTools(private val network: NetworkHelper, private val api: ApiClient, private val session: Session) {

    private suspend fun <T> io(block: suspend () -> T): T = withContext(Dispatchers.IO) { block() }

    fun connection(): ToolResult {
        val active = network.activeLink()
        val wifi = network.wifiLink()
        val rows = mutableListOf<Pair<String, String>>()
        active?.let {
            rows += "Rete attiva" to it.transport + if (it.validated) " · Internet OK" else " · senza Internet"
            rows += "Interfaccia" to (it.interfaceName ?: "—")
            rows += "Indirizzi" to it.addresses.joinToString(", ").ifBlank { "—" }
            rows += "Gateway" to (it.gateway ?: "—")
            rows += "DNS" to it.dns.joinToString(", ").ifBlank { "—" }
        }
        wifi?.let {
            rows += "Wi-Fi SSID" to (it.wifiSsid ?: "nascosto / permesso posizione mancante")
            rows += "BSSID" to (it.wifiBssid ?: "—")
            rows += "Segnale" to (it.wifiRssi?.let { r -> "$r dBm" } ?: "—")
            rows += "Frequenza" to (it.wifiFrequency?.let { f -> "$f MHz · canale ${channel(f)}" } ?: "—")
            rows += "Velocità link" to (it.linkSpeedMbps?.let { s -> "$s Mbps" } ?: "—")
            rows += "Subnet Wi-Fi" to (it.cidr ?: "—")
        }
        return ToolResult(rows, note = if (active == null) "Nessuna rete attiva" else null)
    }

    fun suggestedCidr(): String? = (network.wifiLink() ?: network.activeLink())?.cidr

    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    suspend fun wifiScan(): ToolResult = io {
        val wm = network.wifiManager
        wm.startScan()
        delay(2500)
        val results: List<ScanResult> = wm.scanResults.orEmpty()
        val items = results.sortedByDescending { it.level }.map { r ->
            val ssid = if (Build.VERSION.SDK_INT >= 33) r.wifiSsid?.toString()?.trim('"').orEmpty() else r.SSID.orEmpty()
            ToolItem(
                title = ssid.ifBlank { "(SSID nascosto)" },
                subtitle = "${r.BSSID} · ${r.frequency} MHz · CH ${channel(r.frequency)} · ${width(r.channelWidth)} · ${security(r.capabilities)}",
                trailing = "${r.level} dBm",
            )
        }
        val bands = results.map { if (it.frequency < 3000) "2.4 GHz" else if (it.frequency < 5925) "5 GHz" else "6 GHz" }.distinct()
        val seen = results.map { SeenNetwork(it.frequency, it.level, when (it.channelWidth) { 1 -> 40; 2 -> 80; 3, 4 -> 160; else -> 20 }) }
        ToolResult(
            rows = listOf(
                "Reti" to results.size.toString(),
                "Bande" to bands.joinToString(" / ").ifBlank { "—" },
                "Router cliente, 2.4 GHz" to ChannelAdvisor.describe(ChannelAdvisor.best24(seen)).substringAfter(": "),
                "Router cliente, 5 GHz" to ChannelAdvisor.describe(ChannelAdvisor.best5(seen)).substringAfter(": "),
            ),
            items = items,
            note = if (results.isEmpty()) "Nessun risultato: verifica posizione attiva e permessi (Android limita le scansioni a 4 ogni 2 minuti)." else null,
        )
    }

    private fun channel(f: Int): Int = when {
        f == 2484 -> 14
        f in 2412..2472 -> (f - 2407) / 5
        f in 5000..5895 -> (f - 5000) / 5
        f in 5955..7115 -> (f - 5950) / 5
        else -> 0
    }

    private fun width(w: Int) = when (w) { 0 -> "20 MHz"; 1 -> "40 MHz"; 2 -> "80 MHz"; 3 -> "160 MHz"; 4 -> "80+80 MHz"; 5 -> "320 MHz"; else -> "?" }

    private fun security(caps: String) = when {
        caps.contains("SAE") -> "WPA3"
        caps.contains("WPA2") || caps.contains("RSN") -> "WPA2"
        caps.contains("WPA") -> "WPA"
        caps.contains("WEP") -> "WEP"
        else -> "Aperta"
    }

    private fun runCmd(vararg args: String, timeoutMs: Long = 4000): String {
        val p = ProcessBuilder(*args).redirectErrorStream(true).start()
        val out = StringBuilder()
        val reader = Thread { runCatching { p.inputStream.bufferedReader().use { r -> out.append(r.readText()) } } }
        reader.start()
        if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
            p.destroyForcibly()
        }
        reader.join(300)
        return out.toString()
    }

    private fun pingOnce(ip: String, ttl: Int? = null, timeoutSec: Int = 1): String {
        val args = mutableListOf("/system/bin/ping", "-c", "1", "-W", timeoutSec.toString())
        if (ttl != null) args += listOf("-t", ttl.toString())
        args += ip
        return runCmd(*args.toTypedArray(), timeoutMs = (timeoutSec + 2) * 1000L)
    }

    private val TIME = Regex("""time[=<]\s*([0-9.]+)\s*ms""", RegexOption.IGNORE_CASE)

    suspend fun ping(host: String, count: Int = 4): ToolResult = io {
        val ip = InetAddress.getByName(host.trim()).hostAddress ?: throw IOException("Host non valido")
        val times = mutableListOf<Double>()
        repeat(count) {
            val out = pingOnce(ip, timeoutSec = 2)
            TIME.find(out)?.groupValues?.get(1)?.toDoubleOrNull()?.let { times += it }
        }
        val loss = 100 * (count - times.size) / count
        ToolResult(
            rows = listOf(
                "Host" to if (ip == host.trim()) ip else "$host ($ip)",
                "Esito" to if (times.isEmpty()) "Non raggiungibile" else "Raggiungibile",
                "Persi" to "$loss%",
                "Min / media / max" to if (times.isEmpty()) "—" else "%.1f / %.1f / %.1f ms".format(times.min(), times.average(), times.max()),
            ),
        )
    }

    suspend fun dns(host: String): ToolResult = io {
        val all = InetAddress.getAllByName(host.trim())
        ToolResult(rows = listOf("Host" to host.trim()), items = all.map { ToolItem(it.hostAddress ?: "", if (it is Inet4Address) "IPv4" else "IPv6") })
    }

    suspend fun traceroute(host: String): ToolResult = io {
        val target = InetAddress.getByName(host.trim()).hostAddress ?: throw IOException("Host non valido")
        val items = mutableListOf<ToolItem>()
        var reached = false
        for (ttl in 1..20) {
            val out = pingOnce(target, ttl = ttl)
            val from = Regex("""[Ff]rom ((?:\d{1,3}\.){3}\d{1,3})""").find(out)?.groupValues?.get(1)
                ?: if (out.contains("bytes from", true)) target else null
            if (from == null) {
                items += ToolItem("$ttl  *", "timeout")
                continue
            }
            val name = runCatching { InetAddress.getByName(from).canonicalHostName }.getOrNull()?.takeIf { it != from }.orEmpty()
            items += ToolItem("$ttl  $from", name, TIME.find(out)?.groupValues?.get(1)?.let { "$it ms" }.orEmpty())
            if (from == target) {
                reached = true
                break
            }
        }
        ToolResult(rows = listOf("Destinazione" to target, "Esito" to if (reached) "Raggiunta" else "Parziale"), items = items, note = "Traceroute tramite ping con TTL crescente.")
    }

    private fun arpTable(): Map<String, String> {
        val m = mutableMapOf<String, String>()
        runCatching {
            File("/proc/net/arp").bufferedReader().use { it.readLines() }.drop(1).forEach { line ->
                val p = line.trim().split(Regex("""\s+"""))
                if (p.size >= 4 && p[3].matches(Regex("""(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}""")) && p[3] != "00:00:00:00:00:00") m[p[0]] = p[3].uppercase()
            }
        }
        runCatching {
            Regex("""(?m)^((?:\d{1,3}\.){3}\d{1,3}).*?lladdr\s+(([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})""").findAll(runCmd("/system/bin/ip", "neigh", "show"))
                .forEach { m[it.groupValues[1]] = it.groupValues[2].uppercase() }
        }
        return m
    }

    /** Ubiquiti devices on the LAN (UDP 10001/10002): IP, MAC, model, firmware, name. */
    suspend fun ubntDiscovery(): ToolResult {
        val list = UbntDiscovery.discover(network)
        return ToolResult(
            rows = listOf("Apparati Ubiquiti" to list.size.toString()),
            items = list.map { d ->
                ToolItem(
                    title = "${d.ip ?: "IP sconosciuto"} · ${d.hostname ?: d.model ?: "—"}",
                    subtitle = listOfNotNull(d.fullModel ?: d.model, d.firmware, d.mac, d.ssid?.let { "SSID $it" }).joinToString(" · "),
                    trailing = d.uptimeSec?.let { it.formatUptime() }.orEmpty(),
                )
            },
            note = if (list.isEmpty()) "Nessuna risposta: verifica di essere sulla LAN giusta (la discovery non attraversa i router)." else "Discovery Ubiquiti (UDP 10001) e annunci (UDP 10002).",
        )
    }

    private fun Long.formatUptime(): String {
        val d = this / 86_400
        val h = (this % 86_400) / 3600
        return if (d > 0) "${d}g ${h}h" else "${h}h ${(this % 3600) / 60}m"
    }

    suspend fun neighbors(): ToolResult = io {
        val t = arpTable()
        ToolResult(
            rows = listOf("Voci" to t.size.toString()),
            items = t.entries.sortedBy { Ip.parse(it.key) ?: 0 }.map { ToolItem(it.key, it.value) },
            note = if (t.isEmpty()) "Android 10+ limita l'accesso alla tabella ARP: usa la scansione subnet." else null,
        )
    }

    suspend fun discover(cidrText: String, viaWifi: Boolean): ToolResult {
        val cidr = Ip.parseScanCidr(cidrText)
        val block: suspend () -> Pair<List<Pair<String, String>>, Map<String, String>> = {
            val ips = (cidr.first..cidr.last).map { Ip.format(it) }
            val sem = Semaphore(48)
            val alive = coroutineScope {
                ips.map { ip ->
                    async(Dispatchers.IO) {
                        sem.withPermit {
                            val ok = runCatching { InetAddress.getByName(ip).isReachable(350) }.getOrDefault(false) ||
                                listOf(80, 443, 22, 554).any { port -> runCatching { Socket().use { s -> s.connect(InetSocketAddress(ip, port), 250) } }.isSuccess }
                            if (ok) ip else null
                        }
                    }
                }.awaitAll().filterNotNull()
            }
            alive.map { ip -> ip to (runCatching { InetAddress.getByName(ip).canonicalHostName }.getOrNull()?.takeIf { it != ip }.orEmpty()) } to arpTable()
        }
        val (hosts, macs) = withContext(Dispatchers.IO) { if (viaWifi) network.onWifi(block) else block() }
        // Vendor lookup after leaving the Wi-Fi binding: the server is reached over mobile data if needed.
        val vendors = vendorsOf(hosts.mapNotNull { macs[it.first] })
        return ToolResult(
            rows = listOf("Rete" to cidr.toString(), "Host attivi" to hosts.size.toString(), "Con MAC" to hosts.count { macs[it.first] != null }.toString()),
            items = hosts.map { (ip, name) ->
                val mac = macs[ip]
                ToolItem(ip, listOf(name, mac.orEmpty(), mac?.let { vendors[it] }.orEmpty()).filter { it.isNotBlank() }.joinToString(" · "))
            },
        )
    }

    /** Vendor of each MAC (server lookup, best effort: skipped when offline). */
    private suspend fun vendorsOf(macs: List<String>): Map<String, String> {
        if (session.token == null) return emptyMap()
        return runCatching { api.macVendors(macs).filterValues { it != null }.mapValues { it.value!! } }.getOrDefault(emptyMap())
    }

    suspend fun portProbe(host: String, ports: List<Int>, viaWifi: Boolean): ToolResult {
        val block: suspend () -> ToolResult = {
            val ip = Ip.resolvePrivate(host)
            val open = coroutineScope {
                ports.distinct().map { port ->
                    async(Dispatchers.IO) { port.takeIf { runCatching { Socket().use { s -> s.connect(InetSocketAddress(ip, port), 700) } }.isSuccess } }
                }.awaitAll().filterNotNull()
            }
            ToolResult(rows = listOf("Host" to ip, "Porte aperte" to open.sorted().joinToString(", ").ifBlank { "nessuna" }, "Verificate" to ports.joinToString(", ")))
        }
        return withContext(Dispatchers.IO) { if (viaWifi) network.onWifi(block) else block() }
    }

    suspend fun snmp(host: String, community: String, viaWifi: Boolean): ToolResult {
        val oids = linkedMapOf(
            "sysName" to "1.3.6.1.2.1.1.5.0",
            "sysDescr" to "1.3.6.1.2.1.1.1.0",
            "sysUpTime" to "1.3.6.1.2.1.1.3.0",
            "sysContact" to "1.3.6.1.2.1.1.4.0",
            "sysLocation" to "1.3.6.1.2.1.1.6.0",
        )
        val block: suspend () -> ToolResult = {
            val ip = Ip.resolvePrivate(host)
            val v = try {
                Snmp.get(ip, community, oids.values.toList())
            } catch (e: SocketTimeoutException) {
                throw IOException("Nessuna risposta SNMP v2c: verifica IP, community, ACL e servizio SNMP")
            }
            ToolResult(rows = listOf("Host" to ip) + oids.map { (k, oid) -> k to (v[oid] ?: "—") })
        }
        return withContext(Dispatchers.IO) { if (viaWifi) network.onWifi(block) else block() }
    }

    suspend fun netbios(host: String, viaWifi: Boolean): ToolResult {
        val block: suspend () -> ToolResult = {
            val ip = Ip.resolvePrivate(host)
            val q = ByteArray(50).also { q ->
                q[0] = 0x43; q[1] = 0x44; q[5] = 1; q[12] = 32
                for (i in 0 until 16) {
                    val v = if (i == 0) 0x2a else 0x20
                    q[13 + i * 2] = (65 + ((v shr 4) and 15)).toByte()
                    q[14 + i * 2] = (65 + (v and 15)).toByte()
                }
                q[47] = 0x21; q[49] = 1
            }
            DatagramSocket().use { s ->
                s.soTimeout = 2000
                s.send(DatagramPacket(q, q.size, InetAddress.getByName(ip), 137))
                val buf = ByteArray(1024)
                val p = DatagramPacket(buf, buf.size)
                try {
                    s.receive(p)
                    val count = buf.getOrElse(56) { 0 }.toInt() and 0xff
                    val names = (0 until count).mapNotNull { i ->
                        val off = 57 + i * 18
                        if (off + 15 > p.length) null else String(buf, off, 15, Charsets.US_ASCII).trim().ifBlank { null }
                    }.distinct()
                    ToolResult(rows = listOf("Host" to ip, "Nomi NetBIOS" to names.joinToString(", ").ifBlank { "risposta senza nomi" }))
                } catch (_: SocketTimeoutException) {
                    ToolResult(rows = listOf("Host" to ip, "NetBIOS" to "nessuna risposta su UDP 137"))
                }
            }
        }
        return withContext(Dispatchers.IO) { if (viaWifi) network.onWifi(block) else block() }
    }

    /** ONVIF WS-Discovery and Hikvision SADP probes on the local segment. */
    suspend fun cameraDiscovery(hikvision: Boolean, viaWifi: Boolean): ToolResult {
        val block: suspend () -> ToolResult = {
            val lock = network.multicastLock()
            lock.acquire()
            try {
                val id = UUID.randomUUID().toString()
                val (payload, port) = if (hikvision) {
                    """<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${id.uppercase()}</Uuid><Types>inquiry</Types></Probe>""" to 37020
                } else {
                    ("""<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" """ +
                        """xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:$id</w:MessageID>""" +
                        """<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>""" +
                        """</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>""") to 3702
                }
                val bytes = payload.toByteArray(Charsets.UTF_8)
                val found = linkedMapOf<String, ToolItem>()
                DatagramSocket().use { s ->
                    s.broadcast = true
                    s.soTimeout = 700
                    s.send(DatagramPacket(bytes, bytes.size, InetAddress.getByName("239.255.255.250"), port))
                    if (hikvision) s.send(DatagramPacket(bytes, bytes.size, InetAddress.getByName("255.255.255.255"), port))
                    val end = System.currentTimeMillis() + 3500
                    val buf = ByteArray(16384)
                    while (System.currentTimeMillis() < end) {
                        try {
                            val p = DatagramPacket(buf, buf.size)
                            s.receive(p)
                            val ip = p.address.hostAddress ?: continue
                            if (ip in found) continue
                            val body = String(p.data, 0, p.length, Charsets.UTF_8)
                            fun tag(t: String) = Regex("<$t>([^<]*)</$t>", RegexOption.IGNORE_CASE).find(body)?.groupValues?.get(1).orEmpty()
                            found[ip] = if (hikvision) {
                                ToolItem(tag("DeviceDescription").ifBlank { ip }, listOf(ip, tag("MAC"), tag("DeviceSN"), tag("SoftwareVersion")).filter { it.isNotBlank() }.joinToString(" · "))
                            } else {
                                val xaddrs = Regex("""<[^>]*XAddrs[^>]*>([^<]+)""").find(body)?.groupValues?.get(1).orEmpty()
                                ToolItem(ip, xaddrs)
                            }
                        } catch (_: SocketTimeoutException) {
                        }
                    }
                }
                ToolResult(rows = listOf("Protocollo" to if (hikvision) "Hikvision SADP" else "ONVIF WS-Discovery", "Dispositivi" to found.size.toString()), items = found.values.toList())
            } finally {
                lock.release()
            }
        }
        return withContext(Dispatchers.IO) { if (viaWifi) network.onWifi(block) else block() }
    }

    /** Throughput against the CDA Net server (authenticated endpoints). */
    suspend fun speedTest(): ToolResult = io {
        val base = api.base()
        val http = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS).build()
        fun req(path: String) = Request.Builder().url(base + path).header("Cache-Control", "no-store").also { b -> session.token?.let { b.header("Authorization", "Bearer $it") } }
        val pings = (1..5).map {
            val t = System.nanoTime()
            http.newCall(req("/api/tools/speed/ping").build()).execute().use { r -> if (!r.isSuccessful) throw IOException("Speed test HTTP ${r.code}: accedi al server") }
            (System.nanoTime() - t) / 1e6
        }
        var t = System.nanoTime()
        val bytes = http.newCall(req("/api/tools/speed/download?bytes=${16 * 1024 * 1024}").build()).execute().use { r -> r.body?.bytes()?.size ?: 0 }
        val down = bytes * 8 / ((System.nanoTime() - t) / 1e9) / 1e6
        val payload = ByteArray(8 * 1024 * 1024)
        t = System.nanoTime()
        http.newCall(req("/api/tools/speed/upload").post(payload.toRequestBody("application/octet-stream".toMediaType())).build()).execute().close()
        val up = payload.size * 8 / ((System.nanoTime() - t) / 1e9) / 1e6
        val jitter = pings.zipWithNext { a, b -> kotlin.math.abs(b - a) }.average()
        ToolResult(
            rows = listOf(
                "Download" to "%.1f Mbps".format(down),
                "Upload" to "%.1f Mbps".format(up),
                "Ping" to "%.0f ms".format(pings.average()),
                "Jitter" to "%.0f ms".format(jitter),
                "Server" to base,
            ),
            note = "Misura tra questo telefono e il server CDA Net.",
        )
    }
}
