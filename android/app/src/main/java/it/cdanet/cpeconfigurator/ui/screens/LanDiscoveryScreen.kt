package it.cdanet.cpeconfigurator.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.tools.discovery.Found
import it.cdanet.cpeconfigurator.tools.pro.DeviceGuess
import it.cdanet.cpeconfigurator.tools.topology.TopologyScanner
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.StatusChip
import kotlinx.coroutines.launch

/** What each discovery protocol is, for the protocol board. */
private val PROTOCOL_INFO = mapOf(
    "MNDP" to ("MikroTik" to "UDP 5678"),
    "Ubiquiti" to ("Ubiquiti" to "UDP 10001"),
    "SADP" to ("Hikvision" to "UDP 37020"),
    "Dahua" to ("Dahua" to "UDP 37810"),
    "ONVIF" to ("Telecamere ONVIF" to "WS-Discovery"),
    "WSD" to ("Stampanti, PC" to "UDP 3702"),
    "SSDP" to ("UPnP: router, TV" to "UDP 1900"),
    "mDNS" to ("Apple, NAS, IoT" to "UDP 5353"),
    "NSDP" to ("Netgear" to "UDP 63322"),
)

/** One device seen by one or more protocols. */
private data class Discovered(val ip: String, val found: List<Found>) {
    val vendor = found.map { it.vendor }.firstOrNull { it !in setOf("UPnP", "mDNS", "ONVIF", "WS-Discovery") } ?: found.first().vendor
    val name = found.firstNotNullOfOrNull { it.name }
    val model = found.firstNotNullOfOrNull { it.model }
    val mac = found.firstNotNullOfOrNull { it.mac }
    val firmware = found.firstNotNullOfOrNull { it.firmware }
    val protocols = found.map { it.protocol }.distinct()
    val details = found.flatMap { it.details.entries }.associate { it.key to it.value }
}

/**
 * Multi-vendor discovery: every vendor protocol at once (~4 s), with a board that shows which ones
 * answered; devices with their model, firmware, MAC and the protocols that saw them. The classic
 * tools (ARP table, NetBIOS, port check) stay below.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LanDiscoveryScreen(c: AppContainer) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val scanner = remember { TopologyScanner(c.network) }
    val state = remember { mutableStateMapOf<String, Int>() } // protocol -> answers (-1 = running)
    var devices by remember { mutableStateOf<List<Discovered>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var filter by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<String?>(null) }
    var classic by remember { mutableStateOf(false) }

    fun start() {
        busy = true
        error = null
        filter = null
        scanner.protocols.forEach { state[it] = -1 }
        scope.launch {
            runCatching { scanner.discover { p, n -> state[p] = n } }
                .onSuccess { list -> devices = list.groupBy { it.ip }.map { (ip, fs) -> Discovered(ip, fs) }.sortedBy { Ip.parse(it.ip) ?: Long.MAX_VALUE } }
                .onFailure { error = it.message ?: it.toString() }
            busy = false
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        Panel {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                PanelTitle("Discovery multi-vendor", R.drawable.ic_device_hub) {
                    when {
                        busy -> StatusChip("IN ASCOLTO", NoticeKind.Warn)
                        devices != null -> StatusChip("${devices!!.size} DISPOSITIVI", NoticeKind.Good)
                        else -> {}
                    }
                }
                Text(
                    "Interroga in un colpo solo i protocolli dei produttori: chi risponde dice modello, firmware e MAC, anche se ha un IP di un'altra subnet.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                // protocol board: grey waiting, spinner listening, green with the answers, dim silent
                androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth()) {
                    // as many columns as fit (3 on a phone), cells stretched to the full width
                    val cols = (maxWidth / 112.dp).toInt().coerceIn(3, 9)
                    val cell = (maxWidth - 6.dp * (cols - 1)) / cols - 1.dp // rounding must not push the last one to a new row
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        scanner.protocols.forEach { p -> ProtocolCell(p, state[p], filter == p, Modifier.width(cell)) { if ((state[p] ?: 0) > 0) filter = if (filter == p) null else p } }
                    }
                }
                BusyButton(if (busy) "In ascolto…" else if (devices == null) "Avvia discovery" else "Ripeti discovery", busy, Modifier.fillMaxWidth()) { start() }
                // debug builds only: what the protocols answer on the fictitious office LAN (guide screenshots)
                if (it.cdanet.cpeconfigurator.BuildConfig.DEBUG && !busy && devices == null) TextButton(onClick = {
                    val demo = it.cdanet.cpeconfigurator.tools.topology.TopologyDemo.found
                    scanner.protocols.forEach { p -> state[p] = demo.count { f -> f.protocol == p } }
                    devices = demo.groupBy { f -> f.ip }.map { (ip, fs) -> Discovered(ip, fs) }.sortedBy { d -> Ip.parse(d.ip) ?: Long.MAX_VALUE }
                }) { Text("Dati di esempio (solo build di sviluppo)") }
            }
        }
        devices?.let { list ->
            if (list.isEmpty()) {
                EmptyState(R.drawable.ic_device_hub, "Nessuna risposta", "Nessun apparato ha risposto: verifica di essere sulla stessa LAN (multicast e broadcast non filtrati, isolamento client della Wi-Fi spento).")
            } else {
                val shown = list.filter { filter == null || filter in it.protocols }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp, bottom = 2.dp)) {
                    Text(
                        if (filter == null) "${list.size} dispositivi" else "${shown.size} via $filter",
                        style = MaterialTheme.typography.labelLarge,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.weight(1f),
                    )
                    filter?.let { TextButton(onClick = { filter = null }) { Text("$it ✕") } }
                }
                shown.forEach { d ->
                    DiscoveredRow(d, scanner::kindOf, open == d.ip, { open = if (open == d.ip) null else d.ip }) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            FilledTonalButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("http://${d.ip}"))) } }) { Text("Web") }
                            TextButton(onClick = { context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("IP", d.ip)) }) { Text("Copia IP") }
                            d.mac?.let { mac -> TextButton(onClick = { context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("MAC", mac)) }) { Text("Copia MAC") } }
                        }
                    }
                }
            }
        }
        if (devices == null && !busy) {
            EmptyState(R.drawable.ic_device_hub, "Pronto all'ascolto", "MikroTik, Ubiquiti, Hikvision, Dahua, ONVIF, WS-Discovery, UPnP, mDNS e Netgear in circa 4 secondi.")
        }
        Panel {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { classic = !classic }, verticalAlignment = Alignment.CenterVertically) {
                    Text("Strumenti classici", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    Text(if (classic) "Chiudi" else "Tabella ARP, NetBIOS, porte", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                }
                AnimatedVisibility(classic) { DiscoveryScreen(c) }
            }
        }
    }
}

/** A protocol on the board: who it finds, its port, and how many answered. */
@Composable
private fun ProtocolCell(p: String, answers: Int?, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val (who, port) = PROTOCOL_INFO[p] ?: (p to "")
    val ok = (answers ?: 0) > 0
    val accent = if (ok) GoodGreen else MaterialTheme.colorScheme.outline
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = if (selected) GoodGreen.copy(alpha = 0.18f) else if (ok) GoodGreen.copy(alpha = 0.08f) else MaterialTheme.colorScheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, if (ok) GoodGreen.copy(alpha = 0.6f) else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)),
        modifier = modifier.clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(p, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.weight(1f))
                when {
                    answers == -1 -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
                    answers != null -> Text("$answers", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = accent, fontSize = 13.sp)
                    else -> Box(Modifier.size(7.dp).clip(CircleShape).background(MaterialTheme.colorScheme.outlineVariant))
                }
            }
            Text(who, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(port, fontSize = 10.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

/** A discovered device: icon of its type, vendor badge, name and model, address, protocols. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DiscoveredRow(d: Discovered, kindOf: (Found) -> String, expanded: Boolean, onToggle: () -> Unit, actions: @Composable () -> Unit) {
    val kind = remember(d) { d.found.map(kindOf).firstOrNull { it.isNotBlank() }.orEmpty() }
    val type = DeviceGuess.type(kind.ifBlank { listOfNotNull(d.model, d.name).joinToString(" ") })
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
                    Badge(d.vendor, small = true)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(d.name ?: d.model ?: d.vendor, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(d.ip, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        // the type without the vendor and model already shown ("Switch / router Netgear" → "Switch / router")
                        listOfNotNull(
                            d.vendor,
                            d.model?.takeIf { it != d.name },
                            listOfNotNull(d.vendor, d.model).fold(kind) { k, w -> k.replace(w, "", ignoreCase = true) }.trim().ifBlank { null },
                        ).distinct().joinToString(" · "),
                        style = MaterialTheme.typography.labelMedium,
                        color = col,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(start = 56.dp)) {
                d.protocols.forEach { p ->
                    Text(
                        p,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        fontSize = 11.sp,
                        color = Color(0xFF0D9488),
                        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(Color(0xFF0D9488).copy(alpha = 0.12f)).padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            AnimatedVisibility(expanded) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 4.dp)) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
                    Fact("MAC", d.mac ?: "—", mono = true)
                    d.model?.let { Fact("Modello", it) }
                    d.firmware?.let { Fact("Firmware", it, mono = true) }
                    d.details.forEach { (k, v) -> Fact(k, v) }
                    Spacer(Modifier.size(4.dp))
                    actions()
                }
            }
        }
    }
}

@Composable
private fun Fact(key: String, value: String, mono: Boolean = false) {
    Row(Modifier.fillMaxWidth()) {
        Text(key, modifier = Modifier.width(104.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, fontFamily = if (mono) FontFamily.Monospace else null)
    }
}
