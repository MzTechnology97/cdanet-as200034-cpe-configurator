package it.cdanet.cpeconfigurator.ui.screens

import androidx.annotation.DrawableRes
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.BuildConfig
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.install.InstallMode
import it.cdanet.cpeconfigurator.provisioning.Phase
import it.cdanet.cpeconfigurator.ui.Area
import it.cdanet.cpeconfigurator.ui.CdaOrange
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.Screen
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Where a Home counter or shortcut leads: a screen and, for areas with tabs, which tab. */
data class Dest(val screen: Screen, val tab: String? = null)

/** Icon of each screen, shown next to the title in the top bar. */
@DrawableRes
fun screenIcon(s: Screen): Int? = when (s) {
    Screen.Home -> null
    Screen.Provision, Screen.CpeWeb, Screen.Installations -> R.drawable.ic_settings_input_antenna
    Screen.Acceptance -> R.drawable.ic_check_circle
    Screen.Compass, Screen.Pointing -> R.drawable.ic_explore
    Screen.ArAim -> R.drawable.ic_my_location
    Screen.Settings -> R.drawable.ic_settings
    Screen.History -> R.drawable.ic_history
    Screen.Notifications -> R.drawable.ic_notifications
    Screen.CpeHealth -> R.drawable.ic_monitor_heart
    Screen.NetStatus, Screen.NetHub -> R.drawable.ic_hub
    Screen.Outages -> R.drawable.ic_power_off
    Screen.Coverage -> R.drawable.ic_map
    Screen.Alignment -> R.drawable.ic_signal_cellular_alt
    Screen.Diagnosis -> R.drawable.ic_troubleshoot
    Screen.Wifi -> R.drawable.ic_wifi_find
    Screen.Network, Screen.Diag -> R.drawable.ic_speed
    Screen.IpScanner, Screen.Lan -> R.drawable.ic_radar
    Screen.PortScanner -> R.drawable.ic_manage_search
    Screen.NetDiag -> R.drawable.ic_query_stats
    Screen.Discovery -> R.drawable.ic_device_hub
    Screen.Snmp, Screen.Devices -> R.drawable.ic_memory
    Screen.Camera -> R.drawable.ic_videocam
    Screen.RouterOs -> R.drawable.ic_router
    Screen.Remote -> R.drawable.ic_terminal
    Screen.Guide -> R.drawable.ic_menu_book
    Screen.Tools -> R.drawable.ic_handyman
    Screen.CpeHub -> R.drawable.ic_cell_tower
    Screen.Search -> R.drawable.ic_search
}

/** Counters of the day (null = not loaded or not available). */
private class Today(val todo: Int?, val outages: Int?, val cpeIssues: Int?)

@Composable
fun HomeScreen(c: AppContainer, offline: Boolean, unread: Int, onOpen: (Dest) -> Unit, onLogin: () -> Unit) {
    val session by c.session.state.collectAsState()
    val pending by c.resultQueue.pending.collectAsState()
    val acc by c.acceptanceQueue.pending.collectAsState()
    val prov by c.provisioning.state.collectAsState()
    val install by c.install.state.collectAsState()
    val modules by c.modules.collectAsState()
    val admin = session?.user?.role == "admin"
    var today by remember { mutableStateOf(Today(null, null, null)) }
    LaunchedEffect(offline, modules) {
        if (offline) return@LaunchedEffect
        val todo = runCatching { toDoItems(c.api.myJobs()).size }.getOrNull()
        today = Today(todo, today.outages, today.cpeIssues)
        val out = if (modules["power_outages"] != false) runCatching { c.api.outages().active.size }.getOrNull() else null
        today = Today(today.todo, out, today.cpeIssues)
        val issues = if (modules["cpe_health"] != false) runCatching { c.api.cpeHealth().totals.let { it.cpes - it.ok } }.getOrNull() else null
        today = Today(today.todo, today.outages, issues)
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(bottom = 12.dp)) {
        var order = 0
        Enter(order++) {
            Hero(
                name = session?.user?.username,
                role = if (admin) "Amministratore" else "Installatore",
                offline = offline,
                resume = install.mode != null || (prov.pkg != null && prov.phase != Phase.Done),
                onNew = { c.activeWorkOrder.value = null; c.provisioning.reset(); c.install.start(InstallMode.New); onOpen(Dest(Screen.Provision)) },
                onRepoint = { c.install.start(InstallMode.Repoint); onOpen(Dest(Screen.Provision)) },
                onResume = { onOpen(Dest(Screen.Provision)) },
                onLogin = onLogin,
            )
        }
        if (acc.isNotEmpty()) Notice("${acc.size} collaudi in attesa di invio (foto comprese): partiranno appena c'è rete.", NoticeKind.Info)
        if (pending.isNotEmpty()) Notice("${pending.size} esiti in attesa di invio al server: partiranno appena torni online.", NoticeKind.Info)

        if (!offline && modules["work_orders"] != false) {
            Enter(order++) { WorkOrdersToday(c, onOpen) }
        }

        if (!offline) {
            Enter(order++) { GroupHeader("Oggi", Area.Work) }
            val counters = buildList {
                add(Counter(today.todo, "da completare", R.drawable.ic_pending_actions, Area.Work, Dest(Screen.Installations, "Da completare")))
                add(Counter(unread, "notifiche da leggere", R.drawable.ic_notifications, Area.Work, Dest(Screen.Notifications)))
                if (modules["power_outages"] != false) add(Counter(today.outages, if (admin) "guasti Enel attivi" else "guasti nelle tue zone", R.drawable.ic_power_off, Area.Network, Dest(Screen.NetHub, "Guasti")))
                if (modules["cpe_health"] != false) add(Counter(today.cpeIssues, "CPE con problemi", R.drawable.ic_monitor_heart, Area.Network, Dest(Screen.Installations, if (admin) "Salute CPE" else "Stato CPE")))
            }
            counters.chunked(2).forEach { pair ->
                Enter(order++) {
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        pair.forEach { k -> CounterTile(k, Modifier.weight(1f).fillMaxHeight()) { onOpen(k.dest) } }
                        if (pair.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }

        val shortcuts = buildList {
            val cpe = cpeTabTitles(modules)
            if (!offline && cpe.isNotEmpty()) add(Shortcut("CPE collegata", "Diagnosi, puntamento, AP visibili, collaudo", R.drawable.ic_cell_tower, Area.Field, Dest(Screen.CpeHub)))
            if (!offline && "Puntamento" in cpe) add(Shortcut("Puntamento", "Segnale in tempo reale con bip", R.drawable.ic_signal_cellular_alt, Area.Field, Dest(Screen.CpeHub, "Puntamento")))
            if (!offline && "AP vicini" in networkTabTitles(modules)) add(Shortcut("AP vicini", "Da qui o da un indirizzo", R.drawable.ic_explore, Area.Network, Dest(Screen.NetHub, "AP vicini")))
            if (modules["network_tools"] != false) add(Shortcut("Scansione LAN", "Apparati nella rete del cliente", R.drawable.ic_radar, Area.Tools, Dest(Screen.Lan)))
            if (!offline) add(Shortcut("Guida", "Installazione passo per passo", R.drawable.ic_menu_book, Area.Help, Dest(Screen.Guide)))
        }
        if (shortcuts.isNotEmpty()) {
            Enter(order++) { GroupHeader("Scorciatoie", Area.Field) }
            shortcuts.chunked(2).forEach { pair ->
                Enter(order++) {
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        pair.forEach { t -> FeatureTile(t.title, t.subtitle, t.icon, t.area, Modifier.weight(1f).fillMaxHeight(), wide = pair.size == 1) { onOpen(t.dest) } }
                    }
                }
            }
        }
        Text(
            "CDA Net CPE ${BuildConfig.VERSION_NAME}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.outline,
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

private class Counter(val value: Int?, val label: String, @DrawableRes val icon: Int, val area: Area, val dest: Dest)

private class Shortcut(val title: String, val subtitle: String, @DrawableRes val icon: Int, val area: Area, val dest: Dest)

/** A big number of the day: tap to open where it comes from. */
@Composable
private fun CounterTile(k: Counter, modifier: Modifier, onClick: () -> Unit) {
    val accent = k.area.accent
    Card(
        onClick = onClick,
        modifier = modifier,
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    k.value?.toString() ?: "–",
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                    color = if ((k.value ?: 0) > 0) accent.content else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Box(Modifier.size(36.dp).clip(RoundedCornerShape(12.dp)).background(accent.container), contentAlignment = Alignment.Center) {
                    Icon(painterResource(k.icon), contentDescription = null, tint = accent.content, modifier = Modifier.size(20.dp))
                }
            }
            Text(k.label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Brand card on top: greeting and the main actions of the day. */
@Composable
private fun Hero(
    name: String?,
    role: String,
    offline: Boolean,
    resume: Boolean,
    onNew: () -> Unit,
    onRepoint: () -> Unit,
    onResume: () -> Unit,
    onLogin: () -> Unit,
) {
    val shape = RoundedCornerShape(28.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Brush.linearGradient(listOf(CdaOrange, Color(0xFFD9431A), Color(0xFF8E2A0C)))),
    ) {
        // the CDA Net symbol, large and faint, as a watermark (does not size the card)
        Box(Modifier.matchParentSize()) {
            Icon(
                painterResource(R.drawable.ic_launcher_foreground),
                contentDescription = null,
                tint = Color.White.copy(alpha = 0.13f),
                modifier = Modifier.size(230.dp).align(Alignment.TopEnd).offset(x = 70.dp, y = (-46).dp),
            )
        }
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(48.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.18f)), contentAlignment = Alignment.Center) {
                    Icon(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, tint = Color.White, modifier = Modifier.size(44.dp))
                }
                Spacer(Modifier.width(14.dp))
                Column {
                    val greeting = remember {
                        when (java.time.LocalTime.now().hour) {
                            in 5..12 -> "Buongiorno"
                            in 13..17 -> "Buon pomeriggio"
                            else -> "Buonasera"
                        }
                    }
                    Text(
                        if (offline) "Solo strumenti locali" else "$greeting · $role",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color.White.copy(alpha = 0.85f),
                    )
                    Text(
                        if (offline) "Modalità offline" else name.orEmpty(),
                        style = MaterialTheme.typography.titleLarge,
                        color = Color.White,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (offline) {
                HeroButton("Accedi al server", R.drawable.ic_person, onLogin, primary = true, modifier = Modifier.fillMaxWidth())
            } else if (resume) {
                Text("Hai un intervento in corso.", style = MaterialTheme.typography.bodyMedium, color = Color.White)
                HeroButton("Riprendi l'intervento", R.drawable.ic_arrow_forward, onResume, primary = true, modifier = Modifier.fillMaxWidth())
            } else {
                Text("Che intervento fai oggi?", style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.9f))
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    HeroButton("Nuova installazione", R.drawable.ic_add_circle, onNew, primary = true, modifier = Modifier.fillMaxWidth())
                    HeroButton("Ripuntamento o cambio AP", R.drawable.ic_my_location, onRepoint, primary = false, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}

@Composable
private fun HeroButton(text: String, @DrawableRes icon: Int, onClick: () -> Unit, primary: Boolean, modifier: Modifier = Modifier) {
    val content: @Composable () -> Unit = {
        Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    if (primary) {
        Button(
            onClick = onClick,
            modifier = modifier.height(48.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Color(0xFFB83A14)),
        ) { content() }
    } else {
        OutlinedButton(
            onClick = onClick,
            modifier = modifier.height(48.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.7f)),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
        ) { content() }
    }
}

@Composable
private fun GroupHeader(title: String, area: Area) {
    Row(Modifier.padding(top = 10.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(area.accent.content))
        Spacer(Modifier.width(8.dp))
        Text(title.uppercase(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun FeatureTile(title: String, subtitle: String, @DrawableRes icon: Int, area: Area, modifier: Modifier, wide: Boolean = false, onClick: () -> Unit) {
    val accent = area.accent
    Card(
        onClick = onClick,
        modifier = modifier,
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp, pressedElevation = 4.dp),
    ) {
        val badge: @Composable () -> Unit = {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(accent.container), contentAlignment = Alignment.Center) {
                Icon(painterResource(icon), contentDescription = null, tint = accent.content, modifier = Modifier.size(24.dp))
            }
        }
        val texts: @Composable () -> Unit = {
            Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (wide) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                badge()
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) { texts() }
                Icon(painterResource(R.drawable.ic_arrow_forward), contentDescription = null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(20.dp))
            }
        } else {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                badge()
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) { texts() }
            }
        }
    }
}

/** Staggered entrance: each block fades in and rises a little, one after the other. */
@Composable
private fun Enter(index: Int, content: @Composable () -> Unit) {
    val p = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        delay(35L * index.coerceAtMost(12))
        p.animateTo(1f, tween(420, easing = FastOutSlowInEasing))
    }
    Box(Modifier.graphicsLayer { alpha = p.value; translationY = (1f - p.value) * 28.dp.toPx() }) { content() }
}

/**
 * The day's work orders from the office: customer, slot, address and the actions of the field
 * (navigate, start with everything filled in, postpone). Hidden when there are none.
 */
@Composable
private fun WorkOrdersToday(c: AppContainer, onOpen: (Dest) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var orders by remember { mutableStateOf<List<it.cdanet.cpeconfigurator.data.WorkOrderDto>?>(null) }
    var postpone by remember { mutableStateOf<it.cdanet.cpeconfigurator.data.WorkOrderDto?>(null) }
    var note by remember { mutableStateOf("") }
    suspend fun load() {
        orders = runCatching { c.api.workOrders().items }.getOrNull()
        // the APs around each address go on the phone now, for the roofs without mobile signal
        val user = c.session.state.value?.user?.id
        if (user != null && c.moduleOn("compass")) {
            val places = orders.orEmpty().filter { it.status != "done" && it.status != "cancelled" && it.lat != null && it.lon != null }
                .map { Triple(it.customer, it.lat!!, it.lon!!) }
            c.scope.launch { c.pointingCache.prefetch(c.api, user, places) }
        }
    }
    LaunchedEffect(c.refresh.collectAsState().value) { load() }
    val list = orders?.filter { it.status != "done" && it.status != "cancelled" } ?: return
    val done = orders?.count { it.status == "done" } ?: 0
    if (list.isEmpty() && done == 0) return
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        GroupHeader(if (list.isEmpty()) "Interventi di oggi · tutti fatti" else "Interventi di oggi · ${list.size} da fare" + if (done > 0) ", $done fatti" else "", Area.Work)
        list.forEach { o ->
            Card(
                shape = MaterialTheme.shapes.large,
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(o.customer, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                listOf(o.slot, o.kindLabel).filter { it.isNotBlank() }.joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        when {
                            o.overdue -> it.cdanet.cpeconfigurator.ui.StatusChip("in ritardo", it.cdanet.cpeconfigurator.ui.NoticeKind.Bad)
                            o.status == "started" -> it.cdanet.cpeconfigurator.ui.StatusChip("in corso", it.cdanet.cpeconfigurator.ui.NoticeKind.Warn)
                            o.status == "postponed" -> it.cdanet.cpeconfigurator.ui.StatusChip("rimandato", it.cdanet.cpeconfigurator.ui.NoticeKind.Warn)
                        }
                    }
                    if (o.address.isNotBlank()) Text(o.address, style = MaterialTheme.typography.bodyMedium)
                    if (o.contact.isNotBlank()) Text("Contatto: ${o.contact}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (o.notes.isNotBlank()) Text(o.notes, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (o.statusNote.isNotBlank()) Text("Nota: ${o.statusNote}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Button(onClick = {
                            // the acceptance test will check the GPS against this order's position
                            c.activeWorkOrder.value = o
                            when (o.kind) {
                                "new" -> {
                                    c.provisioning.startWorkOrder(o)
                                    c.install.start(InstallMode.New)
                                    onOpen(Dest(Screen.Provision))
                                }
                                "survey" -> onOpen(Dest(Screen.NetHub, "AP vicini"))
                                else -> {
                                    c.install.start(InstallMode.Repoint)
                                    onOpen(Dest(Screen.Provision))
                                }
                            }
                            scope.launch { runCatching { c.api.setWorkOrderStatus(o.id, "started") } }
                        }) {
                            Icon(painterResource(R.drawable.ic_arrow_forward), contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Inizia")
                        }
                        if (o.address.isNotBlank() || o.lat != null) {
                            OutlinedButton(onClick = {
                                val uri = if (o.lat != null && o.lon != null) "geo:${o.lat},${o.lon}?q=${o.lat},${o.lon}(${android.net.Uri.encode(o.customer)})" else "geo:0,0?q=${android.net.Uri.encode(o.address)}"
                                runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(uri))) }
                            }) { Text("Naviga") }
                        }
                        Spacer(Modifier.weight(1f))
                        androidx.compose.material3.TextButton(onClick = { note = ""; postpone = o }) { Text("Rimanda") }
                    }
                }
            }
        }
    }
    postpone?.let { o ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { postpone = null },
            title = { Text("Rimandare l'intervento?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${o.customer}: l'ufficio vede che è rimandato e il motivo.")
                    androidx.compose.material3.OutlinedTextField(note, { note = it.take(300) }, label = { Text("Motivo (es. cliente assente)") }, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    postpone = null
                    scope.launch {
                        runCatching { c.api.setWorkOrderStatus(o.id, "postponed", note.trim()) }
                        load()
                    }
                }) { Text("Rimanda") }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { postpone = null }) { Text("Annulla") } },
        )
    }
}
