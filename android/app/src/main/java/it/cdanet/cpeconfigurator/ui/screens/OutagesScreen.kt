package it.cdanet.cpeconfigurator.ui.screens

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
import it.cdanet.cpeconfigurator.data.OutagesDto
import it.cdanet.cpeconfigurator.outages.OutageAlerts
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.launch

private val KIND = mapOf("guasto_mt" to "Guasto media tensione", "guasto_bt" to "Guasto bassa tensione", "lavoro" to "Lavoro programmato", "altro" to "Interruzione")
private fun hm(s: String?) = s?.replace('T', ' ')?.let { "${it.substring(8, 10)}/${it.substring(5, 7)} ${it.substring(11)}" } ?: "—"

/** Guasti Enel: outages in the CDA Net zones, and background notifications on this phone. */
@Composable
fun OutagesScreen(c: AppContainer) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
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
        SectionCard("Notifiche sul telefono") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Avvisami dei guasti nelle zone CDA Net", modifier = Modifier.weight(1f))
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
        BusyButton("Aggiorna", busy, Modifier.fillMaxWidth(), primary = false) { scope.launch { load() } }
        if (c.session.isAdmin) ZoneEditor(c) { scope.launch { load() } }
        val d = data ?: return@Column
        Text(d.lastRun?.at?.let { "Ultimo controllo del server: ${it.replace('T', ' ').take(16)} · fonte e-distribuzione" } ?: "Il server non ha ancora controllato", style = MaterialTheme.typography.bodySmall)
        if (d.active.isEmpty()) {
            SectionCard { Text("Nessun guasto né lavoro nelle zone di interesse.") }
        }
        d.active.forEach { o ->
            SectionCard {
                Text(KIND[o.kind] ?: o.cause, fontWeight = FontWeight.SemiBold, color = when (o.kind) { "guasto_mt" -> BadRed; "lavoro" -> MaterialTheme.colorScheme.onSurfaceVariant; else -> WarnAmber })
                Text("${o.place} (${o.province})", style = MaterialTheme.typography.titleMedium)
                o.zones.firstOrNull()?.let { z -> Text("${z.name} a ${if (z.distanceM >= 1000) "%.1f km".format(z.distanceM / 1000.0) else "${z.distanceM} m"}", style = MaterialTheme.typography.bodySmall) }
                if (o.impact.isNotEmpty()) {
                    Text("Potenzialmente impattati:", color = BadRed, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall)
                    o.impact.take(5).forEach { i ->
                        Text("• ${if (i.type == "pop") "POP" else "AP"} ${i.name} a ${i.distanceM} m" + (i.stations?.let { " · $it CPE" } ?: ""), color = BadRed, style = MaterialTheme.typography.bodySmall)
                    }
                }
                Text("${o.customers} clienti Enel · dal ${hm(o.start)} · ripristino previsto ${hm(o.expectedRestore)}", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:${o.lat},${o.lon}?q=${o.lat},${o.lon}"))) }
                }) { Text("Apri sulla mappa") }
            }
        }
    }
}

/** Admin: new area of interest from the phone (GPS with automatic address, address search or typed coordinates). */
@Composable
private fun ZoneEditor(c: AppContainer, onAdded: () -> Unit) {
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var radius by remember { mutableStateOf("2") }
    var lat by remember { mutableStateOf("") }
    var lon by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    SectionCard("Zone di interesse (admin)") {
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
                    c.api.createOutageZone(name.trim(), lat.toDouble(), lon.toDouble(), radius.toDoubleOrNull() ?: 2.0)
                    name = ""; lat = ""; lon = ""; label = ""
                    onAdded()
                    "Zona salvata: entra nel prossimo controllo (entro 10 minuti)."
                }.getOrElse { it.message }
                busy = false
            }
        }
    }
}
