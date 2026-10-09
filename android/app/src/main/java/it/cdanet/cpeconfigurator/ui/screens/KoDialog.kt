package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.KoMeasures
import it.cdanet.cpeconfigurator.data.KoRequest
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.launch
import java.time.LocalDate

/** Same keys as the server (routes/ko.ts). */
val KO_REASONS = linkedMapOf(
    "no_signal" to "Segnale insufficiente o nessun AP",
    "no_link" to "La CPE non si aggancia",
    "obstacles" to "Ostacoli, nessuna visibilità",
    "cpe_fault" to "CPE guasta",
    "no_access" to "Cliente assente o accesso impossibile",
    "weather" to "Maltempo",
    "material" to "Materiale mancante",
    "other" to "Altro",
)
val KO_KINDS = mapOf("postponed" to "Rimandata", "definitive" to "KO definitivo")

/** What the app knows when the technician reports: filled in by itself, never typed. */
data class KoContext(
    val jobId: String?,
    val mode: String,
    val step: String,
    val mac: String?,
    val ssid: String?,
    val measures: KoMeasures = KoMeasures(),
)

/**
 * "Segnala KO": postponed (with the reason and, if agreed, the day to retry) or definitive KO
 * (reason always required). The installation is not blocked: after sending, the technician
 * chooses to retry now or to end the visit.
 */
@Composable
fun KoDialog(c: AppContainer, ctx: KoContext, onDismiss: () -> Unit, onRetry: () -> Unit, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf("postponed") }
    var reason by remember { mutableStateOf(if (ctx.step == "link" || ctx.step == "aim") "no_signal" else "") }
    var note by remember { mutableStateOf("") }
    var retryDays by remember { mutableStateOf<Int?>(null) }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var sent by remember { mutableStateOf(false) }

    if (sent) {
        AlertDialog(
            onDismissRequest = onRetry,
            title = { Text(if (kind == "postponed") "Installazione rimandata" else "KO segnalato") },
            text = { Text("Il NOC è stato avvisato. Puoi riprovare subito (es. un altro AP o un nuovo puntamento) oppure chiudere l'intervento: l'installazione si potrà riprendere in qualsiasi momento.") },
            confirmButton = { TextButton(onClick = onClose) { Text("Chiudi intervento") } },
            dismissButton = { TextButton(onClick = onRetry) { Text("Riprova ora") } },
        )
        return
    }

    val valid = reason.isNotEmpty() && note.trim().length >= 5
    AlertDialog(
        onDismissRequest = { if (!sending) onDismiss() },
        title = { Text("Segnala KO") },
        text = {
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    KO_KINDS.forEach { (k, label) -> FilterChip(selected = kind == k, onClick = { kind = k }, label = { Text(label) }) }
                }
                Text(
                    if (kind == "postponed") "Si riprova in un altro momento: scrivi il motivo e, se concordato, quando."
                    else "L'installazione non si può fare: scrivi sempre la motivazione per il NOC.",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (kind == "postponed") WarnAmber else BadRed,
                )
                Text("Motivo", fontWeight = FontWeight.SemiBold)
                KO_REASONS.forEach { (k, label) ->
                    Row(Modifier.fillMaxWidth().selectable(selected = reason == k, onClick = { reason = k }), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = reason == k, onClick = { reason = k })
                        Text(label, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                OutlinedTextField(
                    note,
                    { note = it.take(1000) },
                    label = { Text(if (kind == "postponed") "Motivazione del rimando (obbligatoria)" else "Motivazione del KO (obbligatoria)") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    isError = note.isNotEmpty() && note.trim().length < 5,
                )
                if (kind == "postponed") {
                    Text("Da riprovare", fontWeight = FontWeight.SemiBold)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(null to "Da definire", 1 to "Domani", 2 to "Fra 2 giorni", 7 to "Fra una settimana").forEach { (d, label) ->
                            FilterChip(selected = retryDays == d, onClick = { retryDays = d }, label = { Text(label, style = MaterialTheme.typography.labelSmall) })
                        }
                    }
                }
                val auto = listOfNotNull(ctx.ssid, ctx.measures.signal?.let { "$it dBm" }, ctx.mac).joinToString(" · ")
                if (auto.isNotEmpty()) Text("Allegati in automatico: $auto", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                error?.let { Text(it, color = BadRed, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            TextButton(enabled = valid && !sending, onClick = {
                scope.launch {
                    sending = true
                    error = null
                    runCatching {
                        c.api.reportKo(
                            KoRequest(
                                kind = kind,
                                jobId = ctx.jobId,
                                mode = ctx.mode,
                                step = ctx.step,
                                reason = reason,
                                note = note.trim(),
                                retryOn = retryDays?.takeIf { kind == "postponed" }?.let { LocalDate.now().plusDays(it.toLong()).toString() },
                                mac = ctx.mac,
                                ssid = ctx.ssid,
                                measures = ctx.measures,
                            ),
                        )
                    }.onSuccess { sent = true }
                        .onFailure { error = "Non inviato: ${it.message}. Serve la connessione dati, riprova." }
                    sending = false
                }
            }) { Text(if (sending) "Invio…" else "Invia al NOC") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !sending) { Text("Annulla") } },
    )
}

/** Radio checks whose red result needs the NOC's approval (same list as the server). */
private val RADIO_CHECKS = setOf("Segnale ricevuto", "Segnale lato AP", "CINR (qualità)", "Capacità airMAX", "Catene (polarizzazioni)", "Collegamento all'AP")

/** Why this acceptance test will wait for the NOC's approval, or null (poor signal or a red radio check). */
fun nocApprovalReason(signal: Int?, signalMin: Int, badChecks: List<String>): String? {
    val why = buildList {
        if (signal != null && signal < signalMin) add("segnale $signal dBm (minimo $signalMin)")
        badChecks.filter { it in RADIO_CHECKS && !(it == "Segnale ricevuto" && signal != null && signal < signalMin) }.forEach { add(it) }
    }
    return why.takeIf { it.isNotEmpty() }?.joinToString(" · ")
}

const val NOC_APPROVAL_TEXT = "Con questo segnale l'installazione deve essere approvata dal NOC: dopo il collaudo ricevi l'esito nelle Notifiche (e su Telegram, se collegato). Se non si riesce a migliorare, puoi anche segnalare KO."
