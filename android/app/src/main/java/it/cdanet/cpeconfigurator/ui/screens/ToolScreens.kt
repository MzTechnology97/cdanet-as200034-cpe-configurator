package it.cdanet.cpeconfigurator.ui.screens

import it.cdanet.cpeconfigurator.ui.wifiPanelIntent
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.tools.RtspPlayerActivity
import it.cdanet.cpeconfigurator.tools.ToolResult
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.ToolResultView
import kotlinx.coroutines.launch
import it.cdanet.cpeconfigurator.tools.pro.SadpDevice
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.GoodGreen
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.material3.TextButton

/** Holds busy/result/error for one screen and runs tool actions. */
private class Runner {
    var busy by mutableStateOf<String?>(null)
    var title by mutableStateOf("")
    var result by mutableStateOf<ToolResult?>(null)
    var error by mutableStateOf<String?>(null)
}

@Composable
private fun rememberRunner() = remember { Runner() }

@Composable
private fun RunnerOutput(r: Runner) {
    ErrorBanner(r.error) { r.error = null }
    r.result?.let { SectionCard(r.title) { ToolResultView(it) } }
}

@Composable
private fun ToolButton(r: Runner, label: String, primary: Boolean = false, action: suspend () -> ToolResult) {
    val scope = rememberCoroutineScope()
    BusyButton(label, r.busy == label, Modifier.fillMaxWidth(), enabled = r.busy == null, primary = primary) {
        scope.launch {
            r.busy = label
            r.error = null
            try {
                r.result = action()
                r.title = label
            } catch (e: Exception) {
                r.error = "$label: ${e.message ?: e.toString()}"
            } finally {
                r.busy = null
            }
        }
    }
}

/** "Use Wi-Fi" switch: route LAN tools over Wi-Fi even when it has no Internet. */
@Composable
private fun WifiSwitch(value: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text("Usa la rete Wi-Fi", style = MaterialTheme.typography.bodyMedium)
            Text("Necessario se la Wi-Fi non ha Internet e i dati mobili sono attivi", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = value, onCheckedChange = onChange)
    }
}

@Composable
fun WifiScreen(c: AppContainer) {
    val r = rememberRunner()
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!c.network.wifiEnabled) {
            SectionCard("Wi-Fi spento") {
                Text("Per analizzare le reti il Wi-Fi del telefono deve essere acceso (non serve collegarsi).")
                OutlinedButton(onClick = { runCatching { context.startActivity(wifiPanelIntent()) } }) { Text("Accendi il Wi-Fi") }
            }
        }
        SectionCard("Wi-Fi") {
            ToolButton(r, "Scansione reti", primary = true) { c.tools.wifiScan() }
            ToolButton(r, "Connessione attuale") { c.tools.connection() }
        }
        RunnerOutput(r)
    }
}

@Composable
fun NetworkScreen(c: AppContainer) {
    val r = rememberRunner()
    var target by remember { mutableStateOf("1.1.1.1") }
    var cidr by remember { mutableStateOf("192.168.1.0/24") }
    var mac by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionCard("Connessione") {
            ToolButton(r, "Stato connessione", primary = true) { c.tools.connection() }
            ToolButton(r, "Speed test verso server CDA Net") { c.tools.speedTest() }
        }
        SectionCard("Host") {
            Field("Target (IP o nome)", target, { target = it.trim() }, keyboardType = KeyboardType.Uri)
            ToolButton(r, "Ping") { c.tools.ping(target) }
            ToolButton(r, "Traceroute") { c.tools.traceroute(target) }
            ToolButton(r, "DNS lookup") { c.tools.dns(target) }
        }
        SectionCard("Utility") {
            Field("IPv4/CIDR", cidr, { cidr = it.trim() })
            ToolButton(r, "Calcolatrice IP") {
                val x = Ip.parseCidr(cidr)
                ToolResult(
                    rows = listOf(
                        "Rete" to x.toString(),
                        "Netmask" to Ip.format(x.mask),
                        "Broadcast" to Ip.format(x.broadcast),
                        "Primo host" to Ip.format(x.first),
                        "Ultimo host" to Ip.format(x.last),
                        "Indirizzi" to (1L shl (32 - x.prefix)).toString(),
                    ),
                )
            }
            Field("MAC address", mac, { mac = it.trim() })
            ToolButton(r, "MAC vendor (server)") { ToolResult(rows = listOf("MAC" to mac, "Vendor" to c.api.macVendor(mac))) }
        }
        RunnerOutput(r)
    }
}

@Composable
fun DiscoveryScreen(c: AppContainer) {
    val r = rememberRunner()
    var cidr by remember { mutableStateOf(c.tools.suggestedCidr() ?: "192.168.1.0/24") }
    var host by remember { mutableStateOf("") }
    var ports by remember { mutableStateOf("22,80,443,554,8000,8080,8291,20080,20443") }
    var viaWifi by remember { mutableStateOf(c.network.wifiNetwork() != null) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionCard("Subnet") {
            Field("Subnet (max /24)", cidr, { cidr = it.trim() })
            OutlinedButton(onClick = { c.tools.suggestedCidr()?.let { cidr = it } }) { Text("Usa subnet attuale") }
            WifiSwitch(viaWifi) { viaWifi = it }
            ToolButton(r, "Scansiona subnet", primary = true) { c.tools.discover(cidr, viaWifi) }
            ToolButton(r, "Trova apparati Ubiquiti (CPE, AP)") { c.tools.ubntDiscovery() }
            ToolButton(r, "Tabella ARP / neighbor") { c.tools.neighbors() }
        }
        SectionCard("Host") {
            Field("Host", host, { host = it.trim() })
            Field("Porte", ports, { ports = it })
            ToolButton(r, "Verifica porte") { c.tools.portProbe(host, ports.split(',', ' ', ';').mapNotNull { it.trim().toIntOrNull() }.filter { it in 1..65535 }, viaWifi) }
            ToolButton(r, "NetBIOS") { c.tools.netbios(host, viaWifi) }
        }
        RunnerOutput(r)
    }
}

@Composable
fun SnmpScreen(c: AppContainer) {
    val r = rememberRunner()
    var host by remember { mutableStateOf("") }
    var community by remember { mutableStateOf("") }
    var viaWifi by remember { mutableStateOf(c.network.wifiNetwork() != null) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionCard("SNMP v2c") {
            Field("Host", host, { host = it.trim() })
            Field("Community", community, { community = it }, password = true, supporting = "Non viene salvata")
            WifiSwitch(viaWifi) { viaWifi = it }
            ToolButton(r, "Interroga", primary = true) {
                try {
                    c.tools.snmp(host, community, viaWifi)
                } finally {
                    community = ""
                }
            }
        }
        RunnerOutput(r)
    }
}

@Composable
fun CameraScreen(c: AppContainer) {
    val r = rememberRunner()
    val context = LocalContext.current
    var viaWifi by remember { mutableStateOf(c.network.wifiNetwork() != null) }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("554") }
    var path by remember { mutableStateOf("/Streaming/Channels/101") }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var cams by remember { mutableStateOf("8") }
    var bitrate by remember { mutableStateOf("4") }
    var hours by remember { mutableStateOf("24") }
    var days by remember { mutableStateOf("30") }
    var hik by remember { mutableStateOf<List<SadpDevice>?>(null) }
    var hikBusy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // The RTSP player may need the process bound to Wi-Fi; release it when leaving.
    DisposableEffect(Unit) { onDispose { c.network.unbind() } }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionCard("Discovery") {
            WifiSwitch(viaWifi) { viaWifi = it }
            ToolButton(r, "ONVIF WS-Discovery", primary = true) { c.tools.cameraDiscovery(hikvision = false, viaWifi = viaWifi) }
            BusyButton("Hikvision SADP (telecamere, NVR, DVR)", hikBusy, Modifier.fillMaxWidth(), enabled = !hikBusy, primary = false) {
                scope.launch {
                    hikBusy = true
                    runCatching { c.tools.sadp(viaWifi) }.onSuccess { hik = it }.onFailure { r.error = it.message }
                    hikBusy = false
                }
            }
        }
        hik?.let { list ->
            SectionCard("Hikvision SADP: ${list.size} dispositivi") {
                if (list.isEmpty()) Text("Nessuna risposta: verifica di essere sulla stessa rete dei dispositivi (stesso segmento, multicast non filtrato).", style = MaterialTheme.typography.bodySmall)
                val inactive = list.count { it.activated == false }
                if (inactive > 0) Text("$inactive da attivare: impostare la password di amministrazione (es. da interfaccia web o SADP) prima dell'uso.", color = BadRed, style = MaterialTheme.typography.bodySmall)
                list.forEachIndexed { i, d ->
                    if (i > 0) androidx.compose.material3.HorizontalDivider()
                    Text("${d.description.ifBlank { d.model }} · ${d.ip}", fontWeight = FontWeight.SemiBold)
                    Text(
                        when (d.activated) { false -> "NON ATTIVATA"; true -> "attivata"; null -> "stato attivazione sconosciuto" } +
                            (d.hikConnect?.let { if (it) " · Hik-Connect attivo" else "" } ?: ""),
                        color = if (d.activated == false) BadRed else GoodGreen,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        listOf(
                            d.mac,
                            d.serial,
                            d.firmware,
                            "mask ${d.subnetMask} · gw ${d.gateway} · ${when (d.dhcp) { true -> "DHCP"; false -> "IP statico"; null -> "" }}",
                            listOfNotNull(d.httpPort?.let { "HTTP $it" }, d.sdkPort?.let { "SDK $it" }).joinToString(" · "),
                            listOfNotNull(d.analogChannels?.takeIf { it > 0 }?.let { "$it canali analogici" }, d.digitalChannels?.takeIf { it > 0 }?.let { "$it canali IP" }).joinToString(" · "),
                        ).filter { it.isNotBlank() }.joinToString("
"),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Row {
                        TextButton(onClick = {
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("http://${d.ip}${d.httpPort?.takeIf { it != 80 }?.let { ":$it" } ?: ""}/"))) }
                        }) { Text("Interfaccia web") }
                        TextButton(onClick = { host = d.ip; path = "/Streaming/Channels/101" }) { Text("Usa per RTSP") }
                        TextButton(onClick = {
                            scope.launch {
                                r.busy = "porte"
                                r.title = "Porte ${d.ip}"
                                runCatching { c.tools.portProbe(d.ip, listOfNotNull(d.httpPort ?: 80, 443, 554, d.sdkPort ?: 8000).distinct(), viaWifi) }
                                    .onSuccess { r.result = it }.onFailure { r.error = it.message }
                                r.busy = null
                            }
                        }) { Text("Porte") }
                    }
                }
            }
        }
        SectionCard("Telecamera / NVR") {
            Field("IP", host, { host = it.trim() })
            ToolButton(r, "Verifica porte camera") { c.tools.portProbe(host, listOf(80, 443, port.toIntOrNull() ?: 554, 8000, 8080, 8899), viaWifi) }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = path == "/Streaming/Channels/101", onClick = { path = "/Streaming/Channels/101" }, label = { Text("Hik main") })
                FilterChip(selected = path == "/Streaming/Channels/102", onClick = { path = "/Streaming/Channels/102" }, label = { Text("Hik sub") })
                FilterChip(selected = path == "/cam/realmonitor?channel=1&subtype=0", onClick = { path = "/cam/realmonitor?channel=1&subtype=0" }, label = { Text("Dahua") })
            }
            Field("Porta RTSP", port, { port = it.filter(Char::isDigit) }, keyboardType = KeyboardType.Number)
            Field("Percorso RTSP", path, { path = it.trim() })
            Field("Username", user, { user = it })
            Field("Password", pass, { pass = it }, password = true)
            BusyButton("Apri stream RTSP", false, Modifier.fillMaxWidth()) {
                runCatching {
                    val ip = Ip.parse(host)?.let { host } ?: throw IllegalArgumentException("IP non valido")
                    if (viaWifi) c.network.bindToWifi()
                    context.startActivity(RtspPlayerActivity.intent(context, ip, port.toIntOrNull() ?: 554, path, user, pass))
                    pass = ""
                }.onFailure { r.error = it.message }
            }
        }
        SectionCard("Calcolo banda e storage") {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Field("Telecamere", cams, { cams = it.filter(Char::isDigit) }, Modifier.weight(1f), keyboardType = KeyboardType.Number)
                Field("Mbps/cam", bitrate, { bitrate = it }, Modifier.weight(1f), keyboardType = KeyboardType.Decimal)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Field("Ore/giorno", hours, { hours = it.filter(Char::isDigit) }, Modifier.weight(1f), keyboardType = KeyboardType.Number)
                Field("Giorni", days, { days = it.filter(Char::isDigit) }, Modifier.weight(1f), keyboardType = KeyboardType.Number)
            }
            val n = cams.toIntOrNull() ?: 0
            val b = bitrate.replace(',', '.').toDoubleOrNull() ?: 0.0
            val h = (hours.toIntOrNull() ?: 0).coerceIn(0, 24)
            val d = days.toIntOrNull() ?: 0
            val total = n * b
            val gbDay = total * 3600 * h / 8 / 1000
            KeyValue("Banda totale", "%.1f Mbps".format(total))
            KeyValue("Storage al giorno", "%.1f GB".format(gbDay))
            KeyValue("Storage per $d giorni", "%.2f TB".format(gbDay * d / 1000))
        }
        RunnerOutput(r)
    }
}

@Composable
fun RemoteScreen(c: AppContainer) {
    val context = LocalContext.current
    var error by remember { mutableStateOf<String?>(null) }
    var sshHost by remember { mutableStateOf("") }
    var sshPort by remember { mutableStateOf("22") }
    var sshUser by remember { mutableStateOf("") }
    var rdpHost by remember { mutableStateOf("") }
    var rdpPort by remember { mutableStateOf("3389") }
    fun open(uri: String) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
        } catch (_: ActivityNotFoundException) {
            error = "Nessuna app compatibile installata (es. Termius/JuiceSSH per SSH, Microsoft Remote Desktop per RDP)"
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        SectionCard("SSH") {
            Field("Host", sshHost, { sshHost = it.trim() })
            Field("Porta", sshPort, { sshPort = it.filter(Char::isDigit) }, keyboardType = KeyboardType.Number)
            Field("Username", sshUser, { sshUser = it.trim() })
            BusyButton("Apri client SSH", false, Modifier.fillMaxWidth()) {
                val auth = if (sshUser.isBlank()) "" else Uri.encode(sshUser) + "@"
                open("ssh://$auth$sshHost:${sshPort.ifBlank { "22" }}")
            }
        }
        SectionCard("Remote Desktop") {
            Field("Host", rdpHost, { rdpHost = it.trim() })
            Field("Porta", rdpPort, { rdpPort = it.filter(Char::isDigit) }, keyboardType = KeyboardType.Number)
            BusyButton("Apri Remote Desktop", false, Modifier.fillMaxWidth()) { open("rdp://full%20address=s:$rdpHost:${rdpPort.ifBlank { "3389" }}") }
        }
        Text("Le password non vengono passate alle app esterne.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(8.dp))
    }
}
