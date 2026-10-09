package it.cdanet.cpeconfigurator.ui

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import it.cdanet.cpeconfigurator.core.AppContainer

/** Android's Wi-Fi popup (quick panel, API 29+) or the Wi-Fi settings on older versions. */
fun wifiPanelIntent(): Intent =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Intent(Settings.Panel.ACTION_WIFI) else Intent(Settings.ACTION_WIFI_SETTINGS)

/**
 * Shows [content] only while the phone is really on Wi-Fi (not mobile data). Otherwise it
 * explains which network is needed and opens Android's Wi-Fi popup (once automatically,
 * then with the button). [target] says where to connect, e.g. "alla Wi-Fi di management della CPE".
 */
@Composable
fun WifiRequired(c: AppContainer, target: String, why: String, content: @Composable () -> Unit) {
    val connected by c.network.wifiConnected.collectAsState()
    var asked by rememberSaveable { mutableStateOf(false) }
    var info by remember { mutableStateOf(c.network.wifiLink()) }
    val panel = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { info = c.network.wifiLink() }
    LaunchedEffect(connected) {
        info = c.network.wifiLink()
        if (!connected && !asked) {
            asked = true
            runCatching { panel.launch(wifiPanelIntent()) }
        }
    }
    if (!connected) {
        SectionCard("Serve il Wi-Fi") {
            Text("Il telefono non è collegato a una rete Wi-Fi${if (c.network.wifiEnabled) "" else " (Wi-Fi spento)"}: in questo momento usa la rete mobile.", color = WarnAmber, fontWeight = FontWeight.SemiBold)
            Text("Collegati $target. $why", style = MaterialTheme.typography.bodyMedium)
            BusyButton("Collegati al Wi-Fi", false, Modifier.fillMaxWidth()) { runCatching { panel.launch(wifiPanelIntent()) } }
            Text("La schermata si sblocca da sola appena il telefono è sul Wi-Fi.", style = MaterialTheme.typography.bodySmall)
        }
        return
    }
    Column {
        info?.let { l ->
            Text(
                "Wi-Fi: ${l.wifiSsid ?: "rete collegata"} · ${l.addresses.firstOrNull { it.contains('.') }?.substringBefore('/') ?: ""}" +
                    (l.gateway?.let { " · gateway $it" } ?: "") + if (!l.validated) " · senza Internet" else "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        content()
    }
}
