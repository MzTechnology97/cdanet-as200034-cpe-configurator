package it.cdanet.cpeconfigurator.ui.screens

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.wifi.ScanResult
import android.net.wifi.WifiManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.tools.wifi.WifiAp
import it.cdanet.cpeconfigurator.tools.wifi.WifiBand
import it.cdanet.cpeconfigurator.tools.wifi.WifiMath
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import it.cdanet.cpeconfigurator.ui.wifiPanelIntent
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.roundToInt

private val PALETTE = listOf(
    Color(0xFF0EA5E9), Color(0xFFF59E0B), Color(0xFF22C55E), Color(0xFFEF4444), Color(0xFFA855F7), Color(0xFF14B8A6),
    Color(0xFFEC4899), Color(0xFF84CC16), Color(0xFF6366F1), Color(0xFFF97316), Color(0xFF06B6D4), Color(0xFFE11D48),
)

private fun colorOf(ssid: String) = PALETTE[abs(ssid.hashCode()) % PALETTE.size]

private fun qualityColor(rssi: Int) = when {
    rssi >= -67 -> GoodGreen
    rssi >= -75 -> WarnAmber
    else -> BadRed
}

@SuppressLint("MissingPermission")
@Suppress("DEPRECATION")
private fun readScan(wm: WifiManager): List<WifiAp> {
    val connected = runCatching { wm.connectionInfo?.bssid }.getOrNull()?.lowercase()
    return wm.scanResults.orEmpty().map { r: ScanResult ->
        val ssid = if (Build.VERSION.SDK_INT >= 33) r.wifiSsid?.toString()?.trim('"').orEmpty() else r.SSID.orEmpty()
        val width = WifiMath.widthMhz(r.channelWidth)
        val center = if (width > 20 && r.centerFreq0 > 0) r.centerFreq0 else r.frequency
        WifiAp(
            bssid = r.BSSID.orEmpty().uppercase(),
            ssid = ssid.ifBlank { "(nascosta)" },
            freq = r.frequency,
            centerFreq = center,
            widthMhz = width,
            rssi = r.level,
            security = WifiMath.security(r.capabilities.orEmpty()),
            standard = if (Build.VERSION.SDK_INT >= 30) WifiMath.standard(r.wifiStandard, r.frequency) else "",
            connected = connected != null && r.BSSID.equals(connected, ignoreCase = true),
        )
    }
}

/**
 * Wi-Fi analyzer (WiFiman style): spectrum per band, channel occupancy with the recommended
 * channels, signal over time, the networks in view and the current connection. Android allows
 * 4 scans every 2 minutes: results are read every few seconds and a new scan requested every 30 s.
 */
@Composable
fun WifiAnalyzerScreen(c: AppContainer) {
    val context = LocalContext.current
    val wm = c.network.wifiManager
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    var aps by remember { mutableStateOf<List<WifiAp>>(emptyList()) }
    val history = remember { mutableStateMapOf<String, List<Int>>() }
    val vendors = remember { mutableStateMapOf<String, String?>() }
    var band by remember { mutableStateOf(WifiBand.B24) }
    var tab by remember { mutableIntStateOf(0) }
    var lastScan by remember { mutableStateOf(0L) }
    var throttled by remember { mutableStateOf(false) }

    LaunchedEffect(granted) {
        if (!granted) return@LaunchedEffect
        var tick = 0
        while (true) {
            if (tick % 10 == 0) {
                @Suppress("DEPRECATION")
                throttled = !runCatching { wm.startScan() }.getOrDefault(false)
                lastScan = System.currentTimeMillis()
            }
            val now = readScan(wm)
            aps = now
            for (a in now) history[a.bssid] = ((history[a.bssid] ?: emptyList()) + a.rssi).takeLast(40)
            // manufacturer of new BSSIDs from the IEEE registry on the server (when logged in)
            val unknown = now.map { it.bssid }.filter { it !in vendors }
            if (unknown.isNotEmpty() && c.session.token != null) {
                runCatching { c.api.macVendors(unknown) }.onSuccess { m -> unknown.forEach { b -> vendors[b] = m[b] } }
                    .onFailure { unknown.forEach { b -> vendors[b] = null } }
            }
            tick++
            delay(3000)
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!c.network.wifiEnabled) {
            SectionCard("Wi-Fi spento") {
                Text("Per analizzare le reti il Wi-Fi del telefono deve essere acceso (non serve collegarsi).")
                OutlinedButton(onClick = { runCatching { context.startActivity(wifiPanelIntent()) } }) { Text("Accendi il Wi-Fi") }
            }
        }
        if (!granted) {
            SectionCard("Permesso di posizione") {
                Text("Android mostra le reti Wi-Fi solo alle app con il permesso di posizione (e con la localizzazione attiva).")
                OutlinedButton(onClick = { ask.launch(Manifest.permission.ACCESS_FINE_LOCATION) }) { Text("Consenti") }
            }
            return@Column
        }
        ConnectionCard(c, aps)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            WifiBand.entries.forEach { b ->
                val n = aps.count { it.band == b }
                FilterChip(selected = band == b, onClick = { band = b }, label = { Text("${b.label} ($n)") })
            }
        }
        TabRow(selectedTabIndex = tab) {
            listOf("Spettro", "Canali", "Segnale", "Reti").forEachIndexed { i, t -> Tab(selected = tab == i, onClick = { tab = i }, text = { Text(t) }) }
        }
        val inBand = aps.filter { it.band == band }.sortedByDescending { it.rssi }
        when (tab) {
            0 -> SectionCard { Spectrum(inBand, band) }
            1 -> ChannelsCard(aps, band)
            2 -> SectionCard { SignalHistory(inBand.take(8), history) }
            else -> NetworksCard(inBand, vendors)
        }
        Text(
            (if (lastScan > 0) "Ultima scansione richiesta ${((System.currentTimeMillis() - lastScan) / 1000)} s fa · " else "") +
                (if (throttled) "Android sta limitando le scansioni (4 ogni 2 minuti): per aggiornamenti più rapidi disattiva \"Limitazione scansione Wi-Fi\" nelle Opzioni sviluppatore. " else "") +
                "Distanze indicative (spazio libero).",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@SuppressLint("MissingPermission")
@Composable
private fun ConnectionCard(c: AppContainer, aps: List<WifiAp>) {
    val link = c.network.wifiLink() ?: return
    val me = aps.firstOrNull { it.connected }
    @Suppress("DEPRECATION")
    val info = runCatching { c.network.wifiManager.connectionInfo }.getOrNull()
    SectionCard("Connessione attuale") {
        val rssi = link.wifiRssi ?: me?.rssi
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(link.wifiSsid ?: me?.ssid ?: "Wi-Fi", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            rssi?.let { Text("$it dBm · ${WifiMath.quality(it)}", color = qualityColor(it), fontWeight = FontWeight.SemiBold) }
        }
        rssi?.let { LinearProgressIndicator(progress = { ((it + 100) / 70f).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth(), color = qualityColor(it)) }
        KeyValue("BSSID", link.wifiBssid ?: me?.bssid ?: "—")
        val f = link.wifiFrequency ?: me?.freq
        KeyValue("Canale", f?.let { "${WifiMath.channel(it)} · ${WifiMath.band(it).label}${me?.let { a -> " · ${a.widthMhz} MHz" } ?: ""}" } ?: "—")
        me?.standard?.takeIf { it.isNotBlank() }?.let { KeyValue("Standard", it) }
        val tx = if (Build.VERSION.SDK_INT >= 29) info?.txLinkSpeedMbps?.takeIf { it > 0 } else null
        val rx = if (Build.VERSION.SDK_INT >= 29) info?.rxLinkSpeedMbps?.takeIf { it > 0 } else null
        KeyValue("Velocità link", listOfNotNull(tx?.let { "TX $it" }, rx?.let { "RX $it" }).joinToString(" · ").ifBlank { link.linkSpeedMbps?.let { "$it" } ?: "—" } + " Mbps")
        me?.security?.let { KeyValue("Sicurezza", it) }
        KeyValue("IP / gateway", "${link.addresses.firstOrNull { it.contains('.') } ?: "—"} · ${link.gateway ?: "—"}")
    }
}

/** Every network as a curve as wide as its channel, peak at its signal. */
@Composable
private fun Spectrum(aps: List<WifiAp>, band: WifiBand) {
    val measurer = rememberTextMeasurer()
    val ink = MaterialTheme.colorScheme.onSurface
    val grid = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)
    val dpPerMhz = when (band) { WifiBand.B24 -> 3.6f; WifiBand.B5 -> 1.7f; WifiBand.B6 -> 0.9f }
    val from = band.fromMhz - 10
    val to = band.toMhz + 10
    val widthDp = ((to - from) * dpPerMhz).dp
    if (aps.isEmpty()) Text("Nessuna rete in questa banda.", style = MaterialTheme.typography.bodySmall)
    Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Canvas(Modifier.width(widthDp).height(280.dp)) {
            val top = 8.dp.toPx()
            val bottom = size.height - 26.dp.toPx()
            fun x(mhz: Int) = (mhz - from) * dpPerMhz.dp.toPx()
            fun y(dbm: Int) = top + (bottom - top) * ((-30f - dbm) / 70f).coerceIn(0f, 1f)
            for (dbm in -90..-40 step 10) {
                drawLine(grid, Offset(0f, y(dbm)), Offset(size.width, y(dbm)), strokeWidth = 1f)
                drawText(measurer, "$dbm", Offset(2f, y(dbm) - 14.sp.toPx()), TextStyle(color = ink.copy(alpha = 0.6f), fontSize = 10.sp))
            }
            val labels = WifiMath.channels(band).let { if (band == WifiBand.B6) it.filterIndexed { i, _ -> i % 4 == 0 } else it }
            for (ch in labels) {
                val cx = x(WifiMath.freqOf(band, ch))
                drawLine(grid, Offset(cx, bottom), Offset(cx, bottom + 4.dp.toPx()), strokeWidth = 1f)
                drawText(measurer, "$ch", Offset(cx - 6.dp.toPx(), bottom + 6.dp.toPx()), TextStyle(color = if (WifiMath.isDfs(band, ch)) WarnAmber else ink, fontSize = 10.sp))
            }
            for (a in aps.sortedBy { it.rssi }) {
                val col = colorOf(a.ssid)
                val l = x(a.lowMhz)
                val h = x(a.highMhz)
                val edge = (h - l) * 0.18f
                val p = Path().apply {
                    moveTo(l, bottom)
                    cubicTo(l + edge * 0.6f, bottom, l + edge * 0.4f, y(a.rssi), l + edge, y(a.rssi))
                    lineTo(h - edge, y(a.rssi))
                    cubicTo(h - edge * 0.4f, y(a.rssi), h - edge * 0.6f, bottom, h, bottom)
                }
                drawPath(p, col.copy(alpha = if (a.connected) 0.30f else 0.12f))
                drawPath(p, col, style = Stroke(width = if (a.connected) 3.dp.toPx() else 1.5.dp.toPx()))
                drawText(measurer, a.ssid.take(18), Offset(x(a.centerFreq) - 30.dp.toPx(), y(a.rssi) - 16.sp.toPx()), TextStyle(color = col, fontSize = 10.sp, fontWeight = if (a.connected) FontWeight.Bold else FontWeight.Normal))
            }
        }
    }
    Text("Curve larghe quanto il canale della rete (20/40/80/160 MHz); in grassetto la rete a cui sei collegato. Canali in arancio: DFS.", style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun ChannelsCard(aps: List<WifiAp>, band: WifiBand) {
    val scores = WifiMath.rate(aps, band)
    val best = WifiMath.recommend(aps, band)
    SectionCard("Occupazione dei canali · ${band.label}") {
        Text(
            if (best.isEmpty()) "—" else "Consigliati per un router: " + best.joinToString(", ") { "ch ${it.channel}${if (it.dfs) " (DFS)" else ""}" },
            fontWeight = FontWeight.SemiBold,
            color = GoodGreen,
        )
        if (band == WifiBand.B24) Text("In 2.4 GHz usa solo 1, 6 o 11 (gli altri si sovrappongono).", style = MaterialTheme.typography.bodySmall)
        scores.forEach { s ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${s.channel}", Modifier.width(40.dp), fontWeight = FontWeight.SemiBold, color = if (s.dfs) WarnAmber else MaterialTheme.colorScheme.onSurface)
                val col = when { s.rating >= 7 -> GoodGreen; s.rating >= 4 -> WarnAmber; else -> BadRed }
                Box(Modifier.weight(1f).height(10.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)) {
                    Box(Modifier.fillMaxWidth(s.rating / 10f).height(10.dp).clip(CircleShape).background(col))
                }
                Text(
                    " ${s.networks} reti" + (s.interferenceDbm?.let { " · $it dBm" } ?: ""),
                    Modifier.width(130.dp),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        Text("Barra lunga = canale libero. Calcolato dalla potenza delle reti che si sovrappongono a ogni canale (esclusa la rete a cui sei collegato).", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun SignalHistory(aps: List<WifiAp>, history: Map<String, List<Int>>) {
    val grid = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)
    if (aps.isEmpty()) {
        Text("Nessuna rete in questa banda.", style = MaterialTheme.typography.bodySmall)
        return
    }
    Canvas(Modifier.fillMaxWidth().height(200.dp)) {
        fun y(dbm: Int) = size.height * ((-30f - dbm) / 70f).coerceIn(0f, 1f)
        for (dbm in -90..-40 step 10) drawLine(grid, Offset(0f, y(dbm)), Offset(size.width, y(dbm)), strokeWidth = 1f)
        val step = size.width / 39f
        for (a in aps) {
            val pts = history[a.bssid].orEmpty()
            if (pts.size < 2) continue
            val start = 40 - pts.size
            val p = Path()
            pts.forEachIndexed { i, v -> if (i == 0) p.moveTo((start + i) * step, y(v)) else p.lineTo((start + i) * step, y(v)) }
            drawPath(p, colorOf(a.ssid), style = Stroke(width = if (a.connected) 3.dp.toPx() else 2.dp.toPx()))
        }
    }
    aps.forEach { a ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(colorOf(a.ssid)))
            Text(" ${a.ssid} · ch ${a.channel} · ${a.rssi} dBm", style = MaterialTheme.typography.bodySmall, fontWeight = if (a.connected) FontWeight.Bold else FontWeight.Normal)
        }
    }
    Text("Ultimi ~2 minuti (un punto ogni 3 s); utile per vedere come cambia il segnale spostando il telefono o l'antenna.", style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun NetworksCard(aps: List<WifiAp>, vendors: Map<String, String?>) {
    SectionCard("${aps.size} reti") {
        aps.forEachIndexed { i, a ->
            if (i > 0) HorizontalDivider()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(10.dp).clip(CircleShape).background(colorOf(a.ssid)))
                Text(" ${a.ssid}", fontWeight = if (a.connected) FontWeight.Bold else FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text("${a.rssi} dBm", color = qualityColor(a.rssi), fontWeight = FontWeight.SemiBold)
            }
            Text(
                listOfNotNull(a.bssid, vendors[a.bssid]).joinToString(" · ") + if (a.connected) " · collegato" else "",
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                listOf("ch ${a.channel}", "${a.widthMhz} MHz", a.standard, "~${WifiMath.distanceM(a.rssi, a.freq)} m", WifiMath.quality(a.rssi)).filter { it.isNotBlank() }.joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(a.security, style = MaterialTheme.typography.bodySmall, color = if (a.security == "Aperta" || a.security == "WEP") BadRed else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
