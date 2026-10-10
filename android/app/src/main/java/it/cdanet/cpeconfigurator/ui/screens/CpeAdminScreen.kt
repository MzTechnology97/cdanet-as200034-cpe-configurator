package it.cdanet.cpeconfigurator.ui.screens

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.AdminCpeDto
import it.cdanet.cpeconfigurator.data.AdminCpeViewDto
import it.cdanet.cpeconfigurator.data.AdminCrmDto
import it.cdanet.cpeconfigurator.data.AdminWirelessDto
import it.cdanet.cpeconfigurator.data.SignalHistoryDto
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.RefreshButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.SkeletonRows
import it.cdanet.cpeconfigurator.ui.StatusChip
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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
 * connection) plus its customer in ISP Billing — overview, radio, signal history, interfaces,
 * firmware, backups — with refresh, restart, firmware upgrade, backup and restore, wireless
 * parameters, alias/note/maintenance. Every action asks for confirmation and is in the activity
 * log; Wi-Fi keys stay on the server. A screen of its own, opened from Salute CPE.
 */
@Composable
fun CpeAdminScreen(c: AppContainer, deviceId: String) {
    CpeAdminContent(c, deviceId)
}

@Composable
private fun CpeAdminContent(c: AppContainer, deviceId: String) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<AdminCpeDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var pending by remember { mutableStateOf<Pending?>(null) }
    var stats by remember { mutableStateOf<SignalHistoryDto?>(null) }
    var range by remember { mutableStateOf("week") }
    var reloads by remember { mutableStateOf(0) }
    var wirelessPending by remember { mutableStateOf<JsonObject?>(null) }

    LaunchedEffect(deviceId, reloads) {
        loading = true
        runCatching { c.api.adminCpe(deviceId) }.onSuccess { data = it; error = null }.onFailure { error = it.message }
        loading = false
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

    wirelessPending?.let { body ->
        AlertDialog(
            onDismissRequest = { wirelessPending = null },
            title = { Text("Modificare i parametri wireless?") },
            text = {
                Text(
                    "${body.size} ${if (body.size == 1) "modifica" else "modifiche"}." +
                        (body["ssid"]?.let { " La CPE si aggancerà alla rete $it." } ?: "") +
                        " La CPE può scollegarsi per qualche secondo; un valore sbagliato può lasciare il cliente senza Internet.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    wirelessPending = null
                    scope.launch {
                        busy = true
                        runCatching { c.api.adminCpeWireless(deviceId, body) }
                            .onSuccess { done = "Parametri inviati alla CPE"; delay(6000); reloads++ }
                            .onFailure { error = it.message }
                        busy = false
                    }
                }) { Text("Applica") }
            },
            dismissButton = { TextButton(onClick = { wirelessPending = null }) { Text("Annulla") } },
        )
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

    val d = data
    Column(Modifier.fillMaxSize()) {
        // name and model of the CPE (the app bar above has back and the title)
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(d?.cpe?.let { it.alias ?: it.name.ifBlank { it.mac ?: it.id } } ?: "Caricamento…", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                d?.cpe?.let { cpe ->
                    Text(listOfNotNull(cpe.modelName ?: cpe.model, cpe.mac).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            RefreshButton(loading) { reloads++ }
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            ErrorBanner(error) { error = null }
            done?.let { Notice(it, NoticeKind.Good) { done = null } }
            if (d == null) {
                if (error == null) SkeletonRows(4)
                return@Column
            }
            val cpe = d.cpe
            val good = stats?.thresholds?.good?.toDouble() ?: c.field.thresholds.signalGood.toDouble()
            val min = stats?.thresholds?.min?.toDouble() ?: c.field.thresholds.signalMin.toDouble()
            if (!cpe.online) Notice("Offline${cpe.lastSeen?.let { " dal ${date(it)}" } ?: ""}: UISP accetta i comandi ma arrivano solo se la CPE torna raggiungibile. Firmware, ripristino e parametri wireless solo online.", NoticeKind.Warn)
            if (cpe.maintenance) Notice("In manutenzione su UISP: avvisi sospesi per questa CPE.", NoticeKind.Info)

            Overview(cpe, good, min, busy, onRefresh = { run(Pending("", "refresh", "Stato richiesto a UISP", 3000)) }, onRestart = {
                pending = Pending(
                    if (cpe.online) "Riavviare ${cpe.name}? Il cliente resta senza Internet per circa un minuto." else "${cpe.name} è offline: il riavvio arriva solo se torna raggiungibile. Inviarlo comunque?",
                    "restart",
                    if (cpe.online) "Riavvio inviato: torna online in circa un minuto" else "Comando inviato a UISP (CPE offline)",
                    5000,
                )
            }, onBackup = { run(Pending("", "backups", "Backup richiesto: compare nell'elenco tra poco", 6000)) })

            d.crm?.let { CustomerCard(it) }

            SectionCard("Radio", icon = R.drawable.ic_settings_input_antenna) {
                val r = cpe.radio
                Tiles(
                    "Frequenza" to n(r.frequency, " MHz"),
                    "Canale" to if (r.autoChannelWidth == true) "automatico" else n(r.channelWidth, " MHz"),
                    "Segnale lato AP" to n(r.remoteSignal, " dBm"),
                    "Distanza dall'AP" to (r.distanceM?.let { if (it >= 1000) "%.2f km".format(java.util.Locale.ITALY, it / 1000) else "${it.roundToInt()} m" } ?: "—"),
                    "Potenza TX" to n(r.txPower, " dBm"),
                    "Guadagno" to n(r.antennaGain, " dBi"),
                )
                KeyValue("SSID", r.ssid ?: "—")
                KeyValue("Modalità · sicurezza", listOfNotNull(r.mode, r.security).joinToString(" · ").ifBlank { "—" })
                cpe.wireless?.let { w -> WirelessEditor(w, cpe.online, busy) { wirelessPending = it } }
            }

            SectionCard("Storico segnale", icon = R.drawable.ic_query_stats) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("day" to "24 ore", "week" to "Settimana", "month" to "Mese").forEach { (k, l) -> FilterChip(selected = range == k, onClick = { range = k }, label = { Text(l) }) }
                }
                val s = stats
                if (s == null) {
                    Box(Modifier.fillMaxWidth().height(160.dp), contentAlignment = Alignment.Center) { Text("Caricamento…", style = MaterialTheme.typography.bodySmall) }
                } else {
                    Box(Modifier.fillMaxWidth().height(160.dp)) { SeriesChart(s.signal, s.remoteSignal, good, min) }
                    Text("Linea continua: segnale della CPE · tratteggio: lato AP · soglie ${good.roundToInt()} e ${min.roundToInt()} dBm", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            if (cpe.interfaces.isNotEmpty()) {
                SectionCard("Interfacce", icon = R.drawable.ic_lan) {
                    cpe.interfaces.forEachIndexed { i, itf ->
                        if (i > 0) HorizontalDivider()
                        val color = when {
                            itf.enabled == false -> MaterialTheme.colorScheme.outline
                            itf.plugged == true -> GoodGreen
                            else -> WarnAmber
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(9.dp).clip(RoundedCornerShape(50)).background(color))
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(itf.name, fontWeight = FontWeight.SemiBold)
                                Text(listOfNotNull(itf.type, if (itf.enabled == false) "disattivata" else if (itf.plugged == true) "collegata" else "scollegata").joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text(itf.speed ?: "—", style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }

            SectionCard("Firmware", icon = R.drawable.ic_system_update) {
                val fw = cpe.firmware
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(fw.current ?: "—", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                    fw.upgradeTo?.takeIf { it != fw.current }?.let { to ->
                        Text("  →  $to", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                    }
                    Spacer(Modifier.weight(1f))
                    if (fw.upgradeTo == null || fw.upgradeTo == fw.current) StatusChip("aggiornato", NoticeKind.Good)
                }
                fw.upgradeStatus?.let { Text("Ultimo aggiornamento: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if (fw.upgradeTo != null && fw.upgradeTo != fw.current) {
                    BusyButton("Aggiorna a ${fw.upgradeTo}", busy, Modifier.fillMaxWidth(), enabled = cpe.online && fw.canUpgrade) {
                        pending = Pending(
                            "Aggiornare il firmware di ${cpe.name} da ${fw.current} a ${fw.upgradeTo}? La CPE si riavvia: il cliente resta senza Internet per qualche minuto. Non spegnerla durante l'aggiornamento.",
                            "upgrade",
                            "Aggiornamento avviato: ${fw.current} → ${fw.upgradeTo}",
                            8000,
                        )
                    }
                    Text("All'ultima versione che UISP ha per questo modello. Solo con la CPE online.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            SectionCard("Backup della configurazione", icon = R.drawable.ic_history) {
                if (d.backups.isEmpty()) Text("Nessun backup in UISP.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                d.backups.forEachIndexed { i, b ->
                    if (i > 0) HorizontalDivider()
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(date(b.timestamp), fontWeight = FontWeight.SemiBold)
                            Text(if (b.type == "auto") "automatico" else b.type ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
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
                        ) { Text("Ripristina", color = if (cpe.online) BadRed else MaterialTheme.colorScheme.outline) }
                    }
                }
            }

            UispSettings(cpe, busy) { alias, note, maint ->
                scope.launch {
                    busy = true
                    runCatching { c.api.adminCpeMeta(deviceId, alias, note, maint) }
                        .onSuccess { done = "Salvato in UISP"; reloads++ }
                        .onFailure { error = it.message }
                    busy = false
                }
            }
            Text(
                "Ogni azione è registrata nel Registro attività. Le chiavi Wi-Fi della CPE restano sul server.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        }
    }
}

/** Status, the four numbers that matter and the everyday actions. */
@Composable
private fun Overview(cpe: AdminCpeViewDto, good: Double, min: Double, busy: Boolean, onRefresh: () -> Unit, onRestart: () -> Unit, onBackup: () -> Unit) {
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusChip(if (cpe.online) "online" else "offline", if (cpe.online) NoticeKind.Good else NoticeKind.Bad)
            Spacer(Modifier.width(10.dp))
            Text(
                if (cpe.online) "acceso da ${uptime(cpe.uptimeSec)}" else "ultimo contatto ${date(cpe.lastSeen)}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        val signal = cpe.radio.signal
        val signalColor = when {
            signal == null -> MaterialTheme.colorScheme.onSurface
            signal >= good -> GoodGreen
            signal >= min -> WarnAmber
            else -> BadRed
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Metric("Segnale", n(signal, " dBm"), signalColor)
            Metric("Capacità ↓/↑", if (cpe.radio.downlinkMbps != null) "${n(cpe.radio.downlinkMbps)}/${n(cpe.radio.uplinkMbps)}" else "—", sub = "Mbit/s")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Metric("CPU · RAM", "${n(cpe.cpu, "%")} · ${n(cpe.ram, "%")}", sub = cpe.temperature?.let { "${n(it)} °C" })
            Metric("Firmware", cpe.firmware.current ?: "—", sub = cpe.firmware.upgradeTo?.takeIf { it != cpe.firmware.current }?.let { "disponibile $it" }, subColor = MaterialTheme.colorScheme.primary)
        }
        KeyValue("AP · site", listOfNotNull(cpe.ap, cpe.site).joinToString(" · ").ifBlank { "—" })
        KeyValue("IP · seriale", listOfNotNull(cpe.ip, cpe.serial).joinToString(" · ").ifBlank { "—" })
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Action(R.drawable.ic_refresh, "Aggiorna stato", busy, onRefresh)
            Action(R.drawable.ic_power_off, "Riavvia", busy, onRestart, danger = true)
            Action(R.drawable.ic_storage, "Backup", busy, onBackup)
        }
    }
}

/** One number of the overview: label, value (colored if it means something) and a small note. */
@Composable
private fun RowScope.Metric(label: String, value: String, valueColor: Color = MaterialTheme.colorScheme.onSurface, sub: String? = null, subColor: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Column(Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 10.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = valueColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
        sub?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = subColor, maxLines = 1) }
    }
}

/** Everyday action: icon above a short label, so three fit side by side on any phone. */
@Composable
private fun RowScope.Action(@DrawableRes icon: Int, label: String, busy: Boolean, onClick: () -> Unit, danger: Boolean = false) {
    FilledTonalButton(
        onClick = onClick,
        enabled = !busy,
        modifier = Modifier.weight(1f).height(64.dp),
        shape = RoundedCornerShape(16.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp, vertical = 6.dp),
        colors = if (danger) {
            ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.error)
        } else {
            ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh, contentColor = MaterialTheme.colorScheme.onSurface)
        },
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(20.dp))
            Spacer(Modifier.height(4.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
        }
    }
}

/** Small labeled values two per row. */
@Composable
private fun ColumnScope.Tiles(vararg items: Pair<String, String>) {
    items.toList().chunked(2).forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            row.forEach { (k, v) ->
                Column(Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(k, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(v, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (row.size == 1) Spacer(Modifier.weight(1f))
        }
    }
}

/** The customer of the CPE in ISP Billing. */
@Composable
private fun CustomerCard(crm: AdminCrmDto) {
    SectionCard("Cliente (ISP Billing)", icon = R.drawable.ic_person) {
        val a = crm.account
        val cu = crm.customer
        val (label, kind) = when (a.state) {
            "online" -> "attivo · PPPoE online" to NoticeKind.Good
            "offline" -> "attivo · PPPoE offline" to NoticeKind.Bad
            "services_suspended" -> "servizi sospesi" to NoticeKind.Warn
            "suspended" -> "sospeso" to NoticeKind.Warn
            "terminating" -> "in cessazione" to NoticeKind.Warn
            "terminated" -> "cessato" to NoticeKind.Bad
            else -> "stato non letto" to NoticeKind.Info
        }
        Text(cu?.name ?: "—", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusChip(label, kind)
            Spacer(Modifier.width(8.dp))
            a.speed?.let { StatusChip("${it.down}M/${it.up}M", NoticeKind.Info) } ?: a.profile.takeIf { it.isNotBlank() }?.let { StatusChip(it, NoticeKind.Info) }
        }
        KeyValue("Utente PPPoE", a.username)
        KeyValue("IP sessione", listOfNotNull(a.clientIp, a.staticIp?.let { "statico $it" }).joinToString(" · ").ifBlank { "—" })
        cu?.code?.let { KeyValue("Codice cliente", it) }
        cu?.phone?.let { KeyValue("Telefono", listOfNotNull(it, cu.phone2).joinToString(" · ")) }
        cu?.email?.let { KeyValue("Email", it) }
        crm.site?.let { site -> KeyValue("Sede", listOfNotNull(site.description, site.address).joinToString(" · ").ifBlank { "—" }) }
        cu?.address?.let { KeyValue("Residenza", it) }
        Text("La password PPPoE non viene mostrata.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Wireless parameters: only the changed ones are sent (the server rewrites the rest as it is). */
@Composable
private fun WirelessEditor(w: AdminWirelessDto, online: Boolean, busy: Boolean, onApply: (JsonObject) -> Unit) {
    var open by remember { mutableStateOf(false) }
    OutlinedButton(onClick = { open = !open }, modifier = Modifier.fillMaxWidth()) {
        Icon(painterResource(R.drawable.ic_edit), contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(if (open) "Chiudi modifica" else "Modifica parametri wireless")
    }
    if (!open) return
    fun t(v: Double?) = v?.let { if (it % 1.0 == 0.0) it.roundToInt().toString() else it.toString() } ?: ""
    var ssid by remember { mutableStateOf(w.ssid ?: "") }
    var tx by remember { mutableStateOf(t(w.txPower)) }
    var atpc by remember { mutableStateOf(w.atpc == true) }
    var gain by remember { mutableStateOf(t(w.antennaGain)) }
    var cable by remember { mutableStateOf(t(w.cableLoss ?: 0.0)) }
    var ackAuto by remember { mutableStateOf(w.ackAuto == true) }
    var ack by remember { mutableStateOf(t(w.ackDistanceM)) }
    var cwAuto by remember { mutableStateOf(w.autoChannelWidth == true) }
    var cw by remember { mutableStateOf(w.channelWidth) }
    val dec = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal)
    OutlinedTextField(ssid, { ssid = it.take(32) }, label = { Text("SSID a cui agganciarsi") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(tx, { tx = it }, label = { Text("Potenza TX (dBm)") }, supportingText = w.txPowerRange?.let { { Text("${t(it.min)}…${t(it.max)}") } }, singleLine = true, keyboardOptions = dec, modifier = Modifier.weight(1f))
        OutlinedTextField(gain, { gain = it }, label = { Text("Guadagno (dBi)") }, singleLine = true, keyboardOptions = dec, modifier = Modifier.weight(1f))
    }
    Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(atpc, { atpc = it }); Text("Potenza automatica (ATPC)") }
    OutlinedTextField(cable, { cable = it }, label = { Text("Perdita cavo (dB)") }, singleLine = true, keyboardOptions = dec, modifier = Modifier.fillMaxWidth())
    Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(ackAuto, { ackAuto = it }); Text("Distanza ACK automatica") }
    if (!ackAuto) OutlinedTextField(ack, { ack = it }, label = { Text("Distanza ACK (m)") }, singleLine = true, keyboardOptions = dec, modifier = Modifier.fillMaxWidth())
    Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(cwAuto, { cwAuto = it }); Text("Larghezza di canale automatica") }
    if (!cwAuto && w.channelWidths.isNotEmpty()) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            w.channelWidths.forEach { x -> FilterChip(selected = cw == x, onClick = { cw = x }, label = { Text("${x.roundToInt()} MHz") }) }
        }
    }
    BusyButton("Applica alla CPE", busy, Modifier.fillMaxWidth(), enabled = online) {
        val num = { v: String -> v.replace(',', '.').toDoubleOrNull() }
        val body = buildJsonObject {
            if (ssid.isNotBlank() && ssid != (w.ssid ?: "")) put("ssid", JsonPrimitive(ssid.trim()))
            num(tx)?.takeIf { it != w.txPower }?.let { put("txPower", JsonPrimitive(it.roundToInt())) }
            if (atpc != (w.atpc == true)) put("atpc", JsonPrimitive(atpc))
            num(gain)?.takeIf { it != w.antennaGain }?.let { put("antennaGain", JsonPrimitive(it)) }
            num(cable)?.takeIf { it != (w.cableLoss ?: 0.0) }?.let { put("cableLoss", JsonPrimitive(it)) }
            if (ackAuto != (w.ackAuto == true)) put("ackAuto", JsonPrimitive(ackAuto))
            if (!ackAuto) num(ack)?.takeIf { it != w.ackDistanceM }?.let { put("ackDistanceM", JsonPrimitive(it)) }
            if (cwAuto != (w.autoChannelWidth == true)) put("autoChannelWidth", JsonPrimitive(cwAuto))
            if (!cwAuto) cw?.takeIf { it != w.channelWidth }?.let { put("channelWidth", JsonPrimitive(it.roundToInt())) }
        }
        if (body.isNotEmpty()) onApply(body)
    }
    Text("Il server rilegge la configurazione dalla CPE e cambia solo questi valori: chiavi Wi-Fi e altri parametri restano come sono.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Alias, note and maintenance mode of the device in UISP. */
@Composable
private fun UispSettings(cpe: AdminCpeViewDto, busy: Boolean, onSave: (String, String, Boolean) -> Unit) {
    SectionCard("Gestione in UISP", icon = R.drawable.ic_edit) {
        var alias by remember(cpe.alias) { mutableStateOf(cpe.alias ?: "") }
        var note by remember(cpe.note) { mutableStateOf(cpe.note ?: "") }
        var maint by remember(cpe.maintenance) { mutableStateOf(cpe.maintenance) }
        OutlinedTextField(alias, { alias = it.take(100) }, label = { Text("Alias (nome in UISP)") }, placeholder = { Text(cpe.name) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(note, { note = it.take(1000) }, label = { Text("Note") }, minLines = 2, modifier = Modifier.fillMaxWidth())
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(maint, { maint = it })
            Text("In manutenzione (sospende gli avvisi di UISP)", style = MaterialTheme.typography.bodyMedium)
        }
        BusyButton("Salva in UISP", busy, Modifier.fillMaxWidth()) { onSave(alias, note, maint) }
    }
}
