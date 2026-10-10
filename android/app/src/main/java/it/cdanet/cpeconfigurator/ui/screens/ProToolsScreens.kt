package it.cdanet.cpeconfigurator.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import it.cdanet.cpeconfigurator.ui.Notice
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.material3.SegmentedButton
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.StatusChip
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import it.cdanet.cpeconfigurator.BuildConfig
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
import androidx.compose.material3.FilterChip
import it.cdanet.cpeconfigurator.tools.topology.Topology
import it.cdanet.cpeconfigurator.tools.topology.TopologyDemo
import it.cdanet.cpeconfigurator.tools.topology.LinkKind
import it.cdanet.cpeconfigurator.tools.topology.TopoGraph
import it.cdanet.cpeconfigurator.tools.topology.TopologyRun
import it.cdanet.cpeconfigurator.tools.topology.TopologyScanner

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

@OptIn(ExperimentalLayoutApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
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
    var showMap by remember { mutableStateOf(false) }
    var showGrid by remember { mutableStateOf(false) }
    var typeFilter by remember { mutableStateOf<it.cdanet.cpeconfigurator.tools.topology.DeviceType?>(null) }
    var options by remember { mutableStateOf(false) }
    var topoSettings by remember { mutableStateOf(false) }
    var startedAt by remember { mutableStateOf(0L) }
    var elapsed by remember { mutableStateOf(0L) }
    var useSnmp by remember { mutableStateOf(true) }
    var useDiscovery by remember { mutableStateOf(true) }
    var communities by remember { mutableStateOf("public") }
    var topo by remember { mutableStateOf<TopologyRun?>(null) }
    var topoBusy by remember { mutableStateOf<String?>(null) }
    var selectedNode by remember { mutableStateOf<String?>(null) }
    var wide by remember { mutableStateOf(true) }
    var wideRange by remember { mutableStateOf("192.168.0.0/16") }

    /** Scans [targets] one after the other and adds what it finds (several subnets: wide sweep, routers' subnets). */
    suspend fun scanAll(net: android.net.Network, targets: List<Ip.Cidr>) {
        val wl = c.network.wifiLink()
        val selfIps = wl?.addresses.orEmpty().map { it.substringBefore('/') }.toSet()
        val ubntJob: kotlinx.coroutines.Deferred<List<it.cdanet.cpeconfigurator.tools.UbntDevice>>? =
            if (ubnt) scope.async { runCatching { UbntDiscovery.discover(c.network, 3_000) }.getOrDefault(emptyList()) } else null
        progress = IpScanner.Progress(0, 1, 0, "Avvio")
        val ubntList = ubntJob?.await().orEmpty()
        targets.forEachIndexed { i, t ->
            val label = if (targets.size > 1) "Subnet ${i + 1}/${targets.size} ($t) · " else ""
            val found = IpScanner(net).scan(t, icmp, ubntList, wl?.gateway, selfIps, wl?.dns?.firstOrNull { it.contains('.') }) { p -> progress = p.copy(phase = label + p.phase) }
            progress = IpScanner.Progress(1, 1, found.size, "Produttori (IEEE)")
            val vendors = if (c.session.token != null) runCatching { c.api.macVendors(found.mapNotNull { it.mac }) }.getOrDefault(emptyMap()) else emptyMap()
            val known = hosts.map { it.ip }.toSet()
            hosts += found.filter { it.ip !in known }.map { h ->
                val v = h.mac?.let { vendors[it] }
                h.copy(vendor = v, kind = DeviceGuess.guess(v, h.ports.toSet(), h.hostname ?: h.netbios, h.isGateway, h.ubnt?.fullModel ?: h.ubnt?.model))
            }
        }
    }

    /** The Wi-Fi gateway, or (scanning a LAN the phone reaches through a router) its .1/.254. */
    fun gatewayIp(): String? {
        val ips = hosts.map { it.ip }
        return link?.gateway?.takeIf { it in ips }
            ?: hosts.firstOrNull { it.isGateway }?.ip
            ?: ips.firstOrNull { it.endsWith(".1") } ?: ips.firstOrNull { it.endsWith(".254") } ?: link?.gateway
    }

    /** SNMP + discovery + fingerprints: the real graph of the network, then the enriched host list. */
    fun buildTopology() {
        if (topoBusy != null || job != null || hosts.isEmpty()) return
        topoBusy = "Avvio…"
        selectedNode = null
        scope.launch {
            runCatching {
                TopologyScanner(c.network).run(
                    hosts.toList(),
                    gatewayIp(),
                    if (useSnmp) communities.split(',').map { it.trim() }.filter { it.isNotEmpty() }.ifEmpty { listOf("public") } else emptyList(),
                    useDiscovery,
                    fingerprints = true,
                    vendorOf = { macs ->
                        if (c.session.token == null) emptyMap()
                        else c.api.macVendors(macs).mapNotNull { (k, v) -> v?.let { k to it } }.toMap()
                    },
                ) { topoBusy = it }
            }.onSuccess { r ->
                topo = r
                // discovery enriches the host list (names, MACs, types, devices the scan missed)
                hosts.clear()
                hosts += r.hosts
            }.onFailure { error = it.message ?: it.toString() }
            topoBusy = null
        }
    }

    // the map builds itself once the scan is over (or when it is opened after the scan)
    LaunchedEffect(showMap, job) { if (showMap && job == null && topo == null) buildTopology() }

    fun start() {
        error = null
        hosts.clear()
        topo = null
        selectedNode = null
        typeFilter = null
        startedAt = System.currentTimeMillis()
        elapsed = 0
        job = scope.launch {
            try {
                val net = c.network.wifiNetwork() ?: throw IllegalStateException("Collegati alla Wi-Fi della LAN da scansionare")
                val parsed = Ip.parseScanCidr(cidr, minPrefix = 22)
                // wide: the /24 of the range that answer, after the subnet of the field (16 at most)
                val extra = if (!wide) emptyList() else {
                    val range = Ip.parseCidr(wideRange)
                    IpScanner(net).activeSubnets(range) { progress = it }
                        .filter { it.network !in parsed.network..parsed.broadcast }
                }
                scanAll(net, (listOf(parsed) + extra).take(17))
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

    LaunchedEffect(job) {
        while (job != null) {
            elapsed = (System.currentTimeMillis() - startedAt) / 1000
            kotlinx.coroutines.delay(1000)
        }
    }
    fun setView(v: Int) { showMap = v == 2; showGrid = v == 1 }
    val view = if (showMap) 2 else if (showGrid) 1 else 0

    /** Target, options, radar and progress. */
    @Composable
    fun ControlPanel() {
        Panel {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                PanelTitle("Scansione della rete", R.drawable.ic_radar) {
                    when {
                        job != null -> StatusChip("IN CORSO", NoticeKind.Warn)
                        hosts.isNotEmpty() -> StatusChip("COMPLETATA", NoticeKind.Good)
                        else -> {}
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ScanRadar(hosts, job != null, progress?.let { if (it.total > 0) it.done / it.total.toFloat() else null }, size = 128.dp)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        MonoFact("Wi-Fi", link?.wifiSsid?.trim('"') ?: "—")
                        MonoFact("Questo telefono", link?.addresses?.firstOrNull { it.contains('.') } ?: "—")
                        MonoFact("Gateway", link?.gateway ?: "—")
                        MonoFact("DNS", link?.dns?.firstOrNull { it.contains('.') } ?: "—")
                    }
                }
                Field("Subnet (fino a /22)", cidr, { cidr = it.trim() }, keyboardType = KeyboardType.Uri, leadingIcon = R.drawable.ic_lan)
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { options = !options }.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        listOfNotNull("TCP", if (icmp) "ICMP" else null, if (ubnt) "Ubiquiti" else null, if (wide) "ampia $wideRange" else null).joinToString(" · "),
                        style = MaterialTheme.typography.labelMedium,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    Text(if (options) "Chiudi opzioni" else "Opzioni", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                }
                androidx.compose.animation.AnimatedVisibility(options) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        SwitchRow("Ping ICMP per gli host che non rispondono su TCP", icmp) { icmp = it }
                        SwitchRow("Discovery Ubiquiti (modello, firmware, MAC)", ubnt) { ubnt = it }
                        SwitchRow("Scansione ampia: cerca anche le altre subnet in uso", wide) { wide = it }
                        if (wide) Field("Intervallo (fino a /16)", wideRange, { wideRange = it.trim() }, keyboardType = KeyboardType.Uri, supporting = "Prova i gateway tipici (.1, .254) di ogni /24 e scansiona quelle attive (al massimo 16).")
                    }
                }
                if (job == null) BusyButton(if (hosts.isEmpty()) "Avvia scansione" else "Nuova scansione", false, Modifier.fillMaxWidth()) { start() }
                else OutlinedButton(onClick = { job?.cancel() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Interrompi") }
                progress?.let { p ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        LinearProgressIndicator(progress = { if (p.total > 0) p.done / p.total.toFloat() else 0f }, modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)))
                        Row {
                            Text(p.phase, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f), maxLines = 2)
                            Text("${p.done}/${p.total} · ${mmss(elapsed)}", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
        }
    }

    /** Counters and the device mix (tap a type to filter the list). */
    @Composable
    fun SummaryPanel() {
        Panel {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                PanelTitle("Riepilogo", R.drawable.ic_query_stats)
                val subnets = hosts.map { net24(it.ip) }.distinct().size
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatTile("${hosts.size}", "Host attivi", R.drawable.ic_radar, MaterialTheme.colorScheme.primary, Modifier.weight(1f))
                    val lat = hosts.mapNotNull { it.latencyMs }
                    StatTile(if (lat.isEmpty()) "—" else "${lat.average().toInt()} ms", "Latenza media", R.drawable.ic_speed, latencyColor(lat.takeIf { it.isNotEmpty() }?.average()?.toInt()), Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatTile("${hosts.mapNotNull { it.vendor }.distinct().size}", "Produttori", R.drawable.ic_fingerprint, Color(0xFF0D9488), Modifier.weight(1f))
                    StatTile("$subnets", "Subnet /24", R.drawable.ic_lan, Color(0xFF7C3AED), Modifier.weight(1f))
                }
                TypeBreakdown(hosts, typeFilter) { typeFilter = it; setView(0) }
            }
        }
    }

    /** List, address grid or topology. */
    @Composable
    fun Results(wide: Boolean) {
        if (hosts.isEmpty()) {
            if (job == null) EmptyState(R.drawable.ic_radar, "Nessun host ancora", "Avvia la scansione: qui compariranno host, porte, griglia degli indirizzi e topologia della rete.")
            return
        }
        androidx.compose.material3.SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            listOf("Elenco", "Griglia IP", "Topologia").forEachIndexed { i, label ->
                SegmentedButton(
                    selected = view == i,
                    onClick = { setView(i) },
                    shape = androidx.compose.material3.SegmentedButtonDefaults.itemShape(i, 3),
                ) { Text(label, maxLines = 1) }
            }
        }
        when (view) {
            2 -> Column {
                Panel { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    val t = topo?.result
                    PanelTitle("Topologia di rete", R.drawable.ic_hub) {
                        when {
                            topoBusy != null -> StatusChip("IN COSTRUZIONE", NoticeKind.Warn)
                            job != null -> StatusChip("IN ATTESA", NoticeKind.Info)
                            t?.mode == "snmp" -> StatusChip("SNMP", NoticeKind.Good)
                            t != null -> StatusChip("PRESUNTA", NoticeKind.Warn)
                            else -> {}
                        }
                    }
                    // what the graph is made of, as counters
                    if (t != null) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf(
                                "${t.snmpDevices}" to "apparati SNMP",
                                "${t.count(LinkKind.Lldp) + t.count(LinkKind.Cdp) + t.count(LinkKind.Mndp)}" to "LLDP/CDP/MikroTik",
                                "${t.count(LinkKind.Wireless)}" to "wireless",
                                "${t.count(LinkKind.Fdb)}" to "tabelle MAC",
                                "${t.count(LinkKind.Assumed)}" to "presunti",
                            ).forEach { (n, label) ->
                                Row(
                                    Modifier.clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(horizontal = 8.dp, vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(n, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
                                    Spacer(Modifier.width(5.dp))
                                    Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                    Text(
                        when {
                            topoBusy != null -> topoBusy!!
                            job != null -> "Scansione in corso: per ora tutti i dispositivi risultano collegati al gateway. Al termine il grafo si costruisce da solo con SNMP e discovery."
                            t == null -> "Mappa base dal gateway: \"Costruisci mappa\" prova SNMP e discovery per il grafo reale."
                            t.mode == "snmp" -> "Collegamenti letti dagli apparati; i dispositivi senza informazioni sono presunti sotto il gateway."
                            else -> "Nessun apparato ha risposto via SNMP: i dispositivi sono collegati al gateway come presunti."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = if (topoBusy != null) FontFamily.Monospace else null,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        BusyButton(if (topo == null) "Costruisci mappa" else "Ricostruisci", topoBusy != null, Modifier.weight(1f), enabled = topoBusy == null && job == null) { buildTopology() }
                        OutlinedButton(onClick = { topoSettings = !topoSettings }, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (topoSettings) "Chiudi" else "SNMP e discovery") }
                    }
                    androidx.compose.animation.AnimatedVisibility(topoSettings) {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            SwitchRow("SNMP (LLDP, CDP, vicini MikroTik, stazioni Ubiquiti, tabelle MAC, ARP)", useSnmp) { useSnmp = it }
                            if (useSnmp) Field("Community SNMP v2c (separate da virgola)", communities, { communities = it }, supporting = "Predefinita: public. Le community restano sul telefono.")
                            SwitchRow("Discovery multi-vendor (MikroTik, Ubiquiti, Hikvision, Dahua, ONVIF, UPnP, mDNS, Netgear)", useDiscovery) { useDiscovery = it }
                            // debug builds only: a fictitious office LAN to try the graph without a real network
                            if (BuildConfig.DEBUG) TextButton(onClick = {
                                selectedNode = null
                                topo = TopologyRun(Topology.build(TopologyDemo.hosts, TopologyDemo.snmp, TopologyDemo.GATEWAY, fingerprints = TopologyDemo.fingerprints), emptyList(), TopologyDemo.hosts, TopologyDemo.snmp)
                            }) { Text("Dati di esempio (solo build di sviluppo)") }
                        }
                    }
                    val open = { h: ScanHost -> filter = h.ip; openHost = h.ip; setView(0) }
                    // subnets the routers declare on their interfaces and that are not scanned yet
                    val scanned = hosts.mapNotNull { Ip.parse(it.ip) }
                    val more = topo?.devices.orEmpty().flatMap { it.subnets }.distinct()
                        .mapNotNull { runCatching { Ip.parseCidr(it) }.getOrNull() }
                        .filter { cidr -> cidr.prefix >= 16 && Ip.isPrivate(Ip.format(cidr.network)) && scanned.none { it in cidr.network..cidr.broadcast } }
                    if (more.isNotEmpty() && job == null) {
                        Text("Subnet dichiarate dai router e non ancora scansionate: ${more.joinToString(", ")}", style = MaterialTheme.typography.bodySmall)
                        OutlinedButton(onClick = {
                            job = scope.launch {
                                try {
                                    val net = c.network.wifiNetwork() ?: throw IllegalStateException("Collegati alla Wi-Fi della LAN da scansionare")
                                    scanAll(net, more.flatMap { if (it.prefix >= 22) listOf(it) else Ip.slash24s(it) }.take(16))
                                } catch (e: kotlinx.coroutines.CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    error = e.message ?: e.toString()
                                } finally {
                                    progress = null
                                    job = null
                                }
                            }
                        }) { Text("Scansiona anche queste subnet, poi ricostruisci la mappa") }
                    }
                    // before SNMP and discovery (or while the scan runs): every device presumed under the gateway
                    val snapshot = hosts.toList()
                    val graph = t?.graph ?: remember(snapshot) { Topology.build(snapshot, emptyList(), gatewayIp()).graph }
                    TopologyGraphView(graph, selectedNode, "Topologia di rete $cidr") { selectedNode = it }
                    selectedNode?.let { id ->
                        TopologyNodeCard(graph, id, graph.byId[id]?.host?.let { h -> { open(h) } }) { selectedNode = null }
                    }
                    if (t != null) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedButton(onClick = { shareCsv(context, "Collegamenti di rete", TopoGraph.csv(t.graph)) }) { Text("Collegamenti CSV") }
                        OutlinedButton(onClick = { shareCsv(context, "Dispositivi di rete", TopoGraph.devicesCsv(t.graph)) }) { Text("Dispositivi CSV") }
                    }
                } }
                topo?.found?.takeIf { it.isNotEmpty() }?.let { found ->
                    SectionCard("Discovery: ${found.size} dispositivi") {
                        found.sortedBy { Ip.parse(it.ip) ?: Long.MAX_VALUE }.forEach { f ->
                            Text("${f.ip} · ${f.vendor}${f.model?.let { " $it" } ?: ""}", fontWeight = FontWeight.SemiBold)
                            Text(
                                listOfNotNull(f.protocol, f.name, f.mac, f.firmware, f.details.entries.joinToString(" · ") { "${it.key} ${it.value}" }.ifBlank { null }).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
            1 -> Panel {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    PanelTitle("Occupazione degli indirizzi", R.drawable.ic_lan)
                    SubnetGrid(hosts.toList()) { h -> filter = h.ip; openHost = h.ip; setView(0) }
                }
            }
            else -> {
                @Composable
                fun Search(m: Modifier) = Field("Cerca IP, nome, MAC, produttore", filter, { filter = it }, m, leadingIcon = R.drawable.ic_search, trailing = if (filter.isNotEmpty()) { { TextButton(onClick = { filter = "" }) { Text("Pulisci") } } } else null)
                @Composable
                fun SortAndCsv() {
                    Dropdown("Ordina per", listOf("IP", "Latenza", "Tipo", "Produttore"), sort, { it }, { sort = it }, if (wide) Modifier.width(170.dp) else Modifier.fillMaxWidth(0.72f))
                    OutlinedButton(onClick = {
                        shareCsv(context, "Scansione $cidr", listOf(listOf("IP", "Nome", "MAC", "Produttore", "Tipo", "Porte", "Latenza ms", "Rilevato con")) +
                            hosts.map { listOf(it.ip, it.hostname ?: it.netbios, it.mac, it.vendor, it.kind, it.ports.joinToString(" "), it.latencyMs, it.how) })
                    }, modifier = Modifier.heightIn(min = 56.dp)) { Text("CSV") }
                }
                // one row when there is room, search above sort otherwise
                if (wide) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Search(Modifier.weight(1f))
                    SortAndCsv()
                } else {
                    Search(Modifier)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) { SortAndCsv() }
                }
                val shown = hosts.filter { h ->
                    (typeFilter == null || scanType(h) == typeFilter) &&
                        (filter.isBlank() || listOf(h.ip, h.hostname, h.netbios, h.vendor, h.kind, h.mac).any { it?.contains(filter, true) == true })
                }.let { l ->
                    when (sort) {
                        "Latenza" -> l.sortedBy { it.latencyMs ?: Int.MAX_VALUE }
                        "Tipo" -> l.sortedBy { scanType(it).ordinal }
                        "Produttore" -> l.sortedBy { it.vendor ?: "~" }
                        else -> l.sortedBy { Ip.parse(it.ip) }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp, bottom = 2.dp)) {
                    Text(
                        if (shown.size == hosts.size) "${hosts.size} host" else "${shown.size} di ${hosts.size} host",
                        style = MaterialTheme.typography.labelLarge,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.weight(1f),
                    )
                    typeFilter?.let { t -> TextButton(onClick = { typeFilter = null }) { Text("${t.label} ✕") } }
                }
                shown.forEach { h ->
                    HostRow(h, openHost == h.ip, { openHost = if (openHost == h.ip) null else h.ip }) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            androidx.compose.material3.FilledTonalButton(onClick = { onPortScan(h.ip) }) { Text("Porte") }
                            if (80 in h.ports || 443 in h.ports || 20443 in h.ports || 8080 in h.ports) {
                                androidx.compose.material3.FilledTonalButton(onClick = {
                                    val url = when { 20443 in h.ports -> "https://${h.ip}:20443"; 443 in h.ports -> "https://${h.ip}"; 8080 in h.ports -> "http://${h.ip}:8080"; else -> "http://${h.ip}" }
                                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                                }) { Text("Web") }
                            }
                            TextButton(onClick = {
                                context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("IP", h.ip))
                            }) { Text("Copia IP") }
                            h.mac?.let { mac ->
                                TextButton(onClick = {
                                    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("MAC", mac))
                                }) { Text("Copia MAC") }
                            }
                        }
                    }
                }
            }
        }
    }

    // the screen scrolls by itself: in landscape and on tablets controls and summary on the left,
    // results on the right, each column with its own scroll
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val roomy = maxWidth >= 900.dp
        if (maxWidth >= 640.dp) {
            Row(Modifier.fillMaxSize().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.width(300.dp).fillMaxHeight().verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
                    ErrorBanner(error) { error = null }
                    ControlPanel()
                    if (hosts.isNotEmpty()) SummaryPanel()
                }
                Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) { Results(roomy) }
            }
        } else {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
                ErrorBanner(error) { error = null }
                ControlPanel()
                if (hosts.isNotEmpty()) SummaryPanel()
                Results(false)
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Port scanner
// ---------------------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
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
        Panel {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                PanelTitle("Scansione porte TCP", R.drawable.ic_manage_search) {
                    when {
                        job != null -> StatusChip("IN CORSO", NoticeKind.Warn)
                        results.isNotEmpty() -> StatusChip("COMPLETATA", NoticeKind.Good)
                        else -> {}
                    }
                }
                Field("Host (IP privato o nome)", host, { host = it.trim() }, keyboardType = KeyboardType.Uri, leadingIcon = R.drawable.ic_dns)
                Text("PROFILO", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, letterSpacing = 0.8.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Ports.PRESETS.forEach { (name, list) ->
                        FilterChip(
                            selected = custom.isBlank() && preset == name,
                            onClick = { preset = name; custom = "" },
                            label = { Text("$name · ${list.size}") },
                        )
                    }
                }
                Field("Elenco personalizzato", custom, { custom = it }, placeholder = "es. 1-1024,8291,8728,20443", leadingIcon = R.drawable.ic_terminal)
                Text("TIMEOUT PER PORTA", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, letterSpacing = 0.8.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("300" to "LAN veloce", "600" to "LAN", "1000" to "Radio", "1500" to "Radio lento").forEach { (ms, hint) ->
                        FilterChip(selected = timeout == ms, onClick = { timeout = ms }, label = { Text("$ms ms · $hint") })
                    }
                }
                SwitchRow("Banner, header HTTP e certificati TLS", grab) { grab = it }
                SwitchRow("Mostra anche porte chiuse/filtrate", showClosed) { showClosed = it }
                if (job == null) BusyButton("Avvia scansione", false, Modifier.fillMaxWidth()) { start() }
                else OutlinedButton(onClick = { job?.cancel() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Interrompi") }
                if (job != null && done.second > 0) {
                    LinearProgressIndicator(progress = { done.first / done.second.toFloat() }, modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)))
                    Text("${done.first}/${done.second} porte · ${openLive.size} aperte", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
                }
            }
        }
        val list = if (job != null) openLive else results
        if (list.isNotEmpty()) {
            Panel {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    PanelTitle("Risultati · $host", R.drawable.ic_query_stats) {
                        if (job == null) TextButton(onClick = {
                            shareCsv(context, "Porte $host", listOf(listOf("Porta", "Stato", "Servizio", "Latenza ms", "Banner", "TLS")) + results.filter { showClosed || it.state == PortState.Open }.map { listOf(it.port, it.state, it.service, it.latencyMs, it.banner, it.tls) })
                        }) { Text("CSV") }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatTile("${list.count { it.state == PortState.Open }}", "Aperte", R.drawable.ic_check_circle, GoodGreen, Modifier.weight(1f))
                        if (job == null) {
                            StatTile("${results.count { it.state == PortState.Closed }}", "Chiuse", R.drawable.ic_lock, MaterialTheme.colorScheme.outline, Modifier.weight(1f))
                            StatTile("${results.count { it.state == PortState.Filtered }}", "Filtrate", R.drawable.ic_shield, WarnAmber, Modifier.weight(1f))
                        }
                    }
                    if (job == null) {
                        elapsed?.let { Text("${results.size} porte in ${"%.1f".format(it / 1000.0)} s · filtrata = nessuna risposta (firewall o host spento)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        if (results.size in 2..1100) {
                            PortMap(results)
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                listOf(GoodGreen to "aperta", MaterialTheme.colorScheme.outlineVariant to "chiusa", WarnAmber.copy(alpha = 0.7f) to "filtrata").forEach { (col, label) ->
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(col))
                                        Spacer(Modifier.width(4.dp))
                                        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                            }
                        }
                    }
                    list.filter { showClosed || it.state == PortState.Open }.forEach { r -> PortRow(r) }
                }
            }
        } else if (job == null && results.isNotEmpty()) {
            Notice("Nessuna porta aperta tra le ${results.size} verificate.", NoticeKind.Warn)
        }
    }
}

/** One port: state dot, number, service and latency; banner and certificate below. */
@Composable
private fun PortRow(r: PortResult) {
    val color = when (r.state) { PortState.Open -> GoodGreen; PortState.Closed -> MaterialTheme.colorScheme.outline; PortState.Filtered -> WarnAmber }
    Surface(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp).clip(RoundedCornerShape(50)).background(color))
                Spacer(Modifier.width(10.dp))
                Text("${r.port}", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, modifier = Modifier.width(64.dp))
                Text(r.service.ifBlank { "—" }, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                Text(
                    when (r.state) { PortState.Open -> "aperta"; PortState.Closed -> "chiusa"; PortState.Filtered -> "filtrata" } + (r.latencyMs?.let { " · $it ms" } ?: ""),
                    color = color,
                    style = MaterialTheme.typography.labelMedium,
                    fontFamily = FontFamily.Monospace,
                )
            }
            r.banner?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest).padding(8.dp),
                )
            }
            r.tls?.let { Text("TLS · $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/** Every verified port as a cell: green open, grey closed, amber filtered (in port order). */
@Composable
private fun PortMap(results: List<PortResult>) {
    val open = GoodGreen
    val closed = MaterialTheme.colorScheme.outlineVariant
    val filtered = WarnAmber.copy(alpha = 0.7f)
    val sorted = remember(results) { results.sortedBy { it.port } }
    val cols = if (sorted.size > 200) 32 else 16
    val rows = (sorted.size + cols - 1) / cols
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cell = maxWidth / cols
        androidx.compose.foundation.Canvas(Modifier.fillMaxWidth().height(cell * rows)) {
            val w = size.width / cols
            val gap = if (cols > 16) 1.dp.toPx() else 2.dp.toPx()
            sorted.forEachIndexed { i, r ->
                val c = when (r.state) { PortState.Open -> open; PortState.Closed -> closed; PortState.Filtered -> filtered }
                drawRoundRect(c, androidx.compose.ui.geometry.Offset((i % cols) * w + gap / 2, (i / cols) * w + gap / 2), androidx.compose.ui.geometry.Size(w - gap, w - gap), androidx.compose.ui.geometry.CornerRadius(2.dp.toPx()))
            }
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
            val onWifi by c.network.wifiConnected.collectAsState()
            if (!onWifi) Text("Serve la Wi-Fi della rete del PC da accendere: il magic packet viaggia in broadcast sulla LAN.", color = WarnAmber)
            Field("MAC del PC da accendere", wolMac, { wolMac = it.trim() }, placeholder = "AA:BB:CC:DD:EE:FF")
            Field("Broadcast", wolBcast, { wolBcast = it.trim() }, keyboardType = KeyboardType.Uri)
            BusyButton("Invia magic packet", false, Modifier.fillMaxWidth(), primary = false, enabled = onWifi) {
                scope.launch {
                    error = runCatching { NetDiag.wakeOnLan(wolMac, wolBcast, c.network.wifiNetwork()); null }.getOrElse { it.message }
                    if (error == null) error = "Magic packet inviato a $wolBcast (UDP 9 e 7)"
                }
            }
        }
    }
}
