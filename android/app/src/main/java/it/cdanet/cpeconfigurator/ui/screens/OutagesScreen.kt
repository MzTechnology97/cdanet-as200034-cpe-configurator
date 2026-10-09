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
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.OutagesDto
import it.cdanet.cpeconfigurator.outages.OutageAlerts
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
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
                Text("${o.customers} clienti Enel · dal ${hm(o.start)} · ripristino previsto ${hm(o.expectedRestore)}", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:${o.lat},${o.lon}?q=${o.lat},${o.lon}"))) }
                }) { Text("Apri sulla mappa") }
            }
        }
    }
}
