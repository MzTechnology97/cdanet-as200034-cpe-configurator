package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
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
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.launch

private val ISSUES = mapOf(
    "offline" to "offline",
    "not_in_uisp" to "non trovata in UISP",
    "weak_signal" to "segnale debole",
    "signal_drop" to "segnale calato",
    "ethernet" to "porta LAN",
    "pending" to "da accettare in UISP",
    "low_capacity" to "capacità bassa",
    "firmware" to "firmware",
)

/** "Le mie CPE": the CPEs I installed, current state vs the acceptance test (no PPPoE data). */
@Composable
fun CpeHealthScreen(c: AppContainer) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<CpeHealthDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var onlyIssues by remember { mutableStateOf(true) }
    var open by remember { mutableStateOf<String?>(null) }

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
            TextButton(onClick = { onlyIssues = !onlyIssues }) { Text(if (onlyIssues) "Mostra tutte" else "Solo con problemi") }
        }
        d.cpes.filter { !onlyIssues || it.issues.isNotEmpty() }.forEach { cpe ->
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
                Text("Installata il ${cpe.createdAt.take(10)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (c.moduleOn("signal_history") && cpe.now != null) {
                    Row {
                        TextButton(onClick = { open = if (open == cpe.jobId) null else cpe.jobId }) { Text(if (open == cpe.jobId) "Nascondi storico" else "Storico segnale 7 giorni") }
                    }
                    if (open == cpe.jobId) {
                        SignalHistory(c, JobDto(id = cpe.jobId, createdAt = cpe.createdAt, status = "success", model = cpe.model, mac = cpe.mac, serial = "", ssid = cpe.ssid, pppoeUser = ""))
                    }
                }
            }
        }
    }
}
