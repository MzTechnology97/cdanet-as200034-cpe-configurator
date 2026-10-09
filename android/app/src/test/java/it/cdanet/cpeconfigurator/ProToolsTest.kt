package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.pro.DeviceGuess
import it.cdanet.cpeconfigurator.tools.pro.DnsWire
import it.cdanet.cpeconfigurator.tools.pro.NetBios
import it.cdanet.cpeconfigurator.tools.pro.NetDiag
import it.cdanet.cpeconfigurator.tools.pro.Ports
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ProToolsTest {
    @Test
    fun portSpecs() {
        assertEquals(listOf(22, 80, 81, 82, 8291), Ports.parse("80-82, 22;8291 80"))
        assertEquals(1024, Ports.parse("Prime 1024").size)
        assertThrows(IllegalArgumentException::class.java) { Ports.parse("90-80") }
        assertThrows(IllegalArgumentException::class.java) { Ports.parse("70000") }
        assertThrows(IllegalArgumentException::class.java) { Ports.parse("1-65535", max = 1000) }
        assertEquals("winbox", Ports.service(8291))
    }

    @Test
    fun deviceGuess() {
        assertEquals("Ubiquiti (CPE CDA Net)", DeviceGuess.guess("Ubiquiti Inc", setOf(22, 20443)))
        assertEquals("MikroTik", DeviceGuess.guess(null, setOf(8291)))
        assertEquals("Telecamera / NVR", DeviceGuess.guess("Hangzhou Hikvision Digital Technology", setOf(80, 554)))
        assertEquals("Stampante", DeviceGuess.guess(null, setOf(9100)))
        assertEquals("PC / server Windows", DeviceGuess.guess(null, setOf(135, 445)))
        assertEquals("Router / gateway", DeviceGuess.guess("TP-LINK", setOf(80), isGateway = true))
        assertEquals("Ubiquiti LBE-5AC-Gen2", DeviceGuess.guess(null, emptySet(), ubntModel = "LBE-5AC-Gen2"))
    }

    @Test
    fun dnsWireRoundTrip() {
        val q = DnsWire.query(0x1234, "cda-net.it", 1)
        assertEquals(0x12, q[0].toInt() and 0xff)
        // Response: header + question + 1 A answer (compressed name) + 1 MX answer
        val resp = byteArrayOf(
            0x12, 0x34, 0x81.toByte(), 0x80.toByte(), 0, 1, 0, 2, 0, 0, 0, 0,
            7, 'c'.code.toByte(), 'd'.code.toByte(), 'a'.code.toByte(), '-'.code.toByte(), 'n'.code.toByte(), 'e'.code.toByte(), 't'.code.toByte(),
            2, 'i'.code.toByte(), 't'.code.toByte(), 0, 0, 1, 0, 1,
            0xc0.toByte(), 12, 0, 1, 0, 1, 0, 0, 0x0e, 0x10, 0, 4, 93.toByte(), 41, 10, 20,
            0xc0.toByte(), 12, 0, 15, 0, 1, 0, 0, 0, 60, 0, 6, 0, 10, 2, 'm'.code.toByte(), 'x'.code.toByte(), 0xc0.toByte(), 12,
        )
        val a = DnsWire.parse(resp)
        assertEquals("NOERROR", a.rcodeText)
        assertEquals("A", a.answers[0].type)
        assertEquals("93.41.10.20", a.answers[0].data)
        assertEquals(3600L, a.answers[0].ttl)
        assertEquals("10 mx.cda-net.it", a.answers[1].data)
        assertEquals("20.10.41.93.in-addr.arpa", DnsWire.reverseName("93.41.10.20"))
    }

    @Test
    fun netbiosAndWol() {
        val buf = ByteArray(57 + 18 + 6)
        buf[56] = 1
        "DESKTOP-ABC".toByteArray().copyInto(buf, 57)
        byteArrayOf(0x00, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E).copyInto(buf, 57 + 18)
        val nb = NetBios.parse(buf, buf.size)!!
        assertEquals(listOf("DESKTOP-ABC"), nb.names)
        assertEquals("00:1A:2B:3C:4D:5E", nb.mac)
        assertNull(NetBios.parse(ByteArray(10), 10))

        val p = NetDiag.magicPacket("00:11:22:33:44:55")
        assertEquals(102, p.size)
        assertTrue(p.take(6).all { it == 0xff.toByte() })
        assertEquals(0x55, p[101].toInt() and 0xff)
    }

    @Test
    fun pingStats() {
        val s = NetDiag.stats(listOf(10.0, 12.0, null, 14.0))
        assertEquals(4, s.sent)
        assertEquals(3, s.received)
        assertEquals(25, s.lossPct)
        assertEquals(12.0, s.avg!!, 0.001)
        assertEquals(2.0, s.jitter!!, 0.001)
    }
}
