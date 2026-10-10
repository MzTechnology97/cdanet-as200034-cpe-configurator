package it.cdanet.cpeconfigurator.tools.pro

import android.net.Network
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.tools.UbntDevice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.io.File
import java.net.ConnectException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.coroutineContext

data class ScanHost(
    val ip: String,
    val latencyMs: Int?,
    val how: String,
    val hostname: String? = null,
    val netbios: String? = null,
    val mac: String? = null,
    val vendor: String? = null,
    val ports: List<Int> = emptyList(),
    val kind: String = "",
    val isGateway: Boolean = false,
    val isSelf: Boolean = false,
    val ubnt: UbntDevice? = null,
)

/**
 * LAN scanner for technicians: TCP probes on common ports (a refused connection also proves the
 * host is up), ICMP for silent hosts, reverse DNS, NetBIOS names/MACs, Ubiquiti discovery,
 * ARP when Android allows it, then vendors (IEEE) and a device guess.
 */
class IpScanner(private val wifi: Network?) {
    companion object {
        val PROBE_PORTS = listOf(80, 443, 22, 445, 139, 53, 554, 8291, 8080, 62078, 9100, 3389, 7547, 8000, 20443, 5000)
    }

    data class Progress(val done: Int, val total: Int, val found: Int, val phase: String)

    private fun socket() = wifi?.socketFactory?.createSocket() ?: java.net.Socket()

    suspend fun scan(
        cidr: Ip.Cidr,
        icmp: Boolean,
        ubnt: List<UbntDevice>,
        gateway: String?,
        self: Set<String>,
        /** DNS of the LAN (router) for reverse lookups; null = skip. */
        dnsServer: String?,
        onProgress: (Progress) -> Unit,
    ): List<ScanHost> = coroutineScope {
        val ips = (cidr.first..cidr.last).map { Ip.format(it) }
        val alive = ConcurrentHashMap<String, Pair<Int, String>>() // ip -> latency, method
        val ports = ConcurrentHashMap<String, MutableSet<Int>>()
        val done = AtomicInteger()

        // 1. TCP probes: open port or RST = host up.
        val hostSem = Semaphore(24)
        ips.map { ip ->
            async(Dispatchers.IO) {
                hostSem.withPermit {
                    coroutineContext.ensureActive()
                    val open = java.util.Collections.synchronizedSet(mutableSetOf<Int>())
                    var best: Int? = null
                    coroutineScope {
                        PROBE_PORTS.map { port ->
                            async(Dispatchers.IO) {
                                val t0 = System.nanoTime()
                                val s = socket()
                                try {
                                    s.connect(InetSocketAddress(ip, port), 350)
                                    open += port
                                    synchronized(open) { val ms = ((System.nanoTime() - t0) / 1e6).toInt(); best = minOf(best ?: ms, ms) }
                                } catch (_: ConnectException) {
                                    synchronized(open) { val ms = ((System.nanoTime() - t0) / 1e6).toInt(); best = minOf(best ?: ms, ms) }
                                } catch (_: Exception) {
                                } finally {
                                    runCatching { s.close() }
                                }
                            }
                        }.awaitAll()
                    }
                    best?.let { alive[ip] = it to "TCP" }
                    if (open.isNotEmpty()) ports[ip] = open
                    onProgress(Progress(done.incrementAndGet(), ips.size * if (icmp) 2 else 1, alive.size, "Sondaggio TCP"))
                }
            }
        }.awaitAll()

        // 2. ICMP for the hosts that did not answer on TCP.
        if (icmp) {
            val pingSem = Semaphore(16)
            ips.filter { !alive.containsKey(it) }.map { ip ->
                async(Dispatchers.IO) {
                    pingSem.withPermit {
                        coroutineContext.ensureActive()
                        ping(ip)?.let { alive[ip] = it to "ICMP" }
                        onProgress(Progress(done.incrementAndGet(), ips.size * 2, alive.size, "Ping ICMP"))
                    }
                }
            }.awaitAll()
        }
        ubnt.forEach { d -> d.ip?.let { if (it in ips && !alive.containsKey(it)) alive[it] = (alive[it]?.first ?: 0) to "Ubiquiti" } }
        self.filter { it in ips }.forEach { alive.putIfAbsent(it, 0 to "questo telefono") }

        // 3. Names: reverse DNS and NetBIOS (with MAC) in parallel.
        onProgress(Progress(done.get(), done.get(), alive.size, "Nomi e MAC"))
        val nameSem = Semaphore(24)
        val arp = arpTable()
        val ubntByIp = ubnt.filter { it.ip != null }.associateBy { it.ip!! }
        alive.keys.sortedBy { Ip.parse(it) }.map { ip ->
            async(Dispatchers.IO) {
                nameSem.withPermit {
                    val rdns = dnsServer?.let { ptr(ip, it) }
                    val nb = netbios(ip)
                    val u = ubntByIp[ip]
                    val (lat, how) = alive.getValue(ip)
                    ScanHost(
                        ip = ip,
                        latencyMs = lat.takeIf { how != "Ubiquiti" && how != "questo telefono" },
                        how = how,
                        hostname = rdns ?: u?.hostname,
                        netbios = nb?.names?.firstOrNull(),
                        mac = u?.mac ?: nb?.mac ?: arp[ip],
                        ports = ports[ip]?.sorted().orEmpty(),
                        isGateway = ip == gateway,
                        isSelf = ip in self,
                        ubnt = u,
                    )
                }
            }
        }.awaitAll()
    }

    /**
     * Wide sweep: which /24 of [range] (up to a /16) are in use, from their usual gateway addresses
     * (.1 and .254, also .253): a connection or a refusal on a common port proves the network exists.
     */
    suspend fun activeSubnets(range: Ip.Cidr, onProgress: (Progress) -> Unit): List<Ip.Cidr> = coroutineScope {
        val nets = Ip.slash24s(range)
        val done = AtomicInteger()
        val gate = Semaphore(64)
        val ports = listOf(80, 443, 22, 53, 8291)
        nets.map { net ->
            async(Dispatchers.IO) {
                gate.withPermit {
                    coroutineContext.ensureActive()
                    val up = listOf(1L, 254L, 253L).any { last ->
                        val ip = Ip.format(net.network + last)
                        ports.any { port ->
                            val s = socket()
                            try {
                                s.connect(InetSocketAddress(ip, port), 300)
                                true
                            } catch (_: ConnectException) {
                                true
                            } catch (_: Exception) {
                                false
                            } finally {
                                runCatching { s.close() }
                            }
                        }
                    }
                    onProgress(Progress(done.incrementAndGet(), nets.size, 0, "Ricerca delle subnet attive in $range"))
                    net.takeIf { up }
                }
            }
        }.awaitAll().filterNotNull()
    }

    /** Reverse name from the LAN DNS (the router knows its DHCP clients). */
    private fun ptr(ip: String, server: String): String? = runCatching {
        DatagramSocket().use { s ->
            wifi?.bindSocket(s)
            s.soTimeout = 800
            val q = DnsWire.query(kotlin.random.Random.nextInt(0, 65535), DnsWire.reverseName(ip), 12)
            s.send(DatagramPacket(q, q.size, InetAddress.getByName(server), 53))
            val buf = ByteArray(1500)
            val p = DatagramPacket(buf, buf.size)
            s.receive(p)
            DnsWire.parse(buf.copyOf(p.length)).answers.firstOrNull { it.type == "PTR" }?.data?.trimEnd('.')?.ifBlank { null }
        }
    }.getOrNull()

    private fun ping(ip: String): Int? = runCatching {
        val p = ProcessBuilder("/system/bin/ping", "-c", "1", "-W", "1", ip).redirectErrorStream(true).start()
        if (!p.waitFor(2500, TimeUnit.MILLISECONDS)) { p.destroyForcibly(); return null }
        val out = p.inputStream.bufferedReader().readText()
        Regex("""time[=<]\s*([0-9.]+)""").find(out)?.groupValues?.get(1)?.toDouble()?.toInt()
    }.getOrNull()

    private fun netbios(ip: String): NetBiosInfo? = runCatching {
        DatagramSocket().use { s ->
            wifi?.bindSocket(s)
            s.soTimeout = 700
            s.send(DatagramPacket(NetBios.QUERY, NetBios.QUERY.size, InetAddress.getByName(ip), 137))
            val buf = ByteArray(1024)
            val p = DatagramPacket(buf, buf.size)
            try {
                s.receive(p)
                NetBios.parse(buf, p.length)
            } catch (_: SocketTimeoutException) {
                null
            }
        }
    }.getOrNull()

    /** /proc/net/arp: readable up to Android 9 (later versions restrict it to system apps). */
    private fun arpTable(): Map<String, String> = runCatching {
        File("/proc/net/arp").readLines().drop(1).mapNotNull { line ->
            val p = line.trim().split(Regex("""\s+"""))
            if (p.size >= 4 && p[3] != "00:00:00:00:00:00" && p[3].count { it == ':' } == 5) p[0] to p[3].uppercase() else null
        }.toMap()
    }.getOrDefault(emptyMap())
}
