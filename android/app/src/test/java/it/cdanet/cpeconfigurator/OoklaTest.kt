package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.speedtest.OoklaClient
import it.cdanet.cpeconfigurator.tools.speedtest.OoklaMath
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedInputStream
import java.net.ServerSocket
import java.net.Socket
import javax.net.SocketFactory
import kotlin.concurrent.thread

class OoklaTest {
    @Test
    fun math() {
        assertEquals("2.11", OoklaMath.helloVersion("HELLO 2.11 (2.11.0) 2024-03-01.1234.abc"))
        assertNull(OoklaMath.helloVersion("HTTP/1.1 400 Bad Request"))
        assertEquals(80.0, OoklaMath.mbps(10_000_000, 1_000_000_000), 0.001)
        val (ping, jitter) = OoklaMath.pingJitter(listOf(12.0, 10.0, 14.0))
        assertEquals(10.0, ping, 0.0)
        assertEquals(3.0, jitter, 0.001)
        val (head, payload) = OoklaMath.uploadHeader(1000)
        assertEquals(1000, head.size + payload)
    }

    /** A tiny OoklaServer: HI, PING, DOWNLOAD and UPLOAD as the real one answers them. */
    private fun fakeServer(): ServerSocket {
        val ss = ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            while (!ss.isClosed) {
                val s = runCatching { ss.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { serve(s) }
            }
        }
        return ss
    }

    private fun serve(s: Socket) = runCatching {
        s.use {
            val input = BufferedInputStream(s.getInputStream())
            val out = s.getOutputStream()
            fun line(): String? {
                val sb = StringBuilder()
                while (true) {
                    val b = input.read()
                    if (b < 0) return null
                    if (b == '\n'.code) return sb.toString()
                    sb.append(b.toChar())
                }
            }
            while (true) {
                val cmd = line() ?: return@use
                when {
                    cmd == "HI" -> out.write("HELLO 2.11 (2.11.0) test\n".toByteArray())
                    cmd.startsWith("PING") -> out.write("PONG ${System.currentTimeMillis()}\n".toByteArray())
                    cmd.startsWith("DOWNLOAD") -> {
                        val size = cmd.split(' ')[1].toInt()
                        val body = ByteArray(size) { 'x'.code.toByte() }
                        "DOWNLOAD ".toByteArray().copyInto(body)
                        body[size - 1] = '\n'.code.toByte()
                        out.write(body)
                    }
                    cmd.startsWith("UPLOAD") -> {
                        val size = cmd.split(' ')[1].toInt()
                        var left = size - (cmd.length + 1)
                        val buf = ByteArray(65536)
                        while (left > 0) { val n = input.read(buf, 0, minOf(buf.size, left)); if (n < 0) return@use; left -= n }
                        out.write("OK $size 1\n".toByteArray())
                    }
                }
                out.flush()
            }
        }
    }

    @Test
    fun aFullTestAgainstAnOoklaServer() = runBlocking {
        val ss = fakeServer()
        val r = OoklaClient(SocketFactory.getDefault(), "127.0.0.1", ss.localPort, seconds = 2, streams = 2).run()
        ss.close()
        assertTrue("download ${r.downMbps}", r.downMbps > 1)
        assertTrue("upload ${r.upMbps}", r.upMbps > 1)
        assertTrue(r.pingMs >= 0)
        assertEquals("127.0.0.1:${ss.localPort}", r.server)
    }
}
