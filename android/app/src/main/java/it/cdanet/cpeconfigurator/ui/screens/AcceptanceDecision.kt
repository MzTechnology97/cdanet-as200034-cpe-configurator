package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.AcceptanceOverrideDto
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.localTime
import kotlinx.coroutines.launch

/** Words of the NOC's decision on a failed test (pure, tested). */
object AcceptanceOverride {
    private val VERDICT = mapOf("bad" to "non superato", "warn" to "con riserva")

    /** «Superato per decisione del NOC (admin, 15/10/26 10:30): le misure dicevano «non superato». Motivo: …» */
    fun text(o: AcceptanceOverrideDto, at: String = localTime(o.at)): String =
        "Superato per decisione del NOC (${listOf(o.by, at).filter { it.isNotBlank() }.joinToString(", ")}): " +
            "le misure dicevano «${VERDICT[o.from] ?: o.from}». Motivo: ${o.note}"

    /** The reason is required: at least 3 characters, as the server asks. */
    fun validNote(note: String): Boolean = note.trim().length >= 3
}

/**
 * The NOC's decision on an acceptance test: to everyone, the override when there is one; to admins,
 * on a test «non superato» or «con riserva», «Segna come superato» with the reason.
 */
@Composable
fun AcceptanceDecision(c: AppContainer, jobId: String, verdict: String?) {
    if (verdict == null) return
    val scope = rememberCoroutineScope()
    var override by remember(jobId) { mutableStateOf<AcceptanceOverrideDto?>(null) }
    var current by remember(jobId) { mutableStateOf(verdict) }
    var ask by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(jobId, verdict) {
        runCatching { c.api.storedAcceptance(jobId) }.getOrNull()?.acceptance?.let { a ->
            override = a.override
            current = a.verdict
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        override?.let { Text(AcceptanceOverride.text(it), style = MaterialTheme.typography.bodySmall, color = GoodGreen) }
        if (c.session.isAdmin && override == null && current in setOf("bad", "warn")) {
            TextButton(onClick = { ask = true; note = ""; error = null }) { Text("Segna come superato") }
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }
    if (ask) {
        AlertDialog(
            onDismissRequest = { if (!busy) ask = false },
            title = { Text("Segnare il collaudo come superato?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Le misure dicono «${if (current == "warn") "con riserva" else "non superato"}». Il collaudo diventa superato per decisione del NOC, con il motivo nel rapporto; l'installatore riceve la notifica.", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(note, { note = it.take(500) }, label = { Text("Motivo (obbligatorio)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                TextButton(enabled = !busy && AcceptanceOverride.validNote(note), onClick = {
                    busy = true
                    scope.launch {
                        runCatching { c.api.passAcceptance(jobId, note.trim()) }
                            .onSuccess {
                                ask = false
                                runCatching { c.api.storedAcceptance(jobId) }.getOrNull()?.acceptance?.let { a -> override = a.override; current = a.verdict }
                                // lists (Storico, Da completare) show the new state
                                c.refresh.value++
                            }
                            .onFailure { error = it.message ?: "Non riuscito"; ask = false }
                        busy = false
                    }
                }) { Text(if (busy) "Salvo…" else "Segna come superato") }
            },
            dismissButton = { TextButton(onClick = { ask = false }, enabled = !busy) { Text("Annulla") } },
        )
    }
}
