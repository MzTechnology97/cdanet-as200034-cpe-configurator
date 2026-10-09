package it.cdanet.cpeconfigurator.tools.pro

import it.cdanet.cpeconfigurator.network.Ip

/** Device category of the local network map (from the scanner's guess). */
enum class MapCategory(val label: String) {
    Network("Rete (router, AP, switch)"),
    Ubiquiti("Ubiquiti"),
    MikroTik("MikroTik"),
    Camera("Telecamere / NVR"),
    Computer("PC e server"),
    Nas("NAS"),
    Printer("Stampanti"),
    Phone("Telefoni e tablet"),
    Media("TV e multimedia"),
    Iot("IoT / domotica"),
    Other("Altri dispositivi"),
}

data class MapNode(
    val id: String,
    val label: String,
    val sub: String,
    /** null for the structural nodes (Internet, categories). */
    val host: ScanHost?,
    val category: MapCategory?,
    /** Top-left corner and size in dp. */
    val x: Float,
    val y: Float,
    val w: Float,
    val h: Float,
)

data class MapEdge(val from: String, val to: String)

data class NetworkMapLayout(val nodes: List<MapNode>, val edges: List<MapEdge>, val width: Float, val height: Float)

/**
 * Map of the scanned LAN (local tool, nothing from the server): Internet → gateway → device
 * categories → hosts. A logical map (who is behind the gateway, grouped by type): the phone cannot
 * see which switch port a device is on.
 */
object NetworkMap {
    const val NODE_W = 150f
    const val NODE_H = 54f
    private const val GAP_X = 18f
    private const val ROW = 78f
    private const val HOST_ROW = 62f

    fun category(h: ScanHost): MapCategory {
        val k = h.kind.lowercase()
        return when {
            k.startsWith("ubiquiti") || h.ubnt != null -> MapCategory.Ubiquiti
            k.startsWith("mikrotik") -> MapCategory.MikroTik
            k.contains("router") || k.contains("access point") -> MapCategory.Network
            k.contains("telecamera") || k.contains("nvr") || k.contains("rtsp") -> MapCategory.Camera
            k.contains("stampante") -> MapCategory.Printer
            k.contains("nas") -> MapCategory.Nas
            k.contains("pc") || k.contains("server") || k.contains("linux") -> MapCategory.Computer
            k.contains("apple") || k.contains("android") || h.isSelf -> MapCategory.Phone
            k.contains("tv") || k.contains("chromecast") -> MapCategory.Media
            k.contains("iot") -> MapCategory.Iot
            else -> MapCategory.Other
        }
    }

    private fun hostLabel(h: ScanHost) = (h.hostname ?: h.netbios ?: h.ubnt?.fullModel ?: h.ubnt?.model ?: h.vendor ?: h.kind.ifBlank { "dispositivo" }).take(24)

    fun build(hosts: List<ScanHost>, gatewayIp: String?): NetworkMapLayout {
        val gw = hosts.firstOrNull { it.isGateway } ?: gatewayIp?.let { ip -> hosts.firstOrNull { it.ip == ip } }
        val others = hosts.filter { it !== gw }.sortedBy { Ip.parse(it.ip) ?: Long.MAX_VALUE }
        val groups = others.groupBy { category(it) }.toSortedMap(compareBy { it.ordinal })
        val cols = maxOf(1, groups.size)
        val width = cols * (NODE_W + GAP_X) + GAP_X
        val cx = width / 2 - NODE_W / 2
        val nodes = mutableListOf<MapNode>()
        val edges = mutableListOf<MapEdge>()
        nodes += MapNode("internet", "Internet", "", null, null, cx, GAP_X, NODE_W, NODE_H)
        val gwId = "gw"
        nodes += MapNode(gwId, gw?.let { hostLabel(it) } ?: "Gateway", gw?.ip ?: gatewayIp ?: "non rilevato", gw, gw?.let { MapCategory.Network }, cx, GAP_X + ROW, NODE_W, NODE_H)
        edges += MapEdge("internet", gwId)
        var height = GAP_X + 2 * ROW + NODE_H
        groups.entries.forEachIndexed { i, (cat, list) ->
            val x = GAP_X + i * (NODE_W + GAP_X)
            val gid = "cat:${cat.name}"
            val gy = GAP_X + 2 * ROW
            nodes += MapNode(gid, cat.label, "${list.size}", null, cat, x, gy, NODE_W, NODE_H)
            edges += MapEdge(gwId, gid)
            list.forEachIndexed { j, h ->
                val id = "host:${h.ip}"
                val y = gy + ROW + j * HOST_ROW
                nodes += MapNode(id, hostLabel(h), h.ip + if (h.isSelf) " · tu" else "", h, cat, x, y, NODE_W, NODE_H)
                edges += MapEdge(if (j == 0) gid else "host:${list[j - 1].ip}", id)
                height = maxOf(height, y + NODE_H + GAP_X)
            }
        }
        return NetworkMapLayout(nodes, edges, width, height)
    }
}
