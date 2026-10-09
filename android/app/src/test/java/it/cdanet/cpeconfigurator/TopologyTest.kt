package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.discovery.VendorDiscovery
import it.cdanet.cpeconfigurator.tools.pro.ScanHost
import it.cdanet.cpeconfigurator.tools.topology.Neighbor
import it.cdanet.cpeconfigurator.tools.topology.SnmpDevice
import it.cdanet.cpeconfigurator.tools.topology.Topology
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TopologyTest {
    private val gwMac = "AA:00:00:00:00:01"
    private val swMac = "AA:00:00:00:00:02"
    private val sw2Mac = "AA:00:00:00:00:03"
    private val camMac = "BC:AD:28:00:00:10"
    private val pcMac = "00:11:22:00:00:20"

    private val hosts = listOf(
        ScanHost("192.168.1.1", 1, "tcp", kind = "Router / gateway", isGateway = true),
        ScanHost("192.168.1.2", 1, "tcp", kind = "Router / access point"),
        ScanHost("192.168.1.3", 1, "tcp", kind = ""),
        ScanHost("192.168.1.64", 2, "tcp", kind = "Telecamera / NVR"),
        ScanHost("192.168.1.20", 2, "tcp", kind = "PC / server Windows"),
        ScanHost("192.168.1.30", 2, "tcp", kind = ""),
    )

    // router: ARP knows everybody; core switch: LLDP to the router on port 1 and to the 2nd switch on port 8;
    // FDB: camera on port 5, PC on the 2nd switch (seen on port 8 here, port 3 there)
    private val router = SnmpDevice(
        "192.168.1.1", "public", "gw-mikrotik", "RouterOS RB4011",
        ownMacs = setOf(gwMac),
        arp = mapOf("192.168.1.2" to swMac, "192.168.1.3" to sw2Mac, "192.168.1.64" to camMac, "192.168.1.20" to pcMac),
    )
    private val core = SnmpDevice(
        "192.168.1.2", "public", "core-sw", "TP-Link JetStream T2600G",
        ownMacs = setOf(swMac),
        fdb = mapOf(gwMac to "gi1", camMac to "gi5", pcMac to "gi8", sw2Mac to "gi8"),
        neighbors = listOf(Neighbor("gi1", "gw-mikrotik", "ether2", gwMac, null, "LLDP"), Neighbor("gi8", "access-sw", "port1", null, "192.168.1.3", "LLDP")),
    )
    private val access = SnmpDevice(
        "192.168.1.3", "public", "access-sw", "Huawei S5735",
        ownMacs = setOf(sw2Mac),
        fdb = mapOf(gwMac to "port1", pcMac to "port3", camMac to "port1"),
    )

    @Test
    fun buildsTheRealTreeFromSnmp() {
        val t = Topology.build(hosts, listOf(router, core, access), "192.168.1.1")
        assertEquals("snmp", t.mode)
        assertEquals(3, t.snmpDevices)
        assertTrue(t.links >= 2)
        val nodes = t.layout.nodes.associateBy { it.id }
        assertEquals("gw-mikrotik", nodes.getValue("gw").label)
        // camera on core port gi5, PC on the access switch port3
        assertTrue(nodes.getValue("host:192.168.1.64").sub.startsWith("porta gi5"))
        assertTrue(nodes.getValue("host:192.168.1.20").sub.startsWith("porta port3"))
        assertTrue(t.layout.edges.any { it.from == "gw" && it.to == "dev:192.168.1.2" })
        assertTrue(t.layout.edges.any { it.from == "dev:192.168.1.2" && it.to == "dev:192.168.1.3" })
        // the device without MAC info stays under the gateway
        assertTrue(t.layout.edges.any { it.to == "host:192.168.1.30" })
        assertEquals(2, t.placedOnPorts)
    }

    @Test
    fun withoutSnmpItIsTheBaseMap() {
        val t = Topology.build(hosts, emptyList(), "192.168.1.1")
        assertEquals("base", t.mode)
        assertNotNull(t.layout.nodes.firstOrNull { it.id == "gw" })
    }

    @Test
    fun parsesMikrotikMndp() {
        fun tlv(t: Int, v: ByteArray) = byteArrayOf((t shr 8).toByte(), t.toByte(), (v.size shr 8).toByte(), v.size.toByte()) + v
        val pkt = byteArrayOf(0, 0, 0, 1) + tlv(1, byteArrayOf(0x4c, 0x5e, 0x0c, 1, 2, 3)) + tlv(5, "router-casa".toByteArray()) +
            tlv(7, "7.15.3 (stable)".toByteArray()) + tlv(12, "RB4011iGS+".toByteArray()) + tlv(17, byteArrayOf(192.toByte(), 168.toByte(), 88, 1))
        val f = VendorDiscovery.parseMndp(pkt, pkt.size, "192.168.88.1")!!
        assertEquals("MikroTik", f.vendor)
        assertEquals("router-casa", f.name)
        assertEquals("RB4011iGS+", f.model)
        assertEquals("4C:5E:0C:01:02:03", f.mac)
        assertEquals("192.168.88.1", f.ip)
        assertNull(VendorDiscovery.parseMndp(ByteArray(4), 4, "1.2.3.4"))
    }

    @Test
    fun parsesUpnpAndSsdp() {
        val h = VendorDiscovery.parseSsdp("HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:1900/igd.xml\r\nSERVER: Linux UPnP/1.0 Huawei\r\nST: upnp:rootdevice\r\n\r\n")!!
        assertEquals("http://192.168.1.1:1900/igd.xml", h["location"])
        val d = VendorDiscovery.parseUpnp("<root><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><friendlyName>HG8245Q2</friendlyName><manufacturer>Huawei Technologies</manufacturer><modelName>HG8245Q2</modelName></device></root>")
        assertEquals("Huawei Technologies", d["manufacturer"])
        assertEquals("HG8245Q2", d["modelName"])
    }

    @Test
    fun parsesDahuaAndNsdp() {
        val json = """{"method":"client.notifyDevInfo","params":{"deviceInfo":{"DeviceType":"IPC-HDW2431T","IPv4Address":{"IPAddress":"192.168.1.108"},"Mac":"3c:ef:8c:00:00:01","SerialNo":"6G0ABCDE","Version":"2.800.0000000.25.R","HttpPort":80,"Vendor":"Dahua"}}}"""
        val pkt = ByteArray(32) + json.toByteArray()
        val f = VendorDiscovery.parseDahua(pkt, pkt.size, "192.168.1.108")!!
        assertEquals("IPC-HDW2431T", f.model)
        assertEquals("3C:EF:8C:00:00:01", f.mac)
        assertNull(VendorDiscovery.parseDahua(VendorDiscovery.dahuaProbe(), VendorDiscovery.dahuaProbe().size, "1.1.1.1"))

        val probe = VendorDiscovery.nsdpProbe()
        assertEquals("NSDP", String(probe, 24, 4))
        val resp = probe.copyOf(32).also { it[1] = 2 } + byteArrayOf(0, 1, 0, 6) + "GS308E".toByteArray() + byteArrayOf(0, 6, 0, 4, 192.toByte(), 168.toByte(), 0, 239.toByte()) + byteArrayOf(0xff.toByte(), 0xff.toByte(), 0, 0)
        val n = VendorDiscovery.parseNsdp(resp, resp.size, null)!!
        assertEquals("GS308E", n.model)
        assertEquals("192.168.0.239", n.ip)
    }

    @Test
    fun mdnsQueryAndAnswer() {
        val q = VendorDiscovery.mdnsQuery(listOf("_ipp._tcp.local"))
        assertEquals(1, q[5].toInt())
        // answer: PTR _ipp._tcp.local -> "HP._ipp._tcp.local", TXT ty=HP LaserJet, A 192.168.1.50
        fun name(n: String) = n.split('.').flatMap { listOf(it.length.toByte()) + it.toByteArray().toList() }.toByteArray() + byteArrayOf(0)
        fun rr(n: String, type: Int, data: ByteArray) = name(n) + byteArrayOf(0, type.toByte(), 0, 1, 0, 0, 0, 120, (data.size shr 8).toByte(), data.size.toByte()) + data
        val txt = "ty=HP LaserJet".toByteArray().let { byteArrayOf(it.size.toByte()) + it }
        val msg = byteArrayOf(0, 0, 0x84.toByte(), 0, 0, 0, 0, 3, 0, 0, 0, 0) +
            rr("_ipp._tcp.local", 12, name("HP._ipp._tcp.local")) + rr("HP._ipp._tcp.local", 16, txt) + rr("hp.local", 1, byteArrayOf(192.toByte(), 168.toByte(), 1, 50))
        val recs = VendorDiscovery.parseMdns(msg, msg.size)
        assertEquals(3, recs.size)
        assertEquals("HP._ipp._tcp.local", recs[0].data)
        assertEquals("192.168.1.50", recs[2].data)
    }
}
