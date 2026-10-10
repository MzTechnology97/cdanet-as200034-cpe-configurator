package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.runtime.collectAsState
import it.cdanet.cpeconfigurator.ui.RefreshButton
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.ui.res.painterResource
import it.cdanet.cpeconfigurator.R
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import it.cdanet.cpeconfigurator.data.CpeHealthItemDto
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.CpeHealthDto
import it.cdanet.cpeconfigurator.data.JobDto
import it.cdanet.cpeconfigurator.field.HealthFilter
import it.cdanet.cpeconfigurator.field.HealthOrigin
import it.cdanet.cpeconfigurator.field.HealthProblem
import it.cdanet.cpeconfigurator.field.HealthState
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.launch

private val ISSUES = mapOf(
    "offline" to "offline",
    "not_in_uisp" to "non trovata in rete",
    "weak_signal" to "segnale debole",
    "signal_drop" to "segnale calato",
    "ethernet" to "porta LAN",
    "pending" to "in attesa di attivazione",
    "low_capacity" to "capacità bassa",
    "firmware" to "firmware da aggiornare",
    // admins with ISP Billing connected (the server sends them only to admins)
    "pppoe_offline" to "PPPoE offline",
    "account_suspended" to "account sospeso",
    "account_terminated" to "cliente cessato",
)

/**
 * Salute CPE (admins) / Stato CPE (installers): tiles for every CPE, online, offline and with a
 * problem; search; a filter panel (kind of problem, origin, gone CPEs); one clean row per CPE.
 * Admins open the CPE management (UISP + ISP Billing) with a tap; installers see the details.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CpeHealthScreen(c: AppContainer, onRepoint: (() -> Unit)? = null) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<CpeHealthDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var state by remember { mutableStateOf(HealthState.Issues) }
    var problem by remember { mutableStateOf<HealthProblem?>(null) }
    var origin by remember { mutableStateOf(HealthOrigin.All) }
    var query by remember { mutableStateOf("") }
    var limit by remember { mutableStateOf(PAGE) }
    var open by remember { mutableStateOf<String?>(null) }
    var history by remember { mutableStateOf<String?>(null) }
    var filters by remember { mutableStateOf(false) }
    val admin = c.session.isAdmin
    var showStale by remember { mutableStateOf(false) }

    suspend fun load() {
        busy = true
        error = null
        runCatching { c.api.cpeHealth(showStale) }.onSuccess { data = it }.onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(c.refresh.collectAsState().value) { load() }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ErrorBanner(error) { error = null }
        if (data == null && busy) it.cdanet.cpeconfigurator.ui.SkeletonRows(4)
        val d = data
        if (d == null) {
            BusyButton("Aggiorna", busy, Modifier.fillMaxWidth(), primary = false) { scope.launch { load() } }
            return@Column
        }
        val active = listOfNotNull(problem, origin.takeIf { it != HealthOrigin.All }).size + if (showStale) 1 else 0
        // the other filters apply to the tiles' numbers too, so they always add up with the list
        val base = d.cpes.filter { (problem == null || problem!!.matches(it)) && origin.matches(it) && HealthFilter.matchesQuery(it, query) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            HealthState.entries.forEach { st ->
                StateTile(st, base.count { st.matches(it) }, selected = state == st, modifier = Modifier.weight(1f)) { state = st; limit = PAGE }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it; limit = PAGE },
                modifier = Modifier.weight(1f),
                singleLine = true,
                placeholder = { Text("Cerca", maxLines = 1) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Clear, contentDescription = "Cancella") } },
                shape = RoundedCornerShape(28.dp),
            )
            androidx.compose.material3.FilledTonalButton(onClick = { filters = !filters }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp)) {
                Icon(painterResource(R.drawable.ic_manage_search), contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (active > 0) "Filtri ($active)" else "Filtri")
            }
            RefreshButton(busy) { scope.launch { load() } }
        }
        if (filters) {
            SectionCard {
                Text("Problema", style = MaterialTheme.typography.titleSmall)
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    FilterChip(selected = problem == null, onClick = { problem = null; limit = PAGE }, label = { Text("Qualsiasi") })
                    HealthProblem.entries.filter { admin || !it.adminOnly }.forEach { p ->
                        val n = d.cpes.count { p.matches(it) }
                        if (n > 0 || problem == p) FilterChip(selected = problem == p, onClick = { problem = if (problem == p) null else p; state = HealthState.All; limit = PAGE }, label = { Text("${p.label} ($n)") })
                    }
                }
                if (d.cpes.any { it.source != "app" }) {
                    Text("Origine", style = MaterialTheme.typography.titleSmall)
                    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        HealthOrigin.entries.filter { admin || !it.adminOnly }.forEach { o ->
                            FilterChip(selected = origin == o, onClick = { origin = o; limit = PAGE }, label = { Text(if (admin) o.label else o.installerLabel) })
                        }
                    }
                }
                // admins only: the server does not send it to installers, who never see the gone CPEs
                d.stale?.takeIf { admin && it.count > 0 }?.let { st ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(showStale, { showStale = it; scope.launch { load() } })
                        Text("${if (st.count == 1) "Mostra anche la CPE offline" else "Mostra anche le ${st.count} CPE offline"} da più di ${st.months} mesi (clienti probabilmente dismessi)", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                if (active > 0) TextButton(onClick = { problem = null; origin = HealthOrigin.All; if (showStale) { showStale = false; scope.launch { load() } } }) { Text("Azzera filtri") }
            }
        }
        val shown = HealthFilter.apply(d.cpes, state, problem, origin, query)
        Text(
            listOfNotNull(
                if (shown.isEmpty()) "Nessuna CPE" else "${shown.size} CPE",
                state.summary.takeIf { state != HealthState.All },
                problem?.label?.lowercase(),
                (if (admin) origin.label else origin.installerLabel).lowercase().takeIf { origin != HealthOrigin.All },
                "mostrate le prime $limit".takeIf { shown.size > limit },
            ).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (shown.isEmpty()) {
            it.cdanet.cpeconfigurator.ui.EmptyState(R.drawable.ic_check_circle, if (state == HealthState.Issues) "Nessuna CPE con problemi" else "Nessuna CPE con questi filtri")
        } else {
            SectionCard {
                shown.take(limit).forEachIndexed { i, cpe ->
                    if (i > 0) HorizontalDivider()
                    CpeRow(c, cpe, admin, expanded = open == cpe.mac, history = history == cpe.mac,
                        onToggle = { open = if (open == cpe.mac) null else cpe.mac },
                        onHistory = { history = if (history == cpe.mac) null else cpe.mac },
                        onRepoint = if (cpe.issues.any { it in REPOINT }) onRepoint else null,
                        // admins: the CPE as in the UISP app, on its own screen
                        onManage = if (admin) cpe.deviceId?.let { id -> { c.adminCpeId.value = id; c.openAdminCpe.tryEmit(Unit) } } else null)
                }
            }
        }
        if (shown.size > limit) {
            BusyButton("Mostra altre ${minOf(PAGE, shown.size - limit)}", false, Modifier.fillMaxWidth(), primary = false) { limit += PAGE }
        }
    }
}

/** One of the four tiles: count and label, highlighted when it is the active filter. */
@Composable
private fun StateTile(st: HealthState, count: Int, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val accent = when (st) {
        HealthState.Online -> GoodGreen
        HealthState.Offline -> BadRed
        HealthState.Issues -> WarnAmber
        HealthState.All -> MaterialTheme.colorScheme.primary
    }
    val bg = if (selected) accent.copy(alpha = 0.16f) else MaterialTheme.colorScheme.surfaceContainerHigh
    Column(
        modifier.clip(RoundedCornerShape(16.dp)).background(bg).clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(count.toString(), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = if (st == HealthState.All) MaterialTheme.colorScheme.onSurface else accent)
        Text(st.label, style = MaterialTheme.typography.labelMedium, color = if (selected) accent else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
}

private const val PAGE = 50

/** Problems a re-pointing or a change of AP can fix. */
private val REPOINT = setOf("weak_signal", "signal_drop", "low_capacity")

private val SERIOUS = setOf("offline", "not_in_uisp", "weak_signal")

/** One dense row: state, customer, AP or problem, signal now (and the change since the acceptance test). Tap for details. */
@Composable
private fun CpeRow(
    c: AppContainer,
    cpe: CpeHealthItemDto,
    admin: Boolean,
    expanded: Boolean,
    history: Boolean,
    onToggle: () -> Unit,
    onHistory: () -> Unit,
    onRepoint: (() -> Unit)?,
    onManage: (() -> Unit)? = null,
) {
    val color = when {
        cpe.issues.any { it in SERIOUS } -> BadRed
        cpe.issues.isNotEmpty() -> WarnAmber
        else -> GoodGreen
    }
    Column {
        // admins: a tap opens the CPE management (UISP + ISP Billing); installers: the details below
        Row(Modifier.fillMaxWidth().clickable(onClick = onManage ?: onToggle).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(color))
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(cpe.deviceName.ifBlank { cpe.mac }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(cpe.now?.apName ?: cpe.ssid.ifBlank { null }, cpe.issues.takeIf { it.isNotEmpty() }?.joinToString(" · ") { ISSUES[it] ?: it }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (cpe.issues.isNotEmpty()) color else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                // offline: the last signal read, greyed out
                val online = cpe.now?.status == "active"
                Text(cpe.now?.signal?.let { "${it.toInt()} dBm" } ?: "—", fontWeight = FontWeight.SemiBold, color = if (online) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
                cpe.signalDelta?.takeIf { it != 0 }?.let { d ->
                    Text("${if (d > 0) "+" else ""}$d dB", style = MaterialTheme.typography.bodySmall, color = if (d < 0) WarnAmber else GoodGreen)
                }
            }
            if (onManage != null) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Gestisci", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
        }
        if (expanded) {
            Column(Modifier.padding(start = 20.dp, bottom = 6.dp)) {
                val small = MaterialTheme.typography.bodySmall
                Text("${cpe.model.ifBlank { "CPE" }} · ${cpe.mac}", style = small)
                Text(listOfNotNull(cpe.now?.apName, cpe.ssid.ifBlank { null }).joinToString(" · "), style = small)
                Text("Collaudo ${cpe.acceptanceSignal?.toInt() ?: "—"} dBm → ora ${cpe.now?.signal?.toInt() ?: "—"} dBm", style = small)
                cpe.now?.let { n -> n.ethMbps?.let { Text("Porta LAN $it Mbit/s${if (n.ethHalfDuplex) " half duplex" else ""}", style = small) } }
                Text(
                    listOfNotNull(
                        cpe.createdAt?.let { "Installata il ${it.take(10).split('-').reversed().joinToString("/")}" } ?: if (admin) "Non installata con l'app" else "Assegnata dall'amministratore",
                        cpe.installer.takeIf { admin && it.isNotBlank() }?.let { "da $it" },
                        cpe.assignedTo?.takeIf { admin }?.let { "assegnata a ${it.username}" },
                    ).joinToString(" · "),
                    style = small,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row {
                    val jobId = cpe.jobId
                    if (c.moduleOn("signal_history") && cpe.now != null && jobId != null) {
                        TextButton(onClick = onHistory) { Text(if (history) "Nascondi storico" else "Storico 7 giorni") }
                    }
                    if (onRepoint != null) TextButton(onClick = onRepoint) { Text("Ripuntamento") }
                    if (onManage != null) TextButton(onClick = onManage) { Text("Gestisci CPE") }
                }
                val jobId = cpe.jobId
                if (history && jobId != null) {
                    SignalHistory(c, JobDto(id = jobId, createdAt = cpe.createdAt ?: "", status = "success", model = cpe.model, mac = cpe.mac, serial = "", ssid = cpe.ssid, pppoeUser = ""))
                }
            }
        }
    }
}

