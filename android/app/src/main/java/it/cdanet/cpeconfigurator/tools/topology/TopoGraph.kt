package it.cdanet.cpeconfigurator.tools.topology

import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.tools.discovery.Found
import it.cdanet.cpeconfigurator.tools.pro.MapCategory
import it.cdanet.cpeconfigurator.tools.pro.NetworkMap
import it.cdanet.cpeconfigurator.tools.pro.ScanHost

/** How sure a link is, from the strongest evidence that produced it. */
enum class LinkKind(val label: String, val certain: Boolean) {
    Uplink("Internet", true),
    Lldp("LLDP", true),
    Cdp("CDP", true),
    Mndp("MikroTik", true),
    Wireless("Wireless", true),
    Fdb("Tabella MAC", false),
    Assumed("Presunto", false),
}

/** A device of the graph: scanned host, SNMP device, or a neighbor only known from LLDP/CDP/MikroTik ("ghost"). */
data class GraphNode(
    val id: String,
    val label: String,
    val ip: String?,
    val mac: String?,
    val category: MapCategory?,
    /** Switch, router, access point, radio: drawn as a tile, can have devices below. */
    val infra: Boolean,
    val host: ScanHost? = null,
    val model: String? = null,
    /** Where the node comes from: SNMP, LLDP, CDP, MikroTik, discovery protocols, scan. */
    val sources: Set<String> = emptySet(),
    /** Not in the scanned subnet: known only because a neighbor announced it. */
    val ghost: Boolean = false,
    val isGateway: Boolean = false,
    val type: DeviceType = DeviceType.Unknown,
    val vendor: String? = null,
    /** HTTP/SSH/RTSP/SIP/WS-Discovery/mDNS texts that identified it. */
    val fingerprints: List<String> = emptyList(),
)

/** A link between two nodes; ports are the interface names on each side (when known). */
data class GraphLink(
    val a: String,
    val b: String,
    val kind: LinkKind,
    val aPort: String? = null,
    val bPort: String? = null,
    /** Port speed in Mbit/s, wireless signal in dBm. */
    val speedMbps: Long? = null,
    val signalDbm: Int? = null,
    /** Every protocol that saw this link (LLDP from both sides, CDP and LLDP together…). */
    val seenBy: Set<String> = emptySet(),
)

data class Graph(val nodes: List<GraphNode>, val links: List<GraphLink>) {
    val byId: Map<String, GraphNode> by lazy { nodes.associateBy { it.id } }
    fun linksOf(id: String) = links.filter { it.a == id || it.b == id }
    fun other(l: GraphLink, id: String) = if (l.a == id) l.b else l.a
    fun portOn(l: GraphLink, id: String) = if (l.a == id) l.aPort else l.bPort
}

/**
 * The LAN as a real graph (loops, redundant links, ghosts), from the IP scan, the multi-vendor
 * discovery, fingerprints and SNMP: LLDP, CDP and MikroTik neighbors are certain links, Ubiquiti
 * stations are wireless links, bridge MAC tables place the rest on the switch access port, and what
 * cannot be placed is linked to the gateway as "presunto". Pure, unit-tested.
 */
object TopoGraph {
    const val INTERNET = "internet"

    private fun modelOf(d: SnmpDevice) = d.sysDescr.lineSequence().firstOrNull()?.take(60)?.ifBlank { null }

    fun build(
        hosts: List<ScanHost>,
        snmp: List<SnmpDevice>,
        gatewayIp: String?,
        found: List<Found> = emptyList(),
        fingerprints: Map<String, List<String>> = emptyMap(),
    ): Graph {
        val gwIp = hosts.firstOrNull { it.isGateway }?.ip ?: gatewayIp
        val nodes = linkedMapOf<String, GraphNode>()
        val idOfIp = mutableMapOf<String, String>()
        val idOfMac = mutableMapOf<String, String>()
        val idOfName = mutableMapOf<String, String>()
        fun nameKey(s: String) = s.trim().lowercase().substringBefore('.')
        fun index(n: GraphNode) {
            n.ip?.let { idOfIp[it] = n.id }
            n.mac?.let { idOfMac[it.uppercase()] = n.id }
        }
        val foundByIp = found.groupBy { it.ip }
        // LLDP capabilities and platform that neighbors announce about a device (by IP)
        val announced = snmp.flatMap { it.neighbors }.filter { it.remoteIp != null }.groupBy { it.remoteIp!! }

        fun evidence(h: ScanHost?, d: SnmpDevice?, ip: String?, extraCaps: Set<String> = emptySet(), platform: String? = null): DeviceEvidence {
            val fs = ip?.let { foundByIp[it] }.orEmpty()
            val ann = ip?.let { announced[it] }.orEmpty()
            return DeviceEvidence(
                vendor = h?.vendor ?: fs.firstOrNull { it.vendor !in setOf("UPnP", "mDNS", "ONVIF", "WS-Discovery") }?.vendor,
                kind = h?.kind.orEmpty(),
                // the precise product name of discovery before the (often generic) SNMP description
                model = h?.ubnt?.fullModel ?: fs.firstNotNullOfOrNull { it.model } ?: platform ?: ann.firstNotNullOfOrNull { it.remotePlatform } ?: d?.let { modelOf(it) },
                sysDescr = d?.sysDescr,
                sysObjectId = d?.sysObjectId,
                capabilities = d?.capabilities.orEmpty() + extraCaps + ann.flatMap { it.capabilities },
                ports = h?.ports?.toSet().orEmpty(),
                fingerprints = ip?.let { fingerprints[it] }.orEmpty() + fs.flatMap { f -> listOfNotNull(f.protocol, f.details["Tipo"], f.details["Types"], f.details["Servizi"]) },
                protocols = fs.map { it.protocol }.toSet(),
                isGateway = ip != null && ip == gwIp,
                hostname = h?.hostname ?: h?.netbios,
            )
        }

        // scanned hosts (with what discovery added) and SNMP devices
        val snmpByIp = snmp.associateBy { it.ip }
        for (h in hosts.sortedBy { Ip.parse(it.ip) ?: Long.MAX_VALUE }) {
            val d = snmpByIp[h.ip]
            val id = "ip:${h.ip}"
            val ev = evidence(h, d, h.ip)
            val type = DeviceClassifier.classify(ev)
            nodes[id] = GraphNode(
                id = id,
                label = d?.sysName?.ifBlank { null } ?: h.hostname ?: h.netbios ?: h.ubnt?.hostname ?: h.ubnt?.fullModel ?: h.vendor ?: h.kind.ifBlank { h.ip },
                ip = h.ip,
                mac = h.mac?.uppercase(),
                category = NetworkMap.category(h),
                infra = d != null || type.infra || h.ip == gwIp,
                host = h,
                model = ev.model ?: h.kind.ifBlank { null },
                sources = buildSet { add("scan"); if (d != null) add("SNMP"); addAll(ev.protocols) },
                isGateway = h.ip == gwIp,
                // the gateway is drawn as a router unless it is clearly a firewall or a modem/ONT
                type = if (h.ip == gwIp && type !in setOf(DeviceType.Router, DeviceType.Firewall, DeviceType.Ont)) DeviceType.Router else type,
                vendor = DeviceClassifier.vendor(ev),
                fingerprints = fingerprints[h.ip].orEmpty(),
            ).also(::index)
            d?.sysName?.takeIf { it.isNotBlank() }?.let { idOfName[nameKey(it)] = id }
            (h.hostname ?: h.netbios)?.let { idOfName.putIfAbsent(nameKey(it), id) }
        }
        for (d in snmp) if ("ip:${d.ip}" !in nodes) {
            val id = "ip:${d.ip}"
            val ev = evidence(null, d, d.ip)
            val type = DeviceClassifier.classify(ev).let { if (it.infra) it else DeviceType.Switch }
            nodes[id] = GraphNode(id, d.sysName.ifBlank { d.ip }, d.ip, null, MapCategory.Network, true, model = ev.model, sources = setOf("SNMP"), isGateway = d.ip == gwIp, type = type, vendor = DeviceClassifier.vendor(ev)).also(::index)
            if (d.sysName.isNotBlank()) idOfName[nameKey(d.sysName)] = id
        }
        // MACs of SNMP devices' own interfaces and what every ARP table says
        for (d in snmp) d.ownMacs.forEach { idOfMac.putIfAbsent(it.uppercase(), "ip:${d.ip}") }
        val macOfIp = mutableMapOf<String, String>()
        nodes.values.forEach { n -> if (n.ip != null && n.mac != null) macOfIp[n.ip] = n.mac }
        snmp.forEach { d -> d.arp.forEach { (ip, m) -> macOfIp.putIfAbsent(ip, m.uppercase()); idOfIp[ip]?.let { idOfMac.putIfAbsent(m.uppercase(), it) } } }
        // the gateway node exists even when the scan missed it
        val gwId = gwIp?.let { idOfIp[it] } ?: "ip:${gwIp ?: "gateway"}".also { id ->
            nodes[id] = GraphNode(id, "Gateway", gwIp, null, MapCategory.Network, true, sources = setOf("rete"), isGateway = true, type = DeviceType.Router).also(::index)
        }

        // a neighbor announced by a protocol: known node, or a ghost (outside the scan, unmanaged…)
        fun resolve(n: Neighbor, from: String): String {
            n.remoteIp?.let { idOfIp[it] }?.let { return it }
            n.remoteMac?.uppercase()?.let { idOfMac[it] }?.let { return it }
            n.remoteName?.let { idOfName[nameKey(it)] }?.let { return it }
            val key = "ghost:" + (n.remoteMac?.uppercase() ?: n.remoteName?.let(::nameKey) ?: n.remoteIp ?: "$from:${n.localPort}")
            if (key !in nodes) {
                val ev = DeviceEvidence(vendor = if (n.protocol == "MNDP") "MikroTik" else null, model = n.remotePlatform, capabilities = n.capabilities, hostname = n.remoteName)
                val type = DeviceClassifier.classify(ev).let { if (it.infra) it else if (n.protocol == "MNDP") DeviceType.Router else DeviceType.Switch }
                val cat = if (n.protocol == "MNDP") MapCategory.MikroTik else MapCategory.Network
                nodes[key] = GraphNode(key, n.remoteName?.ifBlank { null } ?: n.remoteIp ?: n.remoteMac ?: "vicino", n.remoteIp, n.remoteMac?.uppercase(), cat, true, model = n.remotePlatform, sources = setOf(n.protocol), ghost = true, type = type, vendor = DeviceClassifier.vendor(ev)).also(::index)
                n.remoteName?.let { idOfName[nameKey(it)] = key }
            }
            return key
        }

        val links = mutableListOf<GraphLink>()
        /** Adds a link or merges it with the same one seen from the other side / by another protocol. */
        fun add(a: String, b: String, kind: LinkKind, aPort: String?, bPort: String?, speed: Long? = null, signal: Int? = null) {
            if (a == b) return
            val i = links.indexOfFirst { l ->
                (l.a == a && l.b == b && compatible(l.aPort, aPort) && compatible(l.bPort, bPort)) ||
                    (l.a == b && l.b == a && compatible(l.aPort, bPort) && compatible(l.bPort, aPort))
            }
            if (i < 0) {
                links += GraphLink(a, b, kind, aPort, bPort, speed, signal, setOf(kind.label))
                return
            }
            val l = links[i]
            val same = l.a == a
            links[i] = l.copy(
                kind = if (kind.ordinal < l.kind.ordinal) kind else l.kind,
                aPort = l.aPort ?: if (same) aPort else bPort,
                bPort = l.bPort ?: if (same) bPort else aPort,
                speedMbps = l.speedMbps ?: speed,
                signalDbm = l.signalDbm ?: signal,
                seenBy = l.seenBy + kind.label,
            )
        }

        // 1. certain links: LLDP, CDP, MikroTik neighbors
        for (d in snmp) {
            val me = "ip:${d.ip}"
            for (n in d.neighbors) {
                val kind = when (n.protocol) { "CDP" -> LinkKind.Cdp; "MNDP" -> LinkKind.Mndp; else -> LinkKind.Lldp }
                add(me, resolve(n, me), kind, n.localPort, n.remotePort, d.speeds[n.localPort])
            }
        }
        // 2. wireless: stations registered on Ubiquiti APs (and the AP seen from the station)
        for (d in snmp) {
            val me = "ip:${d.ip}"
            for (w in d.wireless) {
                val peer = w.ip?.let { idOfIp[it] } ?: idOfMac[w.mac.uppercase()] ?: run {
                    val key = "ghost:${w.mac.uppercase()}"
                    if (key !in nodes) nodes[key] = GraphNode(key, w.name?.ifBlank { null } ?: w.ip ?: w.mac, w.ip, w.mac.uppercase(), MapCategory.Ubiquiti, true, sources = setOf("Wireless"), ghost = true, type = DeviceType.Cpe, vendor = "Ubiquiti").also(::index)
                    key
                }
                add(me, peer, LinkKind.Wireless, w.iface, null, signal = w.signal)
            }
        }

        // ports already explained by a certain link, and each switch's uplink (where it learns the gateway)
        val linkedPorts = mutableMapOf<String, MutableSet<String>>()
        for (l in links) {
            l.aPort?.let { linkedPorts.getOrPut(l.a) { mutableSetOf() } += it }
            l.bPort?.let { linkedPorts.getOrPut(l.b) { mutableSetOf() } += it }
        }
        val gwMacs = listOfNotNull(nodes[gwId]?.mac, gwIp?.let { macOfIp[it] }) + (gwIp?.let { snmpByIp[it] }?.ownMacs.orEmpty())
        val uplink = snmp.associate { d -> "ip:${d.ip}" to gwMacs.firstNotNullOfOrNull { d.fdb[it.uppercase()] ?: d.fdb[it] } }
        fun macsOnPort(d: SnmpDevice, port: String) = d.fdb.values.count { it == port }
        /** Nodes connected to the gateway by the links found so far. */
        fun reachable(): Set<String> {
            val seen = mutableSetOf(gwId)
            val queue = ArrayDeque(listOf(gwId))
            while (queue.isNotEmpty()) {
                val cur = queue.removeFirst()
                for (l in links) {
                    val o = if (l.a == cur) l.b else if (l.b == cur) l.a else continue
                    if (seen.add(o)) queue += o
                }
            }
            return seen
        }

        // 3. bridge MAC tables: what is not connected to the gateway yet (a device, or a group like an AP
        //    with its wireless stations) goes on the access port of the switch that sees it: not the
        //    uplink, not a port of a certain link, the one with the fewest MACs. Network devices first.
        var connected = reachable()
        for (n in nodes.values.sortedBy { if (it.infra) 0 else 1 }) {
            if (n.id in connected) continue
            val macs = listOfNotNull(n.mac, n.ip?.let { macOfIp[it] }) + (n.ip?.let { snmpByIp[it] }?.ownMacs.orEmpty())
            val best = snmp.mapNotNull { d ->
                val sid = "ip:${d.ip}"
                if (sid == n.id) return@mapNotNull null
                macs.firstNotNullOfOrNull { m -> d.fdb[m.uppercase()] }
                    ?.takeIf { p -> p != uplink[sid] && p !in linkedPorts[sid].orEmpty() }
                    ?.let { p -> Triple(sid, p, macsOnPort(d, p)) }
            }.minByOrNull { it.third }
            if (best != null) {
                add(best.first, n.id, LinkKind.Fdb, best.second, null, snmp.first { "ip:${it.ip}" == best.first }.speeds[best.second])
                connected = reachable()
            }
        }
        // 4. everything else hangs from the gateway, marked as presumed (one link per isolated group)
        for (n in nodes.values.sortedBy { if (it.infra) 0 else 1 }) {
            if (n.id in connected) continue
            add(gwId, n.id, LinkKind.Assumed, null, null)
            connected = reachable()
        }
        nodes[INTERNET] = GraphNode(INTERNET, "Internet", null, null, null, true, type = DeviceType.Internet)
        links += GraphLink(INTERNET, gwId, LinkKind.Uplink, seenBy = setOf("rete"))
        return Graph(nodes.values.toList(), links)
    }

    /** Port names that may be the same port (unknown matches anything). */
    private fun compatible(x: String?, y: String?) = x == null || y == null || x.equals(y, ignoreCase = true)

    // ---- Layout (UniFi-like tree) -----------------------------------------------------------------

    data class Placed(val node: GraphNode, val x: Float, val y: Float, val w: Float, val h: Float, val hidden: Int = 0, val client: Boolean = false)

    /** Tree edges (parent → child) and the other links (loops, redundant paths) drawn apart. */
    data class Layout(
        val nodes: List<Placed>,
        val tree: List<Pair<String, GraphLink>>,
        val extra: List<GraphLink>,
        val width: Float,
        val height: Float,
    ) {
        val byId: Map<String, Placed> by lazy { nodes.associateBy { it.node.id } }
        /** Child id → its parent's id. */
        val parentOf: Map<String, String> by lazy { tree.associate { (parent, l) -> (if (l.a == parent) l.b else l.a) to parent } }
    }

    const val TILE_W = 104f
    const val TILE_H = 104f
    const val CLIENT_W = 72f
    const val CLIENT_H = 76f
    private const val GAP_X = 22f
    private const val GAP_Y = 64f
    private const val CLIENT_COLS = 4
    private const val CLIENT_GAP = 8f
    /** Extra space in the middle of a client grid for the vertical line. */
    private const val SPINE_GAP = 14f

    /**
     * Top-down tree from Internet like the UniFi topology: each device reaches the tree through its
     * most reliable link (wired protocols first, then wireless, MAC table, presumed); network devices
     * are tiles, end devices small icons in a grid under the device they hang from; every link not in
     * the tree (rings, second uplinks) is kept as an extra link. [infraOnly] hides end devices.
     */
    fun layout(g: Graph, infraOnly: Boolean = false): Layout {
        val client = { n: GraphNode -> !n.infra }
        // spanning tree, one level at a time: a node joins through its best link from the previous level
        val parent = mutableMapOf<String, Pair<String, GraphLink>>()
        val depth = mutableMapOf(INTERNET to 0)
        var frontier = listOf(INTERNET)
        while (frontier.isNotEmpty()) {
            val candidates = mutableMapOf<String, Pair<String, GraphLink>>()
            for (cur in frontier) {
                if (g.byId[cur]?.let(client) == true) continue // end devices do not forward
                for (l in g.linksOf(cur)) {
                    val o = g.other(l, cur)
                    if (o in depth) continue
                    val prev = candidates[o]
                    if (prev == null || l.kind.ordinal < prev.second.kind.ordinal) candidates[o] = cur to l
                }
            }
            for ((id, p) in candidates) { parent[id] = p; depth[id] = depth.getValue(p.first) + 1 }
            frontier = candidates.keys.sortedBy { g.byId[it]?.label }
        }
        val kids = parent.entries.groupBy({ it.value.first }, { it.key })
        fun infraKids(id: String) = kids[id].orEmpty().filter { g.byId[it]?.let(client) == false }.sortedWith(compareBy({ g.byId[it]?.type?.ordinal }, { g.byId[it]?.label }))
        fun clientKids(id: String) = kids[id].orEmpty().filter { g.byId[it]?.let(client) == true }.sortedBy { Ip.parse(g.byId[it]?.ip ?: "") ?: Long.MAX_VALUE }

        // an even number of columns leaves the middle free for the line to the devices below
        fun cols(n: Int) = if (n <= 2) 2 else CLIENT_COLS
        fun gridW(n: Int) = if (n == 0) 0f else cols(n) * (CLIENT_W + CLIENT_GAP) - CLIENT_GAP + SPINE_GAP
        fun gridH(n: Int) = if (n == 0) 0f else ((n + cols(n) - 1) / cols(n)) * (CLIENT_H + CLIENT_GAP) + 18f
        val widths = mutableMapOf<String, Float>()
        fun width(id: String): Float = widths.getOrPut(id) {
            val own = maxOf(TILE_W, if (infraOnly) 0f else gridW(clientKids(id).size))
            val sub = infraKids(id).let { ks -> if (ks.isEmpty()) 0f else ks.sumOf { width(it).toDouble() }.toFloat() + GAP_X * (ks.size - 1) }
            maxOf(own, sub)
        }
        // each level starts below the tallest tile + client grid of the level above
        val levelBottom = mutableMapOf<Int, Float>()
        val placed = mutableListOf<Placed>()
        fun place(id: String, left: Float, y: Float) {
            val n = g.byId.getValue(id)
            val w = width(id)
            val cx = left + w / 2
            val cl = clientKids(id)
            placed += Placed(n, cx - TILE_W / 2, y, TILE_W, TILE_H, if (infraOnly) cl.size else 0)
            var bottom = y + TILE_H
            if (!infraOnly && cl.isNotEmpty()) {
                val c = cols(cl.size)
                val gridLeft = cx - gridW(cl.size) / 2
                cl.forEachIndexed { i, cid ->
                    val col = i % c
                    val row = i / c
                    val gx = gridLeft + col * (CLIENT_W + CLIENT_GAP) + if (col >= c / 2) SPINE_GAP else 0f
                    placed += Placed(g.byId.getValue(cid), gx, y + TILE_H + 18f + row * (CLIENT_H + CLIENT_GAP), CLIENT_W, CLIENT_H, client = true)
                }
                bottom += gridH(cl.size)
            }
            val d = depth.getValue(id)
            levelBottom[d] = maxOf(levelBottom[d] ?: 0f, bottom)
        }
        // breadth-first placement so that a level's y is known before the next one
        var level = listOf(INTERNET to 18f)
        var y = 18f
        while (level.isNotEmpty()) {
            for ((id, left) in level) place(id, left, y)
            val next = mutableListOf<Pair<String, Float>>()
            for ((id, left) in level) {
                val ks = infraKids(id)
                val total = if (ks.isEmpty()) 0f else ks.sumOf { width(it).toDouble() }.toFloat() + GAP_X * (ks.size - 1)
                var x = left + (width(id) - total) / 2
                for (k in ks) { next += k to x; x += width(k) + GAP_X }
            }
            y = (levelBottom[depth.getValue(level.first().first)] ?: y) + GAP_Y
            level = next
        }
        // nodes the tree could not reach (should not happen: every node has a link) go in a last row
        val shownIds = placed.map { it.node.id }.toMutableSet()
        var x = 18f
        for (n in g.nodes) if (n.id !in shownIds && (!infraOnly || n.infra)) {
            placed += Placed(n, x, y, TILE_W, TILE_H)
            shownIds += n.id
            x += TILE_W + GAP_X
        }
        val treeLinks = parent.entries.filter { it.key in shownIds && it.value.first in shownIds }.map { (_, p) -> p.first to p.second }
        val treeSet = treeLinks.map { it.second }.toSet()
        val extra = g.links.filter { it !in treeSet && it.a in shownIds && it.b in shownIds }
        val width = (placed.maxOfOrNull { it.x + it.w } ?: 0f) + 18f
        val height = (placed.maxOfOrNull { it.y + it.h } ?: 0f) + 18f
        return Layout(placed, treeLinks, extra, width, height)
    }

    /** Rows for the CSV export of the links. */
    fun csv(g: Graph): List<List<Any?>> =
        listOf(listOf("Da", "IP da", "Porta da", "A", "IP a", "Porta a", "Tipo collegamento", "Visto da", "Velocità Mbit/s", "Segnale dBm")) +
            g.links.filter { it.kind != LinkKind.Uplink }.map { l ->
                val a = g.byId[l.a]
                val b = g.byId[l.b]
                listOf(a?.label, a?.ip, l.aPort, b?.label, b?.ip, l.bPort, l.kind.label, l.seenBy.joinToString("/"), l.speedMbps, l.signalDbm)
            }

    /** Rows for the CSV export of the devices. */
    fun devicesCsv(g: Graph): List<List<Any?>> =
        listOf(listOf("Nome", "IP", "MAC", "Tipo", "Produttore", "Modello", "Visto con", "Impronte")) +
            g.nodes.filter { it.id != INTERNET }.map { n -> listOf(n.label, n.ip, n.mac, n.type.label, n.vendor, n.model, n.sources.joinToString("/"), n.fingerprints.joinToString(" | ")) }
}
