package it.cdanet.cpeconfigurator.ui.screens

import androidx.annotation.DrawableRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.tools.pro.DeviceGuess
import it.cdanet.cpeconfigurator.tools.pro.Ports
import it.cdanet.cpeconfigurator.tools.pro.ScanHost
import it.cdanet.cpeconfigurator.tools.topology.DeviceType
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.WarnAmber

/*
 * Building blocks of the LAN scanner: radar, counters, device mix, address grid and host rows.
 * Technical look: monospace for addresses and ports, colors and icons of the device types shared
 * with the topology graph.
 */

/** Device type of a scanned host, from the guess label. */
internal fun scanType(h: ScanHost): DeviceType = DeviceGuess.type(h.kind, h.isGateway)

/** "192.168.1" of "192.168.1.37": the /24 a host belongs to. */
internal fun net24(ip: String) = ip.substringBeforeLast('.')

/** Latency color: green on the LAN, amber when slow, red when far or overloaded. */
@Composable
internal fun latencyColor(ms: Int?): Color = when {
    ms == null -> MaterialTheme.colorScheme.outline
    ms < 20 -> GoodGreen
    ms < 100 -> WarnAmber
    else -> BadRed
}

/**
 * Radar of the scan: hosts are blips (angle from the address, distance from the latency, color of
 * the type); while scanning a sweep turns and the progress runs on the outer ring.
 */
@Composable
internal fun ScanRadar(hosts: List<ScanHost>, scanning: Boolean, progress: Float?, modifier: Modifier = Modifier, size: Dp = 148.dp) {
    val primary = MaterialTheme.colorScheme.primary
    val ring = MaterialTheme.colorScheme.outlineVariant
    val bg = MaterialTheme.colorScheme.surfaceContainerHighest
    val sweep by rememberInfiniteTransition(label = "radar").animateFloat(
        0f, 360f, infiniteRepeatable(tween(2600, easing = LinearEasing), RepeatMode.Restart), label = "sweep",
    )
    val blips = hosts.map { h ->
        val last = h.ip.substringAfterLast('.').toIntOrNull() ?: 0
        val third = net24(h.ip).substringAfterLast('.').toIntOrNull() ?: 0
        val angle = ((last + third * 37) % 256) / 256f * 360f
        // farther = slower: 1 ms near the center, 200+ ms at the edge
        val dist = h.latencyMs?.let { (kotlin.math.ln(1f + it) / kotlin.math.ln(201f)).coerceIn(0.18f, 0.92f) } ?: 0.86f
        Triple(angle, dist, if (h.isGateway) DeviceType.Router else scanType(h))
    }
    val colors = DeviceType.entries.associateWith { typeColor(it) }
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(size)) {
            val r = this.size.minDimension / 2f
            val c = center
            drawCircle(Brush.radialGradient(listOf(primary.copy(alpha = 0.16f), bg), c, r), r, c)
            for (i in 1..4) drawCircle(ring, r * i / 4f, c, style = Stroke(1.dp.toPx()))
            drawLine(ring, Offset(c.x - r, c.y), Offset(c.x + r, c.y), 1.dp.toPx())
            drawLine(ring, Offset(c.x, c.y - r), Offset(c.x, c.y + r), 1.dp.toPx())
            if (scanning) rotate(sweep, c) {
                drawArc(
                    Brush.sweepGradient(0f to Color.Transparent, 0.82f to Color.Transparent, 1f to primary.copy(alpha = 0.45f), center = c),
                    0f, 360f, true, topLeft = Offset(c.x - r, c.y - r), size = Size(2 * r, 2 * r),
                )
                drawLine(primary, c, Offset(c.x + r, c.y), 2.dp.toPx())
            }
            for ((angle, dist, type) in blips) {
                val a = Math.toRadians(angle.toDouble() - 90)
                val p = Offset(c.x + (r * dist * kotlin.math.cos(a)).toFloat(), c.y + (r * dist * kotlin.math.sin(a)).toFloat())
                val col = colors.getValue(type)
                drawCircle(col.copy(alpha = 0.25f), 6.dp.toPx(), p)
                drawCircle(col, 3.dp.toPx(), p)
            }
            progress?.let {
                drawArc(primary, -90f, 360f * it.coerceIn(0f, 1f), false, topLeft = Offset(c.x - r + 2.dp.toPx(), c.y - r + 2.dp.toPx()),
                    size = Size(2 * r - 4.dp.toPx(), 2 * r - 4.dp.toPx()), style = Stroke(3.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round))
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                "${hosts.size}",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surface.copy(alpha = 0.75f)).padding(horizontal = 6.dp),
            )
            Text("host", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** A small "label value" block in monospace, for the network facts (IP, gateway, DNS…). */
@Composable
internal fun MonoFact(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, letterSpacing = 0.8.sp)
        Text(value, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Counter tile: a big monospace number and its label. */
@Composable
internal fun StatTile(value: String, label: String, @DrawableRes icon: Int, accent: Color, modifier: Modifier = Modifier) {
    Surface(modifier, shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(icon), contentDescription = null, tint = accent, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, maxLines = 1)
        }
    }
}

/** Mix of device types: a stacked bar and a legend that filters the list (tap again to clear). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TypeBreakdown(hosts: List<ScanHost>, selected: DeviceType?, onSelect: (DeviceType?) -> Unit) {
    val counts = remember(hosts.toList()) { hosts.groupingBy { scanType(it) }.eachCount().entries.sortedByDescending { it.value } }
    if (counts.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(5.dp))) {
            counts.forEach { (t, n) -> Box(Modifier.weight(n.toFloat()).height(10.dp).background(typeColor(t).copy(alpha = if (selected == null || selected == t) 1f else 0.25f))) }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            counts.forEach { (t, n) ->
                val on = selected == t
                val col = typeColor(t)
                Row(
                    Modifier
                        .clip(RoundedCornerShape(50))
                        .background(if (on) col.copy(alpha = 0.22f) else MaterialTheme.colorScheme.surfaceContainerHigh)
                        .clickable { onSelect(if (on) null else t) }
                        .padding(start = 6.dp, end = 10.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(painterResource(deviceIcon(t)), contentDescription = null, tint = col, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(5.dp))
                    Text(if (t == DeviceType.Unknown) "Non identificato" else t.label, style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.width(5.dp))
                    Text("$n", style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = col)
                }
            }
        }
    }
}

/**
 * Address map of each scanned /24: 256 cells (.0 top left, .255 bottom right), the used ones in the
 * color of the device type, the gateway outlined. Tap a cell to open that host.
 */
@Composable
internal fun SubnetGrid(hosts: List<ScanHost>, onHost: (ScanHost) -> Unit) {
    val nets = remember(hosts.toList()) { hosts.groupBy { net24(it.ip) }.toSortedMap(compareBy { Ip.parse("$it.0") ?: 0L }) }
    val empty = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f)
    val edge = MaterialTheme.colorScheme.onSurface
    val colors = DeviceType.entries.associateWith { typeColor(it) }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        nets.forEach { (net, list) ->
            val byLast = list.associateBy { it.ip.substringAfterLast('.').toIntOrNull() ?: -1 }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("$net.0/24", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    Text("${list.size}/254 in uso · ${"%.0f".format(list.size * 100f / 254)}%", style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                BoxWithConstraints(Modifier.fillMaxWidth()) {
                    val side = minOf(maxWidth, 520.dp)
                    Canvas(
                        Modifier
                            .size(side)
                            .pointerInput(byLast) {
                                detectTapGestures { pos ->
                                    val cell = this.size.width / 16f
                                    val i = (pos.y / cell).toInt() * 16 + (pos.x / cell).toInt()
                                    byLast[i]?.let(onHost)
                                }
                            },
                    ) {
                        val cell = this.size.width / 16f
                        val gap = 2.dp.toPx()
                        for (i in 0 until 256) {
                            val x = (i % 16) * cell
                            val y = (i / 16) * cell
                            val h = byLast[i]
                            val col = h?.let { colors.getValue(scanType(it)) } ?: empty
                            drawRoundRect(col, Offset(x + gap / 2, y + gap / 2), Size(cell - gap, cell - gap), CornerRadius(3.dp.toPx()))
                            if (h?.isGateway == true || h?.isSelf == true) {
                                drawRoundRect(edge, Offset(x + gap / 2, y + gap / 2), Size(cell - gap, cell - gap), CornerRadius(3.dp.toPx()), style = Stroke(2.dp.toPx()))
                            }
                        }
                    }
                }
                Text(".0 in alto a sinistra, .255 in basso a destra · bordo: gateway e questo telefono", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** A port as a compact monospace chip: number and service, colored by family. */
@Composable
internal fun PortChip(port: Int) {
    val color = when (port) {
        80, 443, 8080, 8443, 8000, 20443 -> Color(0xFF2563EB)
        22, 23, 3389, 5900, 8291, 8728 -> Color(0xFF7C3AED)
        554, 8554, 37777 -> Color(0xFFDC2626)
        139, 445, 548, 5000, 5001 -> Color(0xFF0D9488)
        9100, 631, 515 -> Color(0xFF9333EA)
        53, 67, 123, 161 -> Color(0xFFEA580C)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }.let { if (isDark()) androidx.compose.ui.graphics.lerp(it, Color.White, 0.35f) else it }
    Row(
        Modifier.clip(RoundedCornerShape(6.dp)).background(color.copy(alpha = 0.12f)).padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("$port", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 11.sp, color = color)
        Ports.service(port).takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.width(4.dp))
            Text(it, fontSize = 11.sp, color = color.copy(alpha = 0.85f))
        }
    }
}

/** Small uppercase flag next to the address (GATEWAY, TU). */
@Composable
internal fun Flag(text: String, color: Color) {
    Text(
        text,
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.6.sp,
        color = color,
        modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(color.copy(alpha = 0.14f)).padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

/**
 * One host: type icon with the vendor badge, address and name, type and vendor, latency; the open
 * ports below; expanded, the details and [actions].
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun HostRow(h: ScanHost, expanded: Boolean, onToggle: () -> Unit, actions: @Composable () -> Unit) {
    val type = scanType(h)
    val col = typeColor(type)
    Surface(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = if (expanded) BorderStroke(1.5.dp, col.copy(alpha = 0.7f)) else BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
    ) {
        Column(Modifier.clickable(onClick = onToggle).padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(contentAlignment = Alignment.BottomEnd) {
                    DeviceIcon(type, 44.dp, 22.dp, ghost = false, selected = false)
                    Box(Modifier.padding(end = 0.dp)) { Badge(h.vendor, small = true) }
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(h.ip, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
                        if (h.isGateway) Flag("GATEWAY", WarnAmber)
                        if (h.isSelf) Flag("TU", MaterialTheme.colorScheme.primary)
                    }
                    (h.hostname ?: h.netbios)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    val kindText = h.kind.ifBlank { type.label }
                    Text(
                        // "Router MikroTik · MikroTik" once: the vendor only when the type does not name it
                        listOfNotNull(kindText, h.vendor?.takeIf { v -> !kindText.contains(v.substringBefore(' '), true) }).joinToString(" · "),
                        style = MaterialTheme.typography.labelMedium,
                        color = col,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    val lc = latencyColor(h.latencyMs)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(lc))
                        Spacer(Modifier.width(5.dp))
                        Text(h.latencyMs?.let { "$it ms" } ?: "—", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelMedium, color = lc)
                    }
                    Text(h.how, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (h.ports.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(start = 56.dp)) {
                    h.ports.forEach { PortChip(it) }
                }
            }
            AnimatedVisibility(expanded) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 4.dp)) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
                    DetailLine("MAC", h.mac ?: "non disponibile (Android limita l'ARP)", mono = h.mac != null)
                    DetailLine("Produttore", h.vendor ?: if (h.mac != null) "sconosciuto (registro IEEE)" else "—")
                    DetailLine("Tipo", h.kind.ifBlank { type.label })
                    h.netbios?.takeIf { it != h.hostname }?.let { DetailLine("NetBIOS", it, mono = true) }
                    DetailLine("Rilevato con", h.how + (h.latencyMs?.let { " · $it ms" } ?: ""))
                    if (h.ports.isNotEmpty()) DetailLine("Porte", h.ports.joinToString("  ") { p -> "$p/${Ports.service(p).ifBlank { "tcp" }}" }, mono = true)
                    h.ubnt?.let { u -> DetailLine("Ubiquiti", listOfNotNull(u.fullModel ?: u.model, u.firmware, u.ssid?.let { "SSID $it" }).joinToString(" · ")) }
                    Spacer(Modifier.height(4.dp))
                    actions()
                }
            }
        }
    }
}

@Composable
private fun DetailLine(key: String, value: String, mono: Boolean = false) {
    Row(Modifier.fillMaxWidth()) {
        Text(key, modifier = Modifier.width(104.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, fontFamily = if (mono) FontFamily.Monospace else null)
    }
}

/** Header of a panel: a tinted icon, a title and an optional right-hand slot. */
@Composable
internal fun PanelTitle(title: String, @DrawableRes icon: Int, trailing: (@Composable () -> Unit)? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(30.dp).clip(RoundedCornerShape(9.dp)).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(17.dp))
        }
        Spacer(Modifier.width(10.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}

/** Card of the scanner panels (tonal, rounded, no shadow). */
@Composable
internal fun Panel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(
        modifier.fillMaxWidth().padding(vertical = 5.dp),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f)),
    ) {
        Box(Modifier.padding(14.dp)) { content() }
    }
}

/** "00:42" from seconds. */
internal fun mmss(s: Long) = "%02d:%02d".format(s / 60, s % 60)
