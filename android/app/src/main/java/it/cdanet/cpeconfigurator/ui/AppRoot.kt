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
import it.cdanet.cpeconfigurator.install.InstallMode
import it.cdanet.cpeconfigurator.ui.screens.AcceptanceScreen
import it.cdanet.cpeconfigurator.ui.WifiRequired
import it.cdanet.cpeconfigurator.ui.screens.AlignmentScreen
import it.cdanet.cpeconfigurator.ui.screens.CameraScreen
import it.cdanet.cpeconfigurator.ui.screens.CompassScreen
import it.cdanet.cpeconfigurator.ui.screens.CoverageScreen
import it.cdanet.cpeconfigurator.ui.screens.CpeHealthScreen
import it.cdanet.cpeconfigurator.ui.screens.CpeWebScreen
import it.cdanet.cpeconfigurator.ui.screens.DiagnosisScreen
import it.cdanet.cpeconfigurator.ui.screens.DiscoveryScreen
import it.cdanet.cpeconfigurator.ui.screens.HistoryScreen
import it.cdanet.cpeconfigurator.ui.screens.HomeScreen
import it.cdanet.cpeconfigurator.ui.screens.IpScannerScreen
import it.cdanet.cpeconfigurator.ui.screens.NetDiagScreen
import it.cdanet.cpeconfigurator.ui.screens.ArAimScreen
import it.cdanet.cpeconfigurator.ui.screens.NetworkStatusScreen
import it.cdanet.cpeconfigurator.ui.screens.PointingScreen
import it.cdanet.cpeconfigurator.ui.screens.OutagesScreen
import it.cdanet.cpeconfigurator.ui.screens.PortScannerScreen
import it.cdanet.cpeconfigurator.ui.screens.LoginScreen
import it.cdanet.cpeconfigurator.ui.screens.NetworkScreen
import it.cdanet.cpeconfigurator.ui.screens.InstallScreen
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
    Provision("Installazione CPE"),
    CpeWeb("Primo avvio airOS", scroll = false),
    Wifi("Wi-Fi Analyzer"),
    Network("Strumenti di rete"),
    Discovery("Discovery LAN"),
    Coverage("Copertura AP"),
    Alignment("Puntamento antenna"),
    Diagnosis("Diagnosi CPE"),
    Acceptance("Collaudo installazione"),
    Compass("Bussola verso l'AP"),
    Pointing("Trova l'AP", scroll = false),
    ArAim("Mirino verso l'AP", scroll = false),
    CpeHealth("Le mie CPE"),
    IpScanner("Scanner IP"),
    PortScanner("Port scanner"),
    NetDiag("Diagnostica di rete"),
    Outages("Guasti Enel"),
    NetStatus("Stato rete"),
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
    // AR sight opened from the guided installation: it also shows the live CPE signal
    var arWithSignal by remember { mutableStateOf(false) }
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
            // Features enabled by the admin: hidden screens and buttons follow this map.
            launch { runCatching { c.api.meta() }.onSuccess { c.modules.value = it.modules } }
            c.resultQueue.syncInBackground()
            c.acceptanceQueue.syncInBackground()
            scope.launch { c.routerOs.refreshCatalog() }
            // Field work often starts offline: retry the queues every 2 minutes while logged in
            // (child of this effect: cancelled on logout or when the session changes).
            launch {
                while (true) {
                    kotlinx.coroutines.delay(120_000)
                    if (c.resultQueue.pending.value.isNotEmpty()) runCatching { c.resultQueue.sync() }
                    if (c.acceptanceQueue.pending.value.isNotEmpty()) runCatching { c.acceptanceQueue.sync() }
                }
            }
            // CPE credentials for alignment/diagnosis, so they also work later without Internet.
            scope.launch { if (listOf("field_alignment", "field_diagnosis", "acceptance").any { c.moduleOn(it) }) c.field.prefetch() }
        } else {
            c.field.forget()
        }
    }

    if (session == null && !offline) {
        LoginScreen(c, update = update, onUpdate = { update = it }, onOffline = { offline = true })
        return
    }

    BackHandler(enabled = stack.size > 1) { back() }
    QuickLoginOffer(c)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (screen == Screen.CpeHealth && session?.user?.role == "admin") "Salute CPE" else screen.title) },
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
                    Screen.Provision -> InstallScreen(
                        c,
                        onOpenCpeWeb = { go(Screen.CpeWeb) },
                        onLogin = { offline = false },
                        onAim = { t -> c.compassTarget.value = t; arWithSignal = true; go(Screen.ArAim) },
                        onCompass = { t -> c.compassTarget.value = t; go(Screen.Compass) },
                        onPointing = { go(Screen.Pointing) },
                        onAlignment = { go(Screen.Alignment) },
                        onAcceptance = { go(Screen.Acceptance) },
                    )
                    Screen.CpeWeb -> WifiRequired(c, "alla Wi-Fi di management della CPE", "Il primo avvio si fa sull'interfaccia web della CPE, raggiungibile solo in rete locale.") { CpeWebScreen(c) }
                    Screen.Wifi -> WifiScreen(c)
                    Screen.Network -> NetworkScreen(c)
                    Screen.Discovery -> WifiRequired(c, "alla Wi-Fi della rete locale da analizzare", "La discovery funziona solo sulla stessa LAN.") { DiscoveryScreen(c) }
                    Screen.Coverage -> CoverageScreen(
                        c,
                        onCompass = if (c.moduleOn("compass")) ({ t: it.cdanet.cpeconfigurator.field.CompassTarget -> c.compassTarget.value = t; go(Screen.Compass) }) else null,
                    )
                    Screen.Alignment -> WifiRequired(c, "alla Wi-Fi della CPE (management, es. \"LBE-5AC-Gen2:xxxx\") oppure a quella del router del cliente", "Il segnale si legge direttamente dalla CPE.") { AlignmentScreen(c) }
                    Screen.Diagnosis -> WifiRequired(c, "alla Wi-Fi della CPE (management, es. \"LBE-5AC-Gen2:xxxx\") oppure a quella del router del cliente", "La diagnosi interroga la CPE in rete locale.") { DiagnosisScreen(c) }
                    Screen.Acceptance -> AcceptanceScreen(c)
                    Screen.Compass -> CompassScreen(c)
                    Screen.Pointing -> PointingScreen(
                        c,
                        onAim = { t -> c.compassTarget.value = t; arWithSignal = false; go(Screen.ArAim) },
                        onCompass = { t -> c.compassTarget.value = t; go(Screen.Compass) },
                    )
                    Screen.ArAim -> ArAimScreen(c, liveSignal = arWithSignal)
                    Screen.CpeHealth -> CpeHealthScreen(
                        c,
                        onRepoint = if (c.moduleOn("field_alignment")) ({ c.install.start(InstallMode.Repoint); go(Screen.Provision) }) else null,
                    )
                    Screen.IpScanner -> WifiRequired(c, "alla Wi-Fi della rete locale da analizzare", "Lo scanner esamina la subnet della Wi-Fi collegata.") { IpScannerScreen(c, onPortScan = { c.portScanTarget.value = it; go(Screen.PortScanner) }) }
                    Screen.PortScanner -> WifiRequired(c, "alla Wi-Fi della rete locale da analizzare", "Le porte di host privati si verificano dalla stessa rete locale.") { PortScannerScreen(c) }
                    Screen.NetDiag -> NetDiagScreen(c)
                    Screen.Outages -> OutagesScreen(c)
                    Screen.NetStatus -> NetworkStatusScreen(c)
                    Screen.Snmp -> WifiRequired(c, "alla Wi-Fi della rete locale da analizzare", "Gli apparati SNMP si interrogano in rete locale.") { SnmpScreen(c) }
                    Screen.Camera -> WifiRequired(c, "alla Wi-Fi della rete delle telecamere", "ONVIF, SADP e RTSP funzionano sulla rete locale.") { CameraScreen(c) }
                    Screen.Remote -> RemoteScreen(c)
                    Screen.RouterOs -> WifiRequired(c, "alla Wi-Fi della rete del MikroTik", "La consultazione avviene in SSH verso il router in rete locale.") { RouterOsScreen(c) }
                    Screen.History -> HistoryScreen(
                        c,
                        onAcceptance = { c.selectedJob.value = it; go(Screen.Acceptance) },
                        onReplace = { c.provisioning.startReplacement(it); go(Screen.Provision) },
                    )
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
