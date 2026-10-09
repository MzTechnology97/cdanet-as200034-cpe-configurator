package it.cdanet.cpeconfigurator.tools.pro

import android.annotation.SuppressLint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Locale
import javax.net.SocketFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import kotlin.coroutines.coroutineContext

enum class PortState { Open, Closed, Filtered }

data class PortResult(
    val port: Int,
    val state: PortState,
    val service: String,
    val latencyMs: Int?,
    val banner: String? = null,
    val tls: String? = null,
)

/**
 * TCP connect scanner: open / closed (RST) / filtered (no answer), with optional banner grabbing
 * (SSH/FTP/SMTP greeting, HTTP status and Server header) and TLS certificate details.
 * Certificates are only *read*: nothing is trusted or sent.
 */
@SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
class PortScanner(private val sockets: SocketFactory = SocketFactory.getDefault()) {
    private val HTTP = setOf(80, 81, 591, 3000, 5000, 7547, 8000, 8001, 8008, 8080, 8081, 8088, 8888, 9000, 20080)
    private val readOnly = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
    private val tlsFactory by lazy { SSLContext.getInstance("TLS").apply { init(null, arrayOf(readOnly), SecureRandom()) }.socketFactory }

    suspend fun scan(
        host: String,
        ports: List<Int>,
        timeoutMs: Int = 600,
        concurrency: Int = 128,
        grab: Boolean = true,
        onProgress: (done: Int, total: Int, open: List<PortResult>) -> Unit = { _, _, _ -> },
    ): List<PortResult> = coroutineScope {
        val sem = Semaphore(concurrency.coerceIn(1, 512))
        val open = java.util.concurrent.CopyOnWriteArrayList<PortResult>()
        val done = java.util.concurrent.atomic.AtomicInteger()
        ports.map { port ->
            async(Dispatchers.IO) {
                sem.withPermit {
                    coroutineContext.ensureActive()
                    val r = probe(host, port, timeoutMs, grab)
                    if (r.state == PortState.Open) open += r
                    onProgress(done.incrementAndGet(), ports.size, open.sortedBy { it.port })
                    r
                }
            }
        }.awaitAll().sortedBy { it.port }
    }

    fun probe(host: String, port: Int, timeoutMs: Int, grab: Boolean): PortResult {
        val t0 = System.nanoTime()
        val s = sockets.createSocket()
        try {
            s.connect(InetSocketAddress(host, port), timeoutMs)
            val ms = ((System.nanoTime() - t0) / 1_000_000).toInt()
            val (banner, tls) = if (grab) grabInfo(s, host, port) else null to null
            return PortResult(port, PortState.Open, Ports.service(port), ms, banner, tls)
        } catch (_: ConnectException) {
            return PortResult(port, PortState.Closed, Ports.service(port), ((System.nanoTime() - t0) / 1_000_000).toInt())
        } catch (_: SocketTimeoutException) {
            return PortResult(port, PortState.Filtered, Ports.service(port), null)
        } catch (_: NoRouteToHostException) {
            return PortResult(port, PortState.Filtered, Ports.service(port), null)
        } catch (e: Exception) {
            // EHOSTUNREACH and friends surface as generic SocketException on Android.
            return PortResult(port, if (e.message?.contains("refused", true) == true) PortState.Closed else PortState.Filtered, Ports.service(port), null)
        } finally {
            runCatching { s.close() }
        }
    }

    private fun grabInfo(plain: Socket, host: String, port: Int): Pair<String?, String?> = runCatching {
        plain.soTimeout = 1200
        if (port in Ports.TLS) {
            val ssl = tlsFactory.createSocket(plain, host, port, false) as SSLSocket
            ssl.soTimeout = 1500
            ssl.startHandshake()
            val cert = ssl.session.peerCertificates.firstOrNull() as? X509Certificate
            val tls = cert?.let {
                val cn = Regex("CN=([^,]+)").find(it.subjectX500Principal.name)?.groupValues?.get(1) ?: it.subjectX500Principal.name
                val issuer = Regex("CN=([^,]+)").find(it.issuerX500Principal.name)?.groupValues?.get(1) ?: it.issuerX500Principal.name
                val exp = SimpleDateFormat("dd/MM/yyyy", Locale.ITALY).format(it.notAfter)
                val self = it.subjectX500Principal == it.issuerX500Principal
                "${ssl.session.protocol} · CN $cn · emesso da ${if (self) "sé stesso (autofirmato)" else issuer} · scade $exp"
            }
            val banner = if (port in setOf(443, 4433, 5001, 8443, 20443)) httpHead(ssl, host) else null
            return@runCatching banner to tls
        }
        if (port in HTTP) return@runCatching httpHead(plain, host) to null
        // Services that greet first (SSH, FTP, SMTP, POP3, IMAP, telnet, MikroTik API…)
        val buf = ByteArray(256)
        val n = plain.getInputStream().read(buf)
        (if (n > 0) String(buf, 0, n, Charsets.ISO_8859_1).lineSequence().first().filter { it >= ' ' }.trim().take(120).ifBlank { null } else null) to null
    }.getOrDefault(null to null)

    private fun httpHead(s: Socket, host: String): String? {
        s.getOutputStream().write("HEAD / HTTP/1.0\r\nHost: $host\r\nUser-Agent: CDA-Net-CPE\r\nConnection: close\r\n\r\n".toByteArray())
        val text = s.getInputStream().readNBytesCompat(2048)
        val lines = text.lineSequence().toList()
        val status = lines.firstOrNull()?.trim().orEmpty()
        val server = lines.firstOrNull { it.startsWith("Server:", true) }?.substringAfter(':')?.trim()
        val location = lines.firstOrNull { it.startsWith("Location:", true) }?.substringAfter(':')?.trim()
        return listOfNotNull(status.takeIf { it.startsWith("HTTP") }, server?.let { "Server: $it" }, location?.let { "→ $it" }).joinToString(" · ").ifBlank { null }
    }

    private fun java.io.InputStream.readNBytesCompat(max: Int): String {
        val buf = ByteArray(max)
        var total = 0
        while (total < max) {
            val n = runCatching { read(buf, total, max - total) }.getOrDefault(-1)
            if (n <= 0) break
            total += n
            if (String(buf, 0, total, Charsets.ISO_8859_1).contains("\r\n\r\n")) break
        }
        return String(buf, 0, total, Charsets.ISO_8859_1)
    }
}
