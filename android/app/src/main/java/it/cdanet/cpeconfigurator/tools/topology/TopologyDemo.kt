package it.cdanet.cpeconfigurator.tools.topology

import it.cdanet.cpeconfigurator.tools.UbntDevice
import it.cdanet.cpeconfigurator.tools.pro.ScanHost

/**
 * A fictitious office LAN (no real device) for the unit tests and for the "Dati di esempio" button of
 * debug builds: MikroTik router with the ISP ONT beyond it, three LLDP switches in a ring, a Ubiquiti AP
 * with two wireless stations, cameras, PCs, a printer and a TV nobody can place.
 */
object TopologyDemo {
    const val GATEWAY = "192.168.88.1"

    private fun mac(n: Int) = "02:CD:00:00:00:%02X".format(n)

    val hosts: List<ScanHost> = listOf(
        ScanHost(GATEWAY, 1, "tcp", hostname = "router-ufficio", mac = mac(1), vendor = "MikroTik", kind = "Router / gateway", isGateway = true),
        ScanHost("192.168.88.2", 1, "tcp", mac = mac(2), vendor = "TP-Link", kind = "Switch"),
        ScanHost("192.168.88.3", 1, "tcp", mac = mac(3), vendor = "Netgear", kind = "Switch"),
        ScanHost("192.168.88.4", 1, "tcp", mac = mac(4), vendor = "Ubiquiti", kind = "Switch"),
        ScanHost("192.168.88.20", 2, "tcp", mac = mac(20), vendor = "Ubiquiti", kind = "Ubiquiti LiteAP AC", ubnt = UbntDevice("192.168.88.20", mac(20), "AP-cortile", "LAP-120", "LiteAP AC", "XC.v8.7.11", "CDA-UFFICIO", 864000)),
        ScanHost("192.168.88.21", 4, "tcp", mac = mac(21), vendor = "Ubiquiti", kind = "Ubiquiti PowerBeam 5AC", ubnt = UbntDevice("192.168.88.21", mac(21), "PBE-capannone", "PBE-5AC-Gen2", "PowerBeam 5AC Gen2", "XC.v8.7.11", "CDA-UFFICIO", 600000)),
        ScanHost("192.168.88.22", 5, "tcp", mac = mac(22), vendor = "Ubiquiti", kind = "Ubiquiti NanoBeam 5AC", ubnt = UbntDevice("192.168.88.22", mac(22), "NBE-custode", "NBE-5AC-Gen2", "NanoBeam 5AC Gen2", "XC.v8.7.11", "CDA-UFFICIO", 500000)),
        ScanHost("192.168.88.50", 2, "tcp", hostname = "NVR-ufficio", mac = mac(50), vendor = "Hikvision", kind = "Telecamera / NVR"),
        ScanHost("192.168.88.51", 2, "tcp", hostname = "cam-ingresso", mac = mac(51), vendor = "Hikvision", kind = "Telecamera / NVR"),
        ScanHost("192.168.88.52", 2, "tcp", hostname = "cam-parcheggio", mac = mac(52), vendor = "Hikvision", kind = "Telecamera / NVR"),
        ScanHost("192.168.88.70", 6, "tcp", hostname = "cam-capannone", mac = mac(70), vendor = "Dahua", kind = "Telecamera / NVR"),
        ScanHost("192.168.88.100", 3, "tcp", hostname = "PC-amministrazione", mac = mac(100), vendor = "Dell", kind = "PC / server Windows"),
        ScanHost("192.168.88.101", 3, "tcp", hostname = "PC-magazzino", mac = mac(101), vendor = "HP", kind = "PC / server Windows"),
        ScanHost("192.168.88.102", 3, "tcp", hostname = "PC-direzione", mac = mac(102), vendor = "Lenovo", kind = "PC / server Windows"),
        ScanHost("192.168.88.110", 3, "tcp", hostname = "stampante-piano1", mac = mac(110), vendor = "Brother", kind = "Stampante"),
        ScanHost("192.168.88.120", 3, "tcp", hostname = "NAS-backup", mac = mac(120), vendor = "Synology", kind = "NAS"),
        ScanHost("192.168.88.130", 3, "tcp", hostname = "telefono-reception", mac = mac(130), vendor = "Yealink", kind = ""),
        ScanHost("192.168.88.140", 8, "tcp", hostname = "iPhone-di-Marco", mac = mac(140), vendor = "Apple", kind = "Apple (iPhone/iPad/Mac)"),
        ScanHost("192.168.88.150", 9, "tcp", hostname = "Smart TV sala", vendor = "Samsung", kind = "TV / multimedia"),
    )

    /** What the services of some devices answer (HTTP, SSH, RTSP, SIP). */
    val fingerprints: Map<String, List<String>> = mapOf(
        GATEWAY to listOf("SSH: ROSSSH", "HTTP title: RouterOS router configuration page"),
        "192.168.88.50" to listOf("HTTP Server: DNVRS-Webs", "RTSP: Hikvision-Webs"),
        "192.168.88.51" to listOf("HTTP Server: App-webs/", "RTSP: Hikvision-Webs"),
        "192.168.88.52" to listOf("HTTP Server: App-webs/", "RTSP: Hikvision-Webs"),
        "192.168.88.70" to listOf("RTSP: Rtsp Server/3.0"),
        "192.168.88.110" to listOf("HTTP title: Brother HL-L2350DW"),
        "192.168.88.120" to listOf("HTTP title: Synology DiskStation"),
        "192.168.88.130" to listOf("SIP: Yealink SIP-T46U 108.86.0.20"),
    )

    val snmp: List<SnmpDevice> = listOf(
        // router: MikroTik neighbors (the core switch and, on ether5, the ISP's ONT outside the LAN), ARP for all
        SnmpDevice(
            GATEWAY, "public", "router-ufficio", "RouterOS RB4011iGS+",
            ownMacs = setOf(mac(1)),
            neighbors = listOf(
                Neighbor("ether2", "sw-core", null, mac(2), "192.168.88.2", "MNDP", "TP-Link T2600G-28TS"),
                Neighbor("ether5", "ONT-Fibra", "eth0", "02:CD:00:00:00:F0", "10.0.0.1", "LLDP", "Huawei HG8245"),
            ),
            arp = hosts.filter { it.mac != null }.associate { it.ip to it.mac!! },
            speeds = mapOf("ether2" to 1000L, "ether5" to 1000L),
        ),
        // core: LLDP to the router and to the two floor switches; the AP and the NVR/cameras on access ports
        SnmpDevice(
            "192.168.88.2", "public", "sw-core", "TP-Link JetStream T2600G-28TS",
            ownMacs = setOf(mac(2)),
            fdb = mapOf(
                mac(1) to "gi1", mac(3) to "gi23", mac(4) to "gi24", mac(20) to "gi3", mac(21) to "gi3", mac(22) to "gi3", mac(70) to "gi3",
                mac(50) to "gi10", mac(51) to "gi5", mac(52) to "gi6", mac(100) to "gi12", mac(101) to "gi23", mac(102) to "gi24", mac(110) to "gi24", mac(120) to "gi14", mac(130) to "gi24", mac(140) to "gi3",
            ),
            neighbors = listOf(
                Neighbor("gi1", "router-ufficio", "ether2", mac(1), GATEWAY, "LLDP"),
                Neighbor("gi23", "sw-magazzino", "g24", mac(3), "192.168.88.3", "LLDP"),
                Neighbor("gi24", "sw-piano1", "0/1", mac(4), "192.168.88.4", "LLDP"),
            ),
            speeds = mapOf("gi1" to 1000L, "gi23" to 1000L, "gi24" to 10000L, "gi3" to 1000L, "gi10" to 1000L, "gi5" to 100L, "gi6" to 100L, "gi12" to 1000L, "gi14" to 1000L),
        ),
        // warehouse and first floor switches: linked to the core and to each other (a ring, kept by STP)
        SnmpDevice(
            "192.168.88.3", "public", "sw-magazzino", "Netgear GS724Tv4",
            ownMacs = setOf(mac(3)),
            fdb = mapOf(mac(1) to "g24", mac(4) to "g23", mac(101) to "g9"),
            neighbors = listOf(Neighbor("g24", "sw-core", "gi23", mac(2), "192.168.88.2", "LLDP"), Neighbor("g23", "sw-piano1", "0/2", mac(4), "192.168.88.4", "LLDP")),
            speeds = mapOf("g24" to 1000L, "g23" to 1000L, "g9" to 1000L),
        ),
        SnmpDevice(
            "192.168.88.4", "public", "sw-piano1", "EdgeSwitch 24 Lite",
            ownMacs = setOf(mac(4)),
            fdb = mapOf(mac(1) to "0/1", mac(102) to "0/7", mac(110) to "0/9", mac(130) to "0/12"),
            neighbors = listOf(Neighbor("0/1", "sw-core", "gi24", mac(2), "192.168.88.2", "LLDP"), Neighbor("0/2", "sw-magazzino", "g23", mac(3), "192.168.88.3", "LLDP")),
            speeds = mapOf("0/1" to 10000L, "0/2" to 1000L, "0/7" to 1000L, "0/9" to 100L),
        ),
        // Ubiquiti AP: two stations; behind the PowerBeam a camera the core switch also sees on gi3
        SnmpDevice(
            "192.168.88.20", "public", "AP-cortile", "Linux 4.14 airOS XC.v8.7.11",
            ownMacs = setOf(mac(20)),
            fdb = mapOf(mac(1) to "eth0", mac(140) to "ath0"),
            wireless = listOf(WirelessPeer(mac(21), "PBE-capannone", "192.168.88.21", -58), WirelessPeer(mac(22), "NBE-custode", "192.168.88.22", -66), WirelessPeer(mac(140), "iPhone-di-Marco", "192.168.88.140", -61)),
        ),
        SnmpDevice(
            "192.168.88.21", "public", "PBE-capannone", "Linux 4.14 airOS XC.v8.7.11",
            ownMacs = setOf(mac(21)),
            fdb = mapOf(mac(70) to "eth0", mac(1) to "ath0"),
            wireless = listOf(WirelessPeer(mac(20), "AP-cortile", "192.168.88.20", -59)),
        ),
    )
}
