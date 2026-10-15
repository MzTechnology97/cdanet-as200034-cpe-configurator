package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.ApiException
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Remote diagnosis of a work order's customer: findings worst first, the first one is the verdict. */
@Serializable
data class DiagnosisDto(
    val at: String? = null,
    val verdict: String = "",
    val findings: List<DiagnosisFinding> = emptyList(),
    /** Installers: the CPE and its AP in short (admins get the full facts, shown in the console). */
    val cpe: DiagnosisCpe? = null,
    val ap: DiagnosisAp? = null,
)

@Serializable
data class DiagnosisFinding(
    /** bad, warn, info, ok. */
    val level: String = "info",
    val code: String = "",
    val title: String = "",
    val detail: String = "",
    val action: String = "",
)

@Serializable
data class DiagnosisCpe(val found: Boolean = false, val online: Boolean? = null, val signal: Int? = null)

@Serializable
data class DiagnosisAp(val name: String? = null, val online: Boolean? = null)

/** Kinds diagnosed as soon as the order is opened (a fault, a re-pointing); the others on request. */
internal fun diagnosedAtOnce(kind: String) = kind == "repair" || kind == "repoint"

/** No CPE yet to look at: a new installation, a survey. */
internal fun diagnosable(kind: String) = kind != "new" && kind != "survey"

private fun errorText(e: Throwable): String = when ((e as? ApiException)?.status) {
    null -> "Diagnosi non riuscita: senza rete?"
    403 -> "Diagnosi non disponibile per questo intervento."
    404 -> if ((e as ApiException).code == "work_order_not_found") "Intervento non trovato: forse annullato." else "Diagnosi non ancora disponibile su questo server."
    else -> "Diagnosi non riuscita (${(e as ApiException).code})."
}

/**
 * «Diagnosi remota» in the work order card: what the network says about the customer before
 * leaving (CPE signal and trend, PPPoE, the AP and its other CPEs, power outages). It takes a
 * second or two (the server reads the month's statistics): automatic for faults and re-pointings.
 */
@Composable
fun RemoteDiagnosisCard(c: AppContainer, workOrderId: Long, kind: String) {
    val scope = rememberCoroutineScope()
    var data by remember(workOrderId) { mutableStateOf<DiagnosisDto?>(null) }
    var busy by remember(workOrderId) { mutableStateOf(false) }
    var error by remember(workOrderId) { mutableStateOf<String?>(null) }
    val path = (if (c.session.isAdmin) "/api/admin/diagnosis" else "/api/field/diagnosis") + "?workOrderId=$workOrderId"
    fun load() {
        busy = true
        error = null
        scope.launch {
            runCatching { AppJson.decodeFromString(DiagnosisDto.serializer(), c.api.request("GET", path)) }
                .onSuccess { data = it }
                .onFailure { error = errorText(it) }
            busy = false
        }
    }
    LaunchedEffect(workOrderId) { if (diagnosedAtOnce(kind)) load() }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Diagnosi remota", style = MaterialTheme.typography.titleSmall)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        val d = data
        if (d != null) {
            d.findings.forEach { f ->
                val color = when (f.level) { "bad" -> BadRed; "warn" -> WarnAmber; "ok" -> GoodGreen; else -> MaterialTheme.colorScheme.onSurface }
                Text(f.title, color = color, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
                if (f.detail.isNotBlank()) Text(f.detail, style = MaterialTheme.typography.bodySmall)
                if (f.action.isNotBlank()) Text("→ ${f.action}", style = MaterialTheme.typography.bodySmall)
            }
            val short = listOfNotNull(
                d.cpe?.let { cpe -> if (!cpe.found) "CPE non trovata" else "CPE ${if (cpe.online == false) "spenta" else "accesa"}${cpe.signal?.let { " · $it dBm" } ?: ""}" },
                d.ap?.name?.let { n -> "AP $n${if (d.ap.online == false) " fuori servizio" else ""}" },
            )
            if (short.isNotEmpty()) Text(short.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        Row {
            TextButton(onClick = { load() }, enabled = !busy) { Text(if (data == null && error == null) "Fai la diagnosi" else "Rileggi") }
            d?.at?.let { Text("Letta alle ${it.toLocalTime()}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.align(androidx.compose.ui.Alignment.CenterVertically)) }
        }
    }
}

/** «2026-10-15T18:02:11Z» → «20:02», the phone's time. */
private fun String.toLocalTime(): String = runCatching {
    java.time.Instant.parse(this).atZone(java.time.ZoneId.systemDefault()).toLocalTime().toString().take(5)
}.getOrDefault(take(16).replace('T', ' '))
