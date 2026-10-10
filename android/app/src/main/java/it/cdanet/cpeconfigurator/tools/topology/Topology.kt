package it.cdanet.cpeconfigurator.tools.topology

import it.cdanet.cpeconfigurator.tools.Snmp
import it.cdanet.cpeconfigurator.tools.pro.ScanHost

/** A neighbor announced by LLDP, CDP or MikroTik discovery (MNDP) on a local port. */
data class Neighbor(
    val localPort: String,
    val remoteName: String?,
    val remotePort: String?,
    val remoteMac: String?,
    val remoteIp: String?,
    val protocol: String,
    /** Model/platform the neighbor announces (CDP platform, MikroTik board). */
    val remotePlatform: String? = null,
    /** LLDP system capabilities enabled on the neighbor (router, bridge, WLAN access point, telephone…). */
    val capabilities: Set<String> = emptySet(),
)

/** A station registered on a wireless interface (Ubiquiti airMAX AP or the AP seen from a station). */
data class WirelessPeer(val mac: String, val name: String?, val ip: String?, val signal: Int?, val iface: String? = null)

/** What an SNMP-managed device (switch, router, AP) tells about the network. */
data class SnmpDevice(
    val ip: String,
    val community: String,
    val sysName: String,
    val sysDescr: String,
    /** ifIndex → interface name. */
    val ifNames: Map<Int, String> = emptyMap(),
    val ownMacs: Set<String> = emptySet(),
    /** MAC → interface name where the switch learned it (bridge forwarding table). */
    val fdb: Map<String, String> = emptyMap(),
    val neighbors: List<Neighbor> = emptyList(),
    /** IP → MAC (router/switch ARP table). */
    val arp: Map<String, String> = emptyMap(),
    /** Interface name → speed in Mbit/s (interfaces that are up). */
    val speeds: Map<String, Long> = emptyMap(),
    val wireless: List<WirelessPeer> = emptyList(),
    val sysObjectId: String? = null,
    /** LLDP capabilities the device itself announces. */
    val capabilities: Set<String> = emptySet(),
    /** IPv4 subnets of its interfaces ("192.168.10.0/24"): other LANs to scan. */
    val subnets: Set<String> = emptySet(),
)

data class TopologyResult(val graph: Graph, val snmpDevices: Int, val mode: String) {
    fun count(kind: LinkKind) = graph.links.count { it.kind == kind }
}

/**
 * SNMP collection for the network graph ([TopoGraph]): LLDP, CDP and MikroTik neighbors, bridge MAC
 * tables, ARP, Ubiquiti wireless stations and port speeds.
 */
object Topology {
    private const val SYS = "1.3.6.1.2.1.1"
    private const val IF_NAME = "1.3.6.1.2.1.31.1.1.1.1"
    private const val IF_DESCR = "1.3.6.1.2.1.2.2.1.2"
    private const val IF_PHYS = "1.3.6.1.2.1.2.2.1.6"
    private const val IF_OPER = "1.3.6.1.2.1.2.2.1.8"
    private const val IF_HIGH_SPEED = "1.3.6.1.2.1.31.1.1.1.15"
    private const val BRIDGE_PORT_IF = "1.3.6.1.2.1.17.1.4.1.2"
    private const val FDB_PORT = "1.3.6.1.2.1.17.4.3.1.2"
    private const val QFDB_PORT = "1.3.6.1.2.1.17.7.1.2.2.1.2"
    private const val LLDP_LOC_PORT_DESC = "1.0.8802.1.1.2.1.3.7.1.4"
    private const val LLDP_LOC_PORT_ID = "1.0.8802.1.1.2.1.3.7.1.3"
    private const val LLDP_REM = "1.0.8802.1.1.2.1.4.1.1"
    private const val LLDP_MAN = "1.0.8802.1.1.2.1.4.2.1.3"
    private const val CDP_CACHE = "1.3.6.1.4.1.9.9.23.1.2.1.1"
    private const val ARP = "1.3.6.1.2.1.4.22.1.2"
    /** IP-MIB ipNetToPhysicalPhysAddress: the ARP table of newer agents. */
    private const val ARP_PHYS = "1.3.6.1.2.1.4.35.1.4"
    /** MIKROTIK-MIB mtxrNeighborTable: neighbors found by MNDP/CDP/LLDP on RouterOS. */
    private const val MTXR_NEIGHBOR = "1.3.6.1.4.1.14988.1.1.11.1.1"
    /** UBNT-AirMAX-MIB ubntStaTable: stations registered on the airMAX interface. */
    private const val UBNT_STA = "1.3.6.1.4.1.41112.1.4.7.1"
    private const val LLDP_LOC_CAPS = "1.0.8802.1.1.2.1.3.6.0"
    /** ipAddrTable: 1 address, 3 netmask. */
    private const val IP_ADDR = "1.3.6.1.2.1.4.20.1"

    private val CAP_NAMES = listOf("other", "repeater", "bridge", "wlan access point", "router", "telephone", "docsis cable device", "station")

    /** LLDP capability BITS (first bit = other) as names. */
    fun capabilities(raw: ByteArray?): Set<String> {
        if (raw == null) return emptySet()
        return CAP_NAMES.filterIndexed { i, _ -> i / 8 < raw.size && (raw[i / 8].toInt() shr (7 - i % 8)) and 1 == 1 }.toSet()
    }

    /** "192.168.10.5" + "255.255.255.0" → "192.168.10.0/24" (loopback, link-local and /32 skipped). */
    fun subnetOf(addr: String, mask: String): String? {
        val a = addr.split('.').mapNotNull { it.toIntOrNull() }
        val m = mask.split('.').mapNotNull { it.toIntOrNull() }
        if (a.size != 4 || m.size != 4 || a[0] == 127 || (a[0] == 169 && a[1] == 254)) return null
        val bits = m.sumOf { Integer.bitCount(it) }
        if (bits !in 8..30) return null
        return a.zip(m) { x, y -> x and y }.joinToString(".") + "/$bits"
    }

    /** sysName/sysDescr with the first community that answers, or null. */
    fun probe(ip: String, communities: List<String>, timeoutMs: Int = 700): Pair<String, Map<String, String?>>? {
        for (c in communities) {
            val v = runCatching { Snmp.get(ip, c, listOf("$SYS.5.0", "$SYS.1.0"), timeoutMs) }.getOrNull() ?: continue
            return c to v
        }
        return null
    }

    private fun suffix(oid: String, root: String) = oid.removePrefix("$root.")

    /** The last six numbers of an index as a MAC address. */
    fun macFromIndex(parts: List<String>): String? {
        val last = parts.takeLast(6)
        if (last.size != 6) return null
        val bytes = last.map { it.toIntOrNull()?.takeIf { b -> b in 0..255 } ?: return null }
        return bytes.joinToString(":") { "%02X".format(it) }
    }

    /** Column → value of each row of a table (rows keyed by the index after the column number). */
    private fun table(vars: List<Snmp.Var>, root: String): Map<String, Map<Int, Snmp.Var>> {
        val rows = linkedMapOf<String, MutableMap<Int, Snmp.Var>>()
        for (v in vars) {
            val parts = suffix(v.oid, root).split('.')
            val col = parts.firstOrNull()?.toIntOrNull() ?: continue
            if (parts.size < 2) continue
            rows.getOrPut(parts.drop(1).joinToString(".")) { mutableMapOf() }[col] = v
        }
        return rows
    }

    private fun ipOf(v: Snmp.Var?) = v?.raw?.takeIf { it.size == 4 }?.joinToString(".") { (it.toInt() and 0xff).toString() }

    /** Reads one device (blocking: call on Dispatchers.IO, on the Wi-Fi network). */
    fun collect(ip: String, community: String, sysName: String, sysDescr: String): SnmpDevice {
        fun walk(root: String) = runCatching { Snmp.walk(ip, community, root) }.getOrDefault(emptyList())
        val ifNames = (walk(IF_NAME).ifEmpty { walk(IF_DESCR) }).mapNotNull { v -> v.oid.substringAfterLast('.').toIntOrNull()?.let { it to v.text } }.toMap()
        fun ifName(i: Int) = ifNames[i] ?: "if $i"
        val ownMacs = walk(IF_PHYS).mapNotNull { it.mac }.filter { it != "00:00:00:00:00:00" }.toSet()
        val up = walk(IF_OPER).mapNotNull { v -> v.oid.substringAfterLast('.').toIntOrNull()?.takeIf { v.int == 1L } }.toSet()
        val speeds = walk(IF_HIGH_SPEED).mapNotNull { v ->
            val i = v.oid.substringAfterLast('.').toIntOrNull() ?: return@mapNotNull null
            v.int?.takeIf { it > 0 && i in up }?.let { ifName(i) to it }
        }.toMap()
        val sysObjectId = runCatching { Snmp.get(ip, community, listOf("$SYS.2.0"), 1500)["$SYS.2.0"] }.getOrNull()
        val ownCaps = capabilities(walk(LLDP_LOC_CAPS.substringBeforeLast('.')).firstOrNull()?.raw)
        val ipAddr = table(walk(IP_ADDR), IP_ADDR)
        val subnets = ipAddr.values.mapNotNull { cols -> val a = ipOf(cols[1]); val m = ipOf(cols[3]); if (a != null && m != null) subnetOf(a, m) else null }.toSet()
        val portIf = walk(BRIDGE_PORT_IF).mapNotNull { v -> v.oid.substringAfterLast('.').toIntOrNull()?.let { bp -> v.int?.toInt()?.let { bp to it } } }.toMap()
        fun portName(bridgePort: Int): String = portIf[bridgePort]?.let { ifNames[it] } ?: "porta $bridgePort"
        val fdb = linkedMapOf<String, String>()
        for (v in walk(FDB_PORT) + walk(QFDB_PORT)) {
            val mac = macFromIndex(v.oid.split('.')) ?: continue
            val bp = v.int?.toInt() ?: continue
            if (bp > 0) fdb[mac] = portName(bp)
        }
        val neighbors = mutableListOf<Neighbor>()
        // LLDP: local port names, remote table (index timeMark.localPort.remIndex), management addresses
        val locPorts = (walk(LLDP_LOC_PORT_DESC).ifEmpty { walk(LLDP_LOC_PORT_ID) }).mapNotNull { v -> v.oid.substringAfterLast('.').toIntOrNull()?.let { it to v.text } }.toMap()
        val manIp = walk(LLDP_MAN).mapNotNull { v ->
            val p = suffix(v.oid, LLDP_MAN).split('.')
            // timeMark.localPort.remIndex.addrSubtype(1=IPv4).addrLen(4).a.b.c.d
            if (p.size >= 9 && p[3] == "1" && p[4] == "4") "${p[1]}.${p[2]}" to p.takeLast(4).joinToString(".") else null
        }.toMap()
        for ((key, cols) in table(walk(LLDP_REM), LLDP_REM)) {
            val parts = key.split('.')
            if (parts.size < 3) continue
            val localPort = parts[1].toIntOrNull() ?: continue
            neighbors += Neighbor(
                localPort = locPorts[localPort] ?: ifNames[localPort] ?: "porta $localPort",
                remoteName = cols[9]?.text?.ifBlank { null },
                remotePort = (cols[8]?.text?.ifBlank { null } ?: cols[7]?.let { it.mac ?: it.text })?.ifBlank { null },
                remoteMac = cols[5]?.mac,
                remoteIp = manIp["${parts[1]}.${parts[2]}"],
                protocol = "LLDP",
                remotePlatform = cols[10]?.text?.lineSequence()?.firstOrNull()?.take(60)?.ifBlank { null },
                capabilities = capabilities(cols[12]?.raw),
            )
        }
        // CDP (Cisco and compatible): index ifIndex.deviceIndex; 4 address, 6 device id, 7 port, 8 platform
        for ((key, cols) in table(walk(CDP_CACHE), CDP_CACHE)) {
            val ifIndex = key.split('.')[0].toIntOrNull() ?: continue
            neighbors += Neighbor(ifName(ifIndex), cols[6]?.text, cols[7]?.text, null, ipOf(cols[4]), "CDP", cols[8]?.text?.ifBlank { null })
        }
        // MikroTik: 2 ip, 3 mac, 5 platform, 6 identity, 8 local interface (ifIndex)
        for ((_, cols) in table(walk(MTXR_NEIGHBOR), MTXR_NEIGHBOR)) {
            val local = cols[8]?.int?.toInt()?.let(::ifName) ?: continue
            neighbors += Neighbor(local, cols[6]?.text?.ifBlank { null }, null, cols[3]?.mac, ipOf(cols[2]), "MNDP", cols[5]?.text?.ifBlank { null })
        }
        // Ubiquiti airMAX stations: index wlanIndex.mac; 2 name, 3 signal, 10 last IP
        val wireless = table(walk(UBNT_STA), UBNT_STA).mapNotNull { (key, cols) ->
            val mac = macFromIndex(key.split('.')) ?: return@mapNotNull null
            WirelessPeer(mac, cols[2]?.text?.ifBlank { null }, ipOf(cols[10])?.takeIf { it != "0.0.0.0" }, cols[3]?.int?.toInt(), "wlan0")
        }
        val arp = linkedMapOf<String, String>()
        for (v in walk(ARP)) {
            val p = suffix(v.oid, ARP).split('.')
            val m = v.mac ?: continue
            if (p.size >= 5) arp[p.takeLast(4).joinToString(".")] = m
        }
        for (v in walk(ARP_PHYS)) {
            // ifIndex.addrType(1=IPv4).len(4).a.b.c.d
            val p = suffix(v.oid, ARP_PHYS).split('.')
            val m = v.mac ?: continue
            if (p.size == 7 && p[1] == "1" && p[2] == "4") arp.putIfAbsent(p.takeLast(4).joinToString("."), m)
        }
        return SnmpDevice(ip, community, sysName, sysDescr, ifNames, ownMacs, fdb, neighbors, arp, speeds, wireless, sysObjectId, ownCaps, subnets)
    }

    fun build(
        hosts: List<ScanHost>,
        snmp: List<SnmpDevice>,
        gatewayIp: String?,
        found: List<it.cdanet.cpeconfigurator.tools.discovery.Found> = emptyList(),
        fingerprints: Map<String, List<String>> = emptyMap(),
    ) = TopologyResult(TopoGraph.build(hosts, snmp, gatewayIp, found, fingerprints), snmp.size, if (snmp.isEmpty()) "base" else "snmp")
}
