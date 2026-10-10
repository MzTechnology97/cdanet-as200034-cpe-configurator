package it.cdanet.cpeconfigurator.ui.screens

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.tools.topology.DeviceType
import it.cdanet.cpeconfigurator.tools.topology.Graph
import it.cdanet.cpeconfigurator.tools.topology.GraphLink
import it.cdanet.cpeconfigurator.tools.topology.LinkKind
import it.cdanet.cpeconfigurator.tools.topology.TopoGraph
import it.cdanet.cpeconfigurator.tools.topology.VendorBadges

private val WirelessBlue = Color(0xFF0EA5E9)

@DrawableRes
fun deviceIcon(t: DeviceType): Int = when (t) {
    DeviceType.Internet -> R.drawable.ic_public
    DeviceType.Router -> R.drawable.ic_router
    DeviceType.Firewall -> R.drawable.ic_shield
    DeviceType.Ont -> R.drawable.ic_device_hub
    DeviceType.Switch -> R.drawable.ic_lan
    DeviceType.AccessPoint -> R.drawable.ic_wifi
    DeviceType.Cpe -> R.drawable.ic_settings_input_antenna
    DeviceType.Camera -> R.drawable.ic_videocam
    DeviceType.Nvr -> R.drawable.ic_dvr
    DeviceType.Computer -> R.drawable.ic_computer
    DeviceType.Server -> R.drawable.ic_dns
    DeviceType.Nas -> R.drawable.ic_storage
    DeviceType.Printer -> R.drawable.ic_print
    DeviceType.Phone -> R.drawable.ic_smartphone
    DeviceType.VoipPhone -> R.drawable.ic_deskphone
    DeviceType.Tv -> R.drawable.ic_tv
    DeviceType.Iot -> R.drawable.ic_lightbulb
    DeviceType.Unknown -> R.drawable.ic_devices_other
}

fun deviceColor(t: DeviceType): Color = when (t) {
    DeviceType.Internet -> Color(0xFF64748B)
    DeviceType.Router, DeviceType.Ont -> Color(0xFF2563EB)
    DeviceType.Firewall -> Color(0xFFDC2626)
    DeviceType.Switch -> Color(0xFF0891B2)
    DeviceType.AccessPoint, DeviceType.Cpe -> Color(0xFF7C3AED)
    DeviceType.Camera, DeviceType.Nvr -> Color(0xFFE11D48)
    DeviceType.Computer, DeviceType.Server -> Color(0xFF16A34A)
    DeviceType.Nas -> Color(0xFF0D9488)
    DeviceType.Printer -> Color(0xFFA855F7)
    DeviceType.Phone, DeviceType.VoipPhone -> Color(0xFFDB2777)
    DeviceType.Tv -> Color(0xFFEA580C)
    DeviceType.Iot -> Color(0xFF65A30D)
    DeviceType.Unknown -> Color(0xFF94A3B8)
}

/** Dark theme: the app background is dark, colors and lines get lighter and stronger. */
@Composable
private fun isDark() = MaterialTheme.colorScheme.background.luminance() < 0.5f

/** The type color, lightened on a dark background so icons and borders stay readable. */
@Composable
private fun typeColor(t: DeviceType): Color = deviceColor(t).let { if (isDark()) lerp(it, Color.White, 0.38f) else it }

@Composable
private fun linkColor(k: LinkKind): Color {
    val dark = isDark()
    return when (k) {
        LinkKind.Lldp, LinkKind.Cdp, LinkKind.Mndp, LinkKind.Uplink -> MaterialTheme.colorScheme.onSurface.copy(alpha = if (dark) 0.9f else 0.75f)
        LinkKind.Wireless -> if (dark) Color(0xFF38BDF8) else WirelessBlue
        LinkKind.Fdb -> if (dark) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f) else MaterialTheme.colorScheme.outline
        LinkKind.Assumed -> if (dark) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f) else MaterialTheme.colorScheme.outline.copy(alpha = 0.7f)
    }
}

private fun DrawScope.linkStroke(k: LinkKind, boost: Float = 1f): Pair<Float, PathEffect?> = when (k) {
    LinkKind.Lldp, LinkKind.Cdp, LinkKind.Mndp, LinkKind.Uplink -> 2.5.dp.toPx() * boost to null
    LinkKind.Wireless -> 2.dp.toPx() * boost to PathEffect.dashPathEffect(floatArrayOf(8.dp.toPx(), 5.dp.toPx()))
    LinkKind.Fdb -> 1.6.dp.toPx() * boost to null
    LinkKind.Assumed -> 1.6.dp.toPx() * boost to PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 5.dp.toPx()))
}

/** Vendor badge (our own short label and color, not the trademark logo). */
@Composable
private fun Badge(vendor: String?, small: Boolean) {
    val b = VendorBadges.of(vendor) ?: return
    Text(
        b.short,
        color = Color.White,
        fontSize = if (small) 7.sp else 8.sp,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(Color(b.color)).padding(horizontal = 3.dp, vertical = 1.dp),
    )
}

@Composable
private fun DeviceIcon(type: DeviceType, size: Dp, iconSize: Dp, ghost: Boolean, selected: Boolean) {
    val color = typeColor(type)
    Box(
        Modifier
            .size(size)
            .alpha(if (ghost) 0.6f else 1f)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surface)
            .background(color.copy(alpha = if (isDark()) 0.22f else 0.14f))
            .border(if (selected) 3.dp else 2.dp, if (selected) MaterialTheme.colorScheme.primary else color, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(deviceIcon(type)), contentDescription = type.label, tint = color, modifier = Modifier.size(iconSize))
    }
}

/**
 * The LAN as a UniFi-like topology: Internet on top, network devices as tiles with the icon of their
 * type and the vendor badge, end devices as small icons under the device they hang from. Pinch to zoom,
 * drag to move (the gestures stay in the map), tap a device for its links. Solid lines: LLDP/CDP/MikroTik;
 * blue dashed: wireless with the signal; thin: from a switch MAC table; dotted: presumed; faint curves:
 * redundant links (rings, second uplinks).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TopologyGraphView(
    graph: Graph,
    selected: String?,
    title: String = "Topologia di rete",
    modifier: Modifier = Modifier,
    /** Shown in a full-screen dialog: the graph takes all the height, "Chiudi" calls [onClose]. */
    fullScreen: Boolean = false,
    onClose: () -> Unit = {},
    onSelect: (String?) -> Unit,
) {
    var full by remember { mutableStateOf(false) }
    if (full) {
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { full = false },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
        ) {
            androidx.compose.material3.Surface(Modifier.fillMaxSize()) {
                Column(Modifier.fillMaxSize().systemBarsPadding().padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    TopologyGraphView(graph, selected, title, Modifier.weight(1f), fullScreen = true, onClose = { full = false }, onSelect = onSelect)
                    selected?.let { id ->
                        Box(Modifier.heightIn(max = 260.dp).verticalScroll(androidx.compose.foundation.rememberScrollState())) {
                            TopologyNodeCard(graph, id, null) { onSelect(null) }
                        }
                    }
                }
            }
        }
    }
    var infraOnly by rememberSaveable { mutableStateOf(graph.nodes.size > 60) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var exporting by remember { mutableStateOf<String?>(null) }
    /** PNG or PDF of what is shown (all devices, or network devices only), then the share sheet. */
    fun export(kind: String) {
        exporting = kind
        scope.launch {
            val f = runCatching {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
                    if (kind == "PNG") TopologyExport.png(context, graph, infraOnly, title) else TopologyExport.pdf(context, graph, infraOnly, title)
                }
            }.getOrNull()
            exporting = null
            if (f != null) TopologyExport.share(context, f, if (kind == "PNG") "image/png" else "application/pdf")
            else android.widget.Toast.makeText(context, "Esportazione non riuscita", android.widget.Toast.LENGTH_SHORT).show()
        }
    }
    var ports by rememberSaveable { mutableStateOf(true) }
    val layout = remember(graph, infraOnly) { TopoGraph.layout(graph, infraOnly) }
    val measurer = rememberTextMeasurer()
    val labelColor = MaterialTheme.colorScheme.onSurfaceVariant
    val pillBg = MaterialTheme.colorScheme.surface
    val colors = LinkKind.entries.associateWith { linkColor(it) }
    val highlight = MaterialTheme.colorScheme.primary
    val dark = isDark()
    val boost = if (dark) 1.3f else 1f
    val faint = if (dark) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f) else MaterialTheme.colorScheme.outline.copy(alpha = 0.55f)
    val wireless = if (dark) Color(0xFF38BDF8) else WirelessBlue

    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BoxWithConstraints(if (fullScreen) Modifier.fillMaxWidth().weight(1f) else Modifier.fillMaxWidth()) {
            // whole graph in view: by width inline, by width and height at full screen (controls and legend aside)
            val fit = (if (fullScreen) minOf(maxWidth.value / layout.width, (maxHeight.value - 140f) / layout.height) else maxWidth.value / layout.width)
                .coerceIn(0.2f, 1f)
            var scale by remember(layout, fit) { mutableFloatStateOf(fit) }
            var offset by remember(layout, fit) { mutableStateOf(Offset.Zero) }
            var area by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
            /** Buttons zoom around the center of the view. */
            fun zoomBy(f: Float) {
                val newScale = (scale * f).coerceIn(0.2f, 3f)
                val center = Offset(area.width / 2f, area.height / 2f)
                offset = (offset - center) * (newScale / scale) + center
                scale = newScale
            }
            Column(if (fullScreen) Modifier.fillMaxSize() else Modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(selected = infraOnly, onClick = { infraOnly = !infraOnly }, label = { Text("Solo apparati di rete") })
                    FilterChip(selected = ports, onClick = { ports = !ports }, label = { Text("Porte") })
                    OutlinedButton(onClick = { zoomBy(1 / 1.4f) }) { Text("−") }
                    OutlinedButton(onClick = { zoomBy(1.4f) }) { Text("+") }
                    OutlinedButton(onClick = { scale = fit; offset = Offset.Zero }) { Text("Adatta") }
                    if (fullScreen) OutlinedButton(onClick = onClose) { Text("Chiudi") }
                    else OutlinedButton(onClick = { full = true }) { Text("Schermo intero") }
                    OutlinedButton(onClick = { export("PNG") }, enabled = exporting == null) { Text(if (exporting == "PNG") "PNG…" else "PNG") }
                    OutlinedButton(onClick = { export("PDF") }, enabled = exporting == null) { Text(if (exporting == "PDF") "PDF…" else "PDF") }
                }
                Box(
                    (if (fullScreen) Modifier.fillMaxWidth().weight(1f) else Modifier.fillMaxWidth().height(560.dp))
                        .onSizeChanged { area = it }
                        .clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                        .clipToBounds()
                        .pointerInput(layout) {
                            detectTransformGestures { centroid, pan, zoom, _ ->
                                val newScale = (scale * zoom).coerceIn(0.2f, 3f)
                                // keep the point under the fingers still while zooming
                                offset = (offset - centroid) * (newScale / scale) + centroid + pan
                                scale = newScale
                            }
                        },
                ) {
                    Box(
                        Modifier
                            .graphicsLayer {
                                transformOrigin = TransformOrigin(0f, 0f)
                                scaleX = scale
                                scaleY = scale
                                translationX = offset.x
                                translationY = offset.y
                            }
                            .size(layout.width.dp, layout.height.dp),
                    ) {
                        Canvas(Modifier.size(layout.width.dp, layout.height.dp)) {
                            fun x(v: Float) = v.dp.toPx()
                            val small = TextStyle(color = labelColor, fontSize = 9.sp)
                            fun pill(text: String, at: Offset, color: Color = labelColor) {
                                val m = measurer.measure(text, TextStyle(color = color, fontSize = 9.sp, fontWeight = FontWeight.SemiBold))
                                val pad = 3.dp.toPx()
                                drawRoundRect(pillBg, at - Offset(m.size.width / 2f + pad, m.size.height / 2f + 1), androidx.compose.ui.geometry.Size(m.size.width + 2 * pad, m.size.height + 2f), androidx.compose.ui.geometry.CornerRadius(6.dp.toPx()))
                                drawText(m, topLeft = at - Offset(m.size.width / 2f, m.size.height / 2f))
                            }
                            // measured without width limit: a label near the right edge must not fail
                            fun text(t: String, at: Offset, style: TextStyle) = drawText(measurer.measure(t, style), topLeft = at)
                            fun styleOf(l: GraphLink) = linkStroke(l.kind, boost)
                            fun colorOf(l: GraphLink) = if (selected != null && (l.a == selected || l.b == selected)) highlight else colors.getValue(l.kind)

                            // redundant links first (behind everything): faint curves between tile centers
                            for (l in layout.extra) {
                                val a = layout.byId[l.a] ?: continue
                                val b = layout.byId[l.b] ?: continue
                                val p1 = Offset(x(a.x + a.w / 2), x(a.y + a.h / 2))
                                val p2 = Offset(x(b.x + b.w / 2), x(b.y + b.h / 2))
                                val bend = Offset(0f, -minOf(160.dp.toPx(), kotlin.math.abs(p2.x - p1.x) / 3 + 40.dp.toPx()))
                                val path = Path().apply { moveTo(p1.x, p1.y); cubicTo(p1.x + bend.x, p1.y + bend.y, p2.x + bend.x, p2.y + bend.y, p2.x, p2.y) }
                                val c = if (selected != null && (l.a == selected || l.b == selected)) highlight else if (l.kind == LinkKind.Wireless) wireless.copy(alpha = 0.7f) else faint
                                drawPath(path, c, style = Stroke(1.6.dp.toPx() * boost, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx()))))
                                if (ports) {
                                    val mid = Offset((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 + bend.y * 0.75f)
                                    pill(listOfNotNull(l.aPort, l.bPort).joinToString(" ↔ ").ifBlank { l.kind.label }.take(26), mid)
                                }
                            }
                            // tree: elbow lines to network devices, a bus to the end devices
                            for ((parentId, l) in layout.tree) {
                                val p = layout.byId[parentId] ?: continue
                                val childId = if (l.a == parentId) l.b else l.a
                                val c = layout.byId[childId] ?: continue
                                val (w, effect) = styleOf(l)
                                val color = colorOf(l)
                                val px = x(p.x + p.w / 2)
                                val top = x(p.y + p.h - 18f) // under the icon and label of the tile
                                if (c.client) {
                                    val cy = x(c.y + 20f)
                                    drawLine(color, Offset(px, top), Offset(px, cy), w, pathEffect = effect)
                                    val cx = x(c.x + c.w / 2)
                                    drawLine(color, Offset(px, cy), Offset(cx, cy), w, pathEffect = effect)
                                    l.signalDbm?.let { pill("$it dBm", Offset((px + cx) / 2, cy - 9.dp.toPx()), wireless) }
                                } else {
                                    val cx = x(c.x + c.w / 2)
                                    val cTop = x(c.y)
                                    val mid = cTop - 26.dp.toPx()
                                    val path = Path().apply { moveTo(px, top); lineTo(px, mid); lineTo(cx, mid); lineTo(cx, cTop) }
                                    drawPath(path, color, style = Stroke(w, pathEffect = effect))
                                    if (ports) {
                                        val parentPort = if (l.a == parentId) l.aPort else l.bPort
                                        val childPort = if (l.a == parentId) l.bPort else l.aPort
                                        val label = listOfNotNull(parentPort, childPort?.let { "→ $it" }).joinToString(" ")
                                        if (label.isNotBlank()) pill(label.take(24), Offset(cx, mid + 12.dp.toPx()))
                                        l.speedMbps?.let { text(if (it >= 1000) "${it / 1000} G" else "$it M", Offset(cx + 5.dp.toPx(), cTop - 12.dp.toPx()), small) }
                                    }
                                    l.signalDbm?.let { pill("$it dBm", Offset(cx, mid - 10.dp.toPx()), wireless) }
                                }
                            }
                        }
                        for (p in layout.nodes) {
                            val n = p.node
                            val isSel = n.id == selected
                            Column(
                                Modifier
                                    .offset(p.x.dp, p.y.dp)
                                    .size(p.w.dp, p.h.dp)
                                    .clip(RoundedCornerShape(10.dp))
                                    .clickable(enabled = n.id != TopoGraph.INTERNET) { onSelect(if (isSel) null else n.id) },
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Box(contentAlignment = Alignment.BottomEnd) {
                                    if (p.client) DeviceIcon(n.type, 42.dp, 22.dp, n.ghost, isSel) else DeviceIcon(n.type, 58.dp, 32.dp, n.ghost, isSel)
                                    Box(Modifier.offset(x = 6.dp, y = 2.dp)) { Badge(n.vendor, p.client) }
                                }
                                Text(
                                    (if (n.isGateway) "★ " else "") + n.label,
                                    style = if (p.client) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelMedium,
                                    fontWeight = if (p.client) FontWeight.Normal else FontWeight.Bold,
                                    textAlign = TextAlign.Center,
                                    maxLines = if (p.client) 2 else 1,
                                    overflow = TextOverflow.Ellipsis,
                                    lineHeight = if (p.client) 11.sp else 14.sp,
                                    modifier = Modifier.padding(top = 2.dp),
                                )
                                if (!p.client) {
                                    val sub = listOfNotNull(
                                        if (n.ghost) "fuori scansione" else n.ip,
                                        if (p.hidden > 0) "+${p.hidden}" else null,
                                    ).joinToString(" · ")
                                    if (sub.isNotBlank()) Text(sub, style = MaterialTheme.typography.labelSmall, color = labelColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                }
            }
        }
        GraphLegend()
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GraphLegend() {
    val items = listOf(
        LinkKind.Lldp to "LLDP / CDP / MikroTik",
        LinkKind.Wireless to "wireless (segnale)",
        LinkKind.Fdb to "dalla tabella MAC",
        LinkKind.Assumed to "presunto",
    )
    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        for ((k, label) in items) {
            val c = linkColor(k)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Canvas(Modifier.width(26.dp).height(10.dp)) {
                    val (w, effect) = linkStroke(k)
                    drawLine(c, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), w, pathEffect = effect)
                }
                Text(" $label", style = MaterialTheme.typography.labelSmall)
            }
        }
        Text("curve tratteggiate: collegamenti ridondanti", style = MaterialTheme.typography.labelSmall)
    }
}

/** Details of the selected device: type, vendor, how it was found and identified, every link. */
@Composable
fun TopologyNodeCard(graph: Graph, id: String, onOpenHost: (() -> Unit)?, onClose: () -> Unit) {
    val n = graph.byId[id] ?: return
    Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(top = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            DeviceIcon(n.type, 40.dp, 22.dp, n.ghost, false)
            Column(Modifier.weight(1f).padding(start = 8.dp)) {
                Text(n.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(listOfNotNull(n.type.label, n.vendor).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = typeColor(n.type))
            }
            TextButton(onClick = onClose) { Text("Chiudi") }
        }
        Text(
            listOfNotNull(n.ip, n.mac, n.model, if (n.isGateway) "gateway" else null, if (n.ghost) "fuori dalla subnet scansionata" else null).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
        )
        if (n.sources.isNotEmpty()) Text("Visto con: " + n.sources.joinToString(", "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (n.fingerprints.isNotEmpty()) Text("Impronte: " + n.fingerprints.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 4, overflow = TextOverflow.Ellipsis)
        val links = graph.linksOf(id).filter { it.kind != LinkKind.Uplink }.sortedBy { it.kind.ordinal }
        Text("Collegamenti (${links.size})", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
        for (l in links) LinkLine(graph, l, id)
        onOpenHost?.let { OutlinedButton(onClick = it) { Text("Apri nell'elenco host") } }
    }
}

@Composable
private fun LinkLine(graph: Graph, l: GraphLink, from: String) {
    val other = graph.byId[graph.other(l, from)]
    val mine = graph.portOn(l, from)
    val theirs = graph.portOn(l, graph.other(l, from))
    Text(
        listOfNotNull(
            mine?.let { "$it →" },
            other?.label,
            theirs?.let { "($it)" },
            "· ${l.seenBy.joinToString("/")}",
            l.speedMbps?.let { if (it >= 1000) "· ${it / 1000} Gbit/s" else "· $it Mbit/s" },
            l.signalDbm?.let { "· $it dBm" },
        ).joinToString(" "),
        style = MaterialTheme.typography.bodySmall,
        color = if (l.kind.certain) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
}
