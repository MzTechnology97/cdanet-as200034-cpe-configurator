package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.CpeHealthItemDto
import it.cdanet.cpeconfigurator.data.JobDto
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.StatusChip

/** Text a search can match: customer, PPPoE user, MAC (with or without colons), SSID, model, AP. */
fun searchKey(vararg parts: String?) = parts.filterNotNull().joinToString(" ") { it.lowercase() + " " + it.replace(":", "").lowercase() }

/** One field for everything the installer has: their installations and the CPEs they follow. */
@Composable
fun SearchScreen(c: AppContainer, onAcceptance: (JobDto) -> Unit) {
    val modules by c.modules.collectAsState()
    var query by remember { mutableStateOf("") }
    var jobs by remember { mutableStateOf<List<JobDto>>(emptyList()) }
    var cpes by remember { mutableStateOf<List<CpeHealthItemDto>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        runCatching { focus.requestFocus() }
        jobs = runCatching { c.api.myJobs() }.getOrDefault(emptyList())
        if (modules["cpe_health"] != false) cpes = runCatching { c.api.cpeHealth().cpes }.getOrDefault(emptyList())
        loaded = true
    }
    val q = query.trim().lowercase().replace(":", "")
    val jobHits = if (q.length < 2) emptyList() else jobs.filter { searchKey(it.deviceName, it.pppoeUser, it.mac, it.ssid, it.model).contains(q) }.take(30)
    val jobMacs = jobHits.map { it.mac }.toSet()
    val cpeHits = if (q.length < 2) emptyList() else cpes.filter { it.mac !in jobMacs && searchKey(it.deviceName, it.mac, it.ssid, it.model, it.now?.apName).contains(q) }.take(30)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier.fillMaxWidth().focusRequester(focus),
            singleLine = true,
            shape = MaterialTheme.shapes.extraLarge,
            leadingIcon = { Icon(painterResource(R.drawable.ic_search), contentDescription = null) },
            placeholder = { Text("Cliente, utente PPPoE, MAC, SSID, AP…") },
        )
        when {
            q.length < 2 -> EmptyState(R.drawable.ic_search, "Cerca tra le tue installazioni", "Scrivi almeno due caratteri: nome del cliente, utente PPPoE, MAC (anche senza i due punti), SSID o AP.")
            !loaded -> Text("Ricerca…", style = MaterialTheme.typography.bodySmall)
            jobHits.isEmpty() && cpeHits.isEmpty() -> EmptyState(R.drawable.ic_search, "Nessun risultato", "Controlla quello che hai scritto o prova con il MAC.")
        }
        jobHits.forEach { j ->
            ResultRow(
                title = j.deviceName.ifBlank { j.pppoeUser },
                lines = listOf("${j.model} · ${j.mac}", "${j.ssid} · ${j.createdAt.replace('T', ' ').take(16)}"),
                chip = when (j.status) {
                    "success" -> (if (j.acceptance == null) "da collaudare" else "installata") to (if (j.acceptance == null) NoticeKind.Warn else NoticeKind.Good)
                    "failed" -> "fallita" to NoticeKind.Bad
                    "prepared" -> "preparata" to NoticeKind.Warn
                    else -> "scaduta" to NoticeKind.Info
                },
                action = if (j.status == "success" && c.moduleOn("acceptance")) "Collaudo" to { onAcceptance(j) } else null,
            )
        }
        cpeHits.forEach { p ->
            ResultRow(
                title = p.deviceName.ifBlank { p.mac },
                lines = listOf("${p.model} · ${p.mac}", listOfNotNull(p.now?.apName, p.ssid.ifBlank { null }, p.now?.signal?.let { "${it.toInt()} dBm" }).joinToString(" · ")),
                chip = if (p.issues.isEmpty()) "ok" to NoticeKind.Good else p.issues.first().replace('_', ' ') to NoticeKind.Warn,
                action = null,
            )
        }
    }
}

@Composable
private fun ResultRow(title: String, lines: List<String>, chip: Pair<String, NoticeKind>, action: Pair<String, () -> Unit>?) {
    Column(
        Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large).background(MaterialTheme.colorScheme.surfaceContainerLow).padding(start = 16.dp, end = 12.dp, top = 12.dp, bottom = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            StatusChip(chip.first, chip.second)
        }
        lines.filter { it.isNotBlank() }.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (action != null) {
            Row(Modifier.padding(top = 4.dp)) {
                Spacer(Modifier.weight(1f))
                FilledTonalButton(onClick = action.second) {
                    Icon(painterResource(R.drawable.ic_photo_camera), contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text(action.first)
                }
            }
        }
    }
}
