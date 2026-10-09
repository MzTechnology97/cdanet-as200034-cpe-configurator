package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.tools.pro.MapCategory
import it.cdanet.cpeconfigurator.tools.pro.NetworkMap
import it.cdanet.cpeconfigurator.tools.pro.ScanHost

private fun categoryColor(c: MapCategory?): Color = when (c) {
    MapCategory.Network -> Color(0xFFF59E0B)
    MapCategory.Ubiquiti -> Color(0xFF0EA5E9)
    MapCategory.MikroTik -> Color(0xFF6366F1)
    MapCategory.Camera -> Color(0xFFEF4444)
    MapCategory.Computer -> Color(0xFF22C55E)
    MapCategory.Nas -> Color(0xFF14B8A6)
    MapCategory.Printer -> Color(0xFFA855F7)
    MapCategory.Phone -> Color(0xFFEC4899)
    MapCategory.Media -> Color(0xFFF97316)
    MapCategory.Iot -> Color(0xFF84CC16)
    MapCategory.Other, null -> Color(0xFF94A3B8)
}

/**
 * Logical map of the scanned LAN: Internet → gateway → device categories → hosts (scroll in both
 * directions). Tapping a host calls [onHost].
 */
@Composable
fun NetworkMapView(hosts: List<ScanHost>, gatewayIp: String?, onHost: (ScanHost) -> Unit) {
    val layout = remember(hosts, gatewayIp) { NetworkMap.build(hosts, gatewayIp) }
    val line = MaterialTheme.colorScheme.outline
    val surface = MaterialTheme.colorScheme.surface
    Box(Modifier.fillMaxWidth().height(480.dp).horizontalScroll(rememberScrollState()).verticalScroll(rememberScrollState())) {
        Box(Modifier.size(layout.width.dp, layout.height.dp)) {
            Canvas(Modifier.size(layout.width.dp, layout.height.dp)) {
                val byId = layout.nodes.associateBy { it.id }
                for (e in layout.edges) {
                    val a = byId[e.from] ?: continue
                    val b = byId[e.to] ?: continue
                    drawLine(
                        line,
                        Offset((a.x + a.w / 2).dp.toPx(), (a.y + a.h).dp.toPx()),
                        Offset((b.x + b.w / 2).dp.toPx(), b.y.dp.toPx()),
                        strokeWidth = 2.dp.toPx(),
                    )
                }
            }
            for (n in layout.nodes) {
                val color = if (n.id == "internet") MaterialTheme.colorScheme.primary else categoryColor(n.category)
                Column(
                    Modifier
                        .offset(n.x.dp, n.y.dp)
                        .size(n.w.dp, n.h.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (n.host != null || n.id == "gw") surface else color.copy(alpha = 0.18f))
                        .border(2.dp, color, RoundedCornerShape(8.dp))
                        .clickable(enabled = n.host != null) { n.host?.let(onHost) }
                        .padding(horizontal = 6.dp, vertical = 4.dp),
                ) {
                    Text(n.label, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (n.sub.isNotBlank()) Text(n.sub, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
