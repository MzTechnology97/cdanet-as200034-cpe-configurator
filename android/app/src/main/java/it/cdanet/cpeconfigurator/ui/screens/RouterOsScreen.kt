package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.routeros.RosResult
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.MonoBlock
import it.cdanet.cpeconfigurator.ui.SectionCard
import kotlinx.coroutines.launch

@Composable
fun RouterOsScreen(c: AppContainer) {
    val scope = rememberCoroutineScope()
    var host by remember { mutableStateOf("192.168.88.1") }
    var port by remember { mutableStateOf("22") }
    var user by remember { mutableStateOf("admin") }
    var pass by remember { mutableStateOf("") }
    var command by remember { mutableStateOf("") }
    var viaWifi by remember { mutableStateOf(c.network.wifiNetwork() != null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<RosResult?>(null) }

    fun run(action: String, label: String, cmd: String = "") {
        scope.launch {
            busy = label
            error = null
            try {
                result = c.routerOs.run(host, port.toIntOrNull() ?: 22, user, pass, action, cmd, viaWifi)
            } catch (e: Exception) {
                error = e.message ?: e.toString()
            } finally {
                busy = null
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        SectionCard("Router") {
            Field("Host / IP", host, { host = it.trim() }, keyboardType = KeyboardType.Uri)
            Field("Porta SSH", port, { port = it.filter(Char::isDigit) }, keyboardType = KeyboardType.Number)
            Field("Username", user, { user = it.trim() })
            Field("Password", pass, { pass = it }, password = true, supporting = "Solo in memoria, per questa schermata")
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text("Usa la rete Wi-Fi", modifier = Modifier.weight(1f))
                Switch(checked = viaWifi, onCheckedChange = { viaWifi = it })
            }
            BusyButton("Connetti / Dashboard", busy == "dashboard", Modifier.fillMaxWidth(), enabled = busy == null) { run("dashboard", "dashboard") }
            OutlinedButton(onClick = {
                pass = ""
                result = null
            }) { Text("Dimentica password") }
        }
        SectionCard("Sezioni (sola lettura)") {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                c.routerOs.sections.forEach { s ->
                    AssistChip(onClick = { if (busy == null) run(s.id, s.id) }, label = { Text(s.title) })
                }
            }
            Field("Terminale", command, { command = it }, placeholder = "/interface print detail without-paging")
            BusyButton("Esegui comando", busy == "terminal", Modifier.fillMaxWidth(), enabled = busy == null && command.isNotBlank(), primary = false) {
                run("terminal", "terminal", command)
            }
        }
        result?.let { r ->
            SectionCard("RouterOS ${r.host}") { r.summary.forEach { (k, v) -> KeyValue(k, v) } }
            r.sections.forEach { s ->
                SectionCard(s.title) {
                    Text(s.command, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    MonoBlock(s.output.ifBlank { "Nessun dato" })
                }
            }
        }
    }
}
