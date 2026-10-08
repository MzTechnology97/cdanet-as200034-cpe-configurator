package it.cdanet.cpeconfigurator.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.ui.screens.AcceptanceScreen
import it.cdanet.cpeconfigurator.ui.screens.AlignmentScreen
import it.cdanet.cpeconfigurator.ui.screens.CameraScreen
import it.cdanet.cpeconfigurator.ui.screens.CoverageScreen
import it.cdanet.cpeconfigurator.ui.screens.CpeWebScreen
import it.cdanet.cpeconfigurator.ui.screens.DiagnosisScreen
import it.cdanet.cpeconfigurator.ui.screens.DiscoveryScreen
import it.cdanet.cpeconfigurator.ui.screens.HistoryScreen
import it.cdanet.cpeconfigurator.ui.screens.HomeScreen
import it.cdanet.cpeconfigurator.ui.screens.LoginScreen
import it.cdanet.cpeconfigurator.ui.screens.NetworkScreen
import it.cdanet.cpeconfigurator.ui.screens.ProvisionScreen
import it.cdanet.cpeconfigurator.ui.screens.RemoteScreen
import it.cdanet.cpeconfigurator.ui.screens.RouterOsScreen
import it.cdanet.cpeconfigurator.ui.screens.SettingsScreen
import it.cdanet.cpeconfigurator.ui.screens.SnmpScreen
import it.cdanet.cpeconfigurator.ui.screens.UpdateBanner
import it.cdanet.cpeconfigurator.ui.screens.WifiScreen
import it.cdanet.cpeconfigurator.update.UpdateState
import kotlinx.coroutines.launch

enum class Screen(val title: String, val scroll: Boolean = true) {
    Home("CDA Net CPE"),
    Provision("Provisioning CPE"),
    CpeWeb("Primo avvio airOS", scroll = false),
    Wifi("Wi-Fi Analyzer"),
    Network("Strumenti di rete"),
    Discovery("Discovery LAN"),
    Coverage("Copertura AP"),
    Alignment("Puntamento antenna"),
    Diagnosis("Diagnosi CPE"),
    Acceptance("Collaudo installazione"),
    Snmp("SNMP"),
    Camera("TVCC / IP camera"),
    Remote("Accesso remoto"),
    RouterOs("MikroTik · RouterOS"),
    History("Storico provisioning"),
    Settings("Impostazioni"),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRoot(c: AppContainer) {
    val session by c.session.state.collectAsState()
    var offline by remember { mutableStateOf(false) }
    var stack by remember { mutableStateOf(listOf(Screen.Home)) }
    var update by remember { mutableStateOf<UpdateState>(UpdateState.Idle) }
    val scope = rememberCoroutineScope()
    val screen = stack.last()

    fun go(s: Screen) {
        stack = stack + s
    }
    fun back() {
        if (stack.size > 1) stack = stack.dropLast(1)
    }

    // Startup: update check (works before login so a broken build can always be replaced).
    LaunchedEffect(Unit) {
        update = UpdateState.Checking
        update = runCatching { c.updater.check() }.fold(
            onSuccess = { info -> if (info != null) UpdateState.Available(info) else UpdateState.UpToDate },
            onFailure = { UpdateState.Idle },
        )
    }
    LaunchedEffect(session) {
        if (session != null) {
            c.resultQueue.syncInBackground()
            scope.launch { c.routerOs.refreshCatalog() }
            // CPE credentials for alignment/diagnosis, so they also work later without Internet.
            scope.launch { c.field.prefetch() }
        } else {
            c.field.forget()
        }
    }

    if (session == null && !offline) {
        LoginScreen(c, update = update, onUpdate = { update = it }, onOffline = { offline = true })
        return
    }

    BackHandler(enabled = stack.size > 1) { back() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(screen.title) },
                navigationIcon = {
                    if (stack.size > 1) {
                        IconButton(onClick = { back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Indietro") }
                    }
                },
                actions = {
                    if (screen != Screen.Settings) {
                        IconButton(onClick = { go(Screen.Settings) }) { Icon(Icons.Filled.Settings, contentDescription = "Impostazioni") }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            val body: @Composable () -> Unit = {
                when (screen) {
                    Screen.Home -> HomeScreen(c, offline = session == null, onNavigate = ::go, onLogin = { offline = false })
                    Screen.Provision -> ProvisionScreen(c, onOpenCpeWeb = { go(Screen.CpeWeb) }, onLogin = { offline = false }, onAcceptance = { go(Screen.Acceptance) })
                    Screen.CpeWeb -> CpeWebScreen(c)
                    Screen.Wifi -> WifiScreen(c)
                    Screen.Network -> NetworkScreen(c)
                    Screen.Discovery -> DiscoveryScreen(c)
                    Screen.Coverage -> CoverageScreen(c)
                    Screen.Alignment -> AlignmentScreen(c)
                    Screen.Diagnosis -> DiagnosisScreen(c)
                    Screen.Acceptance -> AcceptanceScreen(c)
                    Screen.Snmp -> SnmpScreen(c)
                    Screen.Camera -> CameraScreen(c)
                    Screen.Remote -> RemoteScreen(c)
                    Screen.RouterOs -> RouterOsScreen(c)
                    Screen.History -> HistoryScreen(c, onAcceptance = { c.selectedJob.value = it; go(Screen.Acceptance) })
                    Screen.Settings -> SettingsScreen(c, update = update, onUpdate = { update = it }, onLogout = {
                        c.session.clear()
                        offline = false
                        stack = listOf(Screen.Home)
                    })
                }
            }
            if (screen.scroll) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 8.dp)) {
                    if (screen == Screen.Home) UpdateBanner(c, update) { update = it }
                    body()
                }
            } else {
                body()
            }
        }
    }
}
