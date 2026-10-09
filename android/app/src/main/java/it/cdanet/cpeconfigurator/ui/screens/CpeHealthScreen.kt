package it.cdanet.cpeconfigurator.ui.screens

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
    "firmware" to "firmware",
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
    val admin = c.session.isAdmin

    suspend fun load() {
        busy = true
        error = null
        runCatching { c.api.cpeHealth() }.onSuccess { data = it }.onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(Unit) { load() }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        BusyButton("Aggiorna", busy, Modifier.fillMaxWidth(), primary = false) { scope.launch { load() } }
        val d = data ?: return@Column
        SectionCard {
            Text("${d.totals.cpes} CPE installate · ${d.totals.ok} senza problemi", fontWeight = FontWeight.SemiBold)
            if (d.totals.offline > 0) Text("${d.totals.offline} offline", color = BadRed)
            if (d.totals.signalDrop > 0) Text("${d.totals.signalDrop} con segnale calato dal collaudo", color = WarnAmber)
            if (d.totals.ethernet > 0) Text("${d.totals.ethernet} con porta LAN lenta o half duplex (cavo)", color = WarnAmber)
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
        shown.take(limit).forEach { cpe ->
            SectionCard {
                Text(cpe.deviceName.ifBlank { cpe.mac }, style = MaterialTheme.typography.titleMedium)
                Text("${cpe.model} · ${cpe.mac} · ${cpe.now?.apName ?: cpe.ssid}", style = MaterialTheme.typography.bodySmall)
                if (cpe.issues.isEmpty()) {
                    Text("Nessun problema", color = GoodGreen)
                } else {
                    Text(cpe.issues.joinToString(" · ") { ISSUES[it] ?: it }, color = if (cpe.issues.any { it == "offline" || it == "not_in_uisp" || it == "weak_signal" }) BadRed else WarnAmber)
                }
                Text(
                    "Segnale al collaudo ${cpe.acceptanceSignal?.toInt() ?: "—"} dBm → ora ${cpe.now?.signal?.toInt() ?: "—"} dBm" +
                        (cpe.signalDelta?.let { " (${if (it > 0) "+" else ""}$it dB)" } ?: ""),
                    style = MaterialTheme.typography.bodySmall,
                )
                cpe.now?.let { n -> n.ethMbps?.let { Text("Porta LAN $it Mbit/s${if (n.ethHalfDuplex) " half duplex" else ""}", style = MaterialTheme.typography.bodySmall) } }
                Text(
                    listOfNotNull(
                        cpe.createdAt?.let { "Installata il ${it.take(10).split('-').reversed().joinToString("/")}" } ?: if (admin) "Non installata con l'app" else "Assegnata dall'amministratore",
                        cpe.installer.takeIf { admin && it.isNotBlank() }?.let { "da $it" },
                        cpe.assignedTo?.takeIf { admin }?.let { "assegnata a ${it.username}" },
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val jobId = cpe.jobId
                if (c.moduleOn("signal_history") && cpe.now != null && jobId != null) {
                    Row {
                        TextButton(onClick = { open = if (open == jobId) null else jobId }) { Text(if (open == jobId) "Nascondi storico" else "Storico segnale 7 giorni") }
                    }
                    if (open == jobId) {
                        SignalHistory(c, JobDto(id = jobId, createdAt = cpe.createdAt ?: "", status = "success", model = cpe.model, mac = cpe.mac, serial = "", ssid = cpe.ssid, pppoeUser = ""))
                    }
                }
                if (onRepoint != null && cpe.issues.any { it in REPOINT }) {
                    TextButton(onClick = onRepoint) { Text("Vai al ripuntamento") }
                }
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
