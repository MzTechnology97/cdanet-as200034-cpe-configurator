package it.cdanet.cpeconfigurator.ui

import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import it.cdanet.cpeconfigurator.ui.screens.FieldReadiness
import it.cdanet.cpeconfigurator.ui.screens.GpsGate
import it.cdanet.cpeconfigurator.ui.screens.PrivacyScreen
import it.cdanet.cpeconfigurator.ui.screens.ReadinessScreen
import it.cdanet.cpeconfigurator.ui.screens.CpeHub
import it.cdanet.cpeconfigurator.ui.screens.Dest
import it.cdanet.cpeconfigurator.ui.screens.DevicesHub
import it.cdanet.cpeconfigurator.ui.screens.DiagHub
import it.cdanet.cpeconfigurator.ui.screens.InstallationsHub
import it.cdanet.cpeconfigurator.ui.screens.LanHub
import it.cdanet.cpeconfigurator.ui.screens.NetworkHub
import it.cdanet.cpeconfigurator.ui.screens.SearchScreen
import it.cdanet.cpeconfigurator.ui.screens.ToolEntry
import it.cdanet.cpeconfigurator.ui.screens.ToolsList
import it.cdanet.cpeconfigurator.ui.screens.cpeTabTitles
import it.cdanet.cpeconfigurator.ui.screens.installTabTitles
import it.cdanet.cpeconfigurator.ui.screens.networkTabTitles
import it.cdanet.cpeconfigurator.ui.screens.rememberHubTabs
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.ui.screens.screenIcon
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
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
import it.cdanet.cpeconfigurator.ui.screens.NotificationsScreen
import it.cdanet.cpeconfigurator.ui.screens.InstallScreen
import it.cdanet.cpeconfigurator.ui.screens.RemoteScreen
import it.cdanet.cpeconfigurator.ui.screens.RouterOsScreen
import it.cdanet.cpeconfigurator.ui.screens.SettingsScreen
import it.cdanet.cpeconfigurator.ui.screens.SnmpScreen
import it.cdanet.cpeconfigurator.ui.screens.UpdateBanner
import it.cdanet.cpeconfigurator.ui.screens.WifiScreen
import it.cdanet.cpeconfigurator.update.UpdateInfo
import it.cdanet.cpeconfigurator.update.UpdateState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** [wide]: uses up to 1280 dp on tablets (side-by-side panels) instead of the 760 dp reading column. */
enum class Screen(val title: String, val scroll: Boolean = true, val wide: Boolean = false) {
    Home("CDA Net CPE"),
    Provision("Installazione CPE"),
    CpeWeb("Primo avvio airOS", scroll = false),
    Wifi("Wi-Fi Analyzer"),
    Network("Strumenti di rete"),
    Discovery("Discovery LAN"),
    Coverage("Copertura AP"),
    Alignment("Puntamento antenna"),
    Diagnosis("Diagnosi CPE"),
    Acceptance("Collaudo"),
    Compass("Bussola verso l'AP"),
    Pointing("Trova l'AP", scroll = false),
    ArAim("Mirino verso l'AP", scroll = false),
    CpeHealth("Le mie CPE"),
    IpScanner("Scanner IP", scroll = false, wide = true),
    PortScanner("Port scanner"),
    NetDiag("Diagnostica di rete"),
    Outages("Guasti Enel"),
    NetStatus("Stato rete"),
    Snmp("SNMP"),
    Camera("TVCC / IP camera"),
    Remote("Accesso remoto"),
    RouterOs("MikroTik · RouterOS"),
    History("Storico"),
    Notifications("Notifiche"),
    Settings("Impostazioni"),
    Guide("Guida installatore", scroll = false),
    // areas of the bottom bar and their tabbed sections
    Installations("Installazioni", scroll = false),
    NetHub("Rete", scroll = false),
    Tools("Strumenti"),
    CpeHub("CPE collegata", scroll = false),
    Lan("Scansione LAN", scroll = false, wide = true),
    Diag("Diagnostica di rete", scroll = false),
    Devices("Apparati in LAN", scroll = false),
    Search("Cerca"),
}

/** The four areas of the bottom bar. */
private val TOP = listOf(Screen.Home, Screen.Installations, Screen.NetHub, Screen.Tools)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRoot(c: AppContainer) {
    val session by c.session.state.collectAsState()
    var offline by remember { mutableStateOf(false) }
    var stack by remember { mutableStateOf(listOf(Screen.Home)) }
    var update by remember { mutableStateOf<UpdateState>(UpdateState.Idle) }
    // AR sight opened from the guided installation: it also shows the live CPE signal
    var arWithSignal by remember { mutableStateOf(false) }
    // unread notifications (bell in the top bar), refreshed with the queues while logged in
    var unread by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    val screen = stack.last()
    var lastDepth by remember { mutableStateOf(1) }

    val hubTabs = rememberHubTabs()
    val modules by c.modules.collectAsState()

    fun go(s: Screen) {
        stack = stack + s
    }

    /** An area of the bottom bar: Oggi is the root, the others sit right above it. */
    fun top(s: Screen) {
        stack = if (s == Screen.Home) listOf(Screen.Home) else listOf(Screen.Home, s)
    }

    /** Opens a screen, on a given tab for the areas with tabs. */
    fun open(d: Dest) {
        val titles = when (d.screen) {
            Screen.Installations -> installTabTitles(modules, c.session.isAdmin)
            Screen.NetHub -> networkTabTitles(modules)
            Screen.CpeHub -> cpeTabTitles(modules)
            else -> emptyList()
        }
        d.tab?.let { t -> titles.indexOf(t).takeIf { it >= 0 }?.let { hubTabs[d.screen.name] = it } }
        if (d.screen in TOP) top(d.screen) else go(d.screen)
    }
    fun back() {
        if (stack.size > 1) stack = stack.dropLast(1)
    }

    // Update check (before login, so a broken build can always be replaced): at start, every
    // 15 minutes and as soon as the server refuses this version. New versions download by
    // themselves; a mandatory one ("App sempre all'ultima versione") blocks the whole app.
    val required by c.api.updateRequired.collectAsState()
    var mandatory by remember { mutableStateOf<UpdateInfo?>(null) }
    var recheck by remember { mutableStateOf(0) }
    LaunchedEffect(required, recheck) {
        while (true) {
            if (update is UpdateState.Idle) update = UpdateState.Checking
            runCatching { c.updater.check() }
                .onSuccess { info ->
                    mandatory = info?.takeIf { it.mandatory }
                    val working = update is UpdateState.Downloading || update is UpdateState.ReadyToInstall || update is UpdateState.PermissionRequired
                    if (info == null) {
                        if (!working) update = UpdateState.UpToDate
                    } else if (!working && (update as? UpdateState.Available)?.info?.versionCode != info.versionCode) {
                        update = UpdateState.Available(info)
                    }
                }
                .onFailure { if (update is UpdateState.Checking) update = UpdateState.Idle }
            delay(15 * 60_000L)
        }
    }
    LaunchedEffect(update) {
        val u = update
        if (u is UpdateState.Available) startUpdate(c, u.info) { update = it }
    }
    if (mandatory != null || required != null) {
        MandatoryUpdateScreen(c, mandatory, required, update, onState = { update = it }, onRecheck = { recheck++ })
        return
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
                runCatching { c.api.unreadNotifications() }.onSuccess { unread = it }
                while (true) {
                    kotlinx.coroutines.delay(120_000)
                    runCatching { c.api.unreadNotifications() }.onSuccess { unread = it }
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
    LaunchedEffect(session?.user?.id) {
        if (session != null) {
            allowAutoLogin()
            ensureRemembered(c)
        }
    }
    val locked by c.locked.collectAsState()
    if (locked && session != null) {
        LockScreen(c, onLogout = {
            c.locked.value = false
            scope.launch { logoutPhone(c) }
            offline = false
            stack = listOf(Screen.Home)
        })
        return
    }

    // privacy notice: at the first login and whenever it changes (offline: asked next time)
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var privacy by remember { mutableStateOf<it.cdanet.cpeconfigurator.data.PrivacyDto?>(null) }
    var readinessDone by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(session?.user?.id) {
        val s = session ?: return@LaunchedEffect
        privacy = runCatching { c.api.privacy() }.getOrNull()?.takeIf { it.required }
        // alerts of the work orders and of the NOC on this phone, also with the app closed
        if (!it.cdanet.cpeconfigurator.alerts.PhoneAlerts.isEnabled(ctx)) {
            runCatching { c.api.notificationsDeviceToken() }.onSuccess { token ->
                it.cdanet.cpeconfigurator.alerts.PhoneAlerts.enable(ctx, c.api.base().trimEnd('/'), token)
            }
        }
        if (s.user.role == "admin") readinessDone = true
    }
    privacy?.let { p ->
        if (session != null) {
            PrivacyScreen(c, p, onAccepted = { privacy = null }, onLogout = {
                privacy = null
                scope.launch { logoutPhone(c) }
                stack = listOf(Screen.Home)
            })
            return
        }
    }
    if (session != null && !readinessDone && FieldReadiness.missing(ctx)) {
        ReadinessScreen(onContinue = { readinessDone = true })
        return
    }

    BackHandler(enabled = stack.size > 1) { back() }
    QuickLoginOffer(c)

    // wider than tall and at least 600 dp: navigation rail instead of the bottom bar
    val config = androidx.compose.ui.platform.LocalConfiguration.current
    val wide = config.screenWidthDp >= 600 && config.screenWidthDp > config.screenHeightDp
    val areas = listOf(
        Triple(Screen.Home, "Oggi", R.drawable.ic_home to R.drawable.ic_home_filled),
        Triple(Screen.Installations, "Installa", R.drawable.ic_settings_input_antenna to R.drawable.ic_settings_input_antenna_filled),
        Triple(Screen.NetHub, "Rete", R.drawable.ic_hub to R.drawable.ic_hub_filled),
        Triple(Screen.Tools, "Strumenti", R.drawable.ic_handyman to R.drawable.ic_handyman_filled),
    ).filter { (s, _, _) -> session != null || s == Screen.Home || s == Screen.Tools }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (screen == Screen.Home) {
                            Icon(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(48.dp).offset(x = (-6).dp))
                            Spacer(Modifier.width(2.dp))
                            Text("CDA Net", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                        } else {
                            screenIcon(screen)?.let {
                                Box(Modifier.size(34.dp).clip(RoundedCornerShape(11.dp)).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                                    Icon(painterResource(it), contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(20.dp))
                                }
                                Spacer(Modifier.width(12.dp))
                            }
                            val title = if (screen == Screen.CpeHealth && session?.user?.role == "admin") "Salute CPE" else screen.title
                            Text(
                                title,
                                // long titles one step smaller instead of cut ("Collaudo installazione")
                                style = if (title.length > 16) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = {
                    if (stack.size > 1) {
                        IconButton(onClick = { back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Indietro") }
                    }
                },
                actions = {
                    if (session != null && screen != Screen.Search) {
                        IconButton(onClick = { go(Screen.Search) }) { Icon(painterResource(R.drawable.ic_search), contentDescription = "Cerca") }
                    }
                    if (session != null && screen != Screen.Notifications) {
                        IconButton(onClick = { go(Screen.Notifications) }) {
                            BadgedBox(badge = { if (unread > 0) Badge { Text(if (unread > 99) "99+" else "$unread") } }) {
                                Icon(painterResource(R.drawable.ic_notifications), contentDescription = "Notifiche")
                            }
                        }
                    }
                    if (screen != Screen.Settings) {
                        IconButton(onClick = { go(Screen.Settings) }) { Icon(painterResource(R.drawable.ic_settings), contentDescription = "Impostazioni") }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface, scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainer),
            )
        },
        bottomBar = {
            if (screen in TOP && !wide) {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
                    areas.forEach { (s, label, icons) ->
                        NavigationBarItem(
                            selected = screen == s,
                            onClick = { top(s) },
                            icon = { Icon(painterResource(if (screen == s) icons.second else icons.first), contentDescription = null) },
                            label = { Text(label) },
                        )
                    }
                }
            }
        },
    ) { padding ->
        Row(Modifier.padding(padding).fillMaxSize()) {
        // landscape and tablets: the four areas on the side, the height stays for the content
        if (screen in TOP && wide) {
            androidx.compose.material3.NavigationRail(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
                Spacer(Modifier.weight(1f))
                areas.forEach { (s, label, icons) ->
                    androidx.compose.material3.NavigationRailItem(
                        selected = screen == s,
                        onClick = { top(s) },
                        icon = { Icon(painterResource(if (screen == s) icons.second else icons.first), contentDescription = null) },
                        label = { Text(label) },
                    )
                }
                Spacer(Modifier.weight(1f))
            }
        }
        Box(Modifier.weight(1f).fillMaxHeight()) {
            val body: @Composable () -> Unit = {
                when (screen) {
                    Screen.Home -> HomeScreen(c, offline = session == null, unread = unread, onOpen = ::open, onLogin = { offline = false })
                    Screen.Installations -> InstallationsHub(
                        c,
                        hubTabs[screen.name],
                        { hubTabs[screen.name] = it },
                        onResume = { go(Screen.Provision) },
                        onAcceptance = { c.selectedJob.value = it; go(Screen.Acceptance) },
                        onReplace = { c.provisioning.startReplacement(it); go(Screen.Provision) },
                        onRepoint = if (c.moduleOn("field_alignment")) ({ c.install.start(InstallMode.Repoint); go(Screen.Provision) }) else null,
                    )
                    Screen.NetHub -> NetworkHub(
                        c,
                        hubTabs[screen.name],
                        { hubTabs[screen.name] = it },
                        onAim = { t -> c.compassTarget.value = t; arWithSignal = false; go(Screen.ArAim) },
                        onCompass = { t -> c.compassTarget.value = t; go(Screen.Compass) },
                    )
                    Screen.CpeHub -> CpeHub(c, hubTabs[screen.name], { hubTabs[screen.name] = it }, onAcceptance = { c.selectedJob.value = null; go(Screen.Acceptance) })
                    Screen.Lan -> LanHub(c, hubTabs[screen.name], { hubTabs[screen.name] = it }, onPortScan = { c.portScanTarget.value = it; hubTabs[Screen.Lan.name] = 2 })
                    Screen.Diag -> DiagHub(c, hubTabs[screen.name]) { hubTabs[screen.name] = it }
                    Screen.Devices -> DevicesHub(c, hubTabs[screen.name]) { hubTabs[screen.name] = it }
                    Screen.Tools -> ToolsList(toolGroups(modules, offline = session == null, ::go))
                    Screen.Search -> SearchScreen(c, onAcceptance = { c.selectedJob.value = it; go(Screen.Acceptance) })
                    Screen.Provision -> GpsGate {
                        InstallScreen(
                            c,
                            onOpenCpeWeb = { go(Screen.CpeWeb) },
                            onLogin = { offline = false },
                            onAim = { t -> c.compassTarget.value = t; arWithSignal = true; go(Screen.ArAim) },
                            onCompass = { t -> c.compassTarget.value = t; go(Screen.Compass) },
                            onPointing = { go(Screen.Pointing) },
                            onAlignment = { go(Screen.Alignment) },
                            onAcceptance = { go(Screen.Acceptance) },
                        )
                    }
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
                    Screen.Acceptance -> GpsGate { AcceptanceScreen(c) }
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
                    Screen.Notifications -> NotificationsScreen(c, onUnread = { unread = it })
                    // the installer guide of the server (/wiki/): its links outside the guide open in the browser
                    Screen.Guide -> ServerPage(c, "/wiki/", "Guida", modifier = Modifier.fillMaxSize(), insidePrefix = "/wiki/", document = true)
                    Screen.Settings -> SettingsScreen(c, update = update, onUpdate = { update = it }, onLogout = {
                        // "Esci" really signs out: the phone forgets its key, next time the password is needed
                        scope.launch { logoutPhone(c) }
                        offline = false
                        stack = listOf(Screen.Home)
                    })
                }
            }
            // each new screen slides in (forward) or back; only one screen is ever composed, so
            // field polling, camera and WebViews never run twice during the animation
            key(screen, stack.size) {
                ScreenEnter(forward = stack.size >= lastDepth) {
                    // drag down to reload (not where the gesture belongs to the camera, the compass or a page)
                    val pullable = screen !in setOf(Screen.ArAim, Screen.Compass, Screen.CpeWeb, Screen.Guide)
                    var refreshing by remember { mutableStateOf(false) }
                    androidx.compose.material3.pulltorefresh.PullToRefreshBox(
                        isRefreshing = refreshing,
                        onRefresh = {
                            if (pullable) {
                                refreshing = true
                                c.refresh.value++
                                scope.launch {
                                    delay(800)
                                    refreshing = false
                                }
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        // wide screens (tablet, landscape): a readable column in the middle
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                            Box(Modifier.widthIn(max = if (screen.wide) 1280.dp else 760.dp).fillMaxSize()) {
                                if (screen.scroll) {
                                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
                                        if (screen == Screen.Home) UpdateBanner(c, update) { update = it }
                                        body()
                                    }
                                } else {
                                    body()
                                }
                            }
                        }
                    }
                }
            }
            SideEffect { lastDepth = stack.size }
        }
        }
    }
}

@Composable
private fun ScreenEnter(forward: Boolean, content: @Composable () -> Unit) {
    val p = remember { Animatable(0f) }
    val direction = remember { if (forward) 1 else -1 }
    LaunchedEffect(Unit) { p.animateTo(1f, tween(280, easing = FastOutSlowInEasing)) }
    Box(
        Modifier.fillMaxSize().graphicsLayer {
            alpha = 0.35f + 0.65f * p.value
            translationX = (1f - p.value) * direction * 36.dp.toPx()
        },
    ) { content() }
}

/** The tools area: fewer, grouped entries (scansione LAN, diagnostica and apparati merge the old ones). */
private fun toolGroups(m: Map<String, Boolean>, offline: Boolean, go: (Screen) -> Unit): List<Pair<String, List<ToolEntry>>> {
    val net = m["network_tools"] != false
    val cpe = !offline && cpeTabTitles(m).isNotEmpty()
    return listOf(
        "Con la CPE" to listOfNotNull(
            if (cpe) ToolEntry("CPE collegata", "Diagnosi, puntamento, AP visibili e collaudo con un solo collegamento", R.drawable.ic_cell_tower) { go(Screen.CpeHub) } else null,
        ),
        "Rete del cliente" to listOfNotNull(
            if (net) ToolEntry("Scansione LAN", "Host attivi, discovery Ubiquiti/NetBIOS/SNMP/ARP, porte", R.drawable.ic_radar) { go(Screen.Lan) } else null,
            if (net) ToolEntry("Wi-Fi Analyzer", "Reti, canali e consiglio per il router del cliente", R.drawable.ic_wifi_find) { go(Screen.Wifi) } else null,
            if (net) ToolEntry("Diagnostica di rete", "Ping, traceroute, DNS, speed test, MTU, HTTP, Wake-on-LAN", R.drawable.ic_speed) { go(Screen.Diag) } else null,
            if (net) ToolEntry("Apparati in LAN", "SNMP e telecamere (ONVIF, Hikvision, RTSP)", R.drawable.ic_memory) { go(Screen.Devices) } else null,
            if (m["routeros"] != false) ToolEntry("MikroTik · RouterOS", "Consultazione in sola lettura via SSH", R.drawable.ic_router) { go(Screen.RouterOs) } else null,
            if (net) ToolEntry("Accesso remoto", "SSH e Remote Desktop con app esterne", R.drawable.ic_terminal) { go(Screen.Remote) } else null,
        ),
        "Aiuto" to listOfNotNull(
            if (!offline) ToolEntry("Guida", "Installazione passo per passo e tutti gli strumenti", R.drawable.ic_menu_book) { go(Screen.Guide) } else null,
        ),
    )
}
