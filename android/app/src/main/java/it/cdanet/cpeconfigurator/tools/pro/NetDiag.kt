package it.cdanet.cpeconfigurator.tools.pro

import android.net.Network
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext
import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.random.Random

data class PingStats(val sent: Int, val received: Int, val min: Double?, val avg: Double?, val max: Double?, val jitter: Double?, val stdev: Double?) {
    val lossPct: Int get() = if (sent == 0) 0 else (100 * (sent - received) / sent)
}

/** Ping statistics, path MTU, DNS on any server, HTTP(S) check, Wake-on-LAN. */
object NetDiag {
    private val TIME = Regex("""time[=<]\s*([0-9.]+)\s*ms""", RegexOption.IGNORE_CASE)

    private fun ping(ip: String, size: Int? = null, dontFragment: Boolean = false, timeoutSec: Int = 1): Pair<Double?, String> {
        val args = mutableListOf("/system/bin/ping", "-c", "1", "-W", "$timeoutSec")
        if (size != null) args += listOf("-s", "$size")
        if (dontFragment) args += listOf("-M", "do")
        args += ip
        val p = ProcessBuilder(args).redirectErrorStream(true).start()
        if (!p.waitFor((timeoutSec + 2) * 1000L, TimeUnit.MILLISECONDS)) { p.destroyForcibly(); return null to "timeout" }
        val out = p.inputStream.bufferedReader().readText()
        return TIME.find(out)?.groupValues?.get(1)?.toDoubleOrNull() to out
    }

    fun stats(samples: List<Double?>): PingStats {
        val ok = samples.filterNotNull()
        val avg = ok.takeIf { it.isNotEmpty() }?.average()
        return PingStats(
            sent = samples.size,
            received = ok.size,
            min = ok.minOrNull(),
            avg = avg,
            max = ok.maxOrNull(),
            jitter = ok.zipWithNext { a, b -> abs(b - a) }.takeIf { it.isNotEmpty() }?.average(),
            stdev = avg?.let { a -> sqrt(ok.sumOf { (it - a) * (it - a) } / ok.size) },
        )
    }

    /** Continuous ping: [onSample] gets each RTT (null = lost) as it arrives. */
    suspend fun pingSeries(host: String, count: Int, size: Int, intervalMs: Long, onSample: (Int, Double?) -> Unit): PingStats = withContext(Dispatchers.IO) {
        val ip = InetAddress.getByName(host.trim()).hostAddress ?: throw IllegalArgumentException("Host non valido")
        val samples = mutableListOf<Double?>()
        for (i in 1..count) {
            coroutineContext.ensureActive()
            val (rtt, _) = ping(ip, size.takeIf { it != 56 })
            samples += rtt
            onSample(i, rtt)
            if (i < count) delay(intervalMs)
        }
        stats(samples)
    }

    /**
     * Largest unfragmented packet towards [host] (binary search with the DF bit).
     * Typical: 1500 on Ethernet, 1492 behind PPPoE, less in tunnels.
     */
    suspend fun pathMtu(host: String): String = withContext(Dispatchers.IO) {
        val ip = InetAddress.getByName(host.trim()).hostAddress ?: throw IllegalArgumentException("Host non valido")
        val (base, probeOut) = ping(ip, 64, dontFragment = true, timeoutSec = 2)
        if (probeOut.contains("invalid", true) || probeOut.contains("usage", true)) return@withContext "Il ping di questo telefono non supporta il bit DF (-M do)"
        if (base == null) return@withContext "Host non raggiungibile in ping: impossibile misurare la MTU"
        var lo = 548 // payload; +28 = 576
        var hi = 1472 // payload; +28 = 1500
        if (ping(ip, hi, dontFragment = true, timeoutSec = 2).first != null) return@withContext "MTU di percorso ≥ 1500 byte (nessuna riduzione)"
        while (hi - lo > 1) {
            coroutineContext.ensureActive()
            val mid = (lo + hi) / 2
            if (ping(ip, mid, dontFragment = true, timeoutSec = 2).first != null) lo = mid else hi = mid
        }
        val mtu = lo + 28
        "MTU di percorso $mtu byte (payload ICMP $lo)" + when (mtu) {
            1492 -> " · tipico di PPPoE"
            in 1400..1491 -> " · tunnel o PPPoE con overhead: valuta MSS clamping"
            else -> ""
        }
    }

    suspend fun dns(server: String, name: String, type: String, wifi: Network?): Pair<DnsAnswer, Long> = withContext(Dispatchers.IO) {
        val t = DnsWire.TYPES[type] ?: throw IllegalArgumentException("Tipo non supportato")
        val qname = if (type == "PTR" && Regex("""^\d{1,3}(\.\d{1,3}){3}$""").matches(name.trim())) DnsWire.reverseName(name.trim()) else name.trim()
        val q = DnsWire.query(Random.nextInt(0, 65535), qname, t)
        DatagramSocket().use { s ->
            wifi?.bindSocket(s)
            s.soTimeout = 2500
            val t0 = System.nanoTime()
            s.send(DatagramPacket(q, q.size, InetAddress.getByName(server.trim()), 53))
            val buf = ByteArray(4096)
            val p = DatagramPacket(buf, buf.size)
            s.receive(p)
            DnsWire.parse(buf.copyOf(p.length)) to (System.nanoTime() - t0) / 1_000_000
        }
    }

    data class HttpCheck(val chain: List<String>, val status: Int, val ms: Long, val server: String?, val tls: String?, val error: String? = null)

    /** Redirect chain, status, timing and certificate (validated as a browser would). */
    suspend fun http(url: String): HttpCheck = withContext(Dispatchers.IO) {
        val target = if (url.startsWith("http")) url.trim() else "https://${url.trim()}"
        val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).connectTimeout(6, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build()
        val chain = mutableListOf<String>()
        var current = target
        val t0 = System.nanoTime()
        repeat(6) {
            try {
                client.newCall(Request.Builder().url(current).header("User-Agent", "CDA-Net-CPE").build()).execute().use { r ->
                    chain += "${r.code} $current"
                    val loc = r.header("Location")
                    if (r.isRedirect && loc != null) {
                        current = r.request.url.resolve(loc)?.toString() ?: return@withContext HttpCheck(chain, r.code, 0, r.header("Server"), null)
                    } else {
                        val cert = r.handshake?.peerCertificates?.firstOrNull() as? X509Certificate
                        val tls = cert?.let {
                            val cn = Regex("CN=([^,]+)").find(it.subjectX500Principal.name)?.groupValues?.get(1)
                            val issuer = Regex("(?:CN|O)=([^,]+)").find(it.issuerX500Principal.name)?.groupValues?.get(1)
                            "${r.handshake?.tlsVersion?.javaName} · CN $cn · $issuer · scade ${SimpleDateFormat("dd/MM/yyyy", Locale.ITALY).format(it.notAfter)}"
                        }
                        return@withContext HttpCheck(chain, r.code, (System.nanoTime() - t0) / 1_000_000, r.header("Server"), tls)
                    }
                }
            } catch (e: Exception) {
                return@withContext HttpCheck(chain, 0, (System.nanoTime() - t0) / 1_000_000, null, null, e.message ?: e.toString())
            }
        }
        HttpCheck(chain, 0, (System.nanoTime() - t0) / 1_000_000, null, null, "Troppi redirect")
    }

    /** Magic packet: FF×6 + MAC×16 to the broadcast address (UDP 9). */
    fun magicPacket(mac: String): ByteArray {
        val hex = mac.filter { it.isLetterOrDigit() }
        require(hex.length == 12) { "MAC non valido" }
        val m = ByteArray(6) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        return ByteArray(6) { 0xff.toByte() } + (1..16).flatMap { m.toList() }.toByteArray()
    }

    suspend fun wakeOnLan(mac: String, broadcast: String, wifi: Network?) = withContext(Dispatchers.IO) {
        val p = magicPacket(mac)
        DatagramSocket().use { s ->
            wifi?.bindSocket(s)
            s.broadcast = true
            repeat(3) {
                s.send(DatagramPacket(p, p.size, InetAddress.getByName(broadcast), 9))
                s.send(DatagramPacket(p, p.size, InetAddress.getByName(broadcast), 7))
            }
        }
    }
}
