package it.cdanet.cpeconfigurator.tools.topology

import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.tools.Snmp
import it.cdanet.cpeconfigurator.tools.pro.MapCategory
import it.cdanet.cpeconfigurator.tools.pro.MapEdge
import it.cdanet.cpeconfigurator.tools.pro.MapNode
import it.cdanet.cpeconfigurator.tools.pro.NetworkMap
import it.cdanet.cpeconfigurator.tools.pro.NetworkMapLayout
import it.cdanet.cpeconfigurator.tools.pro.ScanHost

/** A neighbor announced by LLDP or CDP on a local port. */
data class Neighbor(val localPort: String, val remoteName: String?, val remotePort: String?, val remoteMac: String?, val remoteIp: String?, val protocol: String)

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
)

data class TopologyResult(val layout: NetworkMapLayout, val snmpDevices: Int, val links: Int, val placedOnPorts: Int, val mode: String)

/**
 * Network topology from SNMP (LLDP/CDP neighbors, switch MAC tables, ARP) built over the IP scan;
 * without SNMP data it falls back to the base map from the gateway ([NetworkMap]). Pure, unit-tested.
 */
object Topology {
    private const val COL = NetworkMap.NODE_W + 18f
    private const val ROW = 78f
    private const val HOST_ROW = 62f

    // ---- SNMP collection (blocking: call on Dispatchers.IO, on the Wi-Fi network) ----------
    private const val SYS = "1.3.6.1.2.1.1"
    private const val IF_NAME = "1.3.6.1.2.1.31.1.1.1.1"
    private const val IF_DESCR = "1.3.6.1.2.1.2.2.1.2"
    private const val IF_PHYS = "1.3.6.1.2.1.2.2.1.6"
    private const val BRIDGE_PORT_IF = "1.3.6.1.2.1.17.1.4.1.2"
    private const val FDB_PORT = "1.3.6.1.2.1.17.4.3.1.2"
    private const val QFDB_PORT = "1.3.6.1.2.1.17.7.1.2.2.1.2"
    private const val LLDP_LOC_PORT_DESC = "1.0.8802.1.1.2.1.3.7.1.4"
    private const val LLDP_LOC_PORT_ID = "1.0.8802.1.1.2.1.3.7.1.3"
    private const val LLDP_REM = "1.0.8802.1.1.2.1.4.1.1"
    private const val LLDP_MAN = "1.0.8802.1.1.2.1.4.2.1.3"
    private const val CDP_CACHE = "1.3.6.1.4.1.9.9.23.1.2.1.1"
    private const val ARP = "1.3.6.1.2.1.4.22.1.2"

    /** sysName/sysDescr with the first community that answers, or null. */
    fun probe(ip: String, communities: List<String>, timeoutMs: Int = 700): Pair<String, Map<String, String?>>? {
        for (c in communities) {
            val v = runCatching { Snmp.get(ip, c, listOf("$SYS.5.0", "$SYS.1.0"), timeoutMs) }.getOrNull() ?: continue
            return c to v
        }
        return null
    }

    private fun suffix(oid: String, root: String) = oid.removePrefix("$root.")
    private fun macFromIndex(parts: List<String>): String? {
        val last = parts.takeLast(6)
        if (last.size != 6) return null
        val bytes = last.map { it.toIntOrNull()?.takeIf { b -> b in 0..255 } ?: return null }
        return bytes.joinToString(":") { "%02X".format(it) }
    }

    fun collect(ip: String, community: String, sysName: String, sysDescr: String): SnmpDevice {
        fun walk(root: String) = runCatching { Snmp.walk(ip, community, root) }.getOrDefault(emptyList())
        val ifNames = (walk(IF_NAME).ifEmpty { walk(IF_DESCR) }).mapNotNull { v -> v.oid.substringAfterLast('.').toIntOrNull()?.let { it to v.text } }.toMap()
        val ownMacs = walk(IF_PHYS).mapNotNull { it.mac }.filter { it != "00:00:00:00:00:00" }.toSet()
        val portIf = walk(BRIDGE_PORT_IF).mapNotNull { v -> v.oid.substringAfterLast('.').toIntOrNull()?.let { bp -> v.int?.toInt()?.let { bp to it } } }.toMap()
        fun portName(bridgePort: Int): String = portIf[bridgePort]?.let { ifNames[it] } ?: "porta $bridgePort"
        val fdb = linkedMapOf<String, String>()
        for (v in walk(FDB_PORT) + walk(QFDB_PORT)) {
            val mac = macFromIndex(v.oid.split('.')) ?: continue
            val bp = v.int?.toInt() ?: continue
            if (bp > 0) fdb[mac] = portName(bp)
        }
        // LLDP: local port names, remote table (index timeMark.localPort.remIndex), management addresses
        val locPorts = (walk(LLDP_LOC_PORT_DESC).ifEmpty { walk(LLDP_LOC_PORT_ID) }).mapNotNull { v -> v.oid.substringAfterLast('.').toIntOrNull()?.let { it to v.text } }.toMap()
        val rem = mutableMapOf<String, MutableMap<Int, Snmp.Var>>()
        for (v in walk(LLDP_REM)) {
            val parts = suffix(v.oid, LLDP_REM).split('.')
            if (parts.size < 4) continue
            rem.getOrPut(parts.drop(1).joinToString(".")) { mutableMapOf() }[parts[0].toInt()] = v
        }
        val manIp = walk(LLDP_MAN).mapNotNull { v ->
            val p = suffix(v.oid, LLDP_MAN).split('.')
            // timeMark.localPort.remIndex.addrSubtype(1=IPv4).addrLen(4).a.b.c.d
            if (p.size >= 9 && p[3] == "1" && p[4] == "4") "${p[1]}.${p[2]}" to p.takeLast(4).joinToString(".") else null
        }.toMap()
        val neighbors = mutableListOf<Neighbor>()
        for ((key, cols) in rem) {
            val localPort = key.split('.')[1].toIntOrNull() ?: continue
            neighbors += Neighbor(
                localPort = locPorts[localPort] ?: ifNames[localPort] ?: "porta $localPort",
                remoteName = cols[9]?.text?.ifBlank { null },
                remotePort = (cols[8]?.text?.ifBlank { null } ?: cols[7]?.let { it.mac ?: it.text })?.ifBlank { null },
                remoteMac = cols[5]?.mac,
                remoteIp = manIp[key.substringAfter('.')], // key = timeMark.localPort.remIndex
                protocol = "LLDP",
            )
        }
        // CDP (Cisco and compatible): index ifIndex.deviceIndex; 4 address, 6 device id, 7 port
        val cdp = mutableMapOf<String, MutableMap<Int, Snmp.Var>>()
        for (v in walk(CDP_CACHE)) {
            val parts = suffix(v.oid, CDP_CACHE).split('.')
            if (parts.size < 3) continue
            cdp.getOrPut(parts.drop(1).joinToString(".")) { mutableMapOf() }[parts[0].toInt()] = v
        }
        for ((key, cols) in cdp) {
            val ifIndex = key.split('.')[0].toIntOrNull() ?: continue
            val addr = cols[4]?.raw?.takeIf { it.size == 4 }?.joinToString(".") { (it.toInt() and 0xff).toString() }
            neighbors += Neighbor(ifNames[ifIndex] ?: "if $ifIndex", cols[6]?.text, cols[7]?.text, null, addr, "CDP")
        }
        val arp = walk(ARP).mapNotNull { v ->
            val p = suffix(v.oid, ARP).split('.')
            v.mac?.let { m -> if (p.size >= 5) p.takeLast(4).joinToString(".") to m else null }
        }.toMap()
        return SnmpDevice(ip, community, sysName, sysDescr, ifNames, ownMacs, fdb, neighbors, arp)
    }

    // ---- Graph building (pure) ---------------------------------------------------------------
    private fun category(d: SnmpDevice): MapCategory {
        val s = (d.sysDescr + " " + d.sysName).lowercase()
        return when {
            "mikrotik" in s || "routeros" in s -> MapCategory.MikroTik
            "ubiquiti" in s || "unifi" in s || "edgeswitch" in s || "airos" in s -> MapCategory.Ubiquiti
            else -> MapCategory.Network
        }
    }

    private class TNode(val id: String, val label: String, var sub: String, val host: ScanHost?, val category: MapCategory?, val infra: Boolean) {
        var parent: String? = null
        var port: String? = null
    }

    fun build(hosts: List<ScanHost>, snmp: List<SnmpDevice>, gatewayIp: String?): TopologyResult {
        if (snmp.isEmpty()) return TopologyResult(NetworkMap.build(hosts, gatewayIp), 0, 0, 0, "base")
        val byIp = hosts.associateBy { it.ip }
        val gwIp = hosts.firstOrNull { it.isGateway }?.ip ?: gatewayIp
        // MACs: from the scan, then from every ARP table
        val macOf = mutableMapOf<String, String>()
        hosts.forEach { h -> h.mac?.let { macOf[h.ip] = it.uppercase() } }
        snmp.forEach { d -> d.arp.forEach { (ip, m) -> macOf.putIfAbsent(ip, m) } }
        val owner = mutableMapOf<String, String>() // MAC → infra ip
        snmp.forEach { d -> d.ownMacs.forEach { owner[it] = d.ip }; macOf[d.ip]?.let { owner[it] = d.ip } }

        val nodes = linkedMapOf<String, TNode>()
        val gwId = "gw"
        val gwSnmp = snmp.firstOrNull { it.ip == gwIp }
        val gwHost = gwIp?.let { byIp[it] }
        nodes[gwId] = TNode(gwId, gwSnmp?.sysName?.ifBlank { null } ?: gwHost?.let { it.hostname ?: it.vendor } ?: "Gateway", gwIp ?: "gateway", gwHost, gwSnmp?.let { category(it) } ?: MapCategory.Network, true)
        val idOf = { ip: String -> if (ip == gwIp) gwId else "dev:$ip" }
        for (d in snmp) if (d.ip != gwIp) nodes[idOf(d.ip)] = TNode(idOf(d.ip), d.sysName.ifBlank { d.ip }, d.ip, byIp[d.ip], category(d), true)

        // infra links from LLDP/CDP
        val infraIps = snmp.map { it.ip }.toSet() + listOfNotNull(gwIp)
        val bySysName = snmp.associateBy { it.sysName.lowercase() }
        val adj = mutableMapOf<String, MutableList<Triple<String, String, String?>>>() // id → (otherId, localPort, remotePort)
        var links = 0
        for (d in snmp) for (n in d.neighbors) {
            val other = n.remoteIp?.takeIf { it in infraIps } ?: n.remoteMac?.let { owner[it] } ?: n.remoteName?.lowercase()?.let { bySysName[it]?.ip ?: bySysName[it.substringBefore('.')]?.ip }
            if (other == null || other == d.ip) continue
            adj.getOrPut(idOf(d.ip)) { mutableListOf() } += Triple(idOf(other), n.localPort, n.remotePort)
            adj.getOrPut(idOf(other)) { mutableListOf() } += Triple(idOf(d.ip), n.remotePort ?: "?", n.localPort)
            links++
        }
        // orient the tree from the gateway (BFS over the LLDP/CDP links)
        val reached = mutableSetOf(gwId)
        val queue = ArrayDeque(listOf(gwId))
        val linkPorts = mutableMapOf<String, MutableSet<String>>() // infra id → ports used by infra links
        while (queue.isNotEmpty()) {
            val cur = queue.removeFirst()
            for ((other, localPort, remotePort) in adj[cur].orEmpty()) {
                linkPorts.getOrPut(cur) { mutableSetOf() } += localPort
                remotePort?.let { linkPorts.getOrPut(other) { mutableSetOf() } += it }
                if (other in reached || other !in nodes) continue
                reached += other
                nodes.getValue(other).apply { parent = cur; port = localPort }
                queue += other
            }
        }
        // the gateway's MACs (scan/ARP and, when it answers SNMP, its own interfaces): where a switch
        // learns them is its uplink
        val gwMacs = listOfNotNull(gwIp?.let { macOf[it] }) + gwSnmp?.ownMacs.orEmpty()
        val snmpById = snmp.associateBy { idOf(it.ip) }
        val uplink = snmp.associate { d -> idOf(d.ip) to gwMacs.firstNotNullOfOrNull { d.fdb[it] } }
        fun macsOnPort(d: SnmpDevice, port: String) = d.fdb.values.count { it == port }
        // infra not linked by LLDP/CDP: parent = the switch that sees it on a non-uplink port (fewest MACs), else the gateway
        var progress = true
        while (progress) {
            progress = false
            for ((id, n) in nodes) {
                if (id in reached) continue
                val myMacs = snmpById[id]?.let { d -> d.ownMacs + listOfNotNull(macOf[d.ip]) }.orEmpty()
                val best = reached.mapNotNull { pid -> snmpById[pid]?.let { pd ->
                    myMacs.firstNotNullOfOrNull { m -> pd.fdb[m] }?.takeIf { it != uplink[pid] }?.let { p -> Triple(pid, p, macsOnPort(pd, p)) }
                } }.minByOrNull { it.third }
                if (best != null) {
                    n.parent = best.first
                    n.port = best.second
                    linkPorts.getOrPut(best.first) { mutableSetOf() } += best.second
                    reached += id
                    progress = true
                }
            }
        }
        for ((id, n) in nodes) if (id !in reached) { n.parent = gwId; reached += id }

        // end devices: on the access port (non-uplink, non-infra) with the fewest MACs
        var placed = 0
        for (h in hosts.sortedBy { Ip.parse(it.ip) ?: Long.MAX_VALUE }) {
            if (h.ip == gwIp || h.ip in infraIps) continue
            val mac = h.mac?.uppercase() ?: macOf[h.ip]
            val best = mac?.let { m ->
                snmp.mapNotNull { d ->
                    val id = idOf(d.ip)
                    d.fdb[m]?.takeIf { p -> p != uplink[id] && p !in linkPorts[id].orEmpty() }?.let { p -> Triple(id, p, macsOnPort(d, p)) }
                }.minByOrNull { it.third }
            }
            val n = TNode("host:${h.ip}", h.hostname ?: h.netbios ?: h.ubnt?.fullModel ?: h.vendor ?: h.kind.ifBlank { "dispositivo" }, h.ip, h, NetworkMap.category(h), false)
            n.parent = best?.first ?: gwId
            n.port = best?.second
            if (best != null) placed++
            nodes[n.id] = n
        }
        return TopologyResult(layout(nodes, gwId), snmp.size, links, placed, "snmp")
    }

    /** Tree layout: each device has its end devices in a column below, its downstream devices on the right. */
    private fun layout(nodes: Map<String, TNode>, rootId: String): NetworkMapLayout {
        val kids = nodes.values.filter { it.parent != null }.groupBy { it.parent!! }
        val out = mutableListOf<MapNode>()
        val edges = mutableListOf<MapEdge>()
        var height = 0f
        out += MapNode("internet", "Internet", "", null, null, 18f, 18f, NetworkMap.NODE_W, NetworkMap.NODE_H)
        edges += MapEdge("internet", rootId)
        fun place(id: String, col: Int, depth: Int): Int {
            val n = nodes.getValue(id)
            val y = 18f + (depth + 1) * ROW
            val sub = listOfNotNull(n.port?.let { "porta $it" }, n.sub.takeIf { it.isNotBlank() }).joinToString(" · ")
            out += MapNode(id, n.label.take(24), sub, n.host, n.category, 18f + col * COL, y, NetworkMap.NODE_W, NetworkMap.NODE_H)
            height = maxOf(height, y + NetworkMap.NODE_H + 18f)
            val children = kids[id].orEmpty()
            val ends = children.filter { !it.infra }
            val infra = children.filter { it.infra }.sortedBy { it.label }
            var used = 0
            if (ends.isNotEmpty()) {
                ends.forEachIndexed { j, e ->
                    val ey = y + ROW + j * HOST_ROW
                    val esub = listOfNotNull(e.port?.let { "porta $it" }, e.sub).joinToString(" · ")
                    out += MapNode(e.id, e.label.take(24), esub, e.host, e.category, 18f + col * COL, ey, NetworkMap.NODE_W, NetworkMap.NODE_H)
                    edges += MapEdge(if (j == 0) id else ends[j - 1].id, e.id)
                    height = maxOf(height, ey + NetworkMap.NODE_H + 18f)
                }
                used = 1
            }
            for (c in infra) {
                edges += MapEdge(id, c.id)
                used += place(c.id, col + used, depth + 1)
            }
            return maxOf(1, used)
        }
        val cols = place(rootId, 0, 0)
        return NetworkMapLayout(out, edges, 18f + cols * COL, height)
    }
}
