package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.AdminCpeDto
import it.cdanet.cpeconfigurator.data.SignalHistoryDto
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.Banner
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** An action waiting for the admin's confirmation: question, server action, message when done. */
private data class Pending(val question: String, val action: String, val done: String, val reloadAfterMs: Long)

private fun n(v: Double?, unit: String = "") = v?.let { (if (it % 1.0 == 0.0) it.roundToInt().toString() else "%.1f".format(java.util.Locale.ITALY, it)) + unit } ?: "—"
/** UISP times are UTC: shown in the phone's time zone. */
private fun date(iso: String?) = iso?.let {
    runCatching { java.time.format.DateTimeFormatter.ofPattern("dd/MM/yy HH:mm").format(java.time.Instant.parse(it).atZone(java.time.ZoneId.systemDefault())) }.getOrNull()
} ?: "—"
private fun uptime(s: Long?) = s?.let { if (it >= 86400) "${it / 86400} g ${(it % 86400) / 3600} h" else "${it / 3600} h ${(it % 3600) / 60} min" } ?: "—"

/**
 * Admin "Stato CPE" in the app: one customer CPE as in the UISP app (through the server's UISP
 * connection) — overview, radio, signal history, interfaces, firmware, backups — with refresh,
 * restart, firmware upgrade, backup and restore, alias/note/maintenance. Every action asks for
 * confirmation and is in the activity log; Wi-Fi keys stay on the server.
 */
@Composable
fun CpeAdminDialog(c: AppContainer, deviceId: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onClose) { Text("← Chiudi") }
                Text("Gestione CPE", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            }
            CpeAdminContent(c, deviceId)
        }
    }
}

@Composable
private fun CpeAdminContent(c: AppContainer, deviceId: String) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<AdminCpeDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<Pending?>(null) }
    var stats by remember { mutableStateOf<SignalHistoryDto?>(null) }
    var range by remember { mutableStateOf("week") }
    var reloads by remember { mutableStateOf(0) }

    LaunchedEffect(deviceId, reloads) {
        runCatching { c.api.adminCpe(deviceId) }.onSuccess { data = it; error = null }.onFailure { error = it.message }
    }
    LaunchedEffect(deviceId, range) {
        stats = null
        stats = runCatching { c.api.adminCpeStats(deviceId, range) }.getOrNull()
    }

    fun run(p: Pending) {
        scope.launch {
            busy = true
            error = null
            runCatching { c.api.adminCpeAction(deviceId, p.action) }
                .onSuccess {
                    done = p.done
                    delay(p.reloadAfterMs)
                    reloads++
                }
                .onFailure { error = it.message }
            busy = false
        }
    }

    pending?.let { p ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text("Confermi?") },
            text = { Text(p.question) },
            confirmButton = { TextButton(onClick = { pending = null; run(p) }) { Text("Conferma") } },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("Annulla") } },
        )
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        done?.let { Banner(it, GoodGreen) }
        val d = data
        if (d == null) {
            if (error == null) Text("Caricamento dalla rete…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            return@Column
        }
        val cpe = d.cpe
        val fw = cpe.firmware
        val r = cpe.radio
        Text(cpe.alias ?: cpe.name.ifBlank { cpe.mac ?: cpe.id }, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(listOfNotNull(cpe.modelName ?: cpe.model, cpe.mac, cpe.ip).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
        if (!cpe.online) {
            Banner("CPE offline${cpe.lastSeen?.let { " dal ${date(it)}" } ?: ""}: UISP accetta i comandi ma arrivano solo se torna raggiungibile. Firmware e ripristino solo online.", WarnAmber)
        }
        if (cpe.maintenance) Banner("In manutenzione su UISP: avvisi sospesi per questa CPE.", WarnAmber)

        SectionCard("Panoramica") {
            KeyValue("Stato", if (cpe.online) "online" else cpe.status)
            KeyValue("Ultimo contatto", date(cpe.lastSeen))
            KeyValue("Acceso da", uptime(cpe.uptimeSec))
            KeyValue("CPU / RAM", "${n(cpe.cpu, "%")} / ${n(cpe.ram, "%")}")
            KeyValue("Temperatura", n(cpe.temperature, " °C"))
            KeyValue("AP", cpe.ap ?: "—")
            KeyValue("Site", cpe.site ?: "—")
            KeyValue("Seriale", cpe.serial ?: "—")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { run(Pending("", "refresh", "Stato richiesto a UISP", 3000)) }, enabled = !busy) { Text("Aggiorna stato") }
                OutlinedButton(
                    onClick = {
                        pending = Pending(
                            if (cpe.online) "Riavviare ${cpe.name}? Il cliente resta senza Internet per circa un minuto." else "${cpe.name} è offline: il riavvio arriva solo se torna raggiungibile. Inviarlo comunque?",
                            "restart",
                            if (cpe.online) "Riavvio inviato: torna online in circa un minuto" else "Comando inviato a UISP (CPE offline)",
                            5000,
                        )
                    },
                    enabled = !busy,
                ) { Text("Riavvia", color = BadRed) }
            }
        }

        SectionCard("Radio") {
            KeyValue("Modalità", r.mode ?: "—")
            KeyValue("Frequenza", n(r.frequency, " MHz"))
            KeyValue("Larghezza canale", if (r.autoChannelWidth == true) "automatica" else n(r.channelWidth, " MHz"))
            KeyValue("Segnale", n(r.signal, " dBm"))
            KeyValue("Segnale lato AP", n(r.remoteSignal, " dBm"))
            KeyValue("Distanza dall'AP", r.distanceM?.let { if (it >= 1000) "%.2f km".format(java.util.Locale.ITALY, it / 1000) else "${it.roundToInt()} m" } ?: "—")
            KeyValue("Potenza TX", n(r.txPower, " dBm"))
            KeyValue("Guadagno antenna", n(r.antennaGain, " dBi"))
            KeyValue("Capacità ↓ / ↑", if (r.downlinkMbps != null) "${n(r.downlinkMbps)} / ${n(r.uplinkMbps)} Mbit/s" else "—")
            KeyValue("SSID", r.ssid ?: "—")
            KeyValue("Sicurezza", r.security ?: "—")
        }

        SectionCard("Storico segnale") {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("day" to "24 ore", "week" to "Settimana", "month" to "Mese").forEach { (k, l) -> FilterChip(selected = range == k, onClick = { range = k }, label = { Text(l) }) }
            }
            val s = stats
            if (s == null) Text("Caricamento…", style = MaterialTheme.typography.bodySmall) else SeriesChart(s.signal, s.remoteSignal, s.thresholds.good.toDouble(), s.thresholds.min.toDouble())
        }

        if (cpe.interfaces.isNotEmpty()) {
            SectionCard("Interfacce") {
                cpe.interfaces.forEach { i ->
                    KeyValue(i.name, listOfNotNull(i.type, if (i.enabled == false) "disattivata" else if (i.plugged == true) "collegata" else "scollegata", i.speed).joinToString(" · "))
                }
            }
        }

        SectionCard("Firmware") {
            KeyValue("Installato", fw.current ?: "—")
            KeyValue("Disponibile in UISP", fw.upgradeTo ?: "—")
            fw.upgradeStatus?.let { KeyValue("Ultimo aggiornamento", it) }
            BusyButton(
                fw.upgradeTo?.let { "Aggiorna a $it" } ?: "Nessun aggiornamento",
                busy,
                Modifier.fillMaxWidth(),
                enabled = cpe.online && fw.canUpgrade && fw.upgradeTo != null,
            ) {
                pending = Pending(
                    "Aggiornare il firmware di ${cpe.name} da ${fw.current} a ${fw.upgradeTo}? La CPE si riavvia: il cliente resta senza Internet per qualche minuto. Non spegnerla durante l'aggiornamento.",
                    "upgrade",
                    "Aggiornamento avviato: ${fw.current} → ${fw.upgradeTo}",
                    8000,
                )
            }
        }

        SectionCard("Backup della configurazione") {
            if (d.backups.isEmpty()) Text("Nessun backup in UISP.", style = MaterialTheme.typography.bodySmall)
            d.backups.forEach { b ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${date(b.timestamp)} · ${b.type ?: ""}", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    TextButton(
                        onClick = {
                            pending = Pending(
                                "Ripristinare su ${cpe.name} la configurazione del ${date(b.timestamp)}? La CPE si riavvia con quella configurazione: se è sbagliata il cliente può restare senza Internet.",
                                "backups/${java.net.URLEncoder.encode(b.id, "UTF-8")}/apply",
                                "Ripristino inviato",
                                8000,
                            )
                        },
                        enabled = cpe.online && !busy,
                    ) { Text("Ripristina", color = if (cpe.online) BadRed else MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
            OutlinedButton(onClick = { run(Pending("", "backups", "Backup richiesto: compare nell'elenco tra poco", 6000)) }, enabled = !busy) { Text("Crea backup ora") }
        }

        SectionCard("Gestione in UISP") {
            var alias by remember(cpe.alias) { mutableStateOf(cpe.alias ?: "") }
            var note by remember(cpe.note) { mutableStateOf(cpe.note ?: "") }
            var maint by remember(cpe.maintenance) { mutableStateOf(cpe.maintenance) }
            OutlinedTextField(alias, { alias = it.take(100) }, label = { Text("Alias (nome in UISP)") }, placeholder = { Text(cpe.name) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(note, { note = it.take(1000) }, label = { Text("Note") }, minLines = 2, modifier = Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(maint, { maint = it })
                Text("In manutenzione (sospende gli avvisi di UISP)", style = MaterialTheme.typography.bodyMedium)
            }
            BusyButton("Salva", busy, Modifier.fillMaxWidth()) {
                scope.launch {
                    busy = true
                    runCatching { c.api.adminCpeMeta(deviceId, alias, note, maint) }
                        .onSuccess { done = "Salvato in UISP"; reloads++ }
                        .onFailure { error = it.message }
                    busy = false
                }
            }
        }
        Text("Ogni azione è registrata nel Registro attività. Le chiavi Wi-Fi della CPE restano sul server.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
