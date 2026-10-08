package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.ChannelAdvisor
import it.cdanet.cpeconfigurator.tools.SeenNetwork
import it.cdanet.cpeconfigurator.tools.UbntDiscovery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NetworkToolsTest {
    @Test
    fun parsesRealAirOsAnnouncement() {
        val bytes = javaClass.getResource("/airos/airos_sta_discovery_packet.bin")!!.readBytes()
        val d = UbntDiscovery.parse(bytes, sourceIp = "192.168.1.99")!!
        assertEquals("01:23:45:67:89:CD", d.mac)
        assertEquals("192.168.1.3", d.ip) // from the MAC+IP TLV, not the UDP source
        assertEquals("WA.V8.7.17", d.firmware)
        assertEquals("name", d.hostname)
        assertEquals("NanoStation 5AC loco", d.model)
        assertEquals("DemoSSID", d.ssid)
        assertEquals(265_375L, d.uptimeSec) // 0x00040C9F
    }

    @Test
    fun parsesActiveDiscoveryReply() {
        fun tlv(type: Int, value: ByteArray) = byteArrayOf(type.toByte(), (value.size shr 8).toByte(), value.size.toByte()) + value
        val mac = byteArrayOf(0x24, 0xA4.toByte(), 0x3C, 0x11, 0x22, 0x33)
        val body = tlv(0x02, mac + byteArrayOf(192.toByte(), 168.toByte(), 1, 20)) + tlv(0x0B, "ROSSI MARIO".toByteArray()) + tlv(0x0C, "LBE-5AC-Gen2".toByteArray()) + tlv(0x03, "XC.qca956x.v8.7.4".toByteArray())
        val packet = byteArrayOf(1, 0, (body.size shr 8).toByte(), body.size.toByte()) + body
        val d = UbntDiscovery.parse(packet)!!
        assertEquals("192.168.1.20", d.ip)
        assertEquals("24:A4:3C:11:22:33", d.mac)
        assertEquals("ROSSI MARIO", d.hostname)
        assertEquals("LBE-5AC-Gen2", d.model)
        assertNull(UbntDiscovery.parse(byteArrayOf(1, 0, 0, 0)))
        assertNull(UbntDiscovery.parse(byteArrayOf(2, 0, 0, 0, 1)))
        // truncated TLV must not throw
        assertNull(UbntDiscovery.parse(byteArrayOf(1, 0, 0, 9, 0x02, 0, 10, 1, 2)))
    }

    @Test
    fun suggestsTheLeastCrowdedChannel() {
        val nets = listOf(
            SeenNetwork(2412, -40), // ch 1, strong
            SeenNetwork(2437, -50), // ch 6
            SeenNetwork(2442, -60), // ch 7
            SeenNetwork(2462, -85), // ch 11, weak
            SeenNetwork(5180, -55, 80), // 36-48 block, 80 MHz
            SeenNetwork(5745, -60),
        )
        assertEquals(11, ChannelAdvisor.best24(nets).channel)
        // the 80 MHz network covers 36/40/44/48: all equally busy, the first is chosen
        assertEquals(1, ChannelAdvisor.best5(nets).networksOnIt)
        assertEquals(44, ChannelAdvisor.best5(listOf(SeenNetwork(5180, -50), SeenNetwork(5200, -50), SeenNetwork(5240, -50))).channel)
        assertEquals(36..48, ChannelAdvisor.covered5(44, 80))
        assertEquals(36..40, ChannelAdvisor.covered5(40, 40))
        assertEquals("5 GHz: canale 44 (libero)", ChannelAdvisor.describe(ChannelAdvisor.best5(listOf(SeenNetwork(5180, -50), SeenNetwork(5200, -50), SeenNetwork(5240, -50)))))
    }
}
