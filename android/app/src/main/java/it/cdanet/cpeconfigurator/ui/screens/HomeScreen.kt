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

/** Home groups: each has its own accent color and a short label. */
private enum class HomeGroup(val title: String, val area: Area) {
    Work("Il mio lavoro", Area.Work),
    Network("Rete e guasti", Area.Network),
    Field("In campo", Area.Field),
    Tools("Strumenti di rete", Area.Tools),
    Help("Aiuto", Area.Help),
}

private data class Tile(
    val screen: Screen,
    val title: String,
    val subtitle: String,
    @DrawableRes val icon: Int,
    val group: HomeGroup,
    val needsLogin: Boolean = false,
    val module: String? = null,
    /** Admins see every customer, not "their" CPEs: other title and description. */
    val admin: Pair<String, String>? = null,
)

// Installazione CPE is the hero card on top; everything else is a tile.
private val TILES = listOf(
    Tile(Screen.History, "Storico", "I miei provisioning e gli invii in attesa", R.drawable.ic_history, HomeGroup.Work, needsLogin = true),
    Tile(Screen.Notifications, "Notifiche", "Approvazioni e attivazioni del NOC", R.drawable.ic_notifications, HomeGroup.Work, needsLogin = true, admin = "Notifiche" to "Falliti, KO, collaudi da approvare"),
    Tile(Screen.CpeHealth, "Le mie CPE", "Stato attuale rispetto al collaudo", R.drawable.ic_monitor_heart, HomeGroup.Work, needsLogin = true, module = "cpe_health", admin = "Salute CPE" to "Tutte le CPE: offline, segnale, LAN"),
    Tile(Screen.NetStatus, "Stato rete", "POP e AP, CPE offline, guasti vicini", R.drawable.ic_hub, HomeGroup.Network, needsLogin = true, module = "network_status"),
    Tile(Screen.Outages, "Guasti Enel", "Interruzioni elettriche nelle tue zone", R.drawable.ic_power_off, HomeGroup.Network, needsLogin = true, module = "power_outages"),
    Tile(Screen.Coverage, "Copertura", "AP più vicini da GPS o indirizzo", R.drawable.ic_map, HomeGroup.Network, needsLogin = true, module = "coverage"),
    Tile(Screen.Pointing, "Trova l'AP", "Mappa, azimut, tilt e mirino AR", R.drawable.ic_explore, HomeGroup.Field, needsLogin = true, module = "compass"),
    Tile(Screen.Alignment, "Puntamento antenna", "Segnale in tempo reale con bip", R.drawable.ic_signal_cellular_alt, HomeGroup.Field, needsLogin = true, module = "field_alignment"),
    Tile(Screen.Diagnosis, "Diagnosi CPE", "Segnale, cavo, PPPoE, firmware", R.drawable.ic_troubleshoot, HomeGroup.Field, needsLogin = true, module = "field_diagnosis"),
    Tile(Screen.Wifi, "Wi-Fi Analyzer", "Reti, canali e segnale", R.drawable.ic_wifi_find, HomeGroup.Tools, module = "network_tools"),
    Tile(Screen.Network, "Strumenti di rete", "Ping, traceroute, DNS, speed test", R.drawable.ic_speed, HomeGroup.Tools, module = "network_tools"),
    Tile(Screen.IpScanner, "Scanner IP", "Host attivi, produttore, tipo, porte", R.drawable.ic_radar, HomeGroup.Tools, module = "network_tools"),
    Tile(Screen.PortScanner, "Port scanner", "Porte, banner, HTTP, certificati TLS", R.drawable.ic_manage_search, HomeGroup.Tools, module = "network_tools"),
    Tile(Screen.NetDiag, "Diagnostica di rete", "Ping continuo, MTU, DNS, HTTP, WoL", R.drawable.ic_query_stats, HomeGroup.Tools, module = "network_tools"),
    Tile(Screen.Discovery, "Discovery LAN", "Ubiquiti, NetBIOS, SNMP, ARP", R.drawable.ic_device_hub, HomeGroup.Tools, module = "network_tools"),
    Tile(Screen.Snmp, "SNMP v2c", "Interroga apparati in LAN", R.drawable.ic_memory, HomeGroup.Tools, module = "network_tools"),
    Tile(Screen.Camera, "TVCC", "ONVIF, Hikvision SADP, RTSP, banda", R.drawable.ic_videocam, HomeGroup.Tools, module = "network_tools"),
    Tile(Screen.RouterOs, "MikroTik · RouterOS", "Sola lettura via SSH", R.drawable.ic_router, HomeGroup.Tools, module = "routeros"),
    Tile(Screen.Remote, "Accesso remoto", "SSH e Remote Desktop", R.drawable.ic_terminal, HomeGroup.Tools, module = "network_tools"),
    Tile(Screen.Guide, "Guida", "Installazione passo per passo e tutti gli strumenti", R.drawable.ic_menu_book, HomeGroup.Help, needsLogin = true),
)

/** Icon of each screen, also shown next to the title in the top bar. */
@DrawableRes
fun screenIcon(s: Screen): Int? = when (s) {
    Screen.Provision, Screen.CpeWeb -> R.drawable.ic_settings_input_antenna
    Screen.Acceptance -> R.drawable.ic_check_circle
    Screen.Compass -> R.drawable.ic_explore
    Screen.ArAim -> R.drawable.ic_my_location
    Screen.Settings -> R.drawable.ic_settings
    else -> TILES.firstOrNull { it.screen == s }?.icon
}

@Composable
fun HomeScreen(c: AppContainer, offline: Boolean, onNavigate: (Screen) -> Unit, onLogin: () -> Unit) {
    val session by c.session.state.collectAsState()
    val pending by c.resultQueue.pending.collectAsState()
    val acc by c.acceptanceQueue.pending.collectAsState()
    val prov by c.provisioning.state.collectAsState()
    val install by c.install.state.collectAsState()
    val modules by c.modules.collectAsState()
    val admin = session?.user?.role == "admin"

    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(bottom = 12.dp)) {
        var order = 0
        Enter(order++) {
            Hero(
                name = session?.user?.username,
                role = if (admin) "Amministratore" else "Installatore",
                offline = offline,
                resume = install.mode != null || (prov.pkg != null && prov.phase != Phase.Done),
                onNew = { c.install.start(InstallMode.New); onNavigate(Screen.Provision) },
                onRepoint = { c.install.start(InstallMode.Repoint); onNavigate(Screen.Provision) },
                onResume = { onNavigate(Screen.Provision) },
                onLogin = onLogin,
            )
        }
        if (prov.pkg != null && prov.phase != Phase.Done) {
            Notice("Provisioning preparato per ${prov.pkg?.summary?.deviceName}: riprendi l'intervento per completarlo.", NoticeKind.Warn)
        }
        if (acc.isNotEmpty()) Notice("${acc.size} collaudi in attesa di invio (foto comprese): partiranno appena c'è rete.", NoticeKind.Info)
        if (pending.isNotEmpty()) Notice("${pending.size} esiti in attesa di invio al server: partiranno appena torni online.", NoticeKind.Info)

        val visible = TILES.filter { (!it.needsLogin || !offline) && (it.module == null || modules[it.module] != false) }
        HomeGroup.entries.forEach { g ->
            val tiles = visible.filter { it.group == g }
            if (tiles.isEmpty()) return@forEach
            Enter(order++) { GroupHeader(g) }
            tiles.chunked(2).forEach { pair ->
                Enter(order++) {
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        pair.forEach { t ->
                            val title = t.admin?.takeIf { admin }?.first ?: t.title
                            val subtitle = t.admin?.takeIf { admin }?.second ?: t.subtitle
                            // the odd one out of a group spans the whole row, laid out horizontally
                            FeatureTile(title, subtitle, t.icon, g.area, Modifier.weight(1f).fillMaxHeight(), wide = pair.size == 1) { onNavigate(t.screen) }
                        }
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
private fun GroupHeader(g: HomeGroup) {
    Row(Modifier.padding(top = 10.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(g.area.accent.content))
        Spacer(Modifier.width(8.dp))
        Text(g.title.uppercase(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
