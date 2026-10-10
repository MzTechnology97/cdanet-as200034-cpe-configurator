package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
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
import it.cdanet.cpeconfigurator.data.ChannelDto
import it.cdanet.cpeconfigurator.data.OptimizerDto
import it.cdanet.cpeconfigurator.data.OptimizerRunDto
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

/** Findings of an AP that a channel change can fix: the automatic optimisation starts from them. */
private val OPTIMIZABLE = setOf("channel", "width", "cochannel", "noise", "mcs")

/** Whether "Ottimizza…" is offered on a finding (AP findings only, optimisation on in the server). */
fun optimizable(f: AdvisorFindingDto, enabled: Boolean) = enabled && f.cpe == null && f.kind in OPTIMIZABLE

/** Outcome of an optimisation as a chip. */
fun optimizerOutcome(r: OptimizerRunDto): Pair<String, NoticeKind> = when (r.outcome) {
    "migliorato" -> "canale migliore tenuto" to NoticeKind.Good
    "ripristinato" -> "nessun miglioramento, ripristinato" to NoticeKind.Info
    "cpe_mancanti" -> "CPE non riagganciate, ripristinato" to NoticeKind.Warn
    "ripristino_incompleto" -> "CPE mancanti dopo il ripristino" to NoticeKind.Bad
    "annullato" -> "annullato" to NoticeKind.Info
    "interrotto" -> "interrotto, ripristinato" to NoticeKind.Warn
    "errore" -> "non riuscito" to NoticeKind.Bad
    else -> (if (r.state == "in_corso") "in corso" else "programmata ${fmtWhen(r.startAt)}") to NoticeKind.Warn
}

private fun ch(c: ChannelDto?) = if (c == null) "—" else "${c.centre}/${c.width} MHz"

private const val OPTIMIZE_TEXT = "L'IA-AP cambierà il canale dell'AP tramite UISP. A ogni prova le CPE si sganciano per circa un minuto; " +
    "dopo ogni cambio aspetta che tornino tutte, misura per qualche minuto e confronta con prima. Tiene un canale solo se la capacità " +
    "sale di almeno il 5% senza peggiorare SNR e cliente più debole; altrimenti, o se una CPE non torna entro 5 minuti, rimette il " +
    "canale iniziale e avvisa gli admin. Circa 10 minuti per prova."

/** Local date and time of an ISO instant from the server ("" when missing). */
private fun fmtWhen(iso: String?): String = iso?.let {
    runCatching { java.time.format.DateTimeFormatter.ofPattern("dd/MM/yy HH:mm").format(java.time.Instant.parse(it).atZone(java.time.ZoneId.systemDefault())) }.getOrNull() ?: it.replace('T', ' ').take(16)
}.orEmpty()

/** 21.0 → "21", 21.5 → "21,5", null → "—". */
private fun n(v: Double?) = when {
    v == null -> "—"
    v % 1.0 == 0.0 -> v.toLong().toString()
    else -> v.toString().replace('.', ',')
}

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
    var opt by remember { mutableStateOf<OptimizerDto?>(null) }
    var confirmFor by remember { mutableStateOf<AdvisorFindingDto?>(null) }

    suspend fun load() {
        busy = true
        runCatching { c.api.advisor() }.onSuccess { data = it; error = null }.onFailure { error = it.message }
        runCatching { c.api.optimizer() }.onSuccess { opt = it }
        busy = false
    }
    LaunchedEffect(c.refresh.collectAsState().value) { load() }
    // while an optimisation runs, its progress every 15 s (only while this tab is open)
    val running = opt?.runs?.any { it.state == "in_corso" } == true
    LaunchedEffect(running) {
        while (running) {
            delay(15_000)
            load()
        }
    }

    fun cancelRun(r: OptimizerRunDto) = scope.launch {
        runCatching { c.api.cancelOptimizer(r.id) }
            .onSuccess { info = if (r.state == "in_corso") "Annullamento: l'AP torna al canale iniziale" else "Annullata" }
            .onFailure { error = it.message }
        load()
    }

    confirmFor?.let { f ->
        OptimizeDialog(f, onDismiss = { confirmFor = null }) { mode, at ->
            confirmFor = null
            scope.launch {
                runCatching { c.api.startOptimizer(f.id, mode, at) }
                    .onSuccess { info = if (at == "now") "Ottimizzazione avviata" else "Ottimizzazione programmata per stanotte alle 3:00" }
                    .onFailure { error = it.message }
                load()
            }
        }
    }

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
            opt?.let { o -> OptimizerCard(o, ::cancelRun) }
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
                            onOptimize = if (optimizable(f, opt?.enabled == true)) ({ confirmFor = f }) else null,
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
private fun AdviceRow(f: AdvisorFindingDto, onManage: (() -> Unit)?, onDismiss: (Int) -> Unit, onOptimize: (() -> Unit)?) {
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
            if (onOptimize != null) TextButton(onClick = onOptimize) { Text("Ottimizza…") }
            if (f.dismissedUntil != null) {
                TextButton(onClick = { onDismiss(0) }) { Text("Mostra di nuovo") }
            } else {
                TextButton(onClick = { onDismiss(7) }) { Text("Ignora 7 giorni") }
                TextButton(onClick = { onDismiss(90) }) { Text("Ignora 90 giorni") }
            }
        }
    }
}

/** Automatic optimisation: off/on, the runs in progress or scheduled, the last ones. */
@Composable
private fun OptimizerCard(o: OptimizerDto, onCancel: (OptimizerRunDto) -> Unit) {
    var showPast by rememberSaveable { mutableStateOf(false) }
    val live = o.runs.filter { it.state == "in_corso" || it.state == "programmato" }
    val past = o.runs.filter { it !in live }
    SectionCard("Ottimizzazione automatica", icon = R.drawable.ic_troubleshoot) {
        Text(
            if (o.enabled) "Dagli avvisi di un AP (canale, ampiezza, rumore, modulazione), Ottimizza… prova il canale tramite UISP e lo tiene solo se è davvero migliore. Un AP alla volta."
            else "Spenta: l'assistente dà solo consigli. Si accende nella console, Impostazioni server → Assistente rete.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        live.forEach { r ->
            HorizontalDivider(Modifier.fillMaxWidth().padding(vertical = 6.dp))
            RunRow(r, onCancel)
        }
        if (past.isNotEmpty()) {
            TextButton(onClick = { showPast = !showPast }) { Text(if (showPast) "Nascondi le ultime ottimizzazioni" else "Ultime ottimizzazioni (${past.size})") }
            if (showPast) past.forEach { r ->
                HorizontalDivider(Modifier.fillMaxWidth().padding(vertical = 6.dp))
                RunRow(r, onCancel)
            }
        }
    }
}

@Composable
private fun RunRow(r: OptimizerRunDto, onCancel: (OptimizerRunDto) -> Unit) {
    val (label, kind) = optimizerOutcome(r)
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusChip(label, kind)
            Text(r.apName, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        }
        Text(
            "${if (r.mode == "suggested") "Canale consigliato" else "Ricerca del canale migliore"} · da ${r.by}. Iniziale ${ch(r.original)}; da provare ${r.candidates.joinToString { ch(it) }}" +
                (r.kept?.let { " · tenuto ${ch(it)}" } ?: ""),
            style = MaterialTheme.typography.bodySmall,
        )
        if (r.state == "in_corso" || r.state == "programmato") Text("Ora: ${r.step}", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
        r.baseline?.let { b -> Text("Prima: ${b.stations} CPE, capacità ${b.capacityMbps} Mbit/s, SNR ${n(b.medianSnrDb)} dB, più debole ${n(b.weakestDbm)} dBm", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        r.results.forEach { t ->
            val cap = t.capacityRatio?.let { x -> val p = Math.round((x - 1) * 100); " · capacità ${if (p >= 0) "+" else ""}$p%" } ?: ""
            val verdict = when (t.verdict) { "migliore" -> "migliore"; "peggiore" -> "peggiore"; "uguale" -> "nessuna differenza"; else -> "CPE mancanti" }
            Text("${t.centre}/${t.width} MHz: $verdict$cap, SNR ${n(t.after.medianSnrDb)} dB" + (if (t.missing.isNotEmpty()) " · mancano: ${t.missing.joinToString()}" else ""), style = MaterialTheme.typography.bodySmall)
        }
        if (r.missing.isNotEmpty()) Notice("CPE non riagganciate: ${r.missing.joinToString()}", NoticeKind.Bad)
        r.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (r.state == "in_corso" || r.state == "programmato") {
            TextButton(onClick = { onCancel(r) }) { Text(if (r.state == "in_corso") "Annulla e ripristina" else "Annulla") }
        } else {
            Text("${fmtWhen(r.requestedAt)} → ${fmtWhen(r.endedAt)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The admin accepts what the optimisation does, chooses what to try and when. */
@Composable
private fun OptimizeDialog(f: AdvisorFindingDto, onDismiss: () -> Unit, onConfirm: (mode: String, at: String) -> Unit) {
    val freq = (f.params?.get("frequenza") as? JsonPrimitive)?.content
    val width = (f.params?.get("ampiezza") as? JsonPrimitive)?.content
    var mode by remember { mutableStateOf(if (freq != null) "suggested" else "search") }
    var at by remember { mutableStateOf("night") }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Ottimizza ${f.apName}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(OPTIMIZE_TEXT, style = MaterialTheme.typography.bodySmall)
                Text("Cosa", style = MaterialTheme.typography.labelLarge)
                if (freq != null) ChoiceRow("Prova il canale consigliato ($freq/$width MHz)", mode == "suggested") { mode = "suggested" }
                ChoiceRow("Cerca il canale migliore (fino a 3 prove)", mode == "search") { mode = "search" }
                Text("Quando", style = MaterialTheme.typography.labelLarge)
                ChoiceRow("Stanotte alle 3:00 (consigliato)", at == "night") { at = "night" }
                ChoiceRow("Adesso", at == "now") { at = "now" }
            }
        },
        confirmButton = { androidx.compose.material3.Button(onClick = { onConfirm(mode, at) }) { Text("Conferma") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Annulla") } },
    )
}

@Composable
private fun ChoiceRow(text: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected = selected, onClick = onClick, role = androidx.compose.ui.semantics.Role.RadioButton),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.RadioButton(selected = selected, onClick = null)
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp))
    }
}
