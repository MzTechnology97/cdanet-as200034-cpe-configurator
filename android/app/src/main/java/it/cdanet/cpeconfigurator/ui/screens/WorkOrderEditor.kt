package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.InstallerDto
import it.cdanet.cpeconfigurator.data.WorkOrderDto
import it.cdanet.cpeconfigurator.provisioning.ProvisionForm
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.Dropdown
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A work order as the NOC edits it in the app's calendar. */
data class OrderDraft(
    val day: LocalDate,
    val start: String = "",
    val end: String = "",
    val assignedTo: Long? = null,
    val kind: String = "new",
    val customer: String = "",
    val address: String = "",
    val contact: String = "",
    val model: String = "",
    val pppoeUser: String = "",
    /** Only sent when typed: on a change, empty = keep the one already on the server. */
    val pppoePassword: String = "",
    val notes: String = "",
)

/** Times, slots, checks and the request body of the editor (pure, tested). */
object OrderDraftMath {
    val KINDS = listOf("new" to "Nuova installazione", "repoint" to "Ripuntamento / cambio AP", "repair" to "Guasto", "survey" to "Sopralluogo")

    /** Every half hour from 07:00 to 21:00. */
    val TIMES: List<String> = (7 * 60..21 * 60 step 30).map { "%02d:%02d".format(it / 60, it % 60) }

    private fun hm(minutes: Int) = "%02d:%02d".format(minutes / 60, minutes % 60)

    /** "09:00-10:30"; a start alone is an hour; none = without a time. */
    fun slot(start: String, end: String): String = when {
        start.isBlank() -> ""
        end.isBlank() || end <= start -> start
        else -> "$start-$end"
    }

    /** A new order at [hour] of [day] (a tap on the calendar), an hour long; null hour = without a time. */
    fun at(day: LocalDate, hour: Int?, assignedTo: Long? = null): OrderDraft =
        if (hour == null) OrderDraft(day, assignedTo = assignedTo) else OrderDraft(day, hm(hour * 60), hm((hour + 1).coerceAtMost(23) * 60), assignedTo)

    fun of(o: WorkOrderDto): OrderDraft {
        val m = CalendarMath.slotMinutes(o.slot)
        return OrderDraft(
            day = LocalDate.parse(o.day),
            start = m?.let { hm(it.first) } ?: "",
            end = m?.let { hm(it.second) } ?: "",
            assignedTo = o.assignedTo,
            kind = o.kind,
            customer = o.customer,
            address = o.address,
            contact = o.contact,
            model = o.model,
            pppoeUser = o.pppoeUser,
            notes = o.notes,
        )
    }

    /** What stops the save, said plainly; null = it can be saved. */
    fun problem(d: OrderDraft): String? = when {
        d.customer.trim().length < 2 -> "Scrivi il nome del cliente."
        d.start.isNotBlank() && d.end.isNotBlank() && d.end <= d.start -> "L'ora di fine deve venire dopo l'inizio."
        else -> null
    }

    /**
     * The request: every field for a new order; for a change only what differs from [before], so an
     * unchanged address does not throw away the position already found for it.
     */
    fun body(d: OrderDraft, before: OrderDraft? = null): JsonObject = buildJsonObject {
        fun <T> field(key: String, now: T, was: T?, value: () -> kotlinx.serialization.json.JsonElement) {
            if (before == null || now != was) put(key, value())
        }
        field("assignedTo", d.assignedTo, before?.assignedTo) { d.assignedTo?.let { JsonPrimitive(it) } ?: JsonNull }
        field("day", d.day, before?.day) { JsonPrimitive(d.day.toString()) }
        field("slot", slot(d.start, d.end), before?.let { slot(it.start, it.end) }) { JsonPrimitive(slot(d.start, d.end)) }
        field("kind", d.kind, before?.kind) { JsonPrimitive(d.kind) }
        field("customer", d.customer.trim(), before?.customer?.trim()) { JsonPrimitive(d.customer.trim()) }
        field("address", d.address.trim(), before?.address?.trim()) { JsonPrimitive(d.address.trim()) }
        field("contact", d.contact.trim(), before?.contact?.trim()) { JsonPrimitive(d.contact.trim()) }
        field("model", d.model, before?.model) { JsonPrimitive(d.model) }
        field("pppoeUser", d.pppoeUser.trim(), before?.pppoeUser?.trim()) { JsonPrimitive(d.pppoeUser.trim()) }
        field("notes", d.notes.trim(), before?.notes?.trim()) { JsonPrimitive(d.notes.trim()) }
        if (d.pppoePassword.isNotEmpty()) put("pppoePassword", JsonPrimitive(d.pppoePassword))
    }
}

/**
 * Nuovo intervento / Modifica e sposta, for the NOC in the calendar: installer, day and time, kind,
 * customer and the data the installer finds already filled in. [original] null = a new one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkOrderEditor(
    c: AppContainer,
    start: OrderDraft,
    original: WorkOrderDto?,
    installers: List<InstallerDto>,
    onClose: () -> Unit,
    onSaved: (WorkOrderDto) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var d by remember { mutableStateOf(start) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pickDay by remember { mutableStateOf(false) }
    val before = remember(original) { original?.let { OrderDraftMath.of(it) } }

    Dialog(onDismissRequest = { if (!busy) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (original == null) "Nuovo intervento" else "Modifica intervento", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    TextButton(onClick = onClose, enabled = !busy) { Text("Chiudi") }
                }

                val people = listOf<Pair<Long?, String>>(null to "Da assegnare") + installers.map { it.id to it.username }
                Dropdown("Installatore", people, people.firstOrNull { it.first == d.assignedTo } ?: people.first(), { it.second }, { d = d.copy(assignedTo = it.first) }, Modifier.fillMaxWidth())

                Text("Quando", style = MaterialTheme.typography.titleSmall)
                SecondaryButton(onClick = { pickDay = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(d.day.format(DateTimeFormatter.ofPattern("EEEE d MMMM yyyy", Locale.ITALIAN)).replaceFirstChar { it.uppercase() })
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val today = LocalDate.now()
                    TextButton(onClick = { d = d.copy(day = today) }) { Text("Oggi") }
                    TextButton(onClick = { d = d.copy(day = today.plusDays(1)) }) { Text("Domani") }
                    TextButton(onClick = { d = d.copy(day = d.day.plusDays(1)) }) { Text("Giorno dopo") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val starts = listOf("") + OrderDraftMath.TIMES
                    Dropdown("Dalle", starts, d.start, { it.ifBlank { "senza orario" } }, { s ->
                        // a later start moves the end with it: an hour after
                        val end = if (s.isBlank()) "" else if (d.end.isBlank() || d.end <= s) OrderDraftMath.TIMES.firstOrNull { it > s }?.let { e -> OrderDraftMath.TIMES.firstOrNull { it > e } ?: e } ?: "" else d.end
                        d = d.copy(start = s, end = end)
                    }, Modifier.weight(1f))
                    val ends = listOf("") + OrderDraftMath.TIMES.filter { d.start.isBlank() || it > d.start }
                    Dropdown("Alle", ends, d.end, { it.ifBlank { "—" } }, { d = d.copy(end = it) }, Modifier.weight(1f))
                }

                Dropdown("Tipo", OrderDraftMath.KINDS, OrderDraftMath.KINDS.firstOrNull { it.first == d.kind } ?: OrderDraftMath.KINDS.first(), { it.second }, { d = d.copy(kind = it.first) }, Modifier.fillMaxWidth())

                OutlinedTextField(d.customer, { d = d.copy(customer = it.take(120)) }, label = { Text("Cliente") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(d.address, { d = d.copy(address = it.take(200)) }, label = { Text("Indirizzo") }, supportingText = { Text("La posizione si ricava dall'indirizzo.") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(d.contact, { d = d.copy(contact = it.take(120)) }, label = { Text("Contatto") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth())

                if (d.kind == "new") {
                    val models = listOf("") + ProvisionForm.MODELS
                    Dropdown("CPE", models, d.model, { it.ifBlank { "da scegliere sul posto" } }, { d = d.copy(model = it) }, Modifier.fillMaxWidth())
                    OutlinedTextField(d.pppoeUser, { d = d.copy(pppoeUser = it.take(128)) }, label = { Text("Utente PPPoE") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(
                        d.pppoePassword,
                        { d = d.copy(pppoePassword = it.take(200)) },
                        label = { Text("Password PPPoE") },
                        supportingText = { Text(if (original?.hasPassword == true) "Già salvata: lascia vuoto per non cambiarla." else "Resta cifrata sul server: l'installatore non la vede.") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                OutlinedTextField(d.notes, { d = d.copy(notes = it.take(1000)) }, label = { Text("Note per l'installatore") }, minLines = 2, modifier = Modifier.fillMaxWidth())

                ErrorBanner(error) { error = null }
                val problem = OrderDraftMath.problem(d)
                if (problem != null && d.customer.isNotEmpty()) Text(problem, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                BusyButton(if (original == null) "Crea intervento" else "Salva", busy, Modifier.fillMaxWidth(), enabled = problem == null) {
                    scope.launch {
                        busy = true
                        error = null
                        runCatching {
                            if (original == null) c.api.createWorkOrder(OrderDraftMath.body(d))
                            else c.api.updateWorkOrder(original.id, OrderDraftMath.body(d, before))
                        }.onSuccess { onSaved(it) }.onFailure { error = it.message ?: "Salvataggio non riuscito" }
                        busy = false
                    }
                }
                Text("L'installatore riceve la notifica quando gli assegni un intervento o ne cambi giorno e ora.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }

    if (pickDay) {
        val state = rememberDatePickerState(initialSelectedDateMillis = d.day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { pickDay = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { d = d.copy(day = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                    pickDay = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { pickDay = false }) { Text("Annulla") } },
        ) { DatePicker(state) }
    }
}
