package it.cdanet.cpeconfigurator.ui.screens

import it.cdanet.cpeconfigurator.data.MyZonesDto
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.StatusChip
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Slider
import androidx.compose.material3.AlertDialog
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Spacer
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.ListHeader
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import it.cdanet.cpeconfigurator.data.OutageDto
import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.CpeLocation
import it.cdanet.cpeconfigurator.data.OutageItemDto
import it.cdanet.cpeconfigurator.data.OutageTelegramDto
import it.cdanet.cpeconfigurator.data.OutageZoneItemDto
import it.cdanet.cpeconfigurator.data.TelegramLinkDto
import it.cdanet.cpeconfigurator.data.OutagesDto
import it.cdanet.cpeconfigurator.outages.OutageAlerts
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.EmbeddedMap
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.launch

private val KIND = mapOf("guasto_mt" to "Guasto media tensione", "guasto_bt" to "Guasto bassa tensione", "lavoro" to "Lavoro programmato", "altro" to "Interruzione")
private fun hm(s: String?) = s?.replace('T', ' ')?.let { "${it.substring(8, 10)}/${it.substring(5, 7)} ${it.substring(11)}" } ?: "—"

/** What a part of the "Rete" area shows: the outages (map and list) or the areas and their alerts. */
enum class OutageSection { List, Areas }

/**
 * Guasti Enel. [OutageSection.List]: outages in the zones of interest with the map;
 * [OutageSection.Areas]: notifications on this phone and the user's own areas of interest
 * (Telegram is set up once, in Impostazioni).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun OutagesScreen(c: AppContainer, section: OutageSection = OutageSection.List) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val admin = c.session.isAdmin
    var data by remember { mutableStateOf<OutagesDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var alerts by remember { mutableStateOf(OutageAlerts.isEnabled(context)) }
    var planned by remember { mutableStateOf(OutageAlerts.includePlanned(context)) }

    suspend fun load() {
        busy = true
        runCatching { c.api.outages() }.onSuccess { data = it; error = null }.onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(Unit) { load() }

    suspend fun turnOn() {
        runCatching {
            val token = c.api.outageDeviceToken()
            OutageAlerts.enable(context, c.api.base(), token, planned)
        }.onSuccess { alerts = true }.onFailure { error = it.message }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scope.launch { turnOn() } else error = "Senza il permesso di notifica Android non può mostrare gli avvisi."
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        if (section == OutageSection.List) ListHeader(data?.let { d -> if (d.active.isEmpty()) "Nessuna interruzione" else "${d.active.size} ${if (d.active.size == 1) "interruzione" else "interruzioni"}" } ?: "Guasti Enel", busy) { scope.launch { load() } }
        val d = data
        if (d != null && section == OutageSection.List) {
            val at = d.lastRun?.at ?: d.generatedAt
            Text(
                when {
                    at == null -> "In attesa del primo aggiornamento"
                    admin -> "Ultimo controllo del server: ${at.replace('T', ' ').take(16)} · fonte e-distribuzione"
                    else -> "Aggiornato: ${at.replace('T', ' ').take(16)}"
                },
                style = MaterialTheme.typography.bodySmall,
            )
            var mapJson by remember(d) { mutableStateOf<String?>(null) }
            var page by remember { mutableStateOf<android.webkit.WebView?>(null) }
            val mapInView = remember { BringIntoViewRequester() }
            LaunchedEffect(d) { mapJson = runCatching { c.api.outagesMapJson() }.getOrNull() }
            SectionCard("Mappa", Modifier.bringIntoViewRequester(mapInView), icon = it.cdanet.cpeconfigurator.R.drawable.ic_map) {
                EmbeddedMap(c, mapJson?.let { "window.cdaOutages($it)" }, Modifier.fillMaxWidth().height(360.dp)) { page = it }
                Text(
                    "Rosso: guasti MT e POP/AP potenzialmente impattati · arancio: guasti BT · grigio: lavori · tratteggio: zone" + if (admin) "" else " · POP/AP come area approssimativa",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (!d.scope.all) {
                SectionCard("POP/AP assegnati a te", icon = it.cdanet.cpeconfigurator.R.drawable.ic_cell_tower) {
                    if (d.scope.assigned.isEmpty()) {
                        Text("Nessuno: vedi i guasti nelle tue zone, senza i POP/AP potenzialmente impattati.", style = MaterialTheme.typography.bodySmall)
                    } else {
                        Text(d.scope.assigned.joinToString(" · ") { itemLabel(it) }, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (d.active.isEmpty()) {
                EmptyState(R.drawable.ic_bolt, "Nessuna interruzione", if (admin) "Nessun guasto né lavoro nelle zone di interesse." else "Nessun guasto né lavoro nelle tue zone.")
            }
            if (d.active.isNotEmpty()) {
                Text("Tocca una riga per i dettagli", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                var open by remember { mutableStateOf<Long?>(null) }
                SectionCard {
                    d.active.forEachIndexed { i, o ->
                        if (i > 0) HorizontalDivider()
                        OutageRow(o, expanded = open == o.id, onToggle = { open = if (open == o.id) null else o.id }, onMap = {
                            scope.launch { mapInView.bringIntoView() }
                            page?.evaluateJavascript("window.cdaFocusOutage(${o.id})", null)
                        }, onNavigate = {
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:${o.lat},${o.lon}?q=${o.lat},${o.lon}"))) }
                        })
                    }
                }
            }        }
        if (section == OutageSection.Areas) AreasAndAlerts(c, admin, alerts, planned, onAlerts = { on ->
            if (!on) {
                OutageAlerts.disable(context)
                alerts = false
            } else if (Build.VERSION.SDK_INT >= 33 && !OutageAlerts.canNotify(context)) {
                permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                scope.launch { turnOn() }
            }
        }, onPlanned = { p ->
            planned = p
            if (alerts) scope.launch { turnOn() }
        }, onChanged = { scope.launch { load() } })
    }
}

/** Phone notifications and the areas of interest (installers) or the shared zones (admins). */
@Composable
private fun AreasAndAlerts(c: AppContainer, admin: Boolean, alerts: Boolean, planned: Boolean, onAlerts: (Boolean) -> Unit, onPlanned: (Boolean) -> Unit, onChanged: () -> Unit) {
        SectionCard("Notifiche sul telefono", icon = it.cdanet.cpeconfigurator.R.drawable.ic_notifications) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (admin) "Avvisami dei guasti nelle zone CDA Net" else "Avvisami dei guasti nelle mie zone", modifier = Modifier.weight(1f))
                Switch(checked = alerts, onCheckedChange = onAlerts)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (admin) "Anche i lavori programmati" else "Anche i lavori sui POP/AP assegnati", modifier = Modifier.weight(1f))
                Switch(checked = planned, onCheckedChange = onPlanned)
            }
            Text(
                "Controllo ogni 15 minuti anche ad app chiusa, con un accesso in sola lettura ai guasti (revocato se cambi password o esci da tutti i dispositivi)." +
                    if (admin) "" else " Per le tue aree di interesse valgono le regole di ciascuna.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Text("Le notifiche su Telegram si collegano in Impostazioni.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!admin) MyZones(c, onChanged)
        if (admin) ZoneEditor(c, personal = false, onAdded = onChanged)
}

private val SHORT = mapOf("guasto_mt" to "Guasto MT", "guasto_bt" to "Guasto BT", "lavoro" to "Lavoro programmato", "altro" to "Interruzione")

/** One dense row per outage: kind, place, Enel customers, since when, impacted POP/AP; details on tap. */
@Composable
private fun OutageRow(o: OutageDto, expanded: Boolean, onToggle: () -> Unit, onMap: () -> Unit, onNavigate: () -> Unit) {
    val color = when (o.kind) { "guasto_mt" -> BadRed; "lavoro" -> MaterialTheme.colorScheme.onSurfaceVariant; else -> WarnAmber }
    val small = MaterialTheme.typography.bodySmall
    Column {
        Row(Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(color))
            Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                Text("${o.place} (${o.province})", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${SHORT[o.kind] ?: o.cause} · ${o.customers} clienti · dal ${hm(o.start)}", style = small, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (o.impact.isNotEmpty()) Text("${o.impact.size} POP/AP", style = small, color = BadRed, fontWeight = FontWeight.SemiBold)
        }
        if (expanded) {
            Column(Modifier.padding(start = 20.dp, bottom = 4.dp)) {
                o.zones.firstOrNull()?.let { z -> Text("${z.name} a ${if (z.distanceM >= 1000) "%.1f km".format(z.distanceM / 1000.0) else "${z.distanceM} m"}", style = small) }
                Text("Ripristino previsto ${hm(o.expectedRestore)}", style = small)
                if (o.impact.isNotEmpty()) {
                    Text("Potenzialmente impattati:", color = BadRed, fontWeight = FontWeight.SemiBold, style = small)
                    o.impact.take(5).forEach { i ->
                        Text("• ${if (i.type == "pop") "POP" else "AP"} ${i.name} a ${i.distanceM} m" + (i.stations?.let { " · $it CPE" } ?: ""), color = BadRed, style = small)
                    }
                }
                Row {
                    TextButton(onClick = onMap) { Text("Sulla mappa") }
                    TextButton(onClick = onNavigate) { Text("Navigatore") }
                }
            }
        }
    }
}

private fun itemLabel(i: OutageItemDto) = when {
    i.key.startsWith("pop:") -> "POP ${i.name}"
    i.key.startsWith("ap:") -> i.name
    else -> "Zona ${i.name}"
}

/** Personal Telegram: the bot set by the admin writes to the user's own chat (link via Start, or the chat id). */
@Composable
fun PersonalTelegramCard(c: AppContainer) {
    val sessionRole = c.session.state.collectAsState().value?.user?.role
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var t by remember { mutableStateOf<OutageTelegramDto?>(null) }
    var link by remember { mutableStateOf<TelegramLinkDto?>(null) }
    var chatId by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { t = runCatching { c.api.outageTelegram() }.getOrNull() }
    fun act(block: suspend () -> OutageTelegramDto?) {
        scope.launch {
            busy = true
            msg = null
            runCatching { block() }.onSuccess { r -> if (r != null) t = r }.onFailure { msg = it.message }
            busy = false
        }
    }
    val s = t ?: return
    val what = if (s.outages) "i guasti Enel nelle tue zone e sui POP/AP assegnati" else "le notifiche che ti riguardano"
    SectionCard("Notifiche su Telegram", icon = it.cdanet.cpeconfigurator.R.drawable.ic_notifications) {
        msg?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        when {
            !s.available -> Text(
                when (s.reason) {
                    "no_bot" -> if (s.canConfigure) "Manca il bot Telegram: dalla console web apri Connettori → Telegram e incolla il token del bot (creato con @BotFather). Basta il token, il gruppo del NOC è facoltativo."
                    else "Le notifiche Telegram personali non sono ancora attive: chiedi all'amministratore di configurare il bot."
                    "personal_off" -> if (s.canConfigure) "Le notifiche personali sono disattivate: riattivale dalla console web in Connettori → Telegram."
                    else "L'amministratore ha disattivato le notifiche Telegram personali."
                    "module_off" -> if (s.canConfigure) "Il modulo Notifiche Telegram è spento: accendilo dalla console web in Funzionalità."
                    else "Le notifiche Telegram non sono attive su questo server."
                    else -> "Le notifiche Telegram personali non sono attive."
                },
                style = MaterialTheme.typography.bodySmall,
            )
            s.linked -> {
                Text("Telegram collegato (chat ${s.chatHint}): ricevi qui $what.", style = MaterialTheme.typography.bodySmall)
                if (s.outages) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (sessionRole == "admin") "Anche i lavori programmati" else "Anche i lavori sui POP/AP assegnati", modifier = Modifier.weight(1f))
                    Switch(checked = s.planned, onCheckedChange = { p -> act { c.api.outageTelegramSet(null, p) } })
                }
                BusyButton("Scollega Telegram", busy, Modifier.fillMaxWidth(), primary = false) { act { c.api.outageTelegramUnlink() } }
            }
            else -> {
                Text("Ricevi su Telegram $what, con il bot del server.", style = MaterialTheme.typography.bodySmall)
                val l = link
                if (l == null) {
                    BusyButton("Collega Telegram", busy, Modifier.fillMaxWidth()) {
                        scope.launch {
                            busy = true
                            runCatching { c.api.outageTelegramLink() }
                                .onSuccess { r ->
                                    link = r
                                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(r.url))) }
                                }
                                .onFailure { msg = it.message }
                            busy = false
                        }
                    }
                } else {
                    Text("1. Nel bot @${l.bot} premi Avvia.\n2. Torna qui e premi Verifica (entro ${l.expiresInMin} minuti).", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(l.url))) } }) { Text("Apri il bot") }
                    BusyButton("Verifica", busy, Modifier.fillMaxWidth()) { act { c.api.outageTelegramVerify().also { link = null } } }
                }
                Field("Oppure il tuo ID Telegram", chatId, { chatId = it.trim() }, keyboardType = KeyboardType.Number)
                BusyButton("Usa questo ID", busy, Modifier.fillMaxWidth(), primary = false, enabled = chatId.length >= 3) { act { c.api.outageTelegramSet(chatId, null) } }
                Text("Prima di usare l'ID scrivi almeno un messaggio al bot.", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** Installer: own areas of interest (list, delete, add). */
@Composable
private fun MyZones(c: AppContainer, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<MyZonesDto?>(null) }
    var msg by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    suspend fun reload() {
        runCatching { c.api.myOutageZones() }.onSuccess { data = it; msg = null }.onFailure { msg = it.message }
    }
    fun change(z: OutageZoneItemDto, patch: JsonObject) {
        scope.launch {
            runCatching { c.api.updateMyOutageZone(z.id, patch) }.onFailure { msg = it.message }
            reload()
            onChanged()
        }
    }
    LaunchedEffect(Unit) { reload() }
    val zones = data?.zones.orEmpty()
    val max = data?.max ?: 20
    SectionCard("Le mie aree di interesse", icon = R.drawable.ic_my_location) {
        Text(
            "Luoghi da seguire anche fuori dai POP/AP che ti sono assegnati: casa, una frazione, il paese di un cliente. Per ognuno scegli quali avvisi ricevere; in pausa non ti avvisa ma i guasti restano in elenco.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        msg?.let { ErrorBanner(it) { msg = null } }
        if (data != null && zones.isEmpty()) {
            EmptyState(R.drawable.ic_my_location, "Nessuna area", "Aggiungine una dal GPS o da un indirizzo.")
        }
        zones.forEach { z ->
            AreaCard(
                z,
                onPatch = { change(z, it) },
                onDelete = {
                    scope.launch {
                        runCatching { c.api.deleteMyOutageZone(z.id) }.onFailure { msg = it.message }
                        reload()
                        onChanged()
                    }
                },
            )
        }
        if (!adding) {
            BusyButton("Aggiungi un'area (${zones.size}/$max)", false, Modifier.fillMaxWidth(), enabled = zones.size < max, primary = false, tonal = true) { adding = true }
        }
    }
    if (adding) {
        ZoneEditor(c, personal = true, onClose = { adding = false }) {
            adding = false
            scope.launch { reload() }
            onChanged()
        }
    }
}

private fun flag(key: String, value: Boolean) = buildJsonObject { put(key, JsonPrimitive(value)) }

/** One personal area: on/paused, which outages notify, outages now, radius and delete. */
@Composable
private fun AreaCard(z: OutageZoneItemDto, onPatch: (JsonObject) -> Unit, onDelete: () -> Unit) {
    var expanded by remember(z.id) { mutableStateOf(false) }
    var radius by remember(z.id, z.radiusKm) { mutableStateOf(z.radiusKm.toFloat()) }
    var confirmDelete by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(MaterialTheme.colorScheme.surfaceContainer)
            .padding(start = 14.dp, end = 8.dp, top = 10.dp, bottom = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(z.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Raggio ${km(z.radiusKm.toFloat())}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            StatusChip(
                when (z.activeCount) {
                    0 -> "nessun guasto"
                    1 -> "1 interruzione"
                    else -> "${z.activeCount} interruzioni"
                },
                if (z.activeCount > 0) NoticeKind.Warn else NoticeKind.Good,
            )
            Switch(checked = !z.paused, onCheckedChange = { on -> onPatch(flag("paused", !on)) }, modifier = Modifier.padding(start = 8.dp))
        }
        if (z.paused) Text("In pausa: nessun avviso da quest'area.", style = MaterialTheme.typography.bodySmall, color = WarnAmber)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf(Triple("notifyMt", "Guasti MT", z.notifyMt), Triple("notifyBt", "Guasti BT", z.notifyBt), Triple("notifyPlanned", "Lavori", z.notifyPlanned)).forEach { (key, label, on) ->
                FilterChip(selected = on, enabled = !z.paused, onClick = { onPatch(flag(key, !on)) }, label = { Text(label) })
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Chiudi" else "Raggio") }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { confirmDelete = true }) { Text("Elimina", color = BadRed) }
        }
        if (expanded) {
            Text("Raggio: ${km(radius)}", style = MaterialTheme.typography.bodySmall)
            Slider(
                value = radius,
                onValueChange = { radius = (Math.round(it * 2) / 2f).coerceIn(0.5f, 30f) },
                valueRange = 0.5f..30f,
                onValueChangeFinished = { onPatch(buildJsonObject { put("radiusKm", JsonPrimitive(radius.toDouble())) }) },
                modifier = Modifier.padding(end = 8.dp),
            )
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Eliminare l'area?") },
            text = { Text("${z.name}: non riceverai più avvisi per questa zona.") },
            confirmButton = { TextButton(onClick = { confirmDelete = false; onDelete() }) { Text("Elimina", color = BadRed) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Annulla") } },
        )
    }
}

private fun km(v: Float) = "%.1f km".format(java.util.Locale.ITALY, v)

/** New area of interest from the phone (GPS with automatic address, address search or typed coordinates). */
@Composable
private fun ZoneEditor(c: AppContainer, personal: Boolean, onClose: (() -> Unit)? = null, onAdded: () -> Unit) {
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var radius by remember { mutableStateOf(2f) }
    var notifyMt by remember { mutableStateOf(true) }
    var notifyBt by remember { mutableStateOf(true) }
    var notifyPlanned by remember { mutableStateOf(false) }
    var lat by remember { mutableStateOf("") }
    var lon by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    SectionCard(if (personal) "Nuova area di interesse" else "Zone condivise (admin)", icon = R.drawable.ic_add_circle) {
        if (onClose != null) open = true
        if (!open) {
            TextButton(onClick = { open = true }) { Text("Aggiungi una zona da qui") }
            return@SectionCard
        }
        msg?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        LocationPicker(c, lat.toDoubleOrNull()?.let { la -> lon.toDoubleOrNull()?.let { lo -> CpeLocation(la, lo, null, "manual") } }, label) { loc, lab ->
            lat = "%.6f".format(java.util.Locale.ROOT, loc.latitude)
            lon = "%.6f".format(java.util.Locale.ROOT, loc.longitude)
            label = lab
            if (name.isBlank()) {
                scope.launch {
                    runCatching { c.api.reverseGeocode(loc.latitude, loc.longitude) }.getOrNull()?.let { r ->
                        name = listOf(r.street, r.city).filter { s -> s.isNotBlank() }.joinToString(", ")
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Field("Latitudine", lat, { lat = it.replace(',', '.').trim() }, Modifier.weight(1f), keyboardType = KeyboardType.Decimal)
            Field("Longitudine", lon, { lon = it.replace(',', '.').trim() }, Modifier.weight(1f), keyboardType = KeyboardType.Decimal)
        }
        Field(if (personal) "Nome dell'area" else "Nome della zona", name, { name = it })
        Text("Raggio: ${km(radius)}", style = MaterialTheme.typography.bodyMedium)
        Slider(value = radius, onValueChange = { radius = (Math.round(it * 2) / 2f).coerceIn(0.5f, 30f) }, valueRange = 0.5f..30f)
        if (personal) {
            Text("Avvisami di", style = MaterialTheme.typography.labelLarge)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = notifyMt, onClick = { notifyMt = !notifyMt }, label = { Text("Guasti MT") })
                FilterChip(selected = notifyBt, onClick = { notifyBt = !notifyBt }, label = { Text("Guasti BT") })
                FilterChip(selected = notifyPlanned, onClick = { notifyPlanned = !notifyPlanned }, label = { Text("Lavori programmati") })
            }
        }
        BusyButton("Salva zona", busy, Modifier.fillMaxWidth(), enabled = name.trim().length >= 2 && lat.toDoubleOrNull() != null && lon.toDoubleOrNull() != null) {
            scope.launch {
                busy = true
                msg = runCatching {
                    val r = radius.toDouble()
                    if (personal) c.api.createMyOutageZone(name.trim(), lat.toDouble(), lon.toDouble(), r, notifyMt, notifyBt, notifyPlanned)
                    else c.api.createOutageZone(name.trim(), lat.toDouble(), lon.toDouble(), r)
                    name = ""; lat = ""; lon = ""; label = ""
                    onAdded()
                    if (personal) "Area salvata: entra nel prossimo controllo (entro 10 minuti)." else "Zona salvata: entra nel prossimo controllo (entro 10 minuti)."
                }.getOrElse { it.message }
                busy = false
            }
        }
    }
}
