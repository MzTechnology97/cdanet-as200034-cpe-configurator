package it.cdanet.cpeconfigurator.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.tools.UbntDiscovery
import it.cdanet.cpeconfigurator.tools.pro.DeviceGuess
import it.cdanet.cpeconfigurator.tools.pro.DnsWire
import it.cdanet.cpeconfigurator.tools.pro.IpScanner
import it.cdanet.cpeconfigurator.tools.pro.NetDiag
import it.cdanet.cpeconfigurator.tools.pro.PortResult
import it.cdanet.cpeconfigurator.tools.pro.PortScanner
import it.cdanet.cpeconfigurator.tools.pro.PortState
import it.cdanet.cpeconfigurator.tools.pro.Ports
import it.cdanet.cpeconfigurator.tools.pro.ScanHost
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.Dropdown
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

private fun csvCell(v: Any?): String = v?.toString().orEmpty().let { if (it.any { c -> c == ';' || c == '"' || c == '\n' }) "\"" + it.replace("\"", "\"\"") + "\"" else it }

private fun shareCsv(context: android.content.Context, title: String, rows: List<List<Any?>>) {
    val text = rows.joinToString("\n") { r -> r.joinToString(";") { csvCell(it) } }
    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/csv").putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TEXT, text), title))
}

@Composable
private fun SwitchRow(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Switch(checked = value, onCheckedChange = onChange)
    }
}

// ---------------------------------------------------------------------------------------------
// Scanner IP
// ---------------------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun IpScannerScreen(c: AppContainer, onPortScan: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val link = remember { c.network.wifiLink() }
    var cidr by remember { mutableStateOf(link?.cidr ?: "192.168.1.0/24") }
    var icmp by remember { mutableStateOf(true) }
    var ubnt by remember { mutableStateOf(true) }
    var job by remember { mutableStateOf<Job?>(null) }
    var progress by remember { mutableStateOf<IpScanner.Progress?>(null) }
    val hosts = remember { mutableStateListOf<ScanHost>() }
    var error by remember { mutableStateOf<String?>(null) }
    var filter by remember { mutableStateOf("") }
    var sort by remember { mutableStateOf("IP") }
    var openHost by remember { mutableStateOf<String?>(null) }

    fun start() {
        error = null
        hosts.clear()
        job = scope.launch {
            try {
                val net = c.network.wifiNetwork() ?: throw IllegalStateException("Collegati alla Wi-Fi della LAN da scansionare")
                val parsed = Ip.parseScanCidr(cidr, minPrefix = 22)
                val wl = c.network.wifiLink()
                val selfIps = wl?.addresses.orEmpty().map { it.substringBefore('/') }.toSet()
                val ubntJob = if (ubnt) async { runCatching { UbntDiscovery.discover(c.network, 3_000) }.getOrDefault(emptyList()) } else null
                progress = IpScanner.Progress(0, 1, 0, "Avvio")
                val ubntList = ubntJob?.await().orEmpty()
                val found = IpScanner(net).scan(parsed, icmp, ubntList, wl?.gateway, selfIps, wl?.dns?.firstOrNull { it.contains('.') }) { progress = it }
                progress = IpScanner.Progress(1, 1, found.size, "Produttori (IEEE)")
                val vendors = if (c.session.token != null) runCatching { c.api.macVendors(found.mapNotNull { it.mac }) }.getOrDefault(emptyMap()) else emptyMap()
                hosts += found.map { h ->
                    val v = h.mac?.let { vendors[it] }
                    h.copy(vendor = v, kind = DeviceGuess.guess(v, h.ports.toSet(), h.hostname ?: h.netbios, h.isGateway, h.ubnt?.fullModel ?: h.ubnt?.model))
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: e.toString()
            } finally {
                progress = null
                job = null
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        SectionCard("Rete da scansionare") {
            Field("Subnet (fino a /22)", cidr, { cidr = it.trim() }, keyboardType = KeyboardType.Uri, supporting = link?.let { "Wi-Fi ${it.wifiSsid ?: ""} · gateway ${it.gateway ?: "—"}" })
            SwitchRow("Ping ICMP per gli host che non rispondono su TCP", icmp) { icmp = it }
            SwitchRow("Discovery Ubiquiti (modello, firmware, MAC)", ubnt) { ubnt = it }
            if (job == null) BusyButton("Avvia scansione", false, Modifier.fillMaxWidth()) { start() }
            else OutlinedButton(onClick = { job?.cancel() }, modifier = Modifier.fillMaxWidth()) { Text("Interrompi") }
            progress?.let { p ->
                LinearProgressIndicator(progress = { if (p.total > 0) p.done / p.total.toFloat() else 0f }, modifier = Modifier.fillMaxWidth())
                Text("${p.phase} · ${p.done}/${p.total} · ${p.found} host attivi", style = MaterialTheme.typography.bodySmall)
            }
        }
        if (hosts.isNotEmpty()) {
            SectionCard("${hosts.size} host attivi") {
                Field("Filtra (IP, nome, produttore, tipo)", filter, { filter = it })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Dropdown("Ordina per", listOf("IP", "Latenza", "Tipo", "Produttore"), sort, { it }, { sort = it }, Modifier.weight(1f))
                    OutlinedButton(onClick = {
                        shareCsv(context, "Scansione $cidr", listOf(listOf("IP", "Nome", "MAC", "Produttore", "Tipo", "Porte", "Latenza ms", "Rilevato con")) +
                            hosts.map { listOf(it.ip, it.hostname ?: it.netbios, it.mac, it.vendor, it.kind, it.ports.joinToString(" "), it.latencyMs, it.how) })
                    }) { Text("CSV") }
                }
            }
            val shown = hosts.filter { h -> filter.isBlank() || listOf(h.ip, h.hostname, h.netbios, h.vendor, h.kind, h.mac).any { it?.contains(filter, true) == true } }
                .let { l ->
                    when (sort) {
                        "Latenza" -> l.sortedBy { it.latencyMs ?: Int.MAX_VALUE }
                        "Tipo" -> l.sortedBy { it.kind.ifBlank { "~" } }
                        "Produttore" -> l.sortedBy { it.vendor ?: "~" }
                        else -> l.sortedBy { Ip.parse(it.ip) }
                    }
                }
            shown.forEach { h ->
                SectionCard(modifier = Modifier.clickable { openHost = if (openHost == h.ip) null else h.ip }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(h.ip, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                        Text(
                            listOfNotNull(if (h.isGateway) "GATEWAY" else null, if (h.isSelf) "QUESTO TELEFONO" else null, h.latencyMs?.let { "$it ms" }).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (h.isGateway) WarnAmber else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (h.kind.isNotBlank()) Text(h.kind, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
                    (h.hostname ?: h.netbios)?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    Text(
                        listOfNotNull(h.mac, h.vendor ?: if (h.mac != null) "produttore sconosciuto" else "MAC non disponibile (Android limita l'ARP)").joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    h.ubnt?.let { u -> Text(listOfNotNull(u.fullModel ?: u.model, u.firmware, u.ssid?.let { "SSID $it" }).joinToString(" · "), style = MaterialTheme.typography.bodySmall) }
                    if (h.ports.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            h.ports.forEach { p -> SuggestionChip(onClick = {}, label = { Text("$p ${Ports.service(p)}".trim(), style = MaterialTheme.typography.labelSmall) }) }
                        }
                    }
                    if (openHost == h.ip) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedButton(onClick = { onPortScan(h.ip) }) { Text("Porte") }
                            if (80 in h.ports || 443 in h.ports || 20443 in h.ports || 8080 in h.ports) {
                                OutlinedButton(onClick = {
                                    val url = when { 20443 in h.ports -> "https://${h.ip}:20443"; 443 in h.ports -> "https://${h.ip}"; 8080 in h.ports -> "http://${h.ip}:8080"; else -> "http://${h.ip}" }
                                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                                }) { Text("Web") }
                            }
                            TextButton(onClick = {
                                context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("IP", h.ip))
                            }) { Text("Copia IP") }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Port scanner
// ---------------------------------------------------------------------------------------------

@Composable
fun PortScannerScreen(c: AppContainer) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var host by remember { mutableStateOf(c.portScanTarget.value ?: c.network.wifiLink()?.gateway ?: "") }
    var preset by remember { mutableStateOf(Ports.PRESETS.keys.first()) }
    var custom by remember { mutableStateOf("") }
    var timeout by remember { mutableStateOf("600") }
    var grab by remember { mutableStateOf(true) }
    var showClosed by remember { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    var done by remember { mutableStateOf(0 to 0) }
    var results by remember { mutableStateOf<List<PortResult>>(emptyList()) }
    var openLive by remember { mutableStateOf<List<PortResult>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var elapsed by remember { mutableStateOf<Long?>(null) }

    fun start() {
        error = null
        results = emptyList()
        openLive = emptyList()
        job = scope.launch {
            val t0 = System.currentTimeMillis()
            try {
                val ip = Ip.resolvePrivate(host.trim())
                val ports = Ports.parse(custom.ifBlank { preset })
                val net = c.network.wifiNetwork()
                done = 0 to ports.size
                results = PortScanner(net?.socketFactory ?: javax.net.SocketFactory.getDefault()).scan(ip, ports, timeout.toIntOrNull()?.coerceIn(100, 5000) ?: 600, 128, grab) { d, t, open ->
                    done = d to t
                    openLive = open
                }
                elapsed = System.currentTimeMillis() - t0
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: e.toString()
            } finally {
                job = null
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        SectionCard("Bersaglio") {
            Field("Host (IP privato o nome)", host, { host = it.trim() }, keyboardType = KeyboardType.Uri)
            Dropdown("Porte", Ports.PRESETS.keys.toList(), preset, { it }, { preset = it; custom = "" }, Modifier.fillMaxWidth())
            Field("Oppure elenco personalizzato", custom, { custom = it }, placeholder = "es. 1-1024,8291,8728,20443")
            Field("Timeout per porta (ms)", timeout, { timeout = it.filter(Char::isDigit) }, keyboardType = KeyboardType.Number, supporting = "LAN 300-600 ms, link radio 800-1500 ms")
            SwitchRow("Banner, header HTTP e certificati TLS", grab) { grab = it }
            SwitchRow("Mostra anche porte chiuse/filtrate", showClosed) { showClosed = it }
            if (job == null) BusyButton("Avvia scansione", false, Modifier.fillMaxWidth()) { start() }
            else OutlinedButton(onClick = { job?.cancel() }, modifier = Modifier.fillMaxWidth()) { Text("Interrompi") }
            if (job != null && done.second > 0) {
                LinearProgressIndicator(progress = { done.first / done.second.toFloat() }, modifier = Modifier.fillMaxWidth())
                Text("${done.first}/${done.second} porte · ${openLive.size} aperte", style = MaterialTheme.typography.bodySmall)
            }
        }
        val list = if (job != null) openLive else results
        if (list.isNotEmpty()) {
            val open = list.count { it.state == PortState.Open }
            SectionCard("$open porte aperte" + (elapsed?.let { " · ${it / 1000.0} s" } ?: "")) {
                if (job == null) {
                    val closed = results.count { it.state == PortState.Closed }
                    val filtered = results.count { it.state == PortState.Filtered }
                    Text("$closed chiuse (RST) · $filtered filtrate (nessuna risposta: firewall o host spento)", style = MaterialTheme.typography.bodySmall)
                    OutlinedButton(onClick = {
                        shareCsv(context, "Porte $host", listOf(listOf("Porta", "Stato", "Servizio", "Latenza ms", "Banner", "TLS")) + results.filter { showClosed || it.state == PortState.Open }.map { listOf(it.port, it.state, it.service, it.latencyMs, it.banner, it.tls) })
                    }) { Text("Esporta CSV") }
                }
                list.filter { showClosed || it.state == PortState.Open }.forEach { r ->
                    Column(Modifier.fillMaxWidth()) {
                        Row {
                            Text("${r.port}", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.25f))
                            Text(r.service.ifBlank { "—" }, modifier = Modifier.weight(0.45f))
                            Text(
                                when (r.state) { PortState.Open -> "aperta"; PortState.Closed -> "chiusa"; PortState.Filtered -> "filtrata" } + (r.latencyMs?.let { " · $it ms" } ?: ""),
                                color = when (r.state) { PortState.Open -> GoodGreen; PortState.Closed -> MaterialTheme.colorScheme.onSurfaceVariant; PortState.Filtered -> WarnAmber },
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(0.3f),
                            )
                        }
                        r.banner?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                        r.tls?.let { Text("TLS: $it", style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        } else if (job == null && results.isNotEmpty()) {
            SectionCard { Text("Nessuna porta aperta tra quelle verificate.", color = BadRed) }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Diagnostica: ping continuo, MTU, DNS, HTTP, Wake-on-LAN
// ---------------------------------------------------------------------------------------------

@Composable
fun NetDiagScreen(c: AppContainer) {
    val scope = rememberCoroutineScope()
    val link = remember { c.network.wifiLink() }
    var error by remember { mutableStateOf<String?>(null) }

    var pingHost by remember { mutableStateOf(link?.gateway ?: "1.1.1.1") }
    var pingCount by remember { mutableStateOf("20") }
    var pingSize by remember { mutableStateOf("56") }
    val samples = remember { mutableStateListOf<Double?>() }
    var pingJob by remember { mutableStateOf<Job?>(null) }
    var mtu by remember { mutableStateOf<String?>(null) }
    var mtuBusy by remember { mutableStateOf(false) }

    var dnsServer by remember { mutableStateOf(link?.dns?.firstOrNull { it.contains('.') } ?: "1.1.1.1") }
    var dnsName by remember { mutableStateOf("cda-net.it") }
    var dnsType by remember { mutableStateOf("A") }
    var dnsOut by remember { mutableStateOf<String?>(null) }
    var dnsBusy by remember { mutableStateOf(false) }

    var url by remember { mutableStateOf("https://www.google.it") }
    var httpOut by remember { mutableStateOf<NetDiag.HttpCheck?>(null) }
    var httpBusy by remember { mutableStateOf(false) }

    var wolMac by remember { mutableStateOf("") }
    var wolBcast by remember { mutableStateOf(link?.cidr?.let { runCatching { Ip.format(Ip.parseCidr(it).broadcast) }.getOrNull() } ?: "255.255.255.255") }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }

        SectionCard("Ping continuo") {
            Field("Host", pingHost, { pingHost = it.trim() }, keyboardType = KeyboardType.Uri)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field("Pacchetti", pingCount, { pingCount = it.filter(Char::isDigit) }, Modifier.weight(1f), keyboardType = KeyboardType.Number)
                Field("Dimensione (byte)", pingSize, { pingSize = it.filter(Char::isDigit) }, Modifier.weight(1f), keyboardType = KeyboardType.Number)
            }
            if (pingJob == null) {
                BusyButton("Avvia", false, Modifier.fillMaxWidth()) {
                    samples.clear()
                    pingJob = scope.launch {
                        try {
                            NetDiag.pingSeries(pingHost, pingCount.toIntOrNull()?.coerceIn(1, 1000) ?: 20, pingSize.toIntOrNull()?.coerceIn(8, 65000) ?: 56, 1000) { _, rtt -> samples += rtt }
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.message
                        } finally {
                            pingJob = null
                        }
                    }
                }
            } else {
                OutlinedButton(onClick = { pingJob?.cancel() }, modifier = Modifier.fillMaxWidth()) { Text("Ferma") }
            }
            if (samples.isNotEmpty()) {
                val s = NetDiag.stats(samples.toList())
                KeyValue("Inviati / ricevuti", "${s.sent} / ${s.received} · persi ${s.lossPct}%")
                KeyValue("Min / media / max", if (s.avg == null) "—" else "%.1f / %.1f / %.1f ms".format(s.min, s.avg, s.max))
                KeyValue("Jitter / dev. std", if (s.jitter == null) "—" else "%.1f / %.1f ms".format(s.jitter, s.stdev ?: 0.0))
                Text(samples.takeLast(30).joinToString("  ") { it?.let { v -> "%.0f".format(v) } ?: "✖" }, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
            BusyButton("Misura MTU di percorso", mtuBusy, Modifier.fillMaxWidth(), primary = false) {
                scope.launch {
                    mtuBusy = true
                    mtu = runCatching { NetDiag.pathMtu(pingHost) }.getOrElse { it.message }
                    mtuBusy = false
                }
            }
            mtu?.let { Text(it, fontWeight = FontWeight.SemiBold) }
        }

        SectionCard("DNS") {
            Field("Server DNS", dnsServer, { dnsServer = it.trim() }, keyboardType = KeyboardType.Uri, supporting = "Default: il DNS della Wi-Fi. Prova anche 1.1.1.1, 8.8.8.8 o il DNS CDA Net")
            Field("Nome (o IP per PTR)", dnsName, { dnsName = it.trim() }, keyboardType = KeyboardType.Uri)
            Dropdown("Tipo", DnsWire.TYPES.keys.toList(), dnsType, { it }, { dnsType = it }, Modifier.fillMaxWidth())
            BusyButton("Interroga", dnsBusy, Modifier.fillMaxWidth()) {
                scope.launch {
                    dnsBusy = true
                    dnsOut = runCatching {
                        val (a, ms) = NetDiag.dns(dnsServer, dnsName, dnsType, c.network.wifiNetwork())
                        buildString {
                            append("${a.rcodeText} · $ms ms").append(if (a.authoritative) " · autoritativa" else "").append(if (a.truncated) " · troncata" else "")
                            a.answers.forEach { append("\n${it.type}  ${it.data}  (TTL ${it.ttl})") }
                            if (a.answers.isEmpty()) a.authority.forEach { append("\n[autorità] ${it.type}  ${it.data}") }
                        }
                    }.getOrElse { "Nessuna risposta da $dnsServer: ${it.message}" }
                    dnsBusy = false
                }
            }
            dnsOut?.let { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        }

        SectionCard("Verifica HTTP / HTTPS") {
            Field("URL", url, { url = it.trim() }, keyboardType = KeyboardType.Uri)
            BusyButton("Verifica", httpBusy, Modifier.fillMaxWidth()) {
                scope.launch {
                    httpBusy = true
                    httpOut = NetDiag.http(url)
                    httpBusy = false
                }
            }
            httpOut?.let { h ->
                h.chain.forEach { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                h.error?.let { Text("Errore: $it", color = BadRed) }
                if (h.status > 0) KeyValue("Esito", "HTTP ${h.status} in ${h.ms} ms")
                h.server?.let { KeyValue("Server", it) }
                h.tls?.let { KeyValue("Certificato", it) }
            }
        }

        SectionCard("Wake-on-LAN") {
            Field("MAC del PC da accendere", wolMac, { wolMac = it.trim() }, placeholder = "AA:BB:CC:DD:EE:FF")
            Field("Broadcast", wolBcast, { wolBcast = it.trim() }, keyboardType = KeyboardType.Uri)
            BusyButton("Invia magic packet", false, Modifier.fillMaxWidth(), primary = false) {
                scope.launch {
                    error = runCatching { NetDiag.wakeOnLan(wolMac, wolBcast, c.network.wifiNetwork()); null }.getOrElse { it.message }
                    if (error == null) error = "Magic packet inviato a $wolBcast (UDP 9 e 7)"
                }
            }
        }
    }
}
