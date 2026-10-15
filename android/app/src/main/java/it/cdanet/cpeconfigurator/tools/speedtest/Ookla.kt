package it.cdanet.cpeconfigurator.tools.speedtest

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import javax.net.SocketFactory
import kotlin.math.abs

/** One speed test against an OoklaServer: Mbit/s each way, ping and jitter in ms. */
data class SpeedResult(val downMbps: Double, val upMbps: Double, val pingMs: Double, val jitterMs: Double, val server: String)

/** What the test is doing, for the gauge: phase, current Mbit/s (null while pinging), 0..1 of the phase. */
data class SpeedProgress(val phase: Phase, val mbps: Double?, val fraction: Float) {
    enum class Phase(val label: String) { Connect("Collegamento al server"), Ping("Ping"), Download("Download"), Upload("Upload") }
}

/** Pure parts of the Ookla TCP protocol and of the measure (tested). */
object OoklaMath {
    /** «HELLO 2.11 (2.11.0) 2024-…» → «2.11»; null when the answer is not an OoklaServer's. */
    fun helloVersion(line: String): String? = Regex("""^HELLO\s+(\S+)""").find(line.trim())?.groupValues?.get(1)

    /** Mbit/s of [bytes] in [nanos]. */
    fun mbps(bytes: Long, nanos: Long): Double = if (nanos <= 0) 0.0 else bytes * 8.0 / (nanos / 1e9) / 1e6

    /** Ping (lowest round trip, as speed tests show it) and jitter (mean change between consecutive ones), ms. */
    fun pingJitter(rttMs: List<Double>): Pair<Double, Double> {
        if (rttMs.isEmpty()) return 0.0 to 0.0
        val jitter = if (rttMs.size < 2) 0.0 else rttMs.zipWithNext { a, b -> abs(b - a) }.average()
        return rttMs.min() to jitter
    }

    /** The first part of each direction warms the TCP windows up: it is not counted. */
    fun warmupNanos(seconds: Int): Long = (seconds * 1_000_000_000L * 0.2).toLong().coerceIn(500_000_000L, 2_000_000_000L)

    /**
     * The next upload request: doubled while one takes less than [UPLOAD_ROUND_NANOS], so a request
     * keeps a stream busy a fraction of a second on any line (a 4 MB one takes 30 s at 1 Mbit/s).
     */
    fun nextUploadSize(size: Int, nanos: Long): Int = if (nanos < UPLOAD_ROUND_NANOS) minOf(size * 2, OoklaClient.CHUNK) else size

    const val UPLOAD_FIRST = 65_536
    const val UPLOAD_ROUND_NANOS = 250_000_000L

    /** «UPLOAD <size> 0\n» and the payload length that makes [size] bytes in all (newline included). */
    fun uploadHeader(size: Int): Pair<ByteArray, Int> {
        val head = "UPLOAD $size 0\n".toByteArray(Charsets.US_ASCII)
        return head to (size - head.size)
    }
}

/**
 * Speed test with the OoklaServer TCP protocol (HI, PING, DOWNLOAD, UPLOAD) on [streams]
 * connections, [seconds] each way. Every socket comes from [sockets]: the customer's Wi-Fi, never
 * mobile data.
 */
class OoklaClient(
    private val sockets: SocketFactory,
    private val host: String,
    private val port: Int,
    private val seconds: Int = 10,
    private val streams: Int = 4,
    private val timeoutMs: Int = 5000,
) {
    private fun open(): Socket {
        val s = sockets.createSocket()
        s.soTimeout = timeoutMs
        s.tcpNoDelay = true
        s.connect(InetSocketAddress(host, port), timeoutMs)
        return s
    }

    private fun readLine(input: InputStream): String {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) throw IOException("Il server di speedtest ha chiuso la connessione")
            if (b == '\n'.code) return sb.toString()
            if (sb.length < 512) sb.append(b.toChar())
        }
    }

    private fun hello(s: Socket): Pair<InputStream, OutputStream> {
        val input = BufferedInputStream(s.getInputStream(), 65536)
        val out = s.getOutputStream()
        out.write("HI\n".toByteArray(Charsets.US_ASCII))
        out.flush()
        OoklaMath.helloVersion(readLine(input)) ?: throw IOException("$host:$port non è un server di speedtest")
        return input to out
    }

    suspend fun run(onProgress: (SpeedProgress) -> Unit = {}): SpeedResult = withContext(Dispatchers.IO) {
        onProgress(SpeedProgress(SpeedProgress.Phase.Connect, null, 0f))
        // ping: ten round trips on one connection
        val rtts = open().use { s ->
            val (input, out) = hello(s)
            (1..10).map { i ->
                val t0 = System.nanoTime()
                out.write("PING ${System.currentTimeMillis()}\n".toByteArray(Charsets.US_ASCII))
                out.flush()
                val reply = readLine(input)
                if (!reply.startsWith("PONG")) throw IOException("Risposta inattesa al ping")
                onProgress(SpeedProgress(SpeedProgress.Phase.Ping, null, i / 10f))
                (System.nanoTime() - t0) / 1e6
            }
        }
        val (ping, jitter) = OoklaMath.pingJitter(rtts)
        val down = measure(SpeedProgress.Phase.Download, onProgress) { s, input, out, counted, stop -> download(input, out, counted, stop) }
        val up = measure(SpeedProgress.Phase.Upload, onProgress) { s, input, out, counted, stop -> upload(s, input, out, counted, stop) }
        SpeedResult(down, up, ping, jitter, "$host:$port")
    }

    /** [streams] connections for [seconds]; the Mbit/s of what moved after the warm-up. */
    private suspend fun measure(
        phase: SpeedProgress.Phase,
        onProgress: (SpeedProgress) -> Unit,
        work: (Socket, InputStream, OutputStream, AtomicLong, AtomicBoolean) -> Unit,
    ): Double = coroutineScope {
        val bytes = AtomicLong()
        val stop = AtomicBoolean(false)
        val start = System.nanoTime()
        val total = seconds * 1_000_000_000L
        val warm = OoklaMath.warmupNanos(seconds)
        val sockets = mutableListOf<Socket>()
        val jobs = (1..streams).map {
            async(Dispatchers.IO) {
                runCatching {
                    open().use { s ->
                        synchronized(sockets) { sockets += s }
                        val (input, out) = hello(s)
                        work(s, input, out, bytes, stop)
                    }
                }
            }
        }
        var at0 = 0L
        var bytes0 = 0L
        var last = 0L
        var lastBytes = 0L
        while (true) {
            Thread.sleep(200)
            val now = System.nanoTime() - start
            val b = bytes.get()
            if (at0 == 0L && now >= warm) { at0 = now; bytes0 = b }
            val live = if (now > last) OoklaMath.mbps(b - lastBytes, now - last) else 0.0
            last = now
            lastBytes = b
            onProgress(SpeedProgress(phase, live, (now.toFloat() / total).coerceAtMost(1f)))
            if (now >= total) break
        }
        val end = System.nanoTime() - start
        val result = OoklaMath.mbps(bytes.get() - bytes0, end - at0)
        stop.set(true)
        // a stream blocked on a long read ends now
        synchronized(sockets) { sockets.forEach { runCatching { it.close() } } }
        val outcomes = jobs.awaitAll()
        if (bytes.get() == 0L) throw outcomes.firstNotNullOfOrNull { it.exceptionOrNull() } ?: IOException("Nessun dato dal server di speedtest")
        result
    }

    private fun download(input: InputStream, out: OutputStream, counted: AtomicLong, stop: AtomicBoolean) {
        val buf = ByteArray(65536)
        while (!stop.get()) {
            out.write("DOWNLOAD $CHUNK\n".toByteArray(Charsets.US_ASCII))
            out.flush()
            var left = CHUNK.toLong()
            while (left > 0 && !stop.get()) {
                val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                if (n < 0) return
                left -= n
                counted.addAndGet(n.toLong())
            }
        }
    }

    /**
     * Only what the server confirmed counts («OK <size>»): a write ends as soon as the data is in the
     * phone's send buffer, which Android grows to megabytes, so counting writes measured the buffer
     * and then nothing (field report, 15/10/2026: upload 0,0 on a real line).
     */
    private fun upload(s: Socket, input: InputStream, out: OutputStream, counted: AtomicLong, stop: AtomicBoolean) {
        // the confirmation comes when the whole request has crossed the line, not within a read timeout
        s.soTimeout = (seconds + 10) * 1000
        val block = ByteArray(65536) { ('A' + it % 26).code.toByte() }
        var size = OoklaMath.UPLOAD_FIRST
        while (!stop.get()) {
            val t0 = System.nanoTime()
            val (head, payload) = OoklaMath.uploadHeader(size)
            out.write(head)
            var left = payload
            while (left > 0 && !stop.get()) {
                val n = minOf(block.size, left)
                // the last byte of the payload is the newline the server waits for
                if (left == n) block[n - 1] = '\n'.code.toByte()
                out.write(block, 0, n)
                left -= n
                if (left == 0) block[n - 1] = ('A' + (n - 1) % 26).code.toByte()
            }
            if (stop.get()) return
            out.flush()
            if (!readLine(input).startsWith("OK")) throw IOException("Risposta inattesa all'upload")
            counted.addAndGet(size.toLong())
            size = OoklaMath.nextUploadSize(size, System.nanoTime() - t0)
        }
    }

    companion object {
        /** Bytes per request: big enough to keep a fast line busy, small enough to end in time on a slow one. */
        const val CHUNK = 4_000_000
    }
}
