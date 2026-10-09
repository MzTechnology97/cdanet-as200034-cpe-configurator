package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.JobDto
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.launch

private fun statusLabel(s: String) = when (s) {
    "success" -> "Completato" to GoodGreen
    "failed" -> "Fallito" to BadRed
    "prepared" -> "Preparato" to WarnAmber
    else -> "Scaduto" to WarnAmber
}

@Composable
fun HistoryScreen(c: AppContainer, onAcceptance: (JobDto) -> Unit, onReplace: (JobDto) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val pending by c.resultQueue.pending.collectAsState()
    var jobs by remember { mutableStateOf<List<JobDto>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        busy = true
        error = null
        try {
            runCatching { c.resultQueue.sync() }
            jobs = c.api.myJobs()
        } catch (e: Exception) {
            error = e.message
        } finally {
            busy = false
        }
    }
    LaunchedEffect(Unit) { load() }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        if (pending.isNotEmpty()) {
            SectionCard("In attesa di invio (${pending.size})") {
                pending.forEach { Text("• ${it.label} · ${if (it.result.result == "success") "completato" else "fallito"}") }
            }
        }
        BusyButton("Aggiorna", busy, Modifier.fillMaxWidth(), primary = false) { scope.launch { load() } }
        jobs.forEach { j ->
            val (label, color) = statusLabel(j.status)
            SectionCard {
                Text(label, color = color, fontWeight = FontWeight.SemiBold)
                Text(j.deviceName.ifBlank { j.pppoeUser }, style = MaterialTheme.typography.titleMedium)
                Text("${j.model}${j.template?.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()} · ${j.mac} · ${j.ssid}", style = MaterialTheme.typography.bodySmall)
                Text(j.createdAt.replace('T', ' ').take(16), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (j.error.isNotBlank()) Text(j.error, style = MaterialTheme.typography.bodySmall, color = BadRed)
                if (j.attempts > 1) Text("Scrittura riuscita al tentativo ${j.attempts}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                j.ko?.let { k ->
                    Text(
                        "${KO_KINDS[k.kind] ?: k.kind} · ${KO_REASONS[k.reason] ?: k.reason}" + if (j.koCount > 1) " (${j.koCount} segnalazioni)" else "",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (k.kind == "definitive") BadRed else WarnAmber,
                    )
                }
                when (j.review) {
                    "pending" -> Text("In attesa dell'approvazione del NOC (segnale)", style = MaterialTheme.typography.bodySmall, color = WarnAmber)
                    "approved" -> Text("Approvata dal NOC", style = MaterialTheme.typography.bodySmall, color = GoodGreen)
                    "rejected" -> Text("Non accettata dal NOC: vedi Notifiche", style = MaterialTheme.typography.bodySmall, color = BadRed)
                }
                if (j.status == "success") {
                    val acc = when (j.acceptance) {
                        "ok" -> "Collaudo superato" to GoodGreen
                        "warn" -> "Collaudo con riserva" to WarnAmber
                        "bad" -> "Collaudo non superato" to BadRed
                        else -> "Collaudo da fare" to MaterialTheme.colorScheme.onSurfaceVariant
                    }
                    Text(acc.first + if (j.photos > 0) " · ${j.photos} foto" else "", color = acc.second, style = MaterialTheme.typography.bodySmall)
                    if (c.moduleOn("signal_history")) {
                        var showHistory by remember(j.id) { mutableStateOf(false) }
                        if (showHistory) SignalHistory(c, j)
                        TextButton(onClick = { showHistory = !showHistory }) { Text(if (showHistory) "Nascondi storico segnale" else "Storico segnale (7 giorni)") }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (c.moduleOn("acceptance")) OutlinedButton(onClick = { onAcceptance(j) }) { Text(if (j.acceptance == null) "Collaudo" else "Collaudo / foto") }
                        if (c.moduleOn("replacement")) OutlinedButton(onClick = { onReplace(j) }) { Text("Sostituisci CPE") }
                    }
                }
            }
        }
        if (jobs.isEmpty() && !busy) Text("Nessun provisioning registrato.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
