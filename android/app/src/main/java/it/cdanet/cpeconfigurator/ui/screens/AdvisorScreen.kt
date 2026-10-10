package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.AdvisorDto
import it.cdanet.cpeconfigurator.data.AdvisorFindingDto
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.ListHeader
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.SkeletonRows
import it.cdanet.cpeconfigurator.ui.StatusChip
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive

/** Severity of a finding as a chip. */
fun adviceKind(severity: String) = when (severity) {
    "critico" -> NoticeKind.Bad
    "attenzione" -> NoticeKind.Warn
    else -> NoticeKind.Info
}

/**
 * Findings to show, grouped by AP in the server's order (critical first): only the open ones unless
 * [showDismissed], of one severity ("" = all), matching [query] on the AP or CPE name. Pure.
 */
fun adviceGroups(findings: List<AdvisorFindingDto>, severity: String, query: String, showDismissed: Boolean): List<Pair<String, List<AdvisorFindingDto>>> {
    val q = query.trim().lowercase()
    return findings
        .filter { showDismissed || it.dismissedUntil == null }
        .filter { severity.isEmpty() || it.severity == severity }
        .filter { q.isEmpty() || it.apName.lowercase().contains(q) || it.cpe?.name.orEmpty().lowercase().contains(q) }
        .groupBy { it.apId }
        .map { (_, fs) -> fs.first().apName to fs.sortedBy { if (it.cpe == null) 0 else 1 } }
}

private fun fmtWhen(iso: String?) = iso?.replace('T', ' ')?.take(16).orEmpty()

/**
 * IA-AP (admins): AP and CPE problems found every hour from UISP (stations, a week of statistics,
 * the spectrum measured by APs and CPEs) and the coverage model, with what to do. The NOC gets a
 * notification for new critical problems.
 */
@Composable
fun AdvisorScreen(c: AppContainer) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<AdvisorDto?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var severity by rememberSaveable { mutableStateOf("") }
    var query by rememberSaveable { mutableStateOf("") }
    var showDismissed by rememberSaveable { mutableStateOf(false) }

    suspend fun load() {
        busy = true
        runCatching { c.api.advisor() }.onSuccess { data = it; error = null }.onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(c.refresh.collectAsState().value) { load() }

    fun dismiss(f: AdvisorFindingDto, days: Int) = scope.launch {
        runCatching { c.api.dismissAdvice(f.id, days) }
            .onSuccess { info = if (days > 0) "Ignorato per $days giorni" else "Di nuovo visibile" }
            .onFailure { error = it.message }
        load()
    }

    val d = data
    val open = d?.findings.orEmpty().filter { it.dismissedUntil == null }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ErrorBanner(error) { error = null }
        info?.let { Notice(it, NoticeKind.Good) { info = null } }
        if (d == null && busy) SkeletonRows(3)
        ListHeader(
            when {
                d == null -> "IA-AP"
                open.isEmpty() -> "Nessun problema aperto"
                else -> "${open.count { it.severity == "critico" }} critici · ${open.count { it.severity == "attenzione" }} da guardare · ${open.count { it.severity == "info" }} suggerimenti"
            },
            busy,
        ) { scope.launch { load() } }
        if (d != null) {
            Text(
                if (d.at != null) "Ultima analisi ${fmtWhen(d.at)}. Canali proposti tra ${d.range.from} e ${d.range.to} MHz." else "Nessuna analisi ancora: parte con il primo aggiornamento orario dei dati di UISP.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("" to "Tutti", "critico" to "Critici", "attenzione" to "Da guardare", "info" to "Suggerimenti").forEach { (k, l) ->
                    FilterChip(selected = severity == k, onClick = { severity = k }, label = { Text(l) })
                }
                FilterChip(selected = showDismissed, onClick = { showDismissed = !showDismissed }, label = { Text("Ignorati") })
            }
            Field("Cerca AP o CPE", query, { query = it }, leadingIcon = R.drawable.ic_search)
            val groups = adviceGroups(d.findings, severity, query, showDismissed)
            if (groups.isEmpty()) {
                EmptyState(R.drawable.ic_check_circle, if (d.findings.isEmpty()) "Nessun problema trovato" else "Nessun avviso con questi filtri")
            }
            groups.forEach { (apName, fs) ->
                SectionCard("$apName · ${fs.size} ${if (fs.size == 1) "avviso" else "avvisi"}", icon = R.drawable.ic_cell_tower) {
                    fs.forEachIndexed { i, f ->
                        if (i > 0) HorizontalDivider(Modifier.fillMaxWidth().padding(vertical = 6.dp))
                        AdviceRow(
                            f,
                            onManage = f.cpe?.id?.let { id -> { c.adminCpeId.value = id; c.openAdminCpe.tryEmit(Unit) } },
                            onDismiss = { days -> dismiss(f, days) },
                        )
                    }
                }
            }
            OutlinedButton(
                onClick = {
                    scope.launch {
                        runCatching { c.api.refreshAdvisor() }
                            .onSuccess {
                                info = "Aggiornamento avviato: i dati di UISP arrivano in uno o due minuti."
                                delay(120_000)
                                load()
                            }
                            .onFailure { error = it.message }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Rileggi UISP adesso") }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun AdviceRow(f: AdvisorFindingDto, onManage: (() -> Unit)?, onDismiss: (Int) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusChip(f.severity, adviceKind(f.severity))
            Text(f.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        }
        f.cpe?.let { Text(it.name, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold) }
        Text(f.detail, style = MaterialTheme.typography.bodySmall)
        Text("Cosa fare: ${f.action}", style = MaterialTheme.typography.bodySmall)
        f.params?.takeIf { it.isNotEmpty() }?.let { p ->
            Text(
                p.entries.joinToString(" · ") { (k, v) -> "$k ${(v as? JsonPrimitive)?.content ?: v}" },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        Text(
            "dal ${fmtWhen(f.since)}" + (f.dismissedUntil?.let { " · ignorato fino al ${fmtWhen(it)}" } ?: ""),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (onManage != null) TextButton(onClick = onManage) { Text("Gestisci CPE") }
            if (f.dismissedUntil != null) {
                TextButton(onClick = { onDismiss(0) }) { Text("Mostra di nuovo") }
            } else {
                TextButton(onClick = { onDismiss(7) }) { Text("Ignora 7 giorni") }
                TextButton(onClick = { onDismiss(90) }) { Text("Ignora 90 giorni") }
            }
        }
    }
}
