package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.tools.UbntDevice
import it.cdanet.cpeconfigurator.tools.UbntDiscovery
import it.cdanet.cpeconfigurator.ui.Badge
import it.cdanet.cpeconfigurator.ui.Tone
import kotlinx.coroutines.launch

/**
 * Top of «CPE collegata», the same for every tab: the CPE the tools work on, found by the Ubiquiti
 * discovery as the area opens (whatever its IP), or the list to pick from when several answer.
 * «Cerca di nuovo», the web interface and the reboot from here.
 */
@Composable
fun ConnectedCpeBar(c: AppContainer, onOpenWeb: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val selected by c.field.selected.collectAsState()
    val candidates by c.field.candidates.collectAsState()
    val searching by c.field.searching.collectAsState()
    var reboot by remember { mutableStateOf(false) }
    var rebooting by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    // the area opens: the CPE on this Wi-Fi at once (shared with the tools, one search)
    LaunchedEffect(Unit) { if (selected == null && candidates.isEmpty()) runCatching { c.field.discoverCpes() } }

    Column(
        Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large).background(MaterialTheme.colorScheme.surfaceContainerLow).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        val d = selected
        when {
            d != null -> {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${d.product ?: d.model ?: "CPE"} · ${d.ip.orEmpty()}", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    if (d.factoryDefault == true) Badge("di fabbrica", Tone.Warn)
                    d.version?.let { Badge("v$it", if (it == (c.field.targetFirmware ?: "8.7.4")) Tone.Good else Tone.Warn) }
                }
                Text(
                    listOfNotNull(d.hostname, d.mac, d.ssid?.let { "SSID $it" }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            candidates.isNotEmpty() -> {
                Text("Trovate ${candidates.size} CPE: scegli quella da sistemare", style = MaterialTheme.typography.titleSmall)
                candidates.forEach { x -> CandidateRow(x) { c.field.select(x) } }
            }
            searching -> Text("Ricerca della CPE con la discovery…", style = MaterialTheme.typography.titleSmall)
            else -> Text(
                "Nessuna CPE trovata con la discovery: gli strumenti provano gateway, IP LAN e management, oppure usa «IP manuale».",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (searching) LinearProgressIndicator(Modifier.fillMaxWidth())
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            TextButton(enabled = !searching, onClick = {
                note = null
                c.field.forgetSelection()
                scope.launch { runCatching { c.field.discoverCpes() } }
            }) { Text("Cerca di nuovo") }
            d?.webUrl?.let { url -> TextButton(onClick = { onOpenWeb(url) }) { Text("Interfaccia web") } }
            if (d?.mac != null) TextButton(enabled = !rebooting, onClick = { reboot = true }) { Text("Riavvia") }
        }
    }
    val target = selected
    if (reboot && target?.mac != null) {
        RebootDialog(c, target, busy = rebooting, onDismiss = { reboot = false }) { user, pass ->
            scope.launch {
                rebooting = true
                note = try {
                    UbntDiscovery.reboot(c.network, target.mac, user, pass)
                    reboot = false
                    "Riavvio richiesto: la CPE torna raggiungibile in circa un minuto."
                } catch (e: Exception) {
                    e.message ?: e.toString()
                } finally {
                    rebooting = false
                }
            }
        }
    }
}

@Composable
private fun CandidateRow(d: UbntDevice, onPick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).clickable(onClick = onPick).padding(vertical = 6.dp)) {
        Text("${d.product ?: d.model ?: "CPE"} · ${d.ip}", style = MaterialTheme.typography.bodyMedium)
        Text(
            listOfNotNull(d.hostname, d.mac, d.version?.let { "v$it" }, d.ssid?.let { "SSID $it" }).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
