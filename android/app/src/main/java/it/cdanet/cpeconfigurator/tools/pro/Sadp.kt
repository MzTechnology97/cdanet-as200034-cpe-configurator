package it.cdanet.cpeconfigurator.tools.pro

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.UUID

/** A Hikvision device answering SADP (cameras, NVR/DVR, encoders). */
data class SadpDevice(
    val ip: String,
    val model: String,
    val description: String,
    val serial: String,
    val mac: String,
    val firmware: String,
    val subnetMask: String,
    val gateway: String,
    val dhcp: Boolean?,
    val httpPort: Int?,
    val sdkPort: Int?,
    /** false = brand new device: it needs to be activated (admin password) before use. */
    val activated: Boolean?,
    val analogChannels: Int?,
    val digitalChannels: Int?,
    val bootTime: String,
    /** Hik-Connect (cloud) enabled. */
    val hikConnect: Boolean?,
)

/**
 * Hikvision SADP discovery: an XML "inquiry" probe on UDP 37020 (multicast 239.255.255.250 and
 * broadcast); devices answer with a ProbeMatch, often in multicast, so we also listen on the group.
 */
object Sadp {
    const val PORT = 37020
    const val GROUP = "239.255.255.250"

    fun probe(uuid: String = UUID.randomUUID().toString().uppercase()): String =
        """<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>$uuid</Uuid><Types>inquiry</Types></Probe>"""

    private fun tag(xml: String, name: String): String =
        Regex("<$name>([^<]*)</$name>", RegexOption.IGNORE_CASE).find(xml)?.groupValues?.get(1)?.trim().orEmpty()

    private fun bool(v: String): Boolean? = when (v.lowercase()) {
        "true", "1", "yes", "activated" -> true
        "false", "0", "no", "inactive", "unactivated" -> false
        else -> null
    }

    /** Parses a SADP answer; null for anything else (including our own probe echoed by the group). */
    fun parse(xml: String, sourceIp: String? = null): SadpDevice? {
        if (!xml.contains("ProbeMatch", ignoreCase = true)) return null
        val ip = tag(xml, "IPv4Address").ifBlank { sourceIp.orEmpty() }
        if (ip.isBlank()) return null
        return SadpDevice(
            ip = ip,
            model = tag(xml, "DeviceType").ifBlank { tag(xml, "DeviceDescription") },
            description = tag(xml, "DeviceDescription"),
            serial = tag(xml, "DeviceSN"),
            mac = tag(xml, "MAC").uppercase().replace('-', ':'),
            firmware = listOf(tag(xml, "SoftwareVersion"), tag(xml, "DSPVersion")).filter { it.isNotBlank() }.joinToString(" · "),
            subnetMask = tag(xml, "IPv4SubnetMask"),
            gateway = tag(xml, "IPv4Gateway"),
            dhcp = bool(tag(xml, "DHCP")),
            httpPort = tag(xml, "HttpPort").toIntOrNull(),
            sdkPort = tag(xml, "CommandPort").toIntOrNull(),
            activated = bool(tag(xml, "Activated")),
            analogChannels = tag(xml, "AnalogChannelNum").toIntOrNull(),
            digitalChannels = tag(xml, "DigitalChannelNum").toIntOrNull(),
            bootTime = tag(xml, "BootTime"),
            hikConnect = bool(tag(xml, "HCPlatformEnable")),
        )
    }

    /**
     * Sends the probe twice (UDP may be lost) and collects answers for [listenMs], both unicast and
     * multicast. [localIp] is the phone's Wi-Fi address (to join the group on that interface).
     */
    fun discover(localIp: String?, listenMs: Long = 4000): List<SadpDevice> {
        val found = linkedMapOf<String, SadpDevice>()
        val payload = probe().toByteArray(Charsets.UTF_8)
        val group = InetAddress.getByName(GROUP)
        // Listening on 37020 joined to the group catches multicast answers; if the port is taken we
        // still get the unicast ones on an ephemeral port.
        val socket: DatagramSocket = runCatching {
            MulticastSocket(null as InetSocketAddress?).apply {
                reuseAddress = true
                bind(InetSocketAddress(PORT))
                val nif = localIp?.let { runCatching { NetworkInterface.getByInetAddress(InetAddress.getByName(it)) }.getOrNull() }
                joinGroup(InetSocketAddress(group, PORT), nif) // null = the default multicast interface
                timeToLive = 2
            }
        }.getOrElse { DatagramSocket() }
        socket.use { s ->
            s.broadcast = true
            s.soTimeout = 400
            val end = System.currentTimeMillis() + listenMs
            var sends = 0
            var nextSend = 0L
            val buf = ByteArray(16384)
            while (System.currentTimeMillis() < end) {
                if (sends < 2 && System.currentTimeMillis() >= nextSend) {
                    runCatching { s.send(DatagramPacket(payload, payload.size, group, PORT)) }
                    runCatching { s.send(DatagramPacket(payload, payload.size, InetAddress.getByName("255.255.255.255"), PORT)) }
                    sends++
                    nextSend = System.currentTimeMillis() + 1200
                }
                try {
                    val p = DatagramPacket(buf, buf.size)
                    s.receive(p)
                    val d = parse(String(p.data, 0, p.length, Charsets.UTF_8), p.address.hostAddress) ?: continue
                    found[d.mac.ifBlank { d.ip }] = d
                } catch (_: SocketTimeoutException) {
                }
            }
        }
        return found.values.sortedWith(compareBy({ it.activated != false }, { it.ip }))
    }
}
