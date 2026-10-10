package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.runtime.collectAsState
import it.cdanet.cpeconfigurator.ui.RefreshButton
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
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
import it.cdanet.cpeconfigurator.field.HealthShow
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

/** "Le mie CPE": the CPEs I installed, current state vs the acceptance test (no PPPoE data). */
@Composable
fun CpeHealthScreen(c: AppContainer, onRepoint: (() -> Unit)? = null) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<CpeHealthDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var show by remember { mutableStateOf(HealthShow.Issues) }
    var origin by remember { mutableStateOf(HealthOrigin.All) }
    var query by remember { mutableStateOf("") }
    var limit by remember { mutableStateOf(PAGE) }
    var open by remember { mutableStateOf<String?>(null) }
    var history by remember { mutableStateOf<String?>(null) }
    val admin = c.session.isAdmin

    suspend fun load() {
        busy = true
        error = null
        runCatching { c.api.cpeHealth() }.onSuccess { data = it }.onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(c.refresh.collectAsState().value) { load() }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        if (data == null && busy) it.cdanet.cpeconfigurator.ui.SkeletonRows(4)
        val d = data
        if (d == null) {
            BusyButton("Aggiorna", busy, Modifier.fillMaxWidth(), primary = false) { scope.launch { load() } }
            return@Column
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            listOfNotNull(
                "${d.totals.cpes} CPE",
                "${d.totals.ok} ok",
                d.totals.offline.takeIf { it > 0 }?.let { "$it offline" },
                d.totals.signalDrop.takeIf { it > 0 }?.let { "$it segnale calato" },
                d.totals.ethernet.takeIf { it > 0 }?.let { "$it porta LAN" },
            ).joinToString(" · "),
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
        )
            RefreshButton(busy) { scope.launch { load() } }
        }
        OutlinedTextField(
            value = query,
            onValueChange = { query = it; limit = PAGE },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            placeholder = { Text(if (admin) "Cliente, MAC, AP, SSID, installatore…" else "Cliente, MAC, AP, SSID…") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Clear, contentDescription = "Cancella") } },
        )
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            HealthShow.entries.forEach { f ->
                val n = d.cpes.count { f.matches(it) && origin.matches(it) }
                if (n > 0 || f == show || f == HealthShow.Issues || f == HealthShow.All) {
                    FilterChip(selected = show == f, onClick = { show = f; limit = PAGE }, label = { Text("${f.label} ($n)") })
                }
            }
        }
        // origin: only when the list mixes CPEs installed with the app and others
        if (d.cpes.any { it.source != "app" }) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                HealthOrigin.entries.filter { admin || !it.adminOnly }.forEach { o ->
                    FilterChip(selected = origin == o, onClick = { origin = o; limit = PAGE }, label = { Text(if (admin) o.label else o.installerLabel) })
                }
            }
        }
        val shown = HealthFilter.apply(d.cpes, show, origin, query)
        Text(
            if (shown.isEmpty()) "Nessuna CPE con questi filtri" else "${shown.size} CPE" + if (shown.size > limit) " · mostrate le prime $limit" else "",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (shown.isNotEmpty()) SectionCard {
            shown.take(limit).forEachIndexed { i, cpe ->
                if (i > 0) HorizontalDivider()
                CpeRow(c, cpe, admin, expanded = open == cpe.mac, history = history == cpe.mac,
                    onToggle = { open = if (open == cpe.mac) null else cpe.mac },
                    onHistory = { history = if (history == cpe.mac) null else cpe.mac },
                    onRepoint = if (cpe.issues.any { it in REPOINT }) onRepoint else null)
            }
        }
        if (shown.size > limit) {
            BusyButton("Mostra altre ${minOf(PAGE, shown.size - limit)}", false, Modifier.fillMaxWidth(), primary = false) { limit += PAGE }
        }
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
) {
    val color = when {
        cpe.issues.any { it in SERIOUS } -> BadRed
        cpe.issues.isNotEmpty() -> WarnAmber
        else -> GoodGreen
    }
    Column {
        Row(Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(color))
            Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                Text(cpe.deviceName.ifBlank { cpe.mac }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    if (cpe.issues.isNotEmpty()) cpe.issues.joinToString(" · ") { ISSUES[it] ?: it } else cpe.now?.apName ?: cpe.ssid,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (cpe.issues.isNotEmpty()) color else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(cpe.now?.signal?.let { "${it.toInt()} dBm" } ?: "—", fontWeight = FontWeight.SemiBold)
                cpe.signalDelta?.takeIf { it != 0 }?.let { d ->
                    Text("${if (d > 0) "+" else ""}$d dB", style = MaterialTheme.typography.bodySmall, color = if (d < 0) WarnAmber else GoodGreen)
                }
            }
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
                }
                val jobId = cpe.jobId
                if (history && jobId != null) {
                    SignalHistory(c, JobDto(id = jobId, createdAt = cpe.createdAt ?: "", status = "success", model = cpe.model, mac = cpe.mac, serial = "", ssid = cpe.ssid, pppoeUser = ""))
                }
            }
        }
    }
}

