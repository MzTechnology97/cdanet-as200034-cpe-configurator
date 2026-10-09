package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.NetApDto
import it.cdanet.cpeconfigurator.data.NetworkStatusDto
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private fun stateText(s: String) = when (s) {
    "down" -> "non raggiungibile"
    "degraded" -> "molte CPE offline"
    else -> "in funzione"
}

private fun stateColor(s: String): Color = when (s) {
    "down" -> BadRed
    "degraded" -> WarnAmber
    else -> GoodGreen
}

private fun ts(s: String?) = s?.replace('T', ' ')?.take(16) ?: ""

/** "Stato rete": state of the POPs and APs (installers: only the assigned ones). Refreshes every minute, no notifications. */
@Composable
fun NetworkStatusScreen(c: AppContainer) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<NetworkStatusDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    suspend fun load() {
        busy = true
        runCatching { c.api.networkStatus() }.onSuccess { data = it; error = null }.onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(Unit) {
        while (true) {
            load()
            delay(60_000)
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        BusyButton("Aggiorna", busy, Modifier.fillMaxWidth(), primary = false) { scope.launch { load() } }
        val d = data ?: return@Column
        SectionCard {
            val s = d.summary
            Text("${s.aps} AP · ${s.down} non raggiungibili · ${s.degraded} con molte CPE offline · ${s.powerOutage} con guasto Enel vicino", style = MaterialTheme.typography.bodyMedium)
            Text("Aggiornato ${ts(d.generatedAt)} · ogni minuto", style = MaterialTheme.typography.bodySmall)
        }
        if (d.restricted && d.assignedCount == 0) {
            SectionCard { Text("Nessun POP/AP assegnato al tuo account: chiedi all'amministratore.", color = WarnAmber) }
            return@Column
        }
        d.pops.forEach { p ->
            SectionCard {
                Text("POP ${p.name}", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                Text(stateText(p.state) + if (p.powerOutage) " · guasto Enel vicino" else "", color = stateColor(p.state), style = MaterialTheme.typography.bodySmall)
                p.aps.forEach { a -> ApRow(a) }
            }
        }
        if (d.apsWithoutPop.isNotEmpty()) {
            SectionCard("AP senza POP") { d.apsWithoutPop.forEach { a -> ApRow(a) } }
        }
        Text("\"Molte CPE offline\": almeno il 30% delle CPE dell'AP non è raggiungibile (probabile problema di settore).", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun ApRow(a: NetApDto) {
    Text(a.name, fontWeight = FontWeight.Medium)
    val parts = buildList {
        add(stateText(a.state))
        a.cpe?.let { add("CPE ${it.total - it.offline}/${it.total} online") } ?: when (a.cpeOffline) {
            "some" -> add("alcune CPE offline")
            "many" -> add("molte CPE offline")
            else -> {}
        }
        a.lastSeen?.let { add("ultimo contatto ${ts(it)}") }
        if (a.powerOutage) add("guasto Enel vicino")
    }
    Text(parts.distinct().joinToString(" · "), color = stateColor(a.state), style = MaterialTheme.typography.bodySmall)
}
