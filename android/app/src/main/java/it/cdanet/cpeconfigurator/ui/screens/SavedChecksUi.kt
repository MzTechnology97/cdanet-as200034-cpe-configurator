package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.CheckCustomerDto
import it.cdanet.cpeconfigurator.data.SavedCheckCustomerDto
import it.cdanet.cpeconfigurator.data.SavedCheckDto
import it.cdanet.cpeconfigurator.data.SavedChecksDto
import it.cdanet.cpeconfigurator.data.checkCustomers
import it.cdanet.cpeconfigurator.data.deleteCheck
import it.cdanet.cpeconfigurator.data.renameCheck
import it.cdanet.cpeconfigurator.data.saveCheck
import it.cdanet.cpeconfigurator.data.savedChecks
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.localTime
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * «Verifiche salvate» of Verifica copertura: a check saved with a name (the customer, the job) is
 * taken up again later, with the same CPE and height, the other operators with it. Installers see
 * their own and write the name; admins see everyone's (or their own) and may name a check after a
 * customer of ISP Billing.
 */

/** How a check is saved: what the screen shows now (point, CPE, height, how many APs and how far). */
data class CheckToSave(val lat: Double, val lon: Double, val label: String, val heightM: Double?, val cpe: String, val limit: Int?, val km: Int?)

private fun km(m: Double) = if (m < 1000) "${Math.round(m)} m" else String.format(java.util.Locale.ITALY, "%.1f km", m / 1000)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SavedChecksCard(c: AppContainer, admin: Boolean, version: Int, onOpen: (SavedCheckDto) -> Unit) {
    val scope = rememberCoroutineScope()
    var mine by remember { mutableStateOf(!admin) }
    var q by remember { mutableStateOf("") }
    var data by remember { mutableStateOf<SavedChecksDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var all by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var renaming by remember { mutableStateOf<SavedCheckDto?>(null) }
    var removing by remember { mutableStateOf<SavedCheckDto?>(null) }

    LaunchedEffect(version, reload, mine, q) {
        if (q.isNotBlank()) delay(300)
        runCatching { c.api.savedChecks("coverage", mine = admin && mine, q = q) }
            .onSuccess { data = it; error = null }
            .onFailure { error = it.message }
    }

    SectionCard("Verifiche salvate", icon = R.drawable.ic_history) {
        ErrorBanner(error) { error = null }
        if (admin) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !mine, onClick = { mine = false }, label = { Text("Tutte") })
            FilterChip(selected = mine, onClick = { mine = true }, label = { Text("Mie") })
        }
        val d = data
        if (d != null && (d.total > 5 || q.isNotBlank())) Field("Cerca", q, { q = it.take(80) }, placeholder = "Nome, indirizzo o codice cliente", leadingIcon = R.drawable.ic_search)
        when {
            d == null && error == null -> Text("Lettura…", style = MaterialTheme.typography.bodySmall)
            d != null && d.items.isEmpty() -> Text(
                if (q.isNotBlank()) "Nessuna verifica salvata con questo nome." else "Nessuna verifica salvata. Dopo una verifica, «Salva verifica» la tiene qui con il nome che scrivi, per riprenderla più avanti.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        val shown = d?.items.orEmpty().let { if (all || q.isNotBlank()) it else it.take(5) }
        shown.forEachIndexed { i, s ->
            if (i > 0) HorizontalDivider()
            Column(Modifier.fillMaxWidth().clickable { onOpen(s) }.padding(vertical = 6.dp)) {
                Text(s.name, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                s.customer?.let { k -> Text("Cliente ISP Billing" + (k.code.takeIf { it.isNotBlank() }?.let { " $it" } ?: ""), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
                s.summary?.describe()?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                Text(
                    listOfNotNull(s.point.label.ifBlank { null }, localTime(s.createdAt), if (admin && !s.mine) "di ${s.by}" else null).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SecondaryButton(onClick = { onOpen(s) }) { Text("Apri") }
                    TextButton(onClick = { renaming = s }) { Text("Rinomina") }
                    TextButton(onClick = { removing = s }) { Text("Elimina") }
                }
            }
        }
        if (d != null && !all && q.isBlank() && d.items.size > 5) TextButton(onClick = { all = true }) { Text("Mostra tutte (${d.items.size})") }
        if (d != null && d.total > d.items.size) Text("Le ultime ${d.items.size} di ${d.total}: cerca per trovare le altre.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }

    renaming?.let { s ->
        SaveCheckDialog(c, admin, toSave = null, existing = s, onDismiss = { renaming = null }) { reload++ }
    }
    removing?.let { s ->
        var busy by remember(s.id) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { if (!busy) removing = null },
            title = { Text("Eliminare la verifica?") },
            text = { Text("«${s.name}» esce dalle verifiche salvate.", style = MaterialTheme.typography.bodySmall) },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        runCatching { c.api.deleteCheck(s.id) }
                            .onSuccess { reload++ }
                            .onFailure { error = it.message }
                        busy = false
                        removing = null
                    }
                }) { Text(if (busy) "Elimino…" else "Elimina") }
            },
            dismissButton = { TextButton(onClick = { removing = null }, enabled = !busy) { Text("Annulla") } },
        )
    }
}

/**
 * Save [toSave] with a name, or rename [existing]. Admins also see the customers of ISP Billing
 * with a site near the point and those matching the name written: one tap names the check after it.
 */
@Composable
fun SaveCheckDialog(c: AppContainer, admin: Boolean, toSave: CheckToSave?, existing: SavedCheckDto?, onDismiss: () -> Unit, onSaved: (SavedCheckDto) -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var customer by remember { mutableStateOf(existing?.customer) }
    var near by remember { mutableStateOf<List<CheckCustomerDto>>(emptyList()) }
    var found by remember { mutableStateOf<List<CheckCustomerDto>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val lat = toSave?.lat ?: existing?.point?.lat
    val lon = toSave?.lon ?: existing?.point?.lon
    val label = toSave?.label ?: existing?.point?.label.orEmpty()

    LaunchedEffect(admin) {
        if (!admin) return@LaunchedEffect
        runCatching { c.api.checkCustomers(lat, lon) }.onSuccess { near = it.near }
    }
    LaunchedEffect(name, customer) {
        if (!admin || customer != null || name.trim().length < 2) {
            found = emptyList()
            return@LaunchedEffect
        }
        delay(350)
        runCatching { c.api.checkCustomers(q = name) }.onSuccess { r -> found = (r.found + r.near).filter { f -> near.none { it.customerId == f.customerId } } }
    }

    fun save() {
        busy = true
        error = null
        scope.launch {
            runCatching {
                if (existing != null) {
                    val changed = (existing.customer?.id ?: "") != (customer?.id ?: "")
                    c.api.renameCheck(existing.id, name.trim(), if (changed) customer?.id ?: "" else null)
                } else {
                    val t = toSave!!
                    c.api.saveCheck("coverage", name.trim(), t.lat, t.lon, t.label, customer?.id, t.heightM, t.cpe, t.limit, t.km)
                }
            }.onSuccess {
                busy = false
                onSaved(it)
                onDismiss()
            }.onFailure {
                busy = false
                error = it.message ?: "Non riuscito"
            }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (existing != null) "Rinomina la verifica" else "Salva la verifica") },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(listOfNotNull(label.ifBlank { null }, if (lat != null && lon != null) String.format(java.util.Locale.US, "%.5f, %.5f", lat, lon) else null).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Field(
                    "Nome",
                    name,
                    { name = it.take(120) },
                    placeholder = label.ifBlank { "Nome della verifica" },
                    supporting = if (admin) "Scrivi un nome o scegli un cliente di ISP Billing." else "Per esempio il nome del cliente o del lavoro. Vuoto: resta l'indirizzo.",
                )
                customer?.let { k ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Cliente ISP Billing", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            Text(k.name + (k.code.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""), fontWeight = FontWeight.Medium)
                        }
                        TextButton(onClick = { customer = null }) { Text("Togli") }
                    }
                }
                if (admin && customer == null) {
                    CustomerChoices("Clienti con un indirizzo vicino", near) { k -> customer = SavedCheckCustomerDto(k.customerId, k.name, k.code); name = k.name }
                    CustomerChoices("Clienti con questo nome", found) { k -> customer = SavedCheckCustomerDto(k.customerId, k.name, k.code); name = k.name }
                }
                if (existing == null) Text("Il server rifà la verifica e la salva con il risultato di adesso, insieme agli altri operatori: ci vuole qualche secondo.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(enabled = !busy && (existing != null || toSave != null), onClick = { save() }) { Text(if (busy) "Salvo…" else "Salva") } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Annulla") } },
    )
}

@Composable
private fun CustomerChoices(title: String, list: List<CheckCustomerDto>, onPick: (CheckCustomerDto) -> Unit) {
    if (list.isEmpty()) return
    Text(title, style = MaterialTheme.typography.labelMedium)
    list.take(6).forEach { k ->
        Column(Modifier.fillMaxWidth().clickable { onPick(k) }.padding(vertical = 4.dp)) {
            Text(k.name, fontWeight = FontWeight.Medium)
            Text(
                listOfNotNull(k.code.ifBlank { null }, k.address.ifBlank { null }, k.distanceM?.let { "a ${km(it)}" }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Above the APs of a check opened from the list: which one, and what it said then. */
@Composable
fun OpenedCheckNote(s: SavedCheckDto, onClose: () -> Unit) {
    SectionCard("Verifica salvata: ${s.name}") {
        Text(
            "Salvata il ${localTime(s.createdAt)}" + (if (s.mine) "" else " da ${s.by}") + (s.summary?.describe()?.let { ", allora: $it" } ?: "") + ". Sotto, la stessa verifica rifatta adesso.",
            style = MaterialTheme.typography.bodySmall,
        )
        TextButton(onClick = onClose) { Text("Chiudi") }
    }
}
