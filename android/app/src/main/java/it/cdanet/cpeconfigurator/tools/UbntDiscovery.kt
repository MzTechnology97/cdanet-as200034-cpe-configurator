package it.cdanet.cpeconfigurator.tools

import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.network.NetworkHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException

data class UbntDevice(
    val ip: String?,
    val mac: String?,
    val hostname: String?,
    val model: String?,
    val fullModel: String?,
    val firmware: String?,
    val ssid: String?,
    val uptimeSec: Long?,
)

/**
 * Ubiquiti discovery: active request on UDP 10001 (reply `01 00 len`) and passive
 * announcements on UDP 10002 (`01 06 …`), both made of TLVs with 2-byte lengths
 * (except type 0x06 in announcements: a bare 6-byte MAC). Finds CPEs whose IP is unknown.
 */
object UbntDiscovery {
    private val REQUEST = byteArrayOf(1, 0, 0, 0)

    fun parse(data: ByteArray, sourceIp: String? = null): UbntDevice? {
        if (data.size < 4 || data[0].toInt() != 1) return null
        val announce = data[1].toInt() == 0x06
        var off = if (announce) 6 else 4
        var mac: String? = null
        var ip: String? = null
        var hostname: String? = null
        var model: String? = null
        var full: String? = null
        var fw: String? = null
        var ssid: String? = null
        var uptime: Long? = null
        fun u8(i: Int) = data[i].toInt() and 0xff
        fun macAt(i: Int) = (0 until 6).joinToString(":") { "%02X".format(u8(i + it)) }
        fun text(i: Int, n: Int) = String(data, i, n, Charsets.UTF_8).trim { it <= ' ' }.ifBlank { null }
        while (off < data.size) {
            val type = u8(off)
            off += 1
            if (announce && type == 0x06) {
                if (off + 6 > data.size) break
                mac = mac ?: macAt(off)
                off += 6
                continue
            }
            if (off + 2 > data.size) break
            val len = (u8(off) shl 8) or u8(off + 1)
            off += 2
            if (off + len > data.size) break
            when (type) {
                0x01 -> if (len == 6) mac = mac ?: macAt(off)
                0x02 -> if (len == 10) {
                    mac = mac ?: macAt(off)
                    ip = ip ?: "${u8(off + 6)}.${u8(off + 7)}.${u8(off + 8)}.${u8(off + 9)}"
                }
                0x03 -> fw = text(off, len)
                0x0A -> if (len == 4) uptime = ((u8(off).toLong() shl 24) or (u8(off + 1).toLong() shl 16) or (u8(off + 2).toLong() shl 8) or u8(off + 3).toLong())
                0x0B -> hostname = text(off, len)
                0x0C -> model = text(off, len)
                0x0D -> ssid = text(off, len)
                0x14 -> full = text(off, len)
            }
            off += len
        }
        if (mac == null && ip == null) return null
        return UbntDevice(ip ?: sourceIp, mac, hostname, model, full, fw, ssid, uptime)
    }

    /** Broadcast request + listen to announcements for [timeoutMs], over the Wi-Fi network. */
    suspend fun discover(network: NetworkHelper, timeoutMs: Int = 3_000): List<UbntDevice> = withContext(Dispatchers.IO) {
        val wifi = network.wifiNetwork() ?: throw IllegalStateException("Collegati alla Wi-Fi della LAN da scansionare")
        val lock = network.multicastLock().apply { acquire() }
        try {
            val found = linkedMapOf<String, UbntDevice>()
            fun add(d: UbntDevice?) {
                if (d == null) return
                val k = d.mac ?: d.ip ?: return
                found[k] = found[k]?.let { o -> o.copy(ip = o.ip ?: d.ip, hostname = o.hostname ?: d.hostname, model = o.model ?: d.model, fullModel = o.fullModel ?: d.fullModel, firmware = o.firmware ?: d.firmware, ssid = o.ssid ?: d.ssid) } ?: d
            }
            fun listen(socket: DatagramSocket) {
                val buf = ByteArray(1500)
                val end = System.currentTimeMillis() + timeoutMs
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
                            network.wifiLink()?.cidr?.let { c -> add(Ip.format(Ip.parseCidr(c).broadcast)) }
                        }.distinct()
                        repeat(2) {
                            targets.forEach { t -> runCatching { s.send(DatagramPacket(REQUEST, REQUEST.size, InetAddress.getByName(t), 10001)) } }
                        }
                        listen(s)
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
            found.values.sortedBy { d -> d.ip?.let { Ip.parse(it) } ?: Long.MAX_VALUE }
        } finally {
            lock.release()
        }
    }
}
