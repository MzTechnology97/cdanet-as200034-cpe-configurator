package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.discovery.VendorDiscovery
import it.cdanet.cpeconfigurator.tools.pro.ScanHost
import it.cdanet.cpeconfigurator.tools.topology.Neighbor
import it.cdanet.cpeconfigurator.tools.topology.SnmpDevice
import it.cdanet.cpeconfigurator.tools.discovery.Fingerprint
import it.cdanet.cpeconfigurator.tools.topology.DeviceClassifier
import it.cdanet.cpeconfigurator.tools.topology.DeviceEvidence
import it.cdanet.cpeconfigurator.tools.topology.DeviceType
import it.cdanet.cpeconfigurator.tools.topology.LinkKind
import it.cdanet.cpeconfigurator.tools.topology.VendorBadges
import it.cdanet.cpeconfigurator.tools.topology.TopoGraph
import it.cdanet.cpeconfigurator.tools.topology.Topology
import it.cdanet.cpeconfigurator.tools.topology.TopologyDemo
import org.junit.Assert.assertEquals
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
    fun buildsTheGraphFromLldpAndMacTables() {
        val t = Topology.build(hosts, listOf(router, core, access), "192.168.1.1")
        assertEquals("snmp", t.mode)
        assertEquals(3, t.snmpDevices)
        val g = t.graph
        fun link(a: String, b: String) = g.links.firstOrNull { (it.a == "ip:$a" && it.b == "ip:$b") || (it.a == "ip:$b" && it.b == "ip:$a") }
        // LLDP: router-core (seen from the core, ports on both sides) and core-access
        val rc = link("192.168.1.1", "192.168.1.2")!!
        assertEquals(LinkKind.Lldp, rc.kind)
        assertEquals("ether2", g.portOn(rc, "ip:192.168.1.1"))
        assertEquals("gi1", g.portOn(rc, "ip:192.168.1.2"))
        assertEquals(LinkKind.Lldp, link("192.168.1.2", "192.168.1.3")!!.kind)
        // MAC tables: camera on the core access port gi5, PC on the access switch port3 (not on the core's gi8 link)
        val cam = link("192.168.1.2", "192.168.1.64")!!
        assertEquals(LinkKind.Fdb, cam.kind)
        assertEquals("gi5", g.portOn(cam, "ip:192.168.1.2"))
        assertEquals("port3", g.portOn(link("192.168.1.3", "192.168.1.20")!!, "ip:192.168.1.3"))
        // nothing known about .30: presumed behind the gateway
        assertEquals(LinkKind.Assumed, link("192.168.1.1", "192.168.1.30")!!.kind)
        assertTrue(g.links.any { it.a == TopoGraph.INTERNET && it.b == "ip:192.168.1.1" })
    }

    @Test
    fun keepsLoopsGhostsWirelessAndMergesBothSides() {
        val g = Topology.build(TopologyDemo.hosts, TopologyDemo.snmp, TopologyDemo.GATEWAY).graph
        fun links(a: String, b: String) = g.links.filter { (it.a == a && it.b == b) || (it.a == b && it.b == a) }
        // the ring core - warehouse - first floor: three switch links, each seen from both sides once
        val ring = listOf("ip:192.168.88.2" to "ip:192.168.88.3", "ip:192.168.88.3" to "ip:192.168.88.4", "ip:192.168.88.2" to "ip:192.168.88.4")
        for ((a, b) in ring) {
            val l = links(a, b)
            assertEquals("$a-$b", 1, l.size)
            assertEquals(LinkKind.Lldp, l[0].kind)
        }
        // router-core seen by MikroTik (router) and LLDP (core): one link, strongest kind, both protocols
        val rc = links("ip:192.168.88.1", "ip:192.168.88.2").single()
        assertEquals(setOf("LLDP", "MikroTik"), rc.seenBy)
        assertEquals("ether2", g.portOn(rc, "ip:192.168.88.1"))
        assertEquals(1000L, rc.speedMbps)
        // the ONT outside the subnet is a ghost behind ether5
        val ont = g.nodes.single { it.label == "ONT-Fibra" }
        assertTrue(ont.ghost)
        assertEquals("ether5", g.portOn(links("ip:192.168.88.1", ont.id).single(), "ip:192.168.88.1"))
        // wireless: AP to both stations with the signal; the station's own view merged into the same link
        val pbe = links("ip:192.168.88.20", "ip:192.168.88.21").single()
        assertEquals(LinkKind.Wireless, pbe.kind)
        assertEquals(-58, pbe.signalDbm)
        assertEquals(-66, links("ip:192.168.88.20", "ip:192.168.88.22").single().signalDbm)
        // the camera behind the PowerBeam: on its LAN port, not on the core's gi3
        assertEquals("eth0", g.portOn(links("ip:192.168.88.21", "ip:192.168.88.70").single(), "ip:192.168.88.21"))
        // the AP has no LLDP: placed on the core's gi3 from the MAC table
        assertEquals(LinkKind.Fdb, links("ip:192.168.88.2", "ip:192.168.88.20").single().kind)
        // the TV has no MAC: presumed
        assertEquals(LinkKind.Assumed, links("ip:192.168.88.1", "ip:192.168.88.150").single().kind)
        // every node has at least one link and the CSV lists them all
        assertTrue(g.nodes.all { n -> g.links.any { it.a == n.id || it.b == n.id } })
        assertEquals(g.links.size - 1 + 1, TopoGraph.csv(g).size)
    }

    @Test
    fun layoutIsATreeFromInternetWithRedundantLinksApart() {
        val g = Topology.build(TopologyDemo.hosts, TopologyDemo.snmp, TopologyDemo.GATEWAY, fingerprints = TopologyDemo.fingerprints).graph
        val full = TopoGraph.layout(g)
        assertEquals(g.nodes.size, full.nodes.size)
        // no two boxes overlap
        for (a in full.nodes) for (b in full.nodes) if (a !== b) {
            val overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
            assertTrue("${a.node.label} / ${b.node.label}", !overlap)
        }
        // every node but Internet has exactly one parent; the ring adds exactly one redundant link
        assertEquals(g.nodes.size - 1, full.tree.size)
        assertEquals(g.links.size - full.tree.size, full.extra.size)
        assertTrue(full.extra.any { setOf(it.a, it.b) == setOf("ip:192.168.88.3", "ip:192.168.88.4") })
        // Internet on top, then the gateway, then the core switch; clients drawn small under their device
        val y = full.byId.mapValues { it.value.y }
        assertTrue(y.getValue(TopoGraph.INTERNET) < y.getValue("ip:192.168.88.1"))
        assertTrue(y.getValue("ip:192.168.88.1") < y.getValue("ip:192.168.88.2"))
        assertEquals("ip:192.168.88.2", full.parentOf["ip:192.168.88.51"])
        assertTrue(full.byId.getValue("ip:192.168.88.51").client)
        // the phone hangs from the AP by its wireless link, not from the core MAC table
        assertEquals("ip:192.168.88.20", full.parentOf["ip:192.168.88.140"])
        val infra = TopoGraph.layout(g, infraOnly = true)
        assertTrue(infra.nodes.all { it.node.infra })
        assertEquals(g.nodes.count { !it.infra }, infra.nodes.sumOf { it.hidden })
    }

    @Test
    fun classifiesTypesAndVendors() {
        val g = Topology.build(TopologyDemo.hosts, TopologyDemo.snmp, TopologyDemo.GATEWAY, fingerprints = TopologyDemo.fingerprints).graph
        fun type(ip: String) = g.byId.getValue("ip:$ip").type
        assertEquals(DeviceType.Router, type("192.168.88.1"))
        assertEquals(DeviceType.Switch, type("192.168.88.2"))
        assertEquals(DeviceType.Switch, type("192.168.88.4"))
        assertEquals(DeviceType.AccessPoint, type("192.168.88.20"))
        assertEquals(DeviceType.Cpe, type("192.168.88.21"))
        assertEquals(DeviceType.Nvr, type("192.168.88.50"))
        assertEquals(DeviceType.Camera, type("192.168.88.51"))
        assertEquals(DeviceType.Camera, type("192.168.88.70"))
        assertEquals(DeviceType.Computer, type("192.168.88.100"))
        assertEquals(DeviceType.Printer, type("192.168.88.110"))
        assertEquals(DeviceType.Nas, type("192.168.88.120"))
        assertEquals(DeviceType.VoipPhone, type("192.168.88.130"))
        assertEquals(DeviceType.Phone, type("192.168.88.140"))
        assertEquals(DeviceType.Tv, type("192.168.88.150"))
        assertEquals(DeviceType.Ont, g.nodes.single { it.label == "ONT-Fibra" }.type)
        assertEquals("UBNT", VendorBadges.of(g.byId.getValue("ip:192.168.88.20").vendor)?.short)
        assertEquals("MT", VendorBadges.of("Routerboard.com")?.short)
        assertNull(VendorBadges.of("Sconosciuto Srl"))
        // vendor from the SNMP enterprise number when the MAC says nothing
        assertEquals("MikroTik", DeviceClassifier.vendor(DeviceEvidence(sysObjectId = "1.3.6.1.4.1.14988.1")))
        assertEquals(DeviceType.Firewall, DeviceClassifier.classify(DeviceEvidence(fingerprints = listOf("HTTP title: FortiGate"))))
        assertEquals(DeviceType.Switch, DeviceClassifier.classify(DeviceEvidence(capabilities = setOf("bridge"))))
        assertEquals(DeviceType.AccessPoint, DeviceClassifier.classify(DeviceEvidence(capabilities = setOf("bridge", "wlan access point"))))
        assertEquals(DeviceType.Unknown, DeviceClassifier.classify(DeviceEvidence()))
    }

    @Test
    fun recognisesProductsFromFactoryHostnames() {
        fun of(name: String) = DeviceClassifier.classify(DeviceEvidence(hostname = name)) to DeviceClassifier.vendor(DeviceEvidence(hostname = name))
        assertEquals(DeviceType.AccessPoint to "Cambium", of("E410-1A2B3C"))
        assertEquals(DeviceType.Cpe to "Cambium", of("ePMP-Force300-CASA"))
        assertEquals(DeviceType.AccessPoint to "Ubiquiti", of("U6-Lite-ufficio"))
        assertEquals(DeviceType.Switch to "MikroTik", of("CRS326-24G"))
        assertEquals(DeviceType.Router to "Teltonika", of("RUT955"))
        assertEquals(DeviceType.Printer to "Brother", of("BRN3C2AF4123456"))
        assertEquals(DeviceType.VoipPhone to "Yealink", of("SIP-T46U"))
        assertEquals(DeviceType.Camera to "Hikvision", of("DS-2CD2143G2-I"))
        assertEquals(DeviceType.Iot, of("shellyplus1pm-a8032ab12345").first)
        assertEquals(DeviceType.Server, of("pve-01").first)
        assertNull(of("pve-01").second) // a category, not a vendor
        // the gateway stays a router even if its name says access point
        assertEquals(DeviceType.Router, DeviceClassifier.classify(DeviceEvidence(hostname = "U6-Lite", isGateway = true)))
        // and the scanner list says it too
        assertEquals("Access point Cambium", it.cdanet.cpeconfigurator.tools.pro.DeviceGuess.guess(null, emptySet(), "E410-1A2B3C"))
        assertEquals("CMB", VendorBadges.of("Cambium Networks Limited")?.short)
        assertEquals("RKS", VendorBadges.of("Ruckus Wireless")?.short)
    }

    @Test
    fun parsesFingerprintsCapabilitiesAndSubnets() {
        val http = "HTTP/1.1 401 Unauthorized\r\nServer: App-webs/\r\nWWW-Authenticate: Digest realm=\"IP Camera(C1234)\"\r\n\r\n<html><title>Login</title></html>"
        assertEquals(listOf("HTTP Server: App-webs/", "HTTP realm: IP Camera(C1234)", "HTTP title: Login"), Fingerprint.parseHttp(http))
        assertEquals("SSH: ROSSSH", Fingerprint.parseSshBanner("SSH-2.0-ROSSSH\r\n"))
        assertNull(Fingerprint.parseSshBanner("HTTP/1.1 400"))
        assertEquals("SIP: Yealink SIP-T46U", Fingerprint.parseAgent("SIP/2.0 200 OK\r\nUser-Agent: Yealink SIP-T46U\r\n\r\n", "SIP"))
        assertTrue(String(Fingerprint.sipOptions("192.168.1.10", "192.168.1.2")).startsWith("OPTIONS sip:192.168.1.10 SIP/2.0"))
        // LLDP capabilities BITS: 0x28 = bridge + router
        assertEquals(setOf("bridge", "router"), Topology.capabilities(byteArrayOf(0x28)))
        assertEquals(setOf("wlan access point"), Topology.capabilities(byteArrayOf(0x10, 0)))
        assertEquals("192.168.10.0/24", Topology.subnetOf("192.168.10.5", "255.255.255.0"))
        assertEquals("192.168.0.0/16", Topology.subnetOf("192.168.3.1", "255.255.0.0"))
        assertNull(Topology.subnetOf("127.0.0.1", "255.0.0.0"))
        assertNull(Topology.subnetOf("10.0.0.1", "255.255.255.255"))
        val wsd = "<s:Envelope><s:Body><d:ProbeMatches><d:ProbeMatch><d:Types>wsdp:Device wprt:PrintDeviceType</d:Types><d:XAddrs>http://192.168.1.40:5357/x</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>"
        val f = VendorDiscovery.parseWsd(wsd, null)!!
        assertEquals("192.168.1.40", f.ip)
        assertEquals("Stampante", f.details["Tipo"])
    }

    @Test
    fun wideSweepSplitsPrivateRangesInto24s() {
        val nets = it.cdanet.cpeconfigurator.network.Ip.slash24s(it.cdanet.cpeconfigurator.network.Ip.parseCidr("192.168.0.0/16"))
        assertEquals(256, nets.size)
        assertEquals("192.168.0.0/24", nets.first().toString())
        assertEquals("192.168.255.0/24", nets.last().toString())
        assertEquals(4, it.cdanet.cpeconfigurator.network.Ip.slash24s(it.cdanet.cpeconfigurator.network.Ip.parseCidr("10.10.0.0/22")).size)
        assertTrue(runCatching { it.cdanet.cpeconfigurator.network.Ip.slash24s(it.cdanet.cpeconfigurator.network.Ip.parseCidr("10.0.0.0/8")) }.isFailure)
        assertTrue(runCatching { it.cdanet.cpeconfigurator.network.Ip.slash24s(it.cdanet.cpeconfigurator.network.Ip.parseCidr("8.8.0.0/16")) }.isFailure)
    }

    @Test
    fun wideSweepIgnoresUnreachableAndBlanketRefusals() {
        val ipScanner = it.cdanet.cpeconfigurator.tools.pro.IpScanner
        val ip = it.cdanet.cpeconfigurator.network.Ip
        // Android reports "No route to host" as a ConnectException too: not a live network
        assertTrue(ipScanner.isRefused(java.net.ConnectException("failed to connect to /192.168.5.1 (port 80): connect failed: ECONNREFUSED (Connection refused)")))
        assertTrue(!ipScanner.isRefused(java.net.ConnectException("failed to connect to /192.168.5.1 (port 80): connect failed: EHOSTUNREACH (No route to host)")))
        val nets = ip.slash24s(ip.parseCidr("192.168.0.0/16"))
        val Open = it.cdanet.cpeconfigurator.tools.pro.IpScanner.Answer.Open
        val Refused = it.cdanet.cpeconfigurator.tools.pro.IpScanner.Answer.Refused
        val None = it.cdanet.cpeconfigurator.tools.pro.IpScanner.Answer.None
        // a few networks: open and refused both count
        val few = nets.mapIndexed { i, n -> n to when (i) { 1 -> Open; 2 -> Refused; else -> None } }
        assertEquals(listOf("192.168.1.0/24", "192.168.2.0/24"), ipScanner.chooseActive(few).map { it.toString() })
        // everything refused (a firewall rejecting all): only the open ones are real
        val all = nets.mapIndexed { i, n -> n to if (i == 88) Open else Refused }
        assertEquals(listOf("192.168.88.0/24"), ipScanner.chooseActive(all).map { it.toString() })
        // ping: a genuine reply, not an unreachable or a forged echo
        assertEquals(4, ipScanner.pingReply("PING 192.168.10.1 (192.168.10.1) 56(84) bytes of data.\n64 bytes from 192.168.10.1: icmp_seq=1 ttl=255 time=4.82 ms\n", "192.168.10.1"))
        assertEquals(null, ipScanner.pingReply("64 bytes from 192.168.2.77: icmp_seq=0 ttl=255 time=0.000 ms\nwrong data byte #16 should be 0x10 but was 0xa\n", "192.168.2.77"))
        assertEquals(null, ipScanner.pingReply("From 192.168.10.1 icmp_seq=1 Destination Host Unreachable\n", "192.168.5.9"))
        // a router intercepting DNS: port 53 "open" on a phantom address is not a host
        val dns = it.cdanet.cpeconfigurator.tools.pro.IpScanner.Canary(ports = setOf(53))
        assertTrue(!dns.alive(setOf(53), refused = false))
        assertTrue(dns.alive(setOf(53, 80), refused = false))
        assertTrue(dns.alive(emptySet(), refused = true))
        // a firewall refusing every address: refusals prove nothing
        assertTrue(!it.cdanet.cpeconfigurator.tools.pro.IpScanner.Canary(refuses = true).alive(emptySet(), refused = true))
        // every address accepts connections (transparent proxy, emulator NAT): nothing is trusted
        assertEquals(emptyList<String>(), ipScanner.chooseActive(nets.map { it to Open }).map { it.toString() })
    }

    @Test
    fun theHostListGetsVendorsAndTypesFromTheGraph() {
        // scanner hosts without MAC or vendor, as on a phone (no ARP table)
        val bare = TopologyDemo.hosts.map { it.copy(vendor = null, kind = "") }
        val g = Topology.build(TopologyDemo.hosts, TopologyDemo.snmp, TopologyDemo.GATEWAY, fingerprints = TopologyDemo.fingerprints).graph
        val out = it.cdanet.cpeconfigurator.tools.topology.hostsFromGraph(bare, g).associateBy { it.ip }
        val sw = g.nodes.first { it.label == "sw-core" }
        assertEquals(DeviceType.Switch, it.cdanet.cpeconfigurator.tools.pro.DeviceGuess.type(out.getValue(sw.ip!!).kind))
        assertEquals("TP-Link", out.getValue(sw.ip!!).vendor)
        assertEquals(bare.size, out.size)
    }

    @Test
    fun scannerLabelsMapToDeviceTypes() {
        val g = it.cdanet.cpeconfigurator.tools.pro.DeviceGuess
        assertEquals(DeviceType.Camera, g.type("Telecamera / NVR"))
        assertEquals(DeviceType.AccessPoint, g.type("Access point Cambium"))
        assertEquals(DeviceType.Cpe, g.type("Radio / access point"))
        assertEquals(DeviceType.Router, g.type("Router MikroTik"))
        assertEquals(DeviceType.Router, g.type("Stampante", isGateway = true))
        assertEquals(DeviceType.Computer, g.type("PC / server Windows"))
        assertEquals(DeviceType.Server, g.type("Linux / dispositivo SSH"))
        assertEquals(DeviceType.Iot, g.type("IoT / domotica Shelly"))
        assertEquals(DeviceType.VoipPhone, g.type("Telefono VoIP"))
        assertEquals(DeviceType.Unknown, g.type(""))
    }

    @Test
    fun withoutSnmpEverythingHangsFromTheGateway() {
        val t = Topology.build(hosts, emptyList(), "192.168.1.1")
        assertEquals("base", t.mode)
        assertTrue(t.graph.links.filter { it.kind != LinkKind.Uplink }.all { it.kind == LinkKind.Assumed && it.a == "ip:192.168.1.1" })
    }

    @Test
    fun macFromTableIndex() {
        assertEquals("02:CD:00:00:00:15", Topology.macFromIndex("1.3.6.1.4.1.41112.1.4.7.1.2.1.2.205.0.0.0.21".split('.')))
        assertNull(Topology.macFromIndex(listOf("1", "2")))
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
