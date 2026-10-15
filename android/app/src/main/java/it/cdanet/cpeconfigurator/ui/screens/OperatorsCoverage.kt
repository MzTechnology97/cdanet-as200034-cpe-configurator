package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.ApiException
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SectionCard
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.util.Locale

/** «Altri operatori» of a point (admins): FTTH, FTTC, radio of the other operators, by AGCOM sticker. */
@Serializable
data class OperatorsCoverageDto(
    val at: String? = null,
    val cached: Boolean = false,
    val address: OperatorsAddressDto? = null,
    /** Best sticker among the offers that can be activated: F, FWA, FR, R. */
    val best: String? = null,
    val available: Int = 0,
    val groups: List<OperatorsGroupDto> = emptyList(),
)

@Serializable
data class OperatorsAddressDto(val label: String = "", val city: String? = null, val lat: Double? = null, val lon: Double? = null, val geoid: String? = null)

@Serializable
data class OperatorsGroupDto(val sticker: String = "", val label: String = "", val color: String = "#777777", val available: Int = 0, val rows: List<OperatorsRowDto> = emptyList())

@Serializable
data class OperatorsRowDto(
    val operator: String = "",
    val technology: String = "",
    val technologyLabel: String = "",
    val family: String? = null,
    val kind: String? = null,
    /** available, planned, none. */
    val state: String = "none",
    val maxMbps: Double? = null,
    val downMbps: Double? = null,
    val upMbps: Double? = null,
)

/** «#0f940f» → the colour; grey when the server sends something else. */
internal fun stickerColor(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Color(0xFF777777))

/** The AGCOM sticker as a round badge: «F», «FR», «FWA», «R» in white on its colour. */
@Composable
fun AgcomSticker(sticker: String, color: String, size: Int = 30) {
    Box(Modifier.size(size.dp).clip(CircleShape).background(stickerColor(color)), contentAlignment = Alignment.Center) {
        Text(sticker, color = Color.White, fontWeight = FontWeight.Bold, fontSize = if (sticker.length > 2) (size / 3.2).sp else (size / 2.4).sp, maxLines = 1)
    }
}

private val STATE = mapOf("available" to "attivabile", "planned" to "in programma", "none" to "non coperto")

private fun mbit(v: Double?): String? = v?.let { if (it >= 1000) "%.0f Gbit/s".format(Locale.ITALY, it / 1000) else "%.0f Mbit/s".format(Locale.ITALY, it) }

private fun errorText(e: Throwable): String = when ((e as? ApiException)?.code) {
    "operators_not_configured" -> "Copertura degli altri operatori non configurata: Connettori nella console."
    "operators_busy" -> "Troppe verifiche in poco tempo: riprova tra un minuto."
    "invalid_coordinates" -> "Coordinate non valide."
    null -> e.message ?: "Verifica non riuscita"
    else -> "Il servizio di copertura ha risposto con un errore (${(e as ApiException).code})."
}

/**
 * Admins: the coverage of the other operators at the checked point, grouped by AGCOM sticker (F,
 * FWA, FR, R) as the server computes it. Asked on request only: every call goes to an external
 * service (the server keeps the answers a few days).
 */
@Composable
fun OperatorsCoverageCard(c: AppContainer, lat: Double, lon: Double) {
    val scope = rememberCoroutineScope()
    var data by remember(lat, lon) { mutableStateOf<OperatorsCoverageDto?>(null) }
    var busy by remember(lat, lon) { mutableStateOf(false) }
    var error by remember(lat, lon) { mutableStateOf<String?>(null) }
    var showAll by remember(lat, lon) { mutableStateOf(false) }
    fun load(refresh: Boolean) {
        busy = true
        error = null
        scope.launch {
            runCatching {
                AppJson.decodeFromString(
                    OperatorsCoverageDto.serializer(),
                    c.api.request("GET", "/api/admin/coverage/operators?lat=$lat&lon=$lon" + if (refresh) "&refresh=1" else ""),
                )
            }.onSuccess { data = it }.onFailure { error = errorText(it) }
            busy = false
        }
    }
    LaunchedEffect(lat, lon) { data = null }

    SectionCard("Altri operatori") {
        Text("FTTH, FTTC e radio degli altri operatori in questo punto, con il bollino AGCOM di ogni tecnologia.", style = MaterialTheme.typography.bodySmall)
        val d = data
        if (d == null) {
            BusyButton("Verifica gli altri operatori", busy, Modifier.fillMaxWidth()) { load(false) }
        } else {
            d.address?.label?.takeIf { it.isNotBlank() }?.let { Text("Indirizzo riconosciuto: $it", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold) }
            val bestGroup = d.groups.firstOrNull { it.sticker == d.best }
            if (bestGroup != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AgcomSticker(bestGroup.sticker, bestGroup.color, 36)
                    Text("Il meglio attivabile qui: ${bestGroup.label} · ${d.available} offerte attivabili", fontWeight = FontWeight.SemiBold)
                }
            } else {
                Text("Nessuna offerta attivabile degli altri operatori in questo punto.", fontWeight = FontWeight.SemiBold)
            }
            d.groups.forEach { g ->
                val rows = g.rows.filter { showAll || it.state != "none" }
                if (rows.isEmpty() && !showAll) return@forEach
                Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AgcomSticker(g.sticker, g.color)
                    Text("${g.label} · ${g.available} attivabili", fontWeight = FontWeight.SemiBold)
                }
                rows.forEach { r ->
                    val speed = mbit(r.downMbps)?.let { d0 -> d0 + (mbit(r.upMbps)?.let { " / $it" } ?: "") } ?: mbit(r.maxMbps)?.let { "fino a $it" }
                    Column(Modifier.padding(start = 38.dp)) {
                        Text("${r.operator} · ${r.technologyLabel.ifBlank { r.technology }}", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            listOfNotNull(STATE[r.state] ?: r.state, speed).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (r.state == "available") MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            val hidden = d.groups.sumOf { g -> g.rows.count { it.state == "none" } }
            Row {
                if (hidden > 0) TextButton(onClick = { showAll = !showAll }) { Text(if (showAll) "Solo coperti" else "Mostra anche i non coperti ($hidden)") }
                TextButton(onClick = { load(true) }, enabled = !busy) { Text("Aggiorna") }
            }
            d.at?.let { Text("Letto il ${it.take(16).replace('T', ' ')}${if (d.cached) " (dalla memoria del server)" else ""}.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        error?.let { Notice(it, NoticeKind.Warn) }
    }
}
