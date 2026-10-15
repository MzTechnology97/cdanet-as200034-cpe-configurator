package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import it.cdanet.cpeconfigurator.data.RmaItemDto
import it.cdanet.cpeconfigurator.field.RmaAnswer
import it.cdanet.cpeconfigurator.ui.PrimaryButton
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import kotlinx.coroutines.launch

internal val RMA_CONDITIONS = listOf("working" to "Funziona", "broken" to "Guasta", "unknown" to "Non so")

/**
 * At the end of a CPE replacement: «La CPE smontata funziona?». The answer goes with the removed
 * CPE's return to the warehouse (kept on the phone until there is signal).
 */
@Composable
fun RemovedCpeCard(c: AppContainer, replacementJobId: String) {
    val scope = rememberCoroutineScope()
    val pending by c.rmaQueue.pending.collectAsState()
    val sent by c.rmaQueue.sent.collectAsState()
    val given = pending.firstOrNull { it.jobId == replacementJobId }?.condition ?: sent[replacementJobId]
    var change by remember(replacementJobId) { mutableStateOf(false) }
    var note by remember(replacementJobId) { mutableStateOf("") }
    SectionCard("La CPE smontata funziona?") {
        if (given != null && !change) {
            Text("Segnata come: ${RMA_CONDITIONS.firstOrNull { it.first == given }?.second ?: given}" + if (pending.any { it.jobId == replacementJobId }) " (si invia appena c'è rete)" else ".", fontWeight = FontWeight.SemiBold)
            Text("Riportala in magazzino: il NOC la vede tra le CPE da rientrare.", style = MaterialTheme.typography.bodySmall)
            SecondaryButton(onClick = { change = true }) { Text("Cambia") }
        } else {
            Text("Serve al magazzino: una CPE guasta va in riparazione o al fornitore, una funzionante torna disponibile.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(note, { note = it.take(500) }, label = { Text("Nota (facoltativa)") }, placeholder = { Text("es. bruciata dopo il temporale") }, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RMA_CONDITIONS.forEach { (key, label) ->
                    val pick = {
                        change = false
                        scope.launch {
                            c.rmaQueue.answer(RmaAnswer(replacementJobId, key, note.trim()))
                            c.rmaQueue.sync()
                        }
                        Unit
                    }
                    if (key == "working") PrimaryButton(onClick = pick) { Text(label) } else SecondaryButton(onClick = pick) { Text(label) }
                }
            }
        }
    }
}

/** «CPE smontate da riportare»: what the technician took off and still has to bring back. */
@Composable
fun RmaToReturnCard(c: AppContainer) {
    var items by remember { mutableStateOf<List<RmaItemDto>>(emptyList()) }
    val sent by c.rmaQueue.sent.collectAsState()
    LaunchedEffect(sent) { runCatching { c.api.myRma() }.onSuccess { items = it.filter { r -> r.state == "to_return" } } }
    if (items.isEmpty()) return
    SectionCard("CPE smontate da riportare (${items.size})") {
        items.forEach { r ->
            Text("${r.model} · ${r.mac}", fontWeight = FontWeight.SemiBold)
            Text(
                listOfNotNull(r.customer.takeIf { it.isNotBlank() }, RMA_CONDITIONS.firstOrNull { it.first == r.condition }?.second, r.createdAt.take(10).split('-').reversed().joinToString("/")).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
