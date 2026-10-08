package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.provisioning.Phase
import it.cdanet.cpeconfigurator.ui.Banner
import it.cdanet.cpeconfigurator.ui.Screen
import it.cdanet.cpeconfigurator.ui.WarnAmber

private data class Tile(val screen: Screen, val title: String, val subtitle: String, val needsLogin: Boolean = false)

private val TILES = listOf(
    Tile(Screen.Provision, "Provisioning CPE", "airMAX AC · prepara online, applica sulla Wi-Fi della CPE"),
    Tile(Screen.History, "Storico", "I miei provisioning e risultati in attesa di invio", needsLogin = true),
    Tile(Screen.Coverage, "Copertura", "AP più vicini da GPS o indirizzo, con direzione di puntamento", needsLogin = true),
    Tile(Screen.Wifi, "Wi-Fi Analyzer", "Reti, canali e segnale"),
    Tile(Screen.Network, "Strumenti di rete", "Connessione, ping, traceroute, DNS, speed test"),
    Tile(Screen.Discovery, "Discovery LAN", "Scansione subnet, ARP, porte, NetBIOS"),
    Tile(Screen.Snmp, "SNMP v2c", "Interroga apparati in LAN"),
    Tile(Screen.Camera, "TVCC", "ONVIF, Hikvision SADP, RTSP, calcolo banda"),
    Tile(Screen.RouterOs, "MikroTik · RouterOS", "Consultazione in sola lettura via SSH"),
    Tile(Screen.Remote, "Accesso remoto", "SSH e Remote Desktop con app esterne"),
)

@Composable
fun HomeScreen(c: AppContainer, offline: Boolean, onNavigate: (Screen) -> Unit, onLogin: () -> Unit) {
    val session by c.session.state.collectAsState()
    val pending by c.resultQueue.pending.collectAsState()
    val prov by c.provisioning.state.collectAsState()

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (offline) {
            Banner("Modalità offline: solo strumenti locali.", WarnAmber)
            TextButton(onClick = onLogin) { Text("Accedi al server") }
        } else {
            session?.let { Text("Ciao ${it.user.username}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(vertical = 6.dp)) }
        }
        if (prov.pkg != null && prov.phase != Phase.Done) {
            Banner("Provisioning preparato per ${prov.pkg?.summary?.deviceName}: apri Provisioning CPE per completarlo.", WarnAmber)
        }
        if (pending.isNotEmpty()) {
            Banner("${pending.size} esiti in attesa di invio al server (verranno inviati quando torni online e connesso).", WarnAmber)
        }
        TILES.filter { !it.needsLogin || !offline }.forEach { t ->
            Card(
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).clickable { onNavigate(t.screen) },
                colors = CardDefaults.cardColors(
                    containerColor = if (t.screen == Screen.Provision) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
                ),
            ) {
                Row(Modifier.padding(16.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(t.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(t.subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}
