package it.cdanet.cpeconfigurator.ui.screens

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

/** Guasti Enel: outages in the zones of interest, and notifications on this phone and on Telegram. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun OutagesScreen(c: AppContainer) {
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
        ListHeader(data?.let { d -> if (d.active.isEmpty()) "Nessuna interruzione" else "${d.active.size} ${if (d.active.size == 1) "interruzione" else "interruzioni"}" } ?: "Guasti Enel", busy) { scope.launch { load() } }
        val d = data
        if (d != null) {
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
        // settings after the outages: what the technician looks for first is the map and the list
        SectionCard("Notifiche sul telefono", icon = it.cdanet.cpeconfigurator.R.drawable.ic_notifications) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (admin) "Avvisami dei guasti nelle zone CDA Net" else "Avvisami dei guasti nelle mie zone", modifier = Modifier.weight(1f))
                Switch(checked = alerts, onCheckedChange = { on ->
                    if (!on) {
                        OutageAlerts.disable(context)
                        alerts = false
                    } else if (Build.VERSION.SDK_INT >= 33 && !OutageAlerts.canNotify(context)) {
                        permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        scope.launch { turnOn() }
                    }
                })
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Anche i lavori programmati", modifier = Modifier.weight(1f))
                Switch(checked = planned, onCheckedChange = { p ->
                    planned = p
                    if (alerts) scope.launch { turnOn() }
                })
            }
            Text("Controllo ogni 15 minuti anche ad app chiusa, con un accesso in sola lettura ai guasti (revocato se cambi password o esci da tutti i dispositivi).", style = MaterialTheme.typography.bodySmall)
        }
        PersonalTelegramCard(c)
        if (!admin) MyZones(c) { scope.launch { load() } }
        if (admin) ZoneEditor(c, personal = false) { scope.launch { load() } }

    }
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
                    Text("Anche i lavori programmati", modifier = Modifier.weight(1f))
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
    var zones by remember { mutableStateOf<List<OutageZoneItemDto>>(emptyList()) }
    var msg by remember { mutableStateOf<String?>(null) }
    suspend fun reload() {
        runCatching { c.api.myOutageZones() }.onSuccess { zones = it }.onFailure { msg = it.message }
    }
    LaunchedEffect(Unit) { reload() }
    SectionCard("Le mie zone di interesse", icon = it.cdanet.cpeconfigurator.R.drawable.ic_my_location) {
        msg?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        if (zones.isEmpty()) Text("Nessuna zona: aggiungine una qui sotto (massimo 20).", style = MaterialTheme.typography.bodySmall)
        zones.forEach { z ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${z.name} · ${z.radiusKm} km", modifier = Modifier.weight(1f))
                TextButton(onClick = {
                    scope.launch {
                        runCatching { c.api.deleteMyOutageZone(z.id) }.onFailure { msg = it.message }
                        reload()
                        onChanged()
                    }
                }) { Text("Elimina") }
            }
        }
    }
    ZoneEditor(c, personal = true) {
        scope.launch { reload() }
        onChanged()
    }
}

/** New area of interest from the phone (GPS with automatic address, address search or typed coordinates). */
@Composable
private fun ZoneEditor(c: AppContainer, personal: Boolean, onAdded: () -> Unit) {
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var radius by remember { mutableStateOf("2") }
    var lat by remember { mutableStateOf("") }
    var lon by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    SectionCard(if (personal) "Nuova zona" else "Zone condivise (admin)") {
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
        Field("Nome della zona", name, { name = it })
        Field("Raggio (km)", radius, { radius = it.replace(',', '.') }, keyboardType = KeyboardType.Decimal)
        BusyButton("Salva zona", busy, Modifier.fillMaxWidth(), enabled = name.trim().length >= 2 && lat.toDoubleOrNull() != null && lon.toDoubleOrNull() != null) {
            scope.launch {
                busy = true
                msg = runCatching {
                    val r = radius.toDoubleOrNull() ?: 2.0
                    if (personal) c.api.createMyOutageZone(name.trim(), lat.toDouble(), lon.toDouble(), r)
                    else c.api.createOutageZone(name.trim(), lat.toDouble(), lon.toDouble(), r)
                    name = ""; lat = ""; lon = ""; label = ""
                    onAdded()
                    "Zona salvata: entra nel prossimo controllo (entro 10 minuti)."
                }.getOrElse { it.message }
                busy = false
            }
        }
    }
}
