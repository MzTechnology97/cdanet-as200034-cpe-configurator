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
import it.cdanet.cpeconfigurator.network.NetworkHelper.CpeWifi as S

/** Android's Wi-Fi popup (quick panel, API 29+) or the Wi-Fi settings on older versions. */
fun wifiPanelIntent(): Intent =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Intent(Settings.Panel.ACTION_WIFI) else Intent(Settings.ACTION_WIFI_SETTINGS)

/**
 * Shows [content] only while the phone is on a local network: a Wi-Fi or a cable through a USB-C
 * Ethernet adapter (not mobile data). Otherwise it explains which network is needed and opens
 * Android's Wi-Fi popup (once automatically, then with the button). [target] says where to connect,
 * e.g. "alla Wi-Fi di management della CPE".
 */
@Composable
fun WifiRequired(c: AppContainer, target: String, why: String, cpe: Boolean = target.contains("CPE"), content: @Composable () -> Unit) {
    val connected by c.network.localConnected.collectAsState()
    val cpeWifi by c.network.cpeWifi.collectAsState()
    var asked by rememberSaveable { mutableStateOf(false) }
    var info by remember { mutableStateOf(c.network.localLink()) }
    // a cable in, but no address from the other end (a CPE at its factory settings has no DHCP)
    var cableNoAddress by remember { mutableStateOf(c.network.ethernetWithoutAddress()) }
    val panel = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { info = c.network.localLink() }
    // the CPE's Wi-Fi is joined from the app (Android 10+): no automatic trip to the settings
    val joinHere = cpe && c.network.canJoinCpe
    LaunchedEffect(connected, cpeWifi) {
        info = c.network.localLink()
        cableNoAddress = c.network.ethernetWithoutAddress()
        if (!connected && !asked && !joinHere) {
            asked = true
            runCatching { panel.launch(wifiPanelIntent()) }
        }
    }
    if (!connected) {
        SectionCard("Serve la rete locale") {
            Text("Il telefono non è collegato a una Wi-Fi${if (c.network.wifiEnabled) "" else " (Wi-Fi spento)"} né a un cavo: in questo momento usa la rete mobile.", color = WarnAmber, fontWeight = FontWeight.SemiBold)
            Text("Collegati $target. $why", style = MaterialTheme.typography.bodyMedium)
            Text("Va bene anche il cavo: un adattatore USB-C Ethernet collegato alla LAN (porta LAN del PoE della CPE, router del cliente, switch).", style = MaterialTheme.typography.bodySmall)
            if (joinHere) {
                CpeWifiJoin(c, cpeWifi)
                SecondaryButton(onClick = { runCatching { panel.launch(wifiPanelIntent()) } }, modifier = Modifier.fillMaxWidth()) { Text("Altre reti Wi-Fi") }
            } else {
                BusyButton("Collegati al Wi-Fi", false, Modifier.fillMaxWidth()) { runCatching { panel.launch(wifiPanelIntent()) } }
            }
            Text("La schermata si sblocca da sola appena il telefono è sul Wi-Fi o sul cavo.", style = MaterialTheme.typography.bodySmall)
        }
        return
    }
    Column {
        if (cableNoAddress) Text(it.cdanet.cpeconfigurator.network.NetworkHelper.NO_CABLE_ADDRESS, style = MaterialTheme.typography.bodySmall, color = WarnAmber)
        info?.let { l ->
            Text(
                (if (l.isCable) "Cavo Ethernet" else "Wi-Fi: ${l.wifiSsid ?: "rete collegata"}") +
                    " · ${l.addresses.firstOrNull { it.contains('.') }?.substringBefore('/') ?: "senza IPv4"}" +
                    (l.gateway?.let { " · gateway $it" } ?: "") + if (!l.validated) " · senza Internet" else "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (joinHere) CpeWifiJoin(c, cpeWifi, compact = true)
        content()
    }
}

/**
 * «Collegati alla Wi-Fi della CPE»: Android lists the CPE management networks nearby, the installer
 * taps one, and the app uses it for the CPE while the phone stays on Internet with mobile data.
 * [compact]: already on a Wi-Fi, a one-line reminder with the button (or «Scollega»).
 */
@Composable
fun CpeWifiJoin(c: AppContainer, state: S, compact: Boolean = false) {
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { c.network.clearCpeWifiResult() } }
    val message = when (state) {
        S.Searching -> "Scegli la Wi-Fi della CPE nella finestra di Android (es. «LBE-5AC-Gen2:…»)."
        S.NotFound -> if (!c.network.wifiEnabled) "Il Wi-Fi del telefono è spento: accendilo e tocca di nuovo «Collegati alla Wi-Fi della CPE»."
            else "Nessuna Wi-Fi di CPE scelta o trovata: accendi la CPE, avvicinati e riprova, oppure usa «Altre reti Wi-Fi»."
        S.Lost -> "Wi-Fi della CPE persa (la CPE si sta riavviando?): ricollegati quando è di nuovo accesa."
        S.Connected -> "Collegato alla Wi-Fi della CPE dall'app: Internet resta sulla rete mobile."
        S.Idle -> null
    }
    message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (state == S.Connected) GoodGreen else MaterialTheme.colorScheme.onSurfaceVariant) }
    when {
        state == S.Connected -> androidx.compose.material3.TextButton(onClick = { c.network.leaveCpeWifi() }) { Text("Scollega dalla Wi-Fi della CPE") }
        compact -> androidx.compose.material3.TextButton(onClick = { c.network.joinCpeWifi() }, enabled = state != S.Searching) { Text("Collegati alla Wi-Fi della CPE dall'app") }
        else -> BusyButton("Collegati alla Wi-Fi della CPE", state == S.Searching, Modifier.fillMaxWidth()) { c.network.joinCpeWifi() }
    }
}
