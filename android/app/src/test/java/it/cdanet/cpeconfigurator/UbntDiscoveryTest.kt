package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.UbntCrypt
import it.cdanet.cpeconfigurator.tools.UbntDiscovery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream

class UbntDiscoveryTest {
    private fun tlv(version: Int, cmd: Int, vararg items: Pair<Int, ByteArray>): ByteArray {
        val body = ByteArrayOutputStream()
        for ((t, v) in items) {
            body.write(t)
            body.write(v.size shr 8)
            body.write(v.size and 0xff)
            body.write(v)
        }
        val b = body.toByteArray()
        return byteArrayOf(version.toByte(), cmd.toByte(), (b.size shr 8).toByte(), (b.size and 0xff).toByte()) + b
    }

    private val mac = byteArrayOf(0x24, 0xA4.toByte(), 0x3C, 0x11, 0x22, 0x33)
    private fun ip(vararg b: Int) = b.map { it.toByte() }.toByteArray()

    @Test
    fun `airOS reply v1 with every field`() {
        val p = tlv(
            1, 0,
            0x02 to mac + ip(192, 168, 1, 20),
            0x01 to mac,
            0x03 to "WA.ipq40xx.v8.7.4.45112.210415.1103".toByteArray(),
            0x0A to byteArrayOf(0, 1, 0x51, 0x80.toByte()), // 86400 s
            0x0B to "ROSSI MARIO".toByteArray(),
            0x0C to "LBE-5AC-Gen2".toByteArray(),
            0x0D to "CDA-NET-N2-D01".toByteArray(),
            0x0E to byteArrayOf(2),
            0x0F to byteArrayOf(0, 1, 0x4E, 0x9B.toByte()), // https flag + 20123
            0x14 to "LiteBeam 5AC Gen2".toByteArray(),
            0x1C to byteArrayOf(0, 22),
        )
        val d = UbntDiscovery.parse(p, "192.168.1.20")!!
        assertEquals("192.168.1.20", d.ip)
        assertEquals("24:A4:3C:11:22:33", d.mac)
        assertEquals("ROSSI MARIO", d.hostname)
        assertEquals("LBE-5AC-Gen2", d.model)
        assertEquals("LiteBeam 5AC Gen2", d.fullModel)
        assertEquals("LiteBeam 5AC Gen2", d.product)
        assertEquals("8.7.4", d.version)
        assertEquals("45112", d.build)
        assertEquals("CDA-NET-N2-D01", d.ssid)
        assertEquals(86_400L, d.uptimeSec)
        assertEquals("station", d.wirelessMode)
        assertEquals(20123, d.webPort)
        assertTrue(d.webHttps)
        assertEquals("https://192.168.1.20:20123/", d.webUrl)
        assertEquals(22, d.sshPort)
        assertFalse(d.unifi)
        assertEquals("fe80::26a4:3cff:fe11:2233", d.rescueIpv6)
    }

    @Test
    fun `UniFi reply v2, factory default`() {
        val p = tlv(
            2, 6,
            0x02 to mac + ip(192, 168, 1, 30),
            0x15 to "U6-Lite".toByteArray(),
            0x16 to "6.5.28.14491".toByteArray(),
            0x17 to byteArrayOf(1),
        )
        val d = UbntDiscovery.parse(p, "192.168.1.30")!!
        assertTrue(d.unifi)
        assertEquals("U6-Lite", d.product)
        assertEquals("6.5.28.14491", d.version)
        assertEquals(true, d.factoryDefault)
    }

    @Test
    fun `announcement on 10002 and old v0 format`() {
        val announce = byteArrayOf(1, 6, 0, 0, 0, 0) + byteArrayOf(0x06) + mac + byteArrayOf(0x0B, 0, 3) + "CPE".toByteArray()
        val a = UbntDiscovery.parse(announce, "10.0.0.5")!!
        assertEquals("24:A4:3C:11:22:33", a.mac)
        assertEquals("CPE", a.hostname)
        assertEquals("10.0.0.5", a.ip)

        val fw = "XM.ar7240.v5.6.15.30572.180124.1415".toByteArray()
        val v0 = byteArrayOf(0) + mac + ip(10, 0, 0, 9) + byteArrayOf(0, 0, 0, fw.size.toByte()) + fw
        val o = UbntDiscovery.parse(v0)!!
        assertEquals("10.0.0.9", o.ip)
        assertEquals("5.6.15", o.version)
        assertEquals(0, o.protocol)
    }

    @Test
    fun `broken packets and queries are ignored`() {
        assertNull(UbntDiscovery.parse(byteArrayOf(1, 0, 0, 9, 0x0B, 0, 50)))
        assertNull(UbntDiscovery.parse(byteArrayOf(1, 0, 0, 0)))
        assertNull(UbntDiscovery.parse(byteArrayOf(7, 0, 0, 0)))
    }

    @Test
    fun `reboot packets and challenge`() {
        val ask = UbntDiscovery.packet(2, listOf(0x01 to mac, 0x06 to "ubnt".toByteArray()))
        assertEquals(listOf(1, 2, 0, 16), ask.take(4).map { it.toInt() and 0xff })
        val reply = tlv(1, 2, 0x07 to "\$1\$abcdefgh".toByteArray(), 0x08 to byteArrayOf(9, 8, 7))
        val (salt, ch) = UbntDiscovery.parseChallenge(reply)!!
        assertEquals("\$1\$abcdefgh", String(salt))
        assertEquals(3, ch.size)
        assertNull(UbntDiscovery.parseChallenge(tlv(1, 0, 0x0B to "x".toByteArray())))
    }

    @Test
    fun `crypt as openssl passwd`() {
        assertEquals("\$1\$saltsalt\$qjXMvbEw8oaL.CzflDtaK/", UbntCrypt.md5Crypt("password", "\$1\$saltsalt"))
        assertEquals("\$1\$abcdefgh\$ROT7K9UDBhyPhGZMITRAt1", UbntCrypt.md5Crypt("Cpe-Pass!9", "\$1\$abcdefgh\$whatever"))
        assertEquals(
            "\$6\$saltsaltsaltsalt\$bcXJ8qxwY5sQ4v8MTl.0B1jeZ0z0JlA9jjmbUoCJZ.1wYXiLTU.q2ILyrDJLm890lyfuF7sWAeli0yjOyFPkf0",
            UbntCrypt.sha512Crypt("password", "\$6\$saltsaltsaltsalt"),
        )
        assertEquals(
            "\$6\$Xy12\$24F5jPbU5ZYeLcA7cw39lLd47Yaintvczs3bf./mQrtehPE/yCYSNEmj.eX6GxYXCCCC2OSj76eQ29Ytaje0L.",
            UbntCrypt.sha512Crypt("Cpe-Pass!9", "\$6\$Xy12"),
        )
        assertNull(UbntCrypt.crypt("x", "ab"))
        assertEquals(32, UbntCrypt.challengeResponse("password", "\$1\$saltsalt".toByteArray(), byteArrayOf(1, 2))!!.size)
    }
}
