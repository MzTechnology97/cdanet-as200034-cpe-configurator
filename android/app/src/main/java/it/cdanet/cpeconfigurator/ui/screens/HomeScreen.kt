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

private data class Tile(val screen: Screen, val title: String, val subtitle: String, val needsLogin: Boolean = false, val module: String? = null)

private val TILES = listOf(
    Tile(Screen.Provision, "Provisioning CPE", "airMAX AC · prepara online, applica sulla Wi-Fi della CPE"),
    Tile(Screen.History, "Storico", "I miei provisioning e risultati in attesa di invio", needsLogin = true),
    Tile(Screen.CpeHealth, "Le mie CPE", "Stato delle CPE che ho installato, rispetto al collaudo", needsLogin = true, module = "cpe_health"),
    Tile(Screen.Outages, "Guasti Enel", "Guasti e lavori della rete elettrica nelle tue zone, con notifiche", needsLogin = true, module = "power_outages"),
    Tile(Screen.Alignment, "Puntamento antenna", "Segnale in tempo reale con bip, picco e segnale atteso", needsLogin = true, module = "field_alignment"),
    Tile(Screen.Diagnosis, "Diagnosi CPE", "Guasto: segnale, cavo LAN, PPPoE, firmware, con rapporto per il NOC", needsLogin = true, module = "field_diagnosis"),
    Tile(Screen.Coverage, "Copertura", "AP più vicini da GPS o indirizzo, con direzione di puntamento", needsLogin = true, module = "coverage"),
    Tile(Screen.Wifi, "Wi-Fi Analyzer", "Reti, canali e segnale", module = "network_tools"),
    Tile(Screen.Network, "Strumenti di rete", "Connessione, ping, traceroute, DNS, speed test", module = "network_tools"),
    Tile(Screen.IpScanner, "Scanner IP", "Host attivi, nomi, MAC e produttore, tipo di apparato, porte principali", module = "network_tools"),
    Tile(Screen.PortScanner, "Port scanner", "Preset o intervalli, banner, header HTTP, certificati TLS", module = "network_tools"),
    Tile(Screen.NetDiag, "Diagnostica di rete", "Ping continuo, MTU di percorso, DNS avanzato, HTTP, Wake-on-LAN", module = "network_tools"),
    Tile(Screen.Discovery, "Discovery LAN", "Discovery Ubiquiti, NetBIOS, SNMP, ARP", module = "network_tools"),
    Tile(Screen.Snmp, "SNMP v2c", "Interroga apparati in LAN", module = "network_tools"),
    Tile(Screen.Camera, "TVCC", "ONVIF, Hikvision SADP, RTSP, calcolo banda", module = "network_tools"),
    Tile(Screen.RouterOs, "MikroTik · RouterOS", "Consultazione in sola lettura via SSH", module = "routeros"),
    Tile(Screen.Remote, "Accesso remoto", "SSH e Remote Desktop con app esterne", module = "network_tools"),
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
        val acc by c.acceptanceQueue.pending.collectAsState()
        if (acc.isNotEmpty()) {
            Banner("${acc.size} collaudi in attesa di invio (foto comprese): partiranno appena c'è rete.", WarnAmber)
        }
        if (pending.isNotEmpty()) {
            Banner("${pending.size} esiti in attesa di invio al server (verranno inviati quando torni online e connesso).", WarnAmber)
        }
        val modules by c.modules.collectAsState()
        TILES.filter { (!it.needsLogin || !offline) && (it.module == null || modules[it.module] != false) }.forEach { t ->
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
