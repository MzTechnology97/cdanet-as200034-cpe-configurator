package it.cdanet.cpeconfigurator.tools.discovery

import it.cdanet.cpeconfigurator.network.Ip
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.net.URL
import java.util.UUID

/** A device found by a vendor discovery protocol. */
data class Found(
    val ip: String,
    val protocol: String,
    val vendor: String,
    val name: String? = null,
    val model: String? = null,
    val mac: String? = null,
    val firmware: String? = null,
    val details: Map<String, String> = emptyMap(),
)

/**
 * Multi-vendor LAN discovery (local tool): MikroTik MNDP, Dahua DHDiscover, ONVIF WS-Discovery,
 * UPnP/SSDP (with the device description: routers and ONTs of TP-Link, Tenda, Huawei, Netgear,
 * D-Link, AVM, ZTE…), mDNS/DNS-SD (printers, NAS, Chromecast, Apple, Sonos, Shelly…) and
 * Netgear NSDP. Ubiquiti and Hikvision SADP have their own classes. Parsers are pure (unit-tested).
 */
object VendorDiscovery {
    // ---- MikroTik MNDP (UDP 5678) -----------------------------------------------------------
    fun parseMndp(b: ByteArray, len: Int, src: String?): Found? {
        if (len < 8) return null
        fun u16(i: Int) = ((b[i].toInt() and 0xff) shl 8) or (b[i + 1].toInt() and 0xff)
        var off = 4
        val f = mutableMapOf<Int, ByteArray>()
        while (off + 4 <= len) {
            val t = u16(off)
            val l = u16(off + 2)
            if (off + 4 + l > len) break
            f[t] = b.copyOfRange(off + 4, off + 4 + l)
            off += 4 + l
        }
        fun str(t: Int) = f[t]?.let { String(it, Charsets.UTF_8).trim() }?.ifBlank { null }
        val mac = f[1]?.takeIf { it.size == 6 }?.joinToString(":") { "%02X".format(it) }
        val ip = f[17]?.takeIf { it.size == 4 }?.joinToString(".") { (it.toInt() and 0xff).toString() } ?: src ?: return null
        if (mac == null && str(5) == null) return null
        val uptime = f[10]?.takeIf { it.size == 4 }?.let { (it[0].toLong() and 0xff) or ((it[1].toLong() and 0xff) shl 8) or ((it[2].toLong() and 0xff) shl 16) or ((it[3].toLong() and 0xff) shl 24) }
        return Found(
            ip = ip,
            protocol = "MNDP",
            vendor = "MikroTik",
            name = str(5),
            model = str(12) ?: str(8),
            mac = mac,
            firmware = str(7),
            details = listOfNotNull(str(16)?.let { "Interfaccia" to it }, uptime?.let { "Uptime" to "${it / 86400}g ${(it % 86400) / 3600}h" }, str(11)?.let { "Software ID" to it }).toMap(),
        )
    }

    // ---- Dahua DHDiscover (UDP 37810) -------------------------------------------------------
    fun dahuaProbe(): ByteArray {
        val json = """{"method":"DHDiscover.search","params":{"mac":"","uni":1}}""" + "\n"
        val data = json.toByteArray(Charsets.UTF_8)
        fun le(n: Int) = byteArrayOf(n.toByte(), (n shr 8).toByte(), (n shr 16).toByte(), (n shr 24).toByte())
        return byteArrayOf(0x20, 0, 0, 0, 0x44, 0x48, 0x49, 0x50) + ByteArray(8) + le(data.size) + ByteArray(4) + le(data.size) + ByteArray(4) + data
    }

    private fun jsonField(s: String, key: String): String? =
        Regex("\"$key\"\\s*:\\s*(\"([^\"]*)\"|([0-9]+))").find(s)?.let { it.groupValues[2].ifBlank { it.groupValues[3] } }?.ifBlank { null }

    fun parseDahua(b: ByteArray, len: Int, src: String?): Found? {
        val s = String(b, 0, len, Charsets.UTF_8)
        val start = s.indexOf('{')
        if (start < 0 || !s.contains("deviceInfo") || s.contains("DHDiscover.search")) return null
        val body = s.substring(start)
        val ip = Regex("\"IPAddress\"\\s*:\\s*\"([0-9.]+)\"").find(body)?.groupValues?.get(1) ?: src ?: return null
        return Found(
            ip = ip,
            protocol = "Dahua",
            vendor = jsonField(body, "Vendor") ?: "Dahua",
            model = jsonField(body, "DeviceType"),
            mac = jsonField(body, "Mac")?.uppercase(),
            firmware = jsonField(body, "Version"),
            details = listOfNotNull(jsonField(body, "SerialNo")?.let { "Seriale" to it }, jsonField(body, "HttpPort")?.let { "HTTP" to it }).toMap(),
        )
    }

    // ---- ONVIF WS-Discovery (UDP 3702) ------------------------------------------------------
    fun onvifProbe(): ByteArray = (
        """<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" """ +
            """xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:${UUID.randomUUID()}</w:MessageID>""" +
            """<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>""" +
            """</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>"""
        ).toByteArray(Charsets.UTF_8)

    fun parseOnvif(xml: String, src: String?): Found? {
        if (!xml.contains("ProbeMatch")) return null
        val xaddrs = Regex("<[^>]*XAddrs[^>]*>([^<]+)").find(xml)?.groupValues?.get(1).orEmpty()
        val ip = Regex("https?://([0-9.]+)").find(xaddrs)?.groupValues?.get(1) ?: src ?: return null
        val scopes = Regex("<[^>]*Scopes[^>]*>([^<]+)").find(xml)?.groupValues?.get(1).orEmpty().split(Regex("\\s+"))
        fun scope(k: String) = scopes.firstOrNull { it.contains("/$k/", ignoreCase = true) }?.substringAfterLast('/')?.let { java.net.URLDecoder.decode(it, "UTF-8") }
        return Found(ip, "ONVIF", scope("manufacturer") ?: scope("mfr") ?: "ONVIF", name = scope("name"), model = scope("hardware"), details = mapOf("Servizio" to xaddrs.split(' ').first()))
    }

    // ---- UPnP / SSDP (UDP 1900) --------------------------------------------------------------
    private val SSDP_SEARCH = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n").toByteArray()

    /** SSDP answer headers (lower-case keys). */
    fun parseSsdp(text: String): Map<String, String>? {
        if (!text.startsWith("HTTP/1.1 200") && !text.startsWith("NOTIFY")) return null
        return text.split("\r\n").drop(1).mapNotNull { l -> l.indexOf(':').takeIf { it > 0 }?.let { l.substring(0, it).trim().lowercase() to l.substring(it + 1).trim() } }.toMap()
    }

    /** UPnP device description (friendlyName, manufacturer, modelName…). */
    fun parseUpnp(xml: String): Map<String, String> =
        listOf("friendlyName", "manufacturer", "modelName", "modelNumber", "serialNumber", "deviceType", "modelDescription")
            .mapNotNull { t -> Regex("<$t>([^<]*)</$t>").find(xml)?.groupValues?.get(1)?.trim()?.ifBlank { null }?.let { t to it } }.toMap()

    private fun fetch(url: String, timeoutMs: Int = 2000): String? = runCatching {
        val u = URL(url)
        if (Ip.parse(u.host) == null || !Ip.isPrivateLiteralOrLocalName(u.host)) return null
        (u.openConnection() as HttpURLConnection).run {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = false
            inputStream.use { it.readBytes() }.take(65536).toByteArray().toString(Charsets.UTF_8)
        }
    }.getOrNull()

    // ---- mDNS / DNS-SD (UDP 5353) -----------------------------------------------------------
    val MDNS_SERVICES = listOf(
        "_services._dns-sd._udp.local", "_http._tcp.local", "_ipp._tcp.local", "_ipps._tcp.local", "_printer._tcp.local", "_pdl-datastream._tcp.local",
        "_googlecast._tcp.local", "_airplay._tcp.local", "_raop._tcp.local", "_hap._tcp.local", "_smb._tcp.local", "_afpovertcp._tcp.local",
        "_device-info._tcp.local", "_workstation._tcp.local", "_ssh._tcp.local", "_rtsp._tcp.local", "_axis-video._tcp.local", "_sonos._tcp.local",
        "_spotify-connect._tcp.local", "_hue._tcp.local", "_shelly._tcp.local", "_esphomelib._tcp.local", "_androidtvremote2._tcp.local",
        "_amzn-wplay._tcp.local", "_qdiscover._tcp.local", "_scanner._tcp.local", "_uscan._tcp.local", "_mqtt._tcp.local",
    )

    fun mdnsQuery(names: List<String>): ByteArray {
        val out = ByteArrayOutputStream()
        fun u16(v: Int) { out.write((v shr 8) and 0xff); out.write(v and 0xff) }
        u16(0); u16(0); u16(names.size); u16(0); u16(0); u16(0)
        for (n in names) {
            for (label in n.split('.')) { out.write(label.length); out.write(label.toByteArray(Charsets.US_ASCII)) }
            out.write(0)
            u16(12) // PTR
            u16(1) // IN
        }
        return out.toByteArray()
    }

    /** Records of an mDNS answer (all sections): type, name, data (TXT as key=value list). */
    data class MdnsRecord(val type: Int, val name: String, val data: String)

    fun parseMdns(msg: ByteArray, len: Int): List<MdnsRecord> {
        if (len < 12) return emptyList()
        fun u8(i: Int) = msg[i].toInt() and 0xff
        fun u16(i: Int) = (u8(i) shl 8) or u8(i + 1)
        fun name(start: Int): Pair<String, Int> {
            val labels = mutableListOf<String>()
            var i = start
            var end = -1
            var jumps = 0
            while (i < len) {
                val l = u8(i)
                when {
                    l == 0 -> { if (end < 0) end = i + 1; break }
                    l and 0xc0 == 0xc0 -> { if (end < 0) end = i + 2; i = ((l and 0x3f) shl 8) or u8(i + 1); if (++jumps > 32) break }
                    else -> { labels += String(msg, i + 1, minOf(l, len - i - 1), Charsets.UTF_8); i += l + 1 }
                }
            }
            return labels.joinToString(".") to (if (end < 0) len else end)
        }
        val counts = u16(4) to (u16(6) + u16(8) + u16(10))
        var off = 12
        repeat(counts.first) { off = name(off).second + 4 }
        val out = mutableListOf<MdnsRecord>()
        repeat(counts.second) {
            if (off >= len) return out
            val (nm, p) = name(off)
            if (p + 10 > len) return out
            val type = u16(p)
            val rdLen = u16(p + 8)
            val rd = p + 10
            if (rd + rdLen > len) return out
            val data = when (type) {
                1 -> (0 until 4).joinToString(".") { u8(rd + it).toString() }
                12 -> name(rd).first
                33 -> "${u16(rd + 4)} ${name(rd + 6).first}"
                16 -> buildList {
                    var i = rd
                    while (i < rd + rdLen) { val l = u8(i); add(String(msg, i + 1, minOf(l, rd + rdLen - i - 1), Charsets.UTF_8)); i += l + 1 }
                }.joinToString("\u0001")
                else -> ""
            }
            out += MdnsRecord(type, nm, data)
            off = rd + rdLen
        }
        return out
    }

    private fun mdnsFound(src: String, recs: List<MdnsRecord>): Found? {
        val a = recs.firstOrNull { it.type == 1 }?.data ?: src
        val instances = recs.filter { it.type == 12 && !it.name.startsWith("_services") }.map { it.data }
        val txt = recs.filter { it.type == 16 }.flatMap { it.data.split('\u0001') }.mapNotNull { kv -> kv.indexOf('=').takeIf { it > 0 }?.let { kv.substring(0, it).lowercase() to kv.substring(it + 1) } }.toMap()
        val services = instances.map { it.substringAfter("._", "").let { s -> "_$s" }.substringBefore(".local").ifBlank { it } }.distinct()
        if (instances.isEmpty() && txt.isEmpty()) return null
        val name = instances.firstOrNull()?.substringBefore("._") ?: txt["fn"]
        val model = txt["md"] ?: txt["model"] ?: txt["ty"] ?: txt["usb_mdl"] ?: txt["product"]?.trim('(', ')')
        val vendor = txt["usb_mfg"] ?: txt["mfg"] ?: txt["vendor"] ?: when {
            services.any { it.startsWith("_googlecast") } -> "Google Cast"
            services.any { it.startsWith("_airplay") || it.startsWith("_raop") } -> "Apple / AirPlay"
            services.any { it.startsWith("_ipp") || it.startsWith("_printer") || it.startsWith("_pdl") } -> "Stampante"
            services.any { it.startsWith("_sonos") } -> "Sonos"
            services.any { it.startsWith("_shelly") } -> "Shelly"
            services.any { it.startsWith("_hue") } -> "Philips Hue"
            services.any { it.startsWith("_axis") } -> "Axis"
            services.any { it.startsWith("_qdiscover") } -> "QNAP"
            else -> "mDNS"
        }
        return Found(a, "mDNS", vendor, name = name, model = model, details = mapOf("Servizi" to services.joinToString(", ")))
    }

    // ---- Netgear NSDP (UDP 63322 → 63321) ---------------------------------------------------
    fun nsdpProbe(seq: Int = 1): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(1, 1, 0, 0, 0, 0, 0, 0))
        out.write(byteArrayOf(0x02, 0, 0, 0, 0, 1)) // host MAC (Android hides the real one)
        out.write(ByteArray(6)) // all devices
        out.write(byteArrayOf(0, 0, (seq shr 8).toByte(), seq.toByte()))
        out.write("NSDP".toByteArray())
        out.write(ByteArray(4))
        for (t in listOf(0x0001, 0x0003, 0x0004, 0x0006, 0x000d)) out.write(byteArrayOf((t shr 8).toByte(), t.toByte(), 0, 0))
        out.write(byteArrayOf(0xff.toByte(), 0xff.toByte(), 0, 0))
        return out.toByteArray()
    }

    fun parseNsdp(b: ByteArray, len: Int, src: String?): Found? {
        if (len < 32 || b[1].toInt() != 2 || String(b, 24, 4, Charsets.US_ASCII) != "NSDP") return null
        fun u16(i: Int) = ((b[i].toInt() and 0xff) shl 8) or (b[i + 1].toInt() and 0xff)
        val f = mutableMapOf<Int, ByteArray>()
        var off = 32
        while (off + 4 <= len) {
            val t = u16(off)
            val l = u16(off + 2)
            if (t == 0xffff || off + 4 + l > len) break
            f[t] = b.copyOfRange(off + 4, off + 4 + l)
            off += 4 + l
        }
        fun str(t: Int) = f[t]?.let { String(it, Charsets.UTF_8).trim('\u0000', ' ') }?.ifBlank { null }
        val ip = f[6]?.takeIf { it.size == 4 }?.joinToString(".") { (it.toInt() and 0xff).toString() } ?: src ?: return null
        return Found(ip, "NSDP", "Netgear", name = str(3), model = str(1), mac = f[4]?.takeIf { it.size == 6 }?.joinToString(":") { "%02X".format(it) }, firmware = str(0x0d))
    }

    // ---- Network I/O -------------------------------------------------------------------------
    private fun listen(socket: DatagramSocket, ms: Long, onPacket: (ByteArray, Int, String?) -> Unit) {
        socket.soTimeout = 300
        val end = System.currentTimeMillis() + ms
        val buf = ByteArray(65535)
        while (System.currentTimeMillis() < end) {
            try {
                val p = DatagramPacket(buf, buf.size)
                socket.receive(p)
                onPacket(buf, p.length, p.address.hostAddress)
            } catch (_: SocketTimeoutException) {
            }
        }
    }

    private fun boundSocket(port: Int?): DatagramSocket = runCatching {
        if (port == null) DatagramSocket() else DatagramSocket(null).apply { reuseAddress = true; bind(InetSocketAddress(port)) }
    }.getOrElse { DatagramSocket() }

    private fun send(s: DatagramSocket, data: ByteArray, host: String, port: Int) = runCatching { s.send(DatagramPacket(data, data.size, InetAddress.getByName(host), port)) }

    fun mndp(ms: Long): List<Found> = boundSocket(5678).use { s ->
        s.broadcast = true
        send(s, ByteArray(4), "255.255.255.255", 5678)
        val out = linkedMapOf<String, Found>()
        listen(s, ms) { b, l, src -> parseMndp(b, l, src)?.let { out[it.mac ?: it.ip] = it } }
        out.values.toList()
    }

    fun dahua(ms: Long): List<Found> = boundSocket(null).use { s ->
        s.broadcast = true
        val probe = dahuaProbe()
        send(s, probe, "239.255.255.251", 37810)
        send(s, probe, "255.255.255.255", 37810)
        val out = linkedMapOf<String, Found>()
        listen(s, ms) { b, l, src -> parseDahua(b, l, src)?.let { out[it.ip] = it } }
        out.values.toList()
    }

    fun onvif(ms: Long): List<Found> = boundSocket(null).use { s ->
        val probe = onvifProbe()
        send(s, probe, "239.255.255.250", 3702)
        val out = linkedMapOf<String, Found>()
        listen(s, ms) { b, l, src -> parseOnvif(String(b, 0, l, Charsets.UTF_8), src)?.let { out[it.ip] = it } }
        out.values.toList()
    }

    fun ssdp(ms: Long): List<Found> {
        val answers = linkedMapOf<String, Map<String, String>>()
        boundSocket(null).use { s ->
            send(s, SSDP_SEARCH, "239.255.255.250", 1900)
            Thread.sleep(300)
            send(s, SSDP_SEARCH, "239.255.255.250", 1900)
            listen(s, ms) { b, l, src -> if (src != null && src !in answers) parseSsdp(String(b, 0, l, Charsets.UTF_8))?.let { answers[src] = it } }
        }
        return answers.entries.take(48).map { (ip, h) ->
            val desc = h["location"]?.let { fetch(it) }?.let { parseUpnp(it) }.orEmpty()
            Found(
                ip = ip,
                protocol = "UPnP",
                vendor = desc["manufacturer"] ?: h["server"]?.substringBefore(' ') ?: "UPnP",
                name = desc["friendlyName"],
                model = listOfNotNull(desc["modelName"], desc["modelNumber"]).distinct().joinToString(" ").ifBlank { null },
                details = listOfNotNull(h["server"]?.let { "Server" to it }, desc["deviceType"]?.let { "Tipo" to it.substringAfter("device:").substringBefore(':') }, desc["serialNumber"]?.let { "Seriale" to it }).toMap(),
            )
        }
    }

    fun mdns(ms: Long): List<Found> {
        val byIp = linkedMapOf<String, MutableList<MdnsRecord>>()
        boundSocket(null).use { s ->
            // several small queries (one big packet can exceed what some responders accept)
            MDNS_SERVICES.chunked(7).forEach { send(s, mdnsQuery(it), "224.0.0.251", 5353) }
            listen(s, ms) { b, l, src -> if (src != null) byIp.getOrPut(src) { mutableListOf() } += parseMdns(b, l) }
        }
        return byIp.mapNotNull { (ip, recs) -> mdnsFound(ip, recs) }
    }

    fun nsdp(ms: Long): List<Found> = boundSocket(63321).use { s ->
        s.broadcast = true
        send(s, nsdpProbe(), "255.255.255.255", 63322)
        val out = linkedMapOf<String, Found>()
        listen(s, ms) { b, l, src -> parseNsdp(b, l, src)?.let { out[it.mac ?: it.ip] = it } }
        out.values.toList()
    }
}
