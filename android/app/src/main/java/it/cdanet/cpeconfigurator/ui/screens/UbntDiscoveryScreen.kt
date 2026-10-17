package it.cdanet.cpeconfigurator.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.tools.UbntDevice
import it.cdanet.cpeconfigurator.tools.UbntDiscovery
import it.cdanet.cpeconfigurator.ui.Badge
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.Tone
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

private enum class UbntSort(val label: String) { Ip("IP"), Name("Nome"), Product("Prodotto") }

/** "*" and "?" as in the original tool, otherwise a plain substring, on every text of the device. */
internal fun ubntMatches(d: UbntDevice, query: String): Boolean {
    val q = query.trim()
    if (q.isEmpty()) return true
    val hay = listOfNotNull(d.ip, d.mac, d.hostname, d.product, d.model, d.fullModel, d.version, d.ssid, d.serial).joinToString(" ")
    if ('*' in q || '?' in q) {
        val rx = Regex(q.split('*').joinToString(".*") { part -> part.split('?').joinToString(".") { Regex.escape(it) } }, RegexOption.IGNORE_CASE)
        return hay.split(' ').any { rx.matches(it) } || rx.containsMatchIn(hay)
    }
    return hay.contains(q, ignoreCase = true)
}

private fun uptimeText(s: Long?): String? = s?.takeIf { it > 0 }?.let {
    val d = it / 86_400
    val h = (it % 86_400) / 3600
    val m = (it % 3600) / 60
    if (d > 0) "${d}g ${h}h ${m}m" else "${h}h ${m}m"
}

private fun modeText(d: UbntDevice) = when (d.wirelessMode) {
    "station" -> "Station"
    "ap" -> "Access Point"
    "repeater" -> "Ripetitore"
    null -> null
    else -> d.wirelessMode
}

private fun copy(context: Context, text: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("Ubiquiti", text))
}

/**
 * Ubiquiti discovery as the Discovery Utility on the PC: airOS and UniFi devices on the LAN of the
 * Wi-Fi the phone is on (a scan of 10 seconds, devices appear as they answer), with search, order,
 * details, web interface and reboot. The LAN only: the discovery does not cross routers.
 */
@Composable
fun UbntDiscoveryScreen(c: AppContainer, onOpenWeb: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var devices by remember { mutableStateOf<List<UbntDevice>>(emptyList()) }
    var scanning by remember { mutableStateOf(false) }
    var scanned by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var sort by remember { mutableStateOf(UbntSort.Ip) }
    var selected by remember { mutableStateOf<UbntDevice?>(null) }
    var job by remember { mutableStateOf<Job?>(null) }

    fun scan() {
        job?.cancel()
        job = scope.launch {
            scanning = true
            error = null
            devices = emptyList()
            try {
                devices = UbntDiscovery.discover(c.network, 10_000) { devices = it }
            } catch (e: Exception) {
                if (e !is kotlinx.coroutines.CancellationException) error = e.message ?: e.toString()
            } finally {
                scanning = false
                scanned = true
            }
        }
    }
    LaunchedEffect(Unit) { scan() }

    val shown = devices.filter { ubntMatches(it, query) }.let { list ->
        when (sort) {
            UbntSort.Ip -> list
            UbntSort.Name -> list.sortedBy { (it.hostname ?: "~").lowercase() }
            UbntSort.Product -> list.sortedBy { (it.product ?: "~").lowercase() }
        }
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                if (scanning) "Ricerca in corso… ${devices.size} trovati" else "${devices.size} apparati Ubiquiti",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
            )
            BusyButton(if (scanning) "Ferma" else "Cerca di nuovo", busy = false, primary = !scanning) {
                if (scanning) job?.cancel() else scan()
            }
        }
        if (scanning) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorBanner(error) { error = null }
        Field("Cerca (IP, MAC, nome, modello; * e ? ammessi)", query, { query = it }, leadingIcon = R.drawable.ic_search)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Ordina:", style = MaterialTheme.typography.bodySmall)
            UbntSort.entries.forEach { s ->
                TextButton(onClick = { sort = s }) {
                    Text(s.label, fontWeight = if (s == sort) FontWeight.Bold else FontWeight.Normal)
                }
            }
        }
        if (scanned && !scanning && devices.isEmpty() && error == null) {
            EmptyState(R.drawable.ic_radar, "Nessun apparato Ubiquiti", "La discovery non attraversa i router: collegati alla Wi-Fi della CPE o della LAN dove sono gli apparati.")
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(shown, key = { it.mac ?: it.ip ?: it.hashCode().toString() }) { d ->
                SectionCard(modifier = Modifier.clickable { selected = d }) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(d.product ?: d.model ?: "Ubiquiti", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                        if (d.factoryDefault == true) Badge("di fabbrica", Tone.Warn)
                        if (d.unifi) Badge("UniFi", Tone.Info)
                        modeText(d)?.let { Badge(it) }
                    }
                    Text(listOfNotNull(d.ip, d.hostname).joinToString(" · "), style = MaterialTheme.typography.bodyMedium)
                    Text(
                        listOfNotNull(d.mac, d.version?.let { "v$it" }, d.ssid?.let { "SSID $it" }, uptimeText(d.uptimeSec)?.let { "attivo da $it" }).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
    selected?.let { d -> UbntDetails(c, d, onDismiss = { selected = null }, onOpenWeb = onOpenWeb) }
}

@Composable
private fun UbntDetails(c: AppContainer, d: UbntDevice, onDismiss: () -> Unit, onOpenWeb: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var rebooting by remember { mutableStateOf(false) }
    var askReboot by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<Pair<String, NoticeKind>?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(d.product ?: d.model ?: "Apparato Ubiquiti") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                d.hostname?.let { KeyValue("Nome", it) }
                d.ip?.let { KeyValue("IP", it) }
                d.mac?.let { KeyValue("MAC", it) }
                if (d.addresses.size > 1) d.addresses.forEach { (m, ip) -> KeyValue("Interfaccia", "$ip · $m") }
                d.version?.let { KeyValue("Firmware", "$it${d.build?.let { b -> " (build $b)" }.orEmpty()}") }
                d.firmware?.let { KeyValue("Versione completa", it) }
                modeText(d)?.let { KeyValue("Modalità wireless", it) }
                d.ssid?.let { KeyValue("SSID", it) }
                uptimeText(d.uptimeSec)?.let { KeyValue("Attivo da", it) }
                d.serial?.let { KeyValue("Seriale", it) }
                d.webPort?.let { KeyValue("Interfaccia web", "${if (d.webHttps) "HTTPS" else "HTTP"} porta $it") }
                d.sshPort?.let { KeyValue("SSH", "porta $it") }
                d.factoryDefault?.let { KeyValue("Configurazione", if (it) "di fabbrica" else "configurato") }
                d.rescueIpv6?.let { KeyValue("IPv6 di emergenza", it) }
                message?.let { (t, k) -> Notice(t, k) }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    d.webUrl?.let { url -> TextButton(onClick = { onDismiss(); onOpenWeb(url) }) { Text("Interfaccia web") } }
                    TextButton(onClick = {
                        copy(context, listOfNotNull(d.product, d.hostname, d.ip, d.mac, d.firmware).joinToString(" · "))
                        message = "Copiato negli appunti" to NoticeKind.Good
                    }) { Text("Copia") }
                    if (d.mac != null) TextButton(onClick = { askReboot = true }, enabled = !rebooting) { Text("Riavvia") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Chiudi") } },
    )
    if (askReboot && d.mac != null) {
        RebootDialog(c, d, busy = rebooting, onDismiss = { askReboot = false }) { user, pass ->
            scope.launch {
                rebooting = true
                message = try {
                    UbntDiscovery.reboot(c.network, d.mac, user, pass)
                    askReboot = false
                    "Riavvio richiesto: se le credenziali sono giuste l'apparato sparisce e torna in circa un minuto." to NoticeKind.Info
                } catch (e: Exception) {
                    (e.message ?: e.toString()) to NoticeKind.Bad
                } finally {
                    rebooting = false
                }
            }
        }
    }
}

/**
 * Reboot through the discovery (challenge/response, the password never travels): the CDA Net
 * credentials of the CPEs by default (from the server, kept on the phone), or others typed here.
 */
@Composable
internal fun RebootDialog(c: AppContainer, d: UbntDevice, busy: Boolean, onDismiss: () -> Unit, onConfirm: (String, String) -> Unit) {
    var saved by remember { mutableStateOf<it.cdanet.cpeconfigurator.data.CredentialsDto?>(null) }
    // CDA Net's CPE credentials: not for a specialist without «visibilità piena» (issue #275)
    LaunchedEffect(Unit) { if (c.session.state.value != null && c.session.doesCdaWork && c.field.prefetch()) saved = c.field.savedCredentials() }
    var useSaved by remember { mutableStateOf(true) }
    var user by remember { mutableStateOf("ubnt") }
    var pass by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Riavviare ${d.hostname ?: d.ip ?: "l'apparato"}?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("L'apparato si riavvia e resta irraggiungibile per circa un minuto. Il cliente perde la connessione nel frattempo.")
                if (saved != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.Checkbox(checked = useSaved, onCheckedChange = { useSaved = it })
                        Text("Credenziali CDA Net delle CPE")
                    }
                }
                if (saved == null || !useSaved) {
                    Field("Utente", user, { user = it })
                    Field("Password", pass, { pass = it }, password = true)
                }
            }
        },
        confirmButton = {
            BusyButton("Riavvia", busy, enabled = (saved != null && useSaved) || (user.isNotBlank() && pass.isNotEmpty())) {
                val s = saved
                if (s != null && useSaved) onConfirm(s.username, s.password) else onConfirm(user.trim(), pass)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Annulla") } },
    )
}
