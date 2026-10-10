package it.cdanet.cpeconfigurator.tools.discovery

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Active fingerprints of a host (local tool, read-only, short timeouts): what its web server, SSH,
 * RTSP and SIP services say about the product. Nothing is ever sent beyond a plain request (no
 * credentials). The texts feed DeviceClassifier.
 */
object Fingerprint {
    /** "HTTP Server: …", "HTTP title: …", "TLS: CN …", "SSH: …", "RTSP: …", "SIP: …" */
    data class Result(val ip: String, val texts: List<String>)

    // ---- parsers (pure) ---------------------------------------------------------------------------
    /** Server header, WWW-Authenticate realm and HTML title of an HTTP response. */
    fun parseHttp(response: String): List<String> {
        val head = response.substringBefore("\r\n\r\n")
        val out = mutableListOf<String>()
        Regex("""(?im)^server:\s*(.+)$""").find(head)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotBlank() }?.let { out += "HTTP Server: ${it.take(80)}" }
        Regex("""(?im)^www-authenticate:.*realm="([^"]+)"""").find(head)?.groupValues?.get(1)?.let { out += "HTTP realm: ${it.take(80)}" }
        Regex("""(?im)^location:\s*(.+)$""").find(head)?.groupValues?.get(1)?.trim()?.let { loc ->
            // products often redirect to a telling path (/webfig/, /doc/page/login.asp, /cgi-bin/luci)
            if (loc.length < 120) out += "HTTP redirect: $loc"
        }
        Regex("""(?is)<title[^>]*>(.*?)</title>""").find(response)?.groupValues?.get(1)?.replace(Regex("""\s+"""), " ")?.trim()?.takeIf { it.isNotBlank() }?.let { out += "HTTP title: ${it.take(80)}" }
        return out
    }

    /** "SSH-2.0-ROSSSH" → "SSH: ROSSSH". */
    fun parseSshBanner(line: String): String? = line.trim().takeIf { it.startsWith("SSH-") }?.substringAfter('-')?.substringAfter('-')?.take(60)?.let { "SSH: $it" }

    /** Server or User-Agent of an RTSP/SIP answer. */
    fun parseAgent(response: String, proto: String): String? =
        Regex("""(?im)^(server|user-agent):\s*(.+)$""").find(response)?.groupValues?.get(2)?.trim()?.takeIf { it.isNotBlank() }?.let { "$proto: ${it.take(80)}" }

    fun sipOptions(ip: String, localIp: String): ByteArray {
        val tag = (100000..999999).random()
        return (
            "OPTIONS sip:$ip SIP/2.0\r\n" +
                "Via: SIP/2.0/UDP $localIp:5060;branch=z9hG4bK$tag\r\n" +
                "Max-Forwards: 70\r\nFrom: <sip:cdanet@$localIp>;tag=$tag\r\nTo: <sip:$ip>\r\n" +
                "Call-ID: $tag@$localIp\r\nCSeq: 1 OPTIONS\r\nContact: <sip:cdanet@$localIp>\r\nAccept: application/sdp\r\nContent-Length: 0\r\n\r\n"
            ).toByteArray()
    }

    // ---- probes (blocking: Dispatchers.IO, socket factory of the Wi-Fi network) ---------------------
    private val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    })

    /** First bytes of a plain GET / (HTTP) or over TLS (self-signed certificates of LAN devices accepted: read-only). */
    private fun http(newSocket: () -> Socket, ip: String, port: Int, tls: Boolean): List<String> = runCatching {
        val raw = newSocket().apply { soTimeout = 1500; connect(InetSocketAddress(ip, port), 800) }
        val s = if (!tls) raw else {
            val ctx = SSLContext.getInstance("TLS").apply { init(null, trustAll, SecureRandom()) }
            (ctx.socketFactory.createSocket(raw, ip, port, true) as SSLSocket).apply { startHandshake() }
        }
        s.use {
            val cert = (s as? SSLSocket)?.session?.peerCertificates?.firstOrNull() as? X509Certificate
            it.getOutputStream().write("GET / HTTP/1.0\r\nHost: $ip\r\nUser-Agent: CDA-Net-CPE\r\nConnection: close\r\n\r\n".toByteArray())
            val buf = ByteArray(16384)
            var n = 0
            val input = it.getInputStream()
            while (n < buf.size) {
                val r = runCatching { input.read(buf, n, buf.size - n) }.getOrDefault(-1)
                if (r <= 0) break
                n += r
            }
            parseHttp(String(buf, 0, n, Charsets.ISO_8859_1)) +
                listOfNotNull(cert?.subjectX500Principal?.name?.let { dn -> Regex("""(?:CN|O)=([^,]+)""").findAll(dn).joinToString(" ") { m -> m.groupValues[1] } }?.takeIf { it.isNotBlank() }?.let { "TLS: ${it.take(80)}" })
        }
    }.getOrDefault(emptyList())

    private fun banner(newSocket: () -> Socket, ip: String, port: Int, send: ByteArray?): String? = runCatching {
        newSocket().apply { soTimeout = 1500; connect(InetSocketAddress(ip, port), 800) }.use { s ->
            send?.let { s.getOutputStream().write(it) }
            val buf = ByteArray(2048)
            val n = s.getInputStream().read(buf)
            if (n > 0) String(buf, 0, n, Charsets.ISO_8859_1) else null
        }
    }.getOrNull()

    /** All fingerprints of one host, from its open TCP ports (and a SIP OPTIONS on UDP 5060). */
    fun probe(ip: String, ports: Set<Int>, localIp: String?, newSocket: () -> Socket, bindUdp: (DatagramSocket) -> Unit): Result {
        val texts = mutableListOf<String>()
        for (p in listOf(80, 8080, 8000, 20080).filter { it in ports }.take(1)) texts += http(newSocket, ip, p, false)
        for (p in listOf(443, 8443, 20443).filter { it in ports }.take(1)) texts += http(newSocket, ip, p, true)
        if (22 in ports) banner(newSocket, ip, 22, null)?.lineSequence()?.firstOrNull()?.let(::parseSshBanner)?.let { texts += it }
        if (554 in ports) banner(newSocket, ip, 554, "OPTIONS rtsp://$ip/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: CDA-Net-CPE\r\n\r\n".toByteArray())?.let { parseAgent(it, "RTSP") }?.let { texts += it }
        if (localIp != null) runCatching {
            DatagramSocket().use { s ->
                bindUdp(s)
                s.soTimeout = 700
                val msg = sipOptions(ip, localIp)
                s.send(DatagramPacket(msg, msg.size, InetAddress.getByName(ip), 5060))
                val buf = ByteArray(4096)
                val pkt = DatagramPacket(buf, buf.size)
                s.receive(pkt)
                parseAgent(String(buf, 0, pkt.length, Charsets.ISO_8859_1), "SIP")?.let { texts += it }
            }
        }
        return Result(ip, texts.distinct())
    }
}
