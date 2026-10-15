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
import androidx.compose.material3.LinearProgressIndicator
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
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SectionCard
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.net.URLEncoder
import java.util.Locale

/** «Altri operatori» of a point: FTTH, FTTC, radio of the other operators, by AGCOM sticker. */
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
    /** Admins only: installers never get the names of the other operators. */
    val operator: String? = null,
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

/** One step of the search by exact address: a city, a street, a house number or a stair. */
@Serializable
data class OperatorsPlacesDto(val step: String = "", val items: List<OperatorsPlaceDto> = emptyList())

@Serializable
data class OperatorsPlaceDto(
    val city: String? = null,
    val street: String? = null,
    val streetType: String? = null,
    val number: String? = null,
    val stair: String? = null,
    val label: String? = null,
    val zip: String? = null,
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

/** Installers get neutral texts: never where the data comes from. */
private fun errorText(e: Throwable, admin: Boolean): String = when ((e as? ApiException)?.code) {
    "operators_not_configured" -> if (admin) "Copertura degli altri operatori non configurata: Connettori nella console." else "Verifica degli altri operatori non disponibile."
    "operators_busy" -> "Troppe verifiche in poco tempo: riprova tra un minuto."
    "operators_address_not_found" -> "Indirizzo non trovato: controlla comune, via e civico."
    "invalid_coordinates", "invalid_request" -> "Punto o indirizzo non valido."
    null -> e.message ?: "Verifica non riuscita"
    else -> if (admin) "Il servizio di copertura ha risposto con un errore (${(e as ApiException).code})." else "Verifica non riuscita (${(e as ApiException).code})."
}

private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

/** The exact address chosen step by step (city → street → number → stair). */
private data class ExactAddress(val city: String? = null, val street: String? = null, val streetType: String? = null, val number: String? = null, val stair: String? = null) {
    fun query(): String = listOfNotNull(
        city?.let { "city=${enc(it)}" },
        street?.let { "street=${enc(it)}" },
        streetType?.let { "streetType=${enc(it)}" },
        number?.let { "number=${enc(it)}" },
        stair?.let { "stair=${enc(it)}" },
    ).joinToString("&")

    fun label(): String = listOfNotNull(streetType?.let { t -> street?.let { "$t $it" } } ?: street, number, stair?.let { "scala $it" }, city).joinToString(", ")
}

/**
 * The coverage of the other operators at the checked point, grouped by AGCOM sticker (F, FWA, FR,
 * R) as the server computes it, read together with the check (the server keeps the answers a few
 * days). Admins see the operators' names; installers only sticker, technology, state and speed.
 * When the point is not precise enough, the exact address can be chosen step by step.
 */
@Composable
fun OperatorsCoverageCard(c: AppContainer, lat: Double, lon: Double, admin: Boolean) {
    val scope = rememberCoroutineScope()
    val base = if (admin) "/api/admin/coverage/operators" else "/api/field/coverage/operators"
    var data by remember(lat, lon) { mutableStateOf<OperatorsCoverageDto?>(null) }
    var busy by remember(lat, lon) { mutableStateOf(false) }
    var error by remember(lat, lon) { mutableStateOf<String?>(null) }
    var showAll by remember(lat, lon) { mutableStateOf(false) }
    // the exact address (null: the checked point)
    var exact by remember(lat, lon) { mutableStateOf<ExactAddress?>(null) }
    var searching by remember(lat, lon) { mutableStateOf(false) }

    fun load(refresh: Boolean) {
        busy = true
        error = null
        val where = exact?.takeIf { it.number != null }?.query() ?: "lat=$lat&lon=$lon"
        scope.launch {
            runCatching {
                AppJson.decodeFromString(OperatorsCoverageDto.serializer(), c.api.request("GET", "$base?$where" + if (refresh && admin) "&refresh=1" else ""))
            }.onSuccess { data = it }.onFailure { error = errorText(it, admin) }
            busy = false
        }
    }
    // with every check: no button to press
    LaunchedEffect(lat, lon) {
        data = null
        load(false)
    }

    SectionCard("Altri operatori") {
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        val d = data
        if (d != null) {
            val where = exact?.takeIf { it.number != null }?.label() ?: d.address?.label?.takeIf { it.isNotBlank() }
            where?.let { Text("Indirizzo: $it", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold) }
            val bestGroup = d.groups.firstOrNull { it.sticker == d.best }
            if (bestGroup != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AgcomSticker(bestGroup.sticker, bestGroup.color, 36)
                    Text("Il meglio attivabile qui: ${bestGroup.label}", fontWeight = FontWeight.SemiBold)
                }
            } else {
                Text("Nessuna offerta attivabile degli altri operatori in questo punto.", fontWeight = FontWeight.SemiBold)
            }
            d.groups.forEach { g ->
                val rows = g.rows.filter { showAll || it.state != "none" }
                if (rows.isEmpty() && !showAll) return@forEach
                Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AgcomSticker(g.sticker, g.color)
                    Text(g.label, fontWeight = FontWeight.SemiBold)
                }
                rows.forEach { r ->
                    val speed = mbit(r.downMbps)?.let { d0 -> d0 + (mbit(r.upMbps)?.let { " / $it" } ?: "") } ?: mbit(r.maxMbps)?.let { "fino a $it" }
                    val tech = r.technologyLabel.ifBlank { r.technology }
                    Column(Modifier.padding(start = 38.dp)) {
                        Text(listOfNotNull(r.operator?.takeIf { admin && it.isNotBlank() }, tech).joinToString(" · "), style = MaterialTheme.typography.bodyMedium)
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
                if (hidden > 0) TextButton(onClick = { showAll = !showAll }) { Text(if (showAll) "Solo coperti" else "Mostra anche i non coperti") }
                if (admin) TextButton(onClick = { load(true) }, enabled = !busy) { Text("Aggiorna") }
            }
            if (admin) d.at?.let { Text("Letto il ${it.take(16).replace('T', ' ')}${if (d.cached) " (dalla memoria del server)" else ""}.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        error?.let { Notice(it, NoticeKind.Warn) }
        if (searching) {
            ExactAddressSearch(c, admin, onCancel = { searching = false }) { a ->
                searching = false
                exact = a
                load(false)
            }
        } else {
            Row {
                TextButton(onClick = { searching = true }, enabled = !busy) { Text(if (exact == null) "Cerca per indirizzo esatto" else "Cambia indirizzo") }
                if (exact != null) TextButton(onClick = { exact = null; load(false) }, enabled = !busy) { Text("Torna al punto") }
            }
        }
    }
}

/** Comune → strada → civico → scala, each from the list the server gives for what is typed. */
@Composable
private fun ExactAddressSearch(c: AppContainer, admin: Boolean, onCancel: () -> Unit, onDone: (ExactAddress) -> Unit) {
    val places = if (admin) "/api/admin/coverage/operators/places" else "/api/field/coverage/operators/places"
    var a by remember { mutableStateOf(ExactAddress()) }
    var q by remember { mutableStateOf("") }
    var items by remember { mutableStateOf<List<OperatorsPlaceDto>>(emptyList()) }
    var stairs by remember { mutableStateOf<List<OperatorsPlaceDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val step = when {
        a.city == null -> "city"
        a.street == null -> "street"
        else -> "number"
    }
    val min = if (step == "number") 1 else 2
    LaunchedEffect(q, step) {
        items = emptyList()
        error = null
        if (q.trim().length < min) return@LaunchedEffect
        delay(350)
        val query = when (step) {
            "city" -> "q=${enc(q.trim())}"
            else -> a.query() + "&q=${enc(q.trim())}"
        }
        runCatching { AppJson.decodeFromString(OperatorsPlacesDto.serializer(), c.api.request("GET", "$places?$query")) }
            .onSuccess { items = it.items }
            .onFailure { error = errorText(it, admin) }
    }
    LaunchedEffect(a.number) {
        val n = a.number ?: return@LaunchedEffect
        // the stairs of the building: none or one = straight to the check
        val list = runCatching { AppJson.decodeFromString(OperatorsPlacesDto.serializer(), c.api.request("GET", "$places?${a.query()}")).items }.getOrDefault(emptyList())
        val named = list.mapNotNull { it.stair }.distinct()
        if (named.size <= 1) onDone(a.copy(number = n, stair = named.firstOrNull())) else stairs = list
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            listOfNotNull(a.city, a.street?.let { s -> listOfNotNull(a.streetType, s).joinToString(" ") }).joinToString(" · ").ifBlank { "Indirizzo esatto" },
            style = MaterialTheme.typography.titleSmall,
        )
        val st = stairs
        if (st != null) {
            Text("Scala", style = MaterialTheme.typography.bodySmall)
            st.forEach { s -> TextButton(onClick = { onDone(a.copy(stair = s.stair)) }) { Text(s.stair ?: "Non presente") } }
        } else if (a.number == null) {
            OutlinedTextField(
                q,
                { q = it.take(60) },
                label = { Text(when (step) { "city" -> "Comune"; "street" -> "Via o piazza"; else -> "Civico" }) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            items.take(12).forEach { p ->
                val text = when (step) {
                    "city" -> p.label ?: p.city.orEmpty()
                    "street" -> p.label ?: listOfNotNull(p.streetType, p.street).joinToString(" ")
                    else -> p.number.orEmpty()
                }
                TextButton(onClick = {
                    a = when (step) {
                        "city" -> a.copy(city = p.city)
                        "street" -> a.copy(street = p.street, streetType = p.streetType)
                        else -> a.copy(number = p.number)
                    }
                    q = ""
                }, modifier = Modifier.fillMaxWidth()) { Text(text, modifier = Modifier.fillMaxWidth()) }
            }
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        TextButton(onClick = onCancel) { Text("Annulla") }
    }
}
