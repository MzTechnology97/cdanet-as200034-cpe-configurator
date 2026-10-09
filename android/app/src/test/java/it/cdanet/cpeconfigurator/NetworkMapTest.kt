package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.pro.MapCategory
import it.cdanet.cpeconfigurator.tools.pro.MapEdge
import it.cdanet.cpeconfigurator.tools.pro.NetworkMap
import it.cdanet.cpeconfigurator.tools.pro.ScanHost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkMapTest {
    private val hosts = listOf(
        ScanHost("192.168.1.1", 2, "tcp", kind = "Router / gateway", isGateway = true),
        ScanHost("192.168.1.64", 3, "tcp", kind = "Telecamera / NVR"),
        ScanHost("192.168.1.65", 3, "tcp", kind = "Telecamera / NVR"),
        ScanHost("192.168.1.20", 5, "tcp", kind = "Stampante"),
        ScanHost("192.168.1.30", 9, "icmp", kind = ""),
        ScanHost("192.168.1.50", 1, "self", kind = "", isSelf = true),
    )

    @Test
    fun groupsHostsUnderTheGateway() {
        val m = NetworkMap.build(hosts, "192.168.1.1")
        assertEquals("192.168.1.1", m.nodes.first { it.id == "gw" }.sub)
        val cats = m.nodes.filter { it.id.startsWith("cat:") }.map { it.category }
        assertEquals(listOf(MapCategory.Camera, MapCategory.Printer, MapCategory.Phone, MapCategory.Other), cats)
        assertEquals("2", m.nodes.first { it.id == "cat:Camera" }.sub)
        // every host hangs from the map, the gateway from Internet
        assertTrue(m.edges.contains(MapEdge("internet", "gw")))
        assertEquals(hosts.size - 1, m.nodes.count { it.id.startsWith("host:") })
        assertTrue(m.width > 0 && m.height > 0)
    }

    @Test
    fun categories() {
        assertEquals(MapCategory.Ubiquiti, NetworkMap.category(ScanHost("1.1.1.1", 1, "tcp", kind = "Ubiquiti LiteBeam 5AC")))
        assertEquals(MapCategory.Computer, NetworkMap.category(ScanHost("1.1.1.2", 1, "tcp", kind = "PC / server Windows")))
        assertEquals(MapCategory.Network, NetworkMap.category(ScanHost("1.1.1.3", 1, "tcp", kind = "Router / access point")))
    }
}
