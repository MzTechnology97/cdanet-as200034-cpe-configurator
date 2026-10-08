package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
fun HistoryScreen(c: AppContainer) {
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
            }
        }
        if (jobs.isEmpty() && !busy) Text("Nessun provisioning registrato.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
