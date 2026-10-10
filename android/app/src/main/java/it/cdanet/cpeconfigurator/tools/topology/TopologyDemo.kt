package it.cdanet.cpeconfigurator.tools.topology

import it.cdanet.cpeconfigurator.tools.UbntDevice
import it.cdanet.cpeconfigurator.tools.pro.PortState
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

    /** Open ports of the demo devices, for the scanner's "Dati di esempio" (guide screenshots). */
    private val openPorts: Map<String, List<Int>> = mapOf(
        GATEWAY to listOf(22, 53, 80, 8291),
        "192.168.88.2" to listOf(80, 443),
        "192.168.88.3" to listOf(80),
        "192.168.88.4" to listOf(22, 443),
        "192.168.88.20" to listOf(22, 80, 443),
        "192.168.88.21" to listOf(22, 80, 443),
        "192.168.88.22" to listOf(22, 80, 443),
        "192.168.88.50" to listOf(80, 554, 8000),
        "192.168.88.51" to listOf(80, 554, 8000),
        "192.168.88.52" to listOf(80, 554, 8000),
        "192.168.88.70" to listOf(80, 554, 37777),
        "192.168.88.100" to listOf(139, 445, 3389),
        "192.168.88.101" to listOf(139, 445),
        "192.168.88.102" to listOf(139, 445, 3389),
        "192.168.88.110" to listOf(80, 443, 631, 9100),
        "192.168.88.120" to listOf(22, 80, 443, 445, 5000),
        "192.168.88.130" to listOf(80, 443, 5060),
        "192.168.88.140" to listOf(62078),
        "192.168.88.150" to listOf(8001, 8002),
    )

    /** The demo LAN as the scanner sees it: same devices, with their open ports. */
    val scannerHosts: List<ScanHost> get() = hosts.map { it.copy(ports = openPorts[it.ip].orEmpty(), how = "TCP") }

    /** What the vendor discovery protocols answer on the demo LAN. */
    val found: List<it.cdanet.cpeconfigurator.tools.discovery.Found> = run {
        fun f(ip: String, p: String, v: String, name: String? = null, model: String? = null, mac: String? = null, fw: String? = null, details: Map<String, String> = emptyMap()) =
            it.cdanet.cpeconfigurator.tools.discovery.Found(ip, p, v, name, model, mac, fw, details)
        listOf(
            f(GATEWAY, "MNDP", "MikroTik", "router-ufficio", "RB4011iGS+", mac(1), "7.16.1", mapOf("Interfaccia" to "bridge-lan")),
            f(GATEWAY, "SSDP", "UPnP", "router-ufficio", "RouterOS", details = mapOf("Tipo" to "InternetGatewayDevice")),
            f("192.168.88.20", "Ubiquiti", "Ubiquiti", "AP-cortile", "LiteAP AC", mac(20), "XC.v8.7.11", mapOf("SSID" to "CDA-UFFICIO", "Uptime" to "10 g 0 h")),
            f("192.168.88.21", "Ubiquiti", "Ubiquiti", "PBE-capannone", "PowerBeam 5AC Gen2", mac(21), "XC.v8.7.11", mapOf("SSID" to "CDA-UFFICIO", "Uptime" to "6 g 22 h")),
            f("192.168.88.22", "Ubiquiti", "Ubiquiti", "NBE-custode", "NanoBeam 5AC Gen2", mac(22), "XC.v8.7.11", mapOf("SSID" to "CDA-UFFICIO", "Uptime" to "5 g 18 h")),
            f("192.168.88.50", "SADP", "Hikvision", "NVR-ufficio", "DS-7608NI-K2", mac(50), "V4.62.210"),
            f("192.168.88.51", "SADP", "Hikvision", "cam-ingresso", "DS-2CD2143G2-I", mac(51), "V5.7.3"),
            f("192.168.88.51", "ONVIF", "ONVIF", "cam-ingresso", "DS-2CD2143G2-I"),
            f("192.168.88.52", "SADP", "Hikvision", "cam-parcheggio", "DS-2CD2T47G2-L", mac(52), "V5.7.3"),
            f("192.168.88.70", "Dahua", "Dahua", "cam-capannone", "IPC-HDW2431T-AS", mac(70), "2.800.0000000.33"),
            f("192.168.88.70", "ONVIF", "ONVIF", "cam-capannone", "IPC-HDW2431T-AS"),
            f("192.168.88.110", "WSD", "WS-Discovery", "stampante-piano1", "Brother HL-L2350DW", details = mapOf("Tipo" to "Stampante")),
            f("192.168.88.110", "mDNS", "mDNS", "stampante-piano1", "Brother HL-L2350DW", details = mapOf("Servizio" to "_ipp._tcp")),
            f("192.168.88.120", "mDNS", "Synology", "NAS-backup", "DS220+", details = mapOf("Servizio" to "_smb._tcp")),
            f("192.168.88.3", "NSDP", "Netgear", "sw-magazzino", "GS108Tv3", mac(3), "7.0.0.15"),
            f("192.168.88.150", "SSDP", "Samsung", "Smart TV sala", "QE55Q60", details = mapOf("Tipo" to "MediaRenderer")),
        )
    }

    /** The demo router seen by the port scanner ("Rapida" profile), for the guide screenshots. */
    val routerPorts: List<it.cdanet.cpeconfigurator.tools.pro.PortResult> = run {
        val open = mapOf(
            22 to ("SSH-2.0-ROSSSH" to null),
            53 to (null to null),
            80 to ("HTTP/1.1 200 OK · Server: (none) · RouterOS router configuration page" to null),
            443 to ("HTTP/1.1 200 OK · RouterOS" to "TLSv1.3 · CN router-ufficio · autofirmato · scade 03/2027"),
            8291 to (null to null),
            8728 to (null to null),
        )
        val closed = setOf(21, 23, 25, 110, 143, 993, 8080, 8443)
        it.cdanet.cpeconfigurator.tools.pro.Ports.PRESETS.values.first().sorted().map { port ->
            val svc = it.cdanet.cpeconfigurator.tools.pro.Ports.service(port)
            when (port) {
                in open -> it.cdanet.cpeconfigurator.tools.pro.PortResult(port, PortState.Open, svc, 1 + port % 4, open.getValue(port).first, open.getValue(port).second)
                in closed -> it.cdanet.cpeconfigurator.tools.pro.PortResult(port, PortState.Closed, svc, 1)
                else -> it.cdanet.cpeconfigurator.tools.pro.PortResult(port, PortState.Filtered, svc, null)
            }
        }
    }
}
