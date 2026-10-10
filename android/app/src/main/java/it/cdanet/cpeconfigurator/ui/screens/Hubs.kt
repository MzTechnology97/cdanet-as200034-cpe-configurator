package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.widthIn
import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.JobDto
import it.cdanet.cpeconfigurator.field.CompassTarget
import it.cdanet.cpeconfigurator.provisioning.Phase
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.ListHeader
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.StatusChip
import it.cdanet.cpeconfigurator.ui.WifiRequired
import kotlinx.coroutines.launch

/** Tabs of each area for the enabled features (pure: Home uses them to open the right tab). */
fun installTabTitles(m: Map<String, Boolean>, admin: Boolean) = buildList {
    add("Da completare")
    add("Storico")
    if (m["cpe_health"] != false) add(if (admin) "Salute CPE" else "Stato CPE")
}

fun networkTabTitles(m: Map<String, Boolean>) = buildList {
    if (m["network_status"] != false) add("Stato")
    if (m["power_outages"] != false) {
        add("Guasti")
        add("Aree e avvisi")
    }
    if (m["compass"] != false || m["coverage"] != false) add("AP vicini")
}

fun cpeTabTitles(m: Map<String, Boolean>) = buildList {
    if (m["field_diagnosis"] != false) add("Diagnosi")
    if (m["field_alignment"] != false) {
        add("Puntamento")
        add("AP visibili")
    }
    if (m["acceptance"] != false) add("Collaudo")
    if (m["firmware_upgrade"] != false) add("Firmware")
}

/** One tab of an area: title, icon and whether its content scrolls inside the tab. */
class HubTab(val title: String, @DrawableRes val icon: Int, val scroll: Boolean = true, val content: @Composable () -> Unit)

/**
 * An area of the app with tabs (e.g. Rete: Stato, Guasti, Aree, AP vicini). Only the selected tab is
 * composed, so a screen that polls the CPE or uses the camera never runs in the background.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun TabbedHub(tabs: List<HubTab>, selected: Int, onSelect: (Int) -> Unit) {
    if (tabs.isEmpty()) {
        EmptyState(R.drawable.ic_info, "Nessuna funzione disponibile", "Le funzioni di quest'area non sono attive per il tuo account.")
        return
    }
    val index = selected.coerceIn(0, tabs.lastIndex)
    val compactTabs = androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp < 500
    Column(Modifier.fillMaxSize()) {
        if (tabs.size > 1) {
            PrimaryScrollableTabRow(selectedTabIndex = index, edgePadding = 12.dp, containerColor = MaterialTheme.colorScheme.surface) {
                tabs.forEachIndexed { i, t ->
                    Tab(
                        selected = i == index,
                        onClick = { onSelect(i) },
                        text = { Text(t.title, maxLines = 1) },
                        // low screens (phones in landscape): text only, the content gets the height
                        icon = if (compactTabs) null else { { Icon(painterResource(t.icon), contentDescription = null, modifier = Modifier.size(20.dp)) } },
                    )
                }
            }
        }
        val tab = tabs[index]
        Box(Modifier.weight(1f).fillMaxWidth()) {
            androidx.compose.runtime.key(tab.title) {
                if (tab.scroll) {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) { tab.content() }
                } else {
                    tab.content()
                }
            }
        }
    }
}

private const val CPE_WIFI_HUB = "alla Wi-Fi della CPE (management, es. \"LBE-5AC-Gen2:xxxx\") oppure a quella del router del cliente"
private const val LAN_WIFI = "alla Wi-Fi della rete locale da analizzare"

/** "Le mie installazioni": what is left to do, the history and the state of the installed CPEs. */
@Composable
fun InstallationsHub(
    c: AppContainer,
    selected: Int,
    onSelect: (Int) -> Unit,
    onResume: () -> Unit,
    onAcceptance: (JobDto) -> Unit,
    onReplace: (JobDto) -> Unit,
    onRepoint: (() -> Unit)?,
) {
    val modules by c.modules.collectAsState()
    val tabs = installTabTitles(modules, c.session.isAdmin).map { t ->
        when (t) {
            "Da completare" -> HubTab(t, R.drawable.ic_pending_actions) { ToDoPanel(c, onResume, onAcceptance) }
            "Storico" -> HubTab(t, R.drawable.ic_history) { HistoryScreen(c, onAcceptance = onAcceptance, onReplace = onReplace) }
            else -> HubTab(t, R.drawable.ic_monitor_heart) { CpeHealthScreen(c, onRepoint) }
        }
    }
    TabbedHub(tabs, selected, onSelect)
}

/** "Rete": POP/AP state, Enel outages, the user's areas of interest and the APs near a place. */
@Composable
fun NetworkHub(c: AppContainer, selected: Int, onSelect: (Int) -> Unit, onAim: (CompassTarget) -> Unit, onCompass: (CompassTarget) -> Unit) {
    val modules by c.modules.collectAsState()
    val tabs = networkTabTitles(modules).map { t ->
        when (t) {
            "Stato" -> HubTab(t, R.drawable.ic_hub) { NetworkStatusScreen(c) }
            "Guasti" -> HubTab(t, R.drawable.ic_power_off) { OutagesScreen(c, OutageSection.List) }
            "Aree e avvisi" -> HubTab(t, R.drawable.ic_my_location) { OutagesScreen(c, OutageSection.Areas) }
            else -> HubTab(t, R.drawable.ic_explore, scroll = false) { NearApsPanel(c, onAim, onCompass) }
        }
    }
    TabbedHub(tabs, selected, onSelect)
}

/**
 * "AP vicini": one place for what were Trova l'AP (from here, with map, tilt and AR sight) and
 * Copertura (from an address, before going on site).
 */
@Composable
private fun NearApsPanel(c: AppContainer, onAim: (CompassTarget) -> Unit, onCompass: (CompassTarget) -> Unit) {
    val modules by c.modules.collectAsState()
    val here = modules["compass"] != false
    val address = modules["coverage"] != false
    var fromAddress by remember { mutableStateOf(!here) }
    Column(Modifier.fillMaxSize()) {
        if (here && address) {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                SegmentedButton(selected = !fromAddress, onClick = { fromAddress = false }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text("Da qui") }
                SegmentedButton(selected = fromAddress, onClick = { fromAddress = true }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text("Da un indirizzo") }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (fromAddress) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp)) {
                    CoverageScreen(c, onCompass = if (here) onCompass else null)
                }
            } else {
                PointingScreen(c, onAim = onAim, onCompass = onCompass)
            }
        }
    }
}

/** "CPE collegata": everything done with the CPE in hand, connecting to it once. */
@Composable
fun CpeHub(c: AppContainer, selected: Int, onSelect: (Int) -> Unit, onAcceptance: () -> Unit) {
    val modules by c.modules.collectAsState()
    val tabs = cpeTabTitles(modules).map { t ->
        when (t) {
            "Diagnosi" -> HubTab(t, R.drawable.ic_troubleshoot) { WifiRequired(c, CPE_WIFI_HUB, "La diagnosi interroga la CPE in rete locale.") { DiagnosisScreen(c) } }
            "Puntamento" -> HubTab(t, R.drawable.ic_signal_cellular_alt) { WifiRequired(c, CPE_WIFI_HUB, "Il segnale si legge direttamente dalla CPE.") { AlignmentScreen(c) } }
            "AP visibili" -> HubTab(t, R.drawable.ic_cell_tower) { CpeApsPanel(c) }
            "Firmware" -> HubTab(t, R.drawable.ic_system_update) { FirmwareScreen(c) }
            else -> HubTab(t, R.drawable.ic_check_circle) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Notice("Il collaudo misura la CPE collegata, prova Internet dal lato cliente e raccoglie le foto.", NoticeKind.Info)
                    FilledTonalButton(onClick = onAcceptance, modifier = Modifier.fillMaxWidth()) { Text("Apri il collaudo") }
                }
            }
        }
    }
    TabbedHub(tabs, selected, onSelect)
}

/** Network tools grouped: 6 entries instead of 10. */
@Composable
fun LanHub(c: AppContainer, selected: Int, onSelect: (Int) -> Unit, onPortScan: (String) -> Unit) {
    val tabs = listOf(
        HubTab("Host attivi", R.drawable.ic_radar, scroll = false) { WifiRequired(c, LAN_WIFI, "Lo scanner esamina la subnet della Wi-Fi collegata.") { IpScannerScreen(c, onPortScan = onPortScan) } },
        HubTab("Discovery", R.drawable.ic_device_hub) { ReadingColumn { WifiRequired(c, LAN_WIFI, "La discovery funziona solo sulla stessa LAN.") { LanDiscoveryScreen(c) } } },
        HubTab("Porte", R.drawable.ic_manage_search) { ReadingColumn { WifiRequired(c, LAN_WIFI, "Le porte di host privati si verificano dalla stessa rete locale.") { PortScannerScreen(c) } } },
    )
    TabbedHub(tabs, selected, onSelect)
}

/** On a wide screen, keeps a single-column tab at a readable width, centered. */
@Composable
private fun ReadingColumn(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = 760.dp)) { content() }
    }
}

@Composable
fun DiagHub(c: AppContainer, selected: Int, onSelect: (Int) -> Unit) {
    TabbedHub(
        listOf(
            HubTab("Base", R.drawable.ic_speed) { NetworkScreen(c) },
            HubTab("Avanzata", R.drawable.ic_query_stats) { NetDiagScreen(c) },
        ),
        selected,
        onSelect,
    )
}

@Composable
fun DevicesHub(c: AppContainer, selected: Int, onSelect: (Int) -> Unit) {
    TabbedHub(
        listOf(
            HubTab("SNMP", R.drawable.ic_memory) { WifiRequired(c, LAN_WIFI, "Gli apparati SNMP si interrogano in rete locale.") { SnmpScreen(c) } },
            HubTab("TVCC", R.drawable.ic_videocam) { WifiRequired(c, "alla Wi-Fi della rete delle telecamere", "ONVIF, SADP e RTSP funzionano sulla rete locale.") { CameraScreen(c) } },
        ),
        selected,
        onSelect,
    )
}

// ---- Da completare ---------------------------------------------------------------------------

/** Something left to do on an installation, with the action that closes it. */
data class ToDo(val job: JobDto?, val title: String, val detail: String, val kind: NoticeKind, val chip: String, val action: String?)

/** What is still open in the installer's own work (pure, also used for the Oggi counters). */
fun toDoItems(jobs: List<JobDto>): List<ToDo> {
    val okMacs = jobs.filter { it.status == "success" }.map { it.mac }.toSet()
    return buildList {
        jobs.forEach { j ->
            val name = j.deviceName.ifBlank { j.pppoeUser }
            when {
                j.review == "rejected" -> add(ToDo(j, name, "Collaudo non accettato dal NOC: vedi Notifiche, poi ripunta o rifai il collaudo.", NoticeKind.Bad, "non accettato", "Collaudo"))
                j.ko?.kind == "postponed" -> add(ToDo(j, name, "Installazione rimandata: da riprovare.", NoticeKind.Warn, "rimandata", null))
                j.status == "failed" && j.mac !in okMacs -> add(ToDo(j, name, j.error.ifBlank { "Scrittura nella CPE non riuscita." }, NoticeKind.Bad, "fallita", null))
                j.status == "success" && j.acceptance == null -> add(ToDo(j, name, "Installata: manca il collaudo con misure e foto.", NoticeKind.Warn, "collaudo da fare", "Collaudo"))
                j.review == "pending" -> add(ToDo(j, name, "Collaudo in attesa dell'approvazione del NOC.", NoticeKind.Info, "in attesa NOC", null))
            }
        }
    }
}

@Composable
private fun ToDoPanel(c: AppContainer, onResume: () -> Unit, onAcceptance: (JobDto) -> Unit) {
    val scope = rememberCoroutineScope()
    val prov by c.provisioning.state.collectAsState()
    val install by c.install.state.collectAsState()
    val pending by c.resultQueue.pending.collectAsState()
    val refused by c.resultQueue.rejected.collectAsState()
    val acc by c.acceptanceQueue.pending.collectAsState()
    var jobs by remember { mutableStateOf<List<JobDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    suspend fun load() {
        busy = true
        runCatching { jobs = c.api.myJobs() }.onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(c.refresh.collectAsState().value) { load() }
    val items = jobs?.let { toDoItems(it) }.orEmpty()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ErrorBanner(error) { error = null }
        // results sent from the queue and refused by the server: never silently lost
        refused.forEach { r ->
            it.cdanet.cpeconfigurator.ui.Notice(
                "Esito di ${r.label} rifiutato dal server: ${r.reason}. Rifai l'installazione o avvisa il NOC.",
                it.cdanet.cpeconfigurator.ui.NoticeKind.Bad,
            ) { scope.launch { c.resultQueue.dismissRejected(r.jobId) } }
        }
        if (jobs == null && busy) it.cdanet.cpeconfigurator.ui.SkeletonRows(3)
        ListHeader(if (jobs == null) "Da completare" else if (items.isEmpty()) "Tutto in ordine" else "${items.size} da completare", busy) { scope.launch { load() } }
        if (install.mode != null || (prov.pkg != null && prov.phase != Phase.Done)) {
            ToDoRow(
                ToDo(null, prov.pkg?.summary?.deviceName ?: "Intervento in corso", "Hai un'installazione aperta in questo telefono.", NoticeKind.Warn, "in corso", "Riprendi"),
                onAction = onResume,
            )
        }
        if (pending.isNotEmpty()) Notice("${pending.size} esiti in attesa di invio: partiranno appena c'è rete.", NoticeKind.Info)
        if (acc.isNotEmpty()) Notice("${acc.size} collaudi in attesa di invio (foto comprese).", NoticeKind.Info)
        items.forEach { t -> ToDoRow(t) { t.job?.let(onAcceptance) } }
        if (jobs != null && items.isEmpty() && install.mode == null) {
            EmptyState(R.drawable.ic_check_circle, "Niente da completare", "Ogni installazione ha il suo collaudo e nessuna è in sospeso.")
        }
    }
}

@Composable
private fun ToDoRow(t: ToDo, onAction: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large).background(MaterialTheme.colorScheme.surfaceContainerLow).padding(start = 16.dp, end = 12.dp, top = 12.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(t.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                t.job?.let { Text("${it.model} · ${it.mac}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            StatusChip(t.chip, t.kind)
        }
        Text(t.detail, style = MaterialTheme.typography.bodySmall)
        if (t.action != null) {
            Row {
                Spacer(Modifier.weight(1f))
                FilledTonalButton(onClick = onAction) { Text(t.action) }
            }
        }
    }
}

// ---- Strumenti -------------------------------------------------------------------------------

/** One entry of the tools area. */
class ToolEntry(val title: String, val subtitle: String, @DrawableRes val icon: Int, val open: () -> Unit)

/** Tools as a list of large rows, each with its icon. */
@Composable
fun ToolsList(groups: List<Pair<String, List<ToolEntry>>>) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 12.dp)) {
        groups.filter { it.second.isNotEmpty() }.forEach { (title, entries) ->
            Text(title.uppercase(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp, start = 4.dp))
            entries.forEach { e ->
                androidx.compose.material3.Card(
                    onClick = e.open,
                    shape = MaterialTheme.shapes.large,
                    colors = androidx.compose.material3.CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(42.dp).clip(RoundedCornerShape(13.dp)).background(MaterialTheme.colorScheme.tertiaryContainer), contentAlignment = Alignment.Center) {
                            Icon(painterResource(e.icon), contentDescription = null, tint = MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.size(22.dp))
                        }
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(e.title, style = MaterialTheme.typography.titleSmall)
                            Text(e.subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Icon(painterResource(R.drawable.ic_arrow_forward), contentDescription = null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}

/** Selected tab of each area, kept while moving around the app. */
class HubTabs {
    private val map = androidx.compose.runtime.mutableStateMapOf<String, Int>()
    operator fun get(key: String) = map[key] ?: 0
    operator fun set(key: String, value: Int) { map[key] = value }
}

@Composable
fun rememberHubTabs() = remember { HubTabs() }
