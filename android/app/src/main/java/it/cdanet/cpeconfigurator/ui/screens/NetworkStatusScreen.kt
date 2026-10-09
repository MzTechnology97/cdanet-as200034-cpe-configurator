package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.runtime.collectAsState
import it.cdanet.cpeconfigurator.ui.RefreshButton
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
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

@Composable
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
    LaunchedEffect(c.refresh.collectAsState().value) {
        while (true) {
            load()
            delay(60_000)
        }
    }

    var problemsOnly by remember { mutableStateOf<Boolean?>(null) }
    var query by remember { mutableStateOf("") }
    var open by remember { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        if (data == null && busy) it.cdanet.cpeconfigurator.ui.SkeletonRows(3)
        val d = data
        if (d == null) {
            BusyButton("Aggiorna", busy, Modifier.fillMaxWidth(), primary = false) { scope.launch { load() } }
            return@Column
        }
        val s = d.summary
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    listOfNotNull("${s.aps} AP", s.down.takeIf { it > 0 }?.let { "$it giù" }, s.degraded.takeIf { it > 0 }?.let { "$it con molte CPE offline" }, s.powerOutage.takeIf { it > 0 }?.let { "$it con guasto Enel vicino" }).joinToString(" · "),
                    fontWeight = FontWeight.SemiBold,
                )
                Text("Aggiornato ${ts(d.generatedAt)} · ogni minuto", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            RefreshButton(busy) { scope.launch { load() } }
        }
        if (d.restricted && d.assignedCount == 0) {
            SectionCard { Text("Nessun POP/AP assegnato al tuo account: chiedi all'amministratore.", color = WarnAmber) }
            return@Column
        }
        // POPs (and the APs without a POP as one more group), problems first
        val groups = d.pops.map { Group(it.id, "POP ${it.name}", it.state, it.powerOutage, it.aps) } +
            listOfNotNull(d.apsWithoutPop.takeIf { it.isNotEmpty() }?.let { Group("-", "AP senza POP", worst(it), it.any { a -> a.powerOutage }, it) })
        val anyProblem = groups.any { it.problem }
        val onlyProblems = problemsOnly ?: anyProblem
        val q = query.trim().lowercase()
        val shown = groups
            .filter { !onlyProblems || it.problem }
            .filter { g -> q.isEmpty() || g.name.lowercase().contains(q) || g.aps.any { it.name.lowercase().contains(q) || it.ssid.orEmpty().lowercase().contains(q) } }
            .sortedWith(compareBy<Group> { RANK[it.state] ?: 3 }.thenBy { !it.powerOutage }.thenBy { it.name })
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            FilterChip(selected = onlyProblems, onClick = { problemsOnly = true }, label = { Text("Con problemi (${groups.count { it.problem }})") })
            FilterChip(selected = !onlyProblems, onClick = { problemsOnly = false }, label = { Text("Tutti (${groups.size})") })
        }
        if (groups.size > 6) {
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("Cerca POP o AP") })
        }
        if (shown.isEmpty()) {
            Text(if (onlyProblems && q.isEmpty()) "Nessun problema: tutti i POP e gli AP sono in funzione." else "Nessun POP o AP con questi filtri.", color = if (onlyProblems) GoodGreen else MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            SectionCard {
                shown.forEachIndexed { i, g ->
                    if (i > 0) HorizontalDivider()
                    PopRow(g, expanded = open == g.id || q.isNotEmpty()) { open = if (open == g.id) null else g.id }
                }
            }
        }
        Text("\"Molte CPE offline\": almeno il 30% delle CPE dell'AP non è raggiungibile (probabile problema di settore). ⚡ = guasto Enel vicino.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private data class Group(val id: String, val name: String, val state: String, val powerOutage: Boolean, val aps: List<NetApDto>) {
    val problem: Boolean get() = state != "ok" || powerOutage || aps.any { it.state != "ok" || it.powerOutage }
}

private val RANK = mapOf("down" to 0, "degraded" to 1, "ok" to 2)

private fun worst(aps: List<NetApDto>) = aps.minByOrNull { RANK[it.state] ?: 3 }?.state ?: "ok"

private fun Modifier.dot(color: Color) = size(10.dp).clip(CircleShape).background(color)

/** POP: one line (state, name, APs working, outage nearby); its APs one line each when open. */
@Composable
private fun PopRow(g: Group, expanded: Boolean, onToggle: () -> Unit) {
    val ok = g.aps.count { it.state == "ok" }
    Column {
        Row(Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.dot(stateColor(g.state)))
            Text(g.name + if (g.powerOutage) " ⚡" else "", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 10.dp))
            Text("$ok/${g.aps.size} AP", style = MaterialTheme.typography.bodySmall, color = if (ok == g.aps.size) MaterialTheme.colorScheme.onSurfaceVariant else stateColor(worst(g.aps)))
        }
        if (expanded) g.aps.sortedBy { RANK[it.state] ?: 3 }.forEach { a -> ApRow(a) }
    }
}

@Composable
private fun ApRow(a: NetApDto) {
    val detail = a.cpe?.let { "${it.total - it.offline}/${it.total} CPE" } ?: when (a.cpeOffline) {
        "some" -> "alcune CPE offline"
        "many" -> "molte CPE offline"
        else -> if (a.state == "down") a.lastSeen?.let { "visto ${ts(it).takeLast(5)}" } else null
    }
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, top = 2.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.dot(stateColor(a.state)))
        Text(a.name + if (a.powerOutage) " ⚡" else "", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
        detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (a.state == "ok") MaterialTheme.colorScheme.onSurfaceVariant else stateColor(a.state)) }
    }
}
