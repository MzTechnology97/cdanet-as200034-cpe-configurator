package it.cdanet.cpeconfigurator.tools

import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.network.NetworkHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException

/**
 * A Ubiquiti device answering the discovery. [model] is the platform (TLV 0x0C), [fullModel] the
 * product name it gives (0x15 / 0x14), [product] a readable name in any case.
 */
data class UbntDevice(
    val ip: String?,
    val mac: String?,
    val hostname: String?,
    val model: String?,
    val fullModel: String?,
    val firmware: String?,
    val ssid: String?,
    val uptimeSec: Long?,
    /** Every interface it reported: MAC and IP. */
    val addresses: List<Pair<String, String>> = emptyList(),
    val product: String? = null,
    val version: String? = null,
    val build: String? = null,
    /** station, ap, repeater… (airOS wireless mode) */
    val wirelessMode: String? = null,
    val webPort: Int? = null,
    val webHttps: Boolean = false,
    val sshPort: Int? = null,
    val serial: String? = null,
    /** Still with the factory configuration (UniFi and recent airOS say so). */
    val factoryDefault: Boolean? = null,
    val unifi: Boolean = false,
    val protocol: Int = 1,
    /** fe80:: address from the MAC: the device answers there even with a wrong IPv4. */
    val rescueIpv6: String? = null,
) {
    /** Address of its web interface (null without an IP). */
    val webUrl: String?
        get() {
            val host = ip ?: return null
            val https = webHttps || webPort == null
            val port = webPort?.takeIf { it > 0 } ?: if (https) 443 else 80
            val scheme = if (https) "https" else "http"
            val show = !((https && port == 443) || (!https && port == 80))
            return "$scheme://$host${if (show) ":$port" else ""}/"
        }
}

/**
 * Ubiquiti discovery, as the Ubiquiti Discovery Utility does it: queries v1 (`01 00 00 00`) and v2
 * (`02 08 00 00`, UniFi) on UDP 10001 to the broadcast and to the multicast group 233.89.188.1,
 * repeated every half second; replies are TLVs (type, 2-byte length, data). It also listens to the
 * announcements on UDP 10002 (`01 06 …`). The device reboot uses the protocol's challenge/response:
 * the password never travels. Protocol details from ubnt-discovery-next (MIT) and the original tool.
 */
object UbntDiscovery {
    private val QUERY = byteArrayOf(1, 0, 0, 0)
    private val QUERY_V2 = byteArrayOf(2, 8, 0, 0)
    private const val PORT = 10001
    private const val MULTICAST = "233.89.188.1"
    private val V2_REPLIES = setOf(6, 9, 11)
    private val WIRELESS_MODES = listOf("auto", "adhoc", "station", "ap", "repeater", "secondary", "monitor")

    /** Platform code → name for the devices that send only the code (M series and older). */
    private val PRODUCTS = listOf(
        "LM5" to "NanoStation Loco M5", "LM2" to "NanoStation Loco M2", "N5N" to "NanoStation M5", "N2N" to "NanoStation M2",
        "R5N" to "Rocket M5", "R2N" to "Rocket M2", "B5N" to "Bullet M5", "B2N" to "Bullet M2", "AG5" to "AirGrid M5",
        "NB5" to "NanoBridge M5", "PB5" to "PowerBridge M5", "p5N" to "PicoStation M5", "p2N" to "PicoStation M2",
        "LAP" to "AirRouter", "BZ2" to "UniFi AP", "RTR" to "EdgeRouter", "AF24" to "airFiber 24G",
    )

    private fun u8(d: ByteArray, i: Int) = d[i].toInt() and 0xff
    private fun macAt(d: ByteArray, i: Int) = (0 until 6).joinToString(":") { "%02X".format(u8(d, i + it)) }
    private fun ipAt(d: ByteArray, i: Int) = "${u8(d, i)}.${u8(d, i + 1)}.${u8(d, i + 2)}.${u8(d, i + 3)}"
    private fun uint(d: ByteArray, off: Int, len: Int): Long {
        var v = 0L
        for (k in 0 until len.coerceAtMost(8)) v = (v shl 8) or u8(d, off + k).toLong()
        return v
    }

    fun productName(code: String?): String? = code?.let { c -> PRODUCTS.firstOrNull { c.startsWith(it.first) }?.second ?: c }

    /** `XW.ar934x.v6.1.7.32555.180523.1754` → version 6.1.7 and build 32555; `WA.ipq40xx.v8.7.4.…` → 8.7.4. */
    fun parseFirmware(fw: String?): Pair<String?, String?> {
        val t = fw?.split('.')?.filter { it.isNotEmpty() } ?: return null to null
        if (t.size < 6) return null to null
        val n = t.size - 5
        return t.subList(2, 2 + n).joinToString(".").removePrefix("v") to t[2 + n]
    }

    /** fe80::/64 with the EUI-64 of the MAC. */
    fun linkLocal(mac: String?): String? {
        val b = mac?.split(':')?.mapNotNull { it.toIntOrNull(16) }?.takeIf { it.size == 6 } ?: return null
        val g = listOf((b[0] xor 0x02) shl 8 or b[1], b[2] shl 8 or 0xff, 0xfe shl 8 or b[3], b[4] shl 8 or b[5])
        return "fe80::" + g.joinToString(":") { Integer.toHexString(it) }
    }

    fun parse(data: ByteArray, sourceIp: String? = null): UbntDevice? {
        if (data.isEmpty()) return null
        return when (u8(data, 0)) {
            0 -> parseV0(data)
            1, 2 -> parseTlv(data, sourceIp)
            else -> null
        }
    }

    /** The oldest format: 00, MAC, IP, firmware length and text. */
    private fun parseV0(d: ByteArray): UbntDevice? {
        if (d.size < 15) return null
        val mac = macAt(d, 1)
        val ip = ipAt(d, 7)
        val len = uint(d, 11, 4).toInt()
        val fw = if (len > 0 && d.size >= 15 + len) String(d, 15, len, Charsets.ISO_8859_1).trim() else null
        val (version, build) = parseFirmware(fw)
        return UbntDevice(ip, mac, null, null, null, fw, null, null, addresses = listOf(mac to ip), product = fw, version = version, build = build, protocol = 0, rescueIpv6 = linkLocal(mac))
    }

    private class Raw {
        var mac: String? = null
        val addresses = mutableListOf<Pair<String, String>>()
        var ip: String? = null
        var fw: String? = null
        var hostname: String? = null
        var platform: String? = null
        var ssid: String? = null
        var wmode: Int = -1
        var uptime: Long? = null
        var modelShort: String? = null
        var model: String? = null
        var versionStr: String? = null
        var serial: String? = null
        var factory: Boolean? = null
        var webui: Long? = null
        var ssh: Int? = null
        var salt: ByteArray? = null
        var challenge: ByteArray? = null
    }

    /** TLVs of a v1/v2 packet; [announce]: the 10002 announcement, where type 0x06 is a bare MAC. */
    private fun readTlv(d: ByteArray, start: Int, end: Int, announce: Boolean): Raw? {
        val r = Raw()
        fun text(i: Int, n: Int) = String(d, i, n, Charsets.UTF_8).trim { it <= ' ' }.ifBlank { null }
        var off = start
        while (off < end) {
            val type = u8(d, off)
            off += 1
            if (announce && type == 0x06) {
                if (off + 6 > end) return null
                r.mac = r.mac ?: macAt(d, off)
                off += 6
                continue
            }
            if (off + 2 > end) return null
            val len = (u8(d, off) shl 8) or u8(d, off + 1)
            off += 2
            if (off + len > end) return null
            when (type) {
                0x01, 0x05 -> if (len == 6) r.mac = r.mac ?: macAt(d, off)
                0x02 -> when (len) {
                    10 -> r.addresses += macAt(d, off) to ipAt(d, off + 6)
                    4 -> r.ip = ipAt(d, off)
                }
                0x03 -> r.fw = text(off, len)
                0x04 -> if (len == 4) r.ip = ipAt(d, off)
                0x07 -> r.salt = d.copyOfRange(off, off + len)
                0x08 -> r.challenge = d.copyOfRange(off, off + len)
                0x0A -> r.uptime = uint(d, off, len)
                0x0B -> r.hostname = text(off, len)
                0x0C -> r.platform = text(off, len)
                0x0D -> r.ssid = text(off, len)
                0x0E -> r.wmode = uint(d, off, len).toInt()
                0x0F -> r.webui = uint(d, off, len)
                0x13 -> if (len == 6) r.serial = macAt(d, off).replace(":", "")
                0x14 -> r.modelShort = text(off, len)
                0x15 -> r.model = text(off, len)
                0x16 -> r.versionStr = text(off, len)
                0x17 -> r.factory = uint(d, off, len) == 1L
                0x1C -> r.ssh = uint(d, off, len).toInt()
            }
            off += len
        }
        return r
    }

    private fun parseTlv(d: ByteArray, sourceIp: String?): UbntDevice? {
        if (d.size < 4) return null
        val version = u8(d, 0)
        val cmd = u8(d, 1)
        val announce = version == 1 && cmd == 0x06
        val start = if (announce) 6 else 4
        val end = if (announce) d.size else (4 + ((u8(d, 2) shl 8) or u8(d, 3))).coerceAtMost(d.size)
        val discovery = announce || (if (version == 1) cmd == 0 else cmd in V2_REPLIES)
        if (!discovery) return null
        val r = readTlv(d, start, end, announce) ?: return null
        val mac = r.mac ?: r.addresses.firstOrNull()?.first
        val ip = r.addresses.firstOrNull { it.second == sourceIp }?.second ?: r.addresses.firstOrNull()?.second ?: r.ip ?: sourceIp
        if (mac == null && ip == null) return null
        val (fwVersion, build) = parseFirmware(r.fw)
        val code = r.model ?: r.modelShort ?: r.platform
        val unifi = version == 2 || r.factory != null || r.versionStr != null || code?.startsWith("U") == true || r.fw?.startsWith("BZ") == true
        val webPort = r.webui?.let { (it and 0xffff).toInt() }
        // the MAC of the interface that answered gives the rescue address of that link
        val answeringMac = r.addresses.firstOrNull { it.second == sourceIp }?.first ?: mac
        return UbntDevice(
            ip = ip,
            mac = mac,
            hostname = r.hostname,
            model = r.platform,
            fullModel = r.model ?: r.modelShort,
            firmware = r.fw,
            ssid = r.ssid,
            uptimeSec = r.uptime,
            addresses = r.addresses,
            product = if (unifi) code else r.model ?: r.modelShort ?: productName(r.platform) ?: productName(r.fw?.substringBefore('.')),
            version = if (unifi) r.versionStr ?: fwVersion else fwVersion,
            build = build,
            wirelessMode = WIRELESS_MODES.getOrNull(r.wmode),
            webPort = webPort,
            webHttps = r.webui?.let { it > 0xffff || webPort == 443 } ?: false,
            sshPort = r.ssh,
            serial = r.serial,
            factoryDefault = r.factory,
            unifi = unifi,
            protocol = version,
            rescueIpv6 = linkLocal(answeringMac),
        )
    }

    /** Merges two replies of the same device (v1 and v2, query and announcement). */
    private fun merge(o: UbntDevice, n: UbntDevice) = o.copy(
        ip = o.ip ?: n.ip, hostname = o.hostname ?: n.hostname, model = o.model ?: n.model, fullModel = o.fullModel ?: n.fullModel,
        firmware = o.firmware ?: n.firmware, ssid = o.ssid ?: n.ssid, uptimeSec = n.uptimeSec ?: o.uptimeSec,
        addresses = o.addresses.ifEmpty { n.addresses }, product = o.product ?: n.product, version = o.version ?: n.version, build = o.build ?: n.build,
        wirelessMode = o.wirelessMode ?: n.wirelessMode, webPort = o.webPort ?: n.webPort, webHttps = o.webHttps || n.webHttps,
        sshPort = o.sshPort ?: n.sshPort, serial = o.serial ?: n.serial, factoryDefault = o.factoryDefault ?: n.factoryDefault,
        unifi = o.unifi || n.unifi, rescueIpv6 = o.rescueIpv6 ?: n.rescueIpv6,
    )

    private fun sortByIp(list: Collection<UbntDevice>) = list.sortedBy { d -> d.ip?.let { Ip.parse(it) } ?: Long.MAX_VALUE }

    /**
     * Queries every half second for [timeoutMs] and listens to the announcements, over the Wi-Fi
     * network. [onFound]: the list so far, at each new or completed device.
     */
    suspend fun discover(network: NetworkHelper, timeoutMs: Int = 3_000, onFound: ((List<UbntDevice>) -> Unit)? = null): List<UbntDevice> = withContext(Dispatchers.IO) {
        val wifi = network.localNetwork() ?: throw IllegalStateException("Collegati alla Wi-Fi della LAN da scansionare o con il cavo (adattatore USB-C Ethernet)")
        val lock = network.multicastLock().apply { acquire() }
        try {
            val found = linkedMapOf<String, UbntDevice>()
            fun add(d: UbntDevice?) {
                if (d == null) return
                val k = d.mac ?: d.ip ?: return
                val before = found[k]
                val next = before?.let { merge(it, d) } ?: d
                if (next != before) {
                    found[k] = next
                    onFound?.invoke(sortByIp(found.values))
                }
            }
            val end = System.currentTimeMillis() + timeoutMs
            fun listen(socket: DatagramSocket) {
                val buf = ByteArray(1500)
                while (System.currentTimeMillis() < end) {
                    socket.soTimeout = (end - System.currentTimeMillis()).coerceAtLeast(1).toInt()
                    val p = DatagramPacket(buf, buf.size)
                    try {
                        socket.receive(p)
                    } catch (_: SocketTimeoutException) {
                        break
                    }
                    val src = p.address?.hostAddress?.takeIf { Ip.isPrivate(it) }
                    synchronized(found) { add(parse(buf.copyOf(p.length), src)) }
                }
            }
            coroutineScope {
                val active = async {
                    DatagramSocket(null).use { s ->
                        s.reuseAddress = true
                        s.broadcast = true
                        s.bind(InetSocketAddress(0))
                        wifi.bindSocket(s)
                        val targets = buildList {
                            add("255.255.255.255")
                            network.localLink()?.cidr?.let { c -> add(Ip.format(Ip.parseCidr(c).broadcast)) }
                            add(MULTICAST)
                        }.distinct().mapNotNull { runCatching { InetAddress.getByName(it) }.getOrNull() }
                        // like the original tool: a query every 500 ms for the whole scan
                        val sender = launch {
                            while (isActive && System.currentTimeMillis() < end) {
                                for (t in targets) for (q in listOf(QUERY, QUERY_V2)) runCatching { s.send(DatagramPacket(q, q.size, t, PORT)) }
                                delay(500)
                            }
                        }
                        listen(s)
                        sender.cancel()
                    }
                }
                val passive = async {
                    runCatching {
                        DatagramSocket(null).use { s ->
                            s.reuseAddress = true
                            s.broadcast = true
                            s.bind(InetSocketAddress(10002))
                            wifi.bindSocket(s)
                            listen(s)
                        }
                    }
                }
                active.await()
                passive.await()
            }
            sortByIp(found.values)
        } finally {
            lock.release()
        }
    }

    /** `01 <cmd> <len> TLVs…` */
    fun packet(cmd: Int, items: List<Pair<Int, ByteArray>>): ByteArray {
        val body = ByteArrayOutputStream()
        for ((type, v) in items) {
            body.write(type)
            body.write(v.size shr 8)
            body.write(v.size and 0xff)
            body.write(v)
        }
        val b = body.toByteArray()
        return byteArrayOf(1, cmd.toByte(), (b.size shr 8).toByte(), (b.size and 0xff).toByte()) + b
    }

    /** The salt and the challenge of a reply to the reboot request (cmd 2), else null. */
    fun parseChallenge(d: ByteArray): Pair<ByteArray, ByteArray>? {
        if (d.size < 4 || u8(d, 0) != 1 || u8(d, 1) != 2) return null
        val r = readTlv(d, 4, (4 + ((u8(d, 2) shl 8) or u8(d, 3))).coerceAtMost(d.size), false) ?: return null
        return (r.salt ?: return null) to (r.challenge ?: return null)
    }

    class RebootException(message: String) : Exception(message)

    /**
     * Reboots the device with the protocol's challenge/response (as the original tool): it asks for
     * a challenge, then answers with SHA-256(crypt(password, salt) || challenge). The device checks
     * the answer; nothing says whether it accepted it, except that it disappears and comes back.
     */
    suspend fun reboot(network: NetworkHelper, mac: String, username: String, password: String) = withContext(Dispatchers.IO) {
        val wifi = network.localNetwork() ?: throw RebootException("Collegati alla Wi-Fi della LAN dell'apparato o con il cavo (adattatore USB-C Ethernet)")
        val macBytes = mac.split(':').map { it.toInt(16).toByte() }.toByteArray()
        val user = username.toByteArray(Charsets.ISO_8859_1)
        DatagramSocket(null).use { s ->
            s.reuseAddress = true
            s.broadcast = true
            s.bind(InetSocketAddress(0))
            wifi.bindSocket(s)
            val bcast = InetAddress.getByName("255.255.255.255")
            // once: a device that hears the request twice issues a new challenge each time
            val ask = packet(2, listOf(0x01 to macBytes, 0x06 to user))
            s.send(DatagramPacket(ask, ask.size, bcast, PORT))
            val buf = ByteArray(1500)
            val end = System.currentTimeMillis() + 5_000
            var challenge: Pair<ByteArray, ByteArray>? = null
            while (challenge == null && System.currentTimeMillis() < end) {
                s.soTimeout = (end - System.currentTimeMillis()).coerceAtLeast(1).toInt()
                val p = DatagramPacket(buf, buf.size)
                try {
                    s.receive(p)
                } catch (_: SocketTimeoutException) {
                    break
                }
                challenge = parseChallenge(buf.copyOf(p.length))
            }
            val (salt, ch) = challenge ?: throw RebootException("L'apparato non ha risposto alla richiesta di riavvio")
            val answer = UbntCrypt.challengeResponse(password, salt, ch) ?: throw RebootException("Apparato troppo vecchio: riavvio da discovery non supportato")
            val go = packet(1, listOf(0x01 to macBytes, 0x06 to user, 0x09 to answer))
            s.send(DatagramPacket(go, go.size, bcast, PORT))
        }
    }
}
