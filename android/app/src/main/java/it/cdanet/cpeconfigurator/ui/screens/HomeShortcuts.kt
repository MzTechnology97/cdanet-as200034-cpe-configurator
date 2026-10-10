package it.cdanet.cpeconfigurator.ui.screens

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.Settings
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import it.cdanet.cpeconfigurator.ui.Area
import it.cdanet.cpeconfigurator.ui.Screen

/** A Home shortcut: [id] is what is saved for the account, so it never changes. */
class Shortcut(val id: String, val title: String, val subtitle: String, @DrawableRes val icon: Int, val area: Area, val dest: Dest)

/** Shown until the account customises its Home (and again with "Ripristina"). */
val DEFAULT_SHORTCUTS = listOf("cpe", "alignment", "coverage", "near_aps", "lan", "guide")

/**
 * Every shortcut this account can have now: only features enabled for it, and without login only
 * the tools that work on the phone alone. Same order as the editor shows them.
 */
fun shortcutCatalog(m: Map<String, Boolean>, admin: Boolean, offline: Boolean): List<Shortcut> = buildList {
    val on = !offline
    val cpe = cpeTabTitles(m)
    val net = networkTabTitles(m)
    val install = installTabTitles(m, admin)
    val tools = m["network_tools"] != false
    // with the CPE
    if (on && cpe.isNotEmpty()) add(Shortcut("cpe", "CPE collegata", "Diagnosi, puntamento, AP visibili, collaudo", R.drawable.ic_cell_tower, Area.Field, Dest(Screen.CpeHub)))
    if (on && "Puntamento" in cpe) add(Shortcut("alignment", "Puntamento", "Segnale in tempo reale con bip", R.drawable.ic_signal_cellular_alt, Area.Field, Dest(Screen.CpeHub, "Puntamento")))
    if (on && "Diagnosi" in cpe) add(Shortcut("diagnosis", "Diagnosi CPE", "Segnale, cavo LAN, PPPoE, firmware", R.drawable.ic_troubleshoot, Area.Field, Dest(Screen.CpeHub, "Diagnosi")))
    if (on && "AP visibili" in cpe) add(Shortcut("visible_aps", "AP visibili", "Gli AP che la CPE riceve, con il segnale", R.drawable.ic_sensors, Area.Field, Dest(Screen.CpeHub, "AP visibili")))
    if (on && "Collaudo" in cpe) add(Shortcut("acceptance", "Collaudo", "Verifiche finali e foto", R.drawable.ic_check_circle, Area.Field, Dest(Screen.CpeHub, "Collaudo")))
    if (on && "Firmware" in cpe) add(Shortcut("firmware", "Firmware", "Aggiorna la CPE alla versione richiesta", R.drawable.ic_system_update, Area.Field, Dest(Screen.CpeHub, "Firmware")))
    // network
    if (on && m["coverage"] != false) add(Shortcut("coverage", "Verifica copertura", "Un indirizzo è coperto? Prima del sopralluogo", R.drawable.ic_map, Area.Network, Dest(Screen.Coverage)))
    if (on && "AP vicini" in net) add(Shortcut("near_aps", "AP vicini", "Sul posto: AP intorno a te, bussola e mirino", R.drawable.ic_explore, Area.Network, Dest(Screen.NetHub, "AP vicini")))
    if (on && "Stato" in net) add(Shortcut("net_status", "Stato rete", "POP e AP raggiungibili, CPE offline", R.drawable.ic_hub, Area.Network, Dest(Screen.NetHub, "Stato")))
    if (on && "Guasti" in net) add(Shortcut("outages", "Guasti Enel", if (admin) "Guasti e lavori della rete elettrica" else "Guasti e lavori nelle tue zone", R.drawable.ic_power_off, Area.Network, Dest(Screen.NetHub, "Guasti")))
    if (on && "Aree e avvisi" in net) add(Shortcut("areas", "Aree e avvisi", "Zone da seguire e notifiche dei guasti", R.drawable.ic_my_location, Area.Network, Dest(Screen.NetHub, "Aree e avvisi")))
    // my work
    if (on) add(Shortcut("todo", "Da completare", "Installazioni lasciate a metà o rifiutate", R.drawable.ic_pending_actions, Area.Work, Dest(Screen.Installations, "Da completare")))
    if (on) add(Shortcut("history", "Storico", "I miei provisioning e i loro esiti", R.drawable.ic_history, Area.Work, Dest(Screen.Installations, "Storico")))
    install.firstOrNull { it == "Salute CPE" || it == "Stato CPE" }?.let { t ->
        if (on) add(Shortcut("cpe_health", t, if (admin) "CPE con problemi in tutta la rete" else "Le CPE che ho installato", R.drawable.ic_monitor_heart, Area.Work, Dest(Screen.Installations, t)))
    }
    if (on) add(Shortcut("notifications", "Notifiche", "Esiti del NOC, interventi e avvisi", R.drawable.ic_notifications, Area.Work, Dest(Screen.Notifications)))
    // customer's network: these work without login too
    if (tools) add(Shortcut("lan", "Scansione LAN", "Apparati nella rete del cliente", R.drawable.ic_radar, Area.Tools, Dest(Screen.Lan)))
    if (tools) add(Shortcut("wifi", "Wi-Fi Analyzer", "Reti, canali e consiglio per il router", R.drawable.ic_wifi_find, Area.Tools, Dest(Screen.Wifi)))
    if (tools) add(Shortcut("net_diag", "Diagnostica di rete", "Ping, traceroute, DNS, speed test", R.drawable.ic_speed, Area.Tools, Dest(Screen.Diag)))
    if (tools) add(Shortcut("devices", "Apparati in LAN", "SNMP e telecamere", R.drawable.ic_memory, Area.Tools, Dest(Screen.Devices)))
    if (m["routeros"] != false) add(Shortcut("routeros", "MikroTik · RouterOS", "Consultazione in sola lettura", R.drawable.ic_router, Area.Tools, Dest(Screen.RouterOs)))
    if (tools) add(Shortcut("remote", "Accesso remoto", "SSH e Remote Desktop", R.drawable.ic_terminal, Area.Tools, Dest(Screen.Remote)))
    if (on) add(Shortcut("guide", "Guida", "Installazione passo per passo", R.drawable.ic_menu_book, Area.Help, Dest(Screen.Guide)))
}

/**
 * The shortcuts shown on Home: the account's choice in its order ([saved], null = never
 * customised: the defaults), keeping only those available now. A feature turned off later just
 * disappears, and comes back in the same place when it is turned on again.
 */
fun resolveShortcuts(saved: List<String>?, catalog: List<Shortcut>): List<Shortcut> {
    val byId = catalog.associateBy { it.id }
    return (saved ?: DEFAULT_SHORTCUTS).distinct().mapNotNull { byId[it] }
}

/**
 * The account's shortcuts: the server keeps them (they follow the account on every phone), the
 * phone keeps a copy for an instant Home and for when there is no network. A change made offline
 * is marked and sent at the next sync, so the server copy never overwrites it.
 */
class ShortcutStore(private val settings: Settings, private val api: ApiClient) {
    private val lock = Mutex()

    /** Opening Home online: send a pending change, else take the server's choice. */
    suspend fun sync(account: String) = lock.withLock {
        runCatching {
            if (settings.homeShortcutsDirty(account)) {
                api.setHomeShortcuts(settings.homeShortcuts(account).first())
                settings.markHomeShortcutsSaved(account)
            } else {
                settings.setHomeShortcuts(account, api.homeShortcuts(), dirty = false)
            }
        }
    }

    /** A change in the editor: on the phone at once, then on the server (later if offline). */
    suspend fun save(account: String, ids: List<String>?) = lock.withLock {
        settings.setHomeShortcuts(account, ids, dirty = true)
        runCatching { api.setHomeShortcuts(ids) }.onSuccess { settings.markHomeShortcutsSaved(account) }
    }
}

/** Editor moves: one place up or down, clamped. */
fun moveShortcut(ids: List<String>, id: String, delta: Int): List<String> {
    val i = ids.indexOf(id)
    val j = i + delta
    if (i < 0 || j < 0 || j > ids.lastIndex) return ids
    return ids.toMutableList().also { it.add(j, it.removeAt(i)) }
}

/**
 * "Modifica" on Home: the account's shortcuts in order (move, remove) and the others it can add.
 * Every change is saved at once, so Home behind the sheet already shows it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShortcutEditor(catalog: List<Shortcut>, chosen: List<String>, onChange: (List<String>) -> Unit, onReset: () -> Unit, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val byId = catalog.associateBy { it.id }
    val inHome = chosen.mapNotNull { byId[it] }
    val others = catalog.filter { it.id !in chosen }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Scorciatoie della home", style = MaterialTheme.typography.titleLarge)
            Text("Scegli quali vedere in Oggi e in che ordine. Seguono il tuo account: le ritrovi su ogni telefono da cui accedi.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            Text("IN HOME · ${inHome.size}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (inHome.isEmpty()) Text("Nessuna: aggiungine una qui sotto.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            inHome.forEachIndexed { i, s ->
                ShortcutRow(s) {
                    IconButton(onClick = { onChange(moveShortcut(chosen, s.id, -1)) }, enabled = i > 0) { Icon(painterResource(R.drawable.ic_arrow_upward), contentDescription = "Sposta su") }
                    IconButton(onClick = { onChange(moveShortcut(chosen, s.id, 1)) }, enabled = i < inHome.lastIndex) { Icon(painterResource(R.drawable.ic_arrow_downward), contentDescription = "Sposta giù") }
                    IconButton(onClick = { onChange(chosen - s.id) }) { Icon(painterResource(R.drawable.ic_remove_circle), contentDescription = "Togli dalla home", tint = MaterialTheme.colorScheme.error) }
                }
            }
            if (others.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text("DA AGGIUNGERE", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                others.forEach { s ->
                    ShortcutRow(s) {
                        IconButton(onClick = { onChange(chosen + s.id) }) { Icon(painterResource(R.drawable.ic_add_circle), contentDescription = "Aggiungi alla home", tint = MaterialTheme.colorScheme.primary) }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onReset) { Text("Ripristina predefinite") }
                Spacer(Modifier.weight(1f))
                Button(onClick = onDismiss) { Text("Fatto") }
            }
        }
    }
}

@Composable
private fun ShortcutRow(s: Shortcut, actions: @Composable () -> Unit) {
    val accent = s.area.accent
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(12.dp)).background(accent.container), contentAlignment = Alignment.Center) {
            Icon(painterResource(s.icon), contentDescription = null, tint = accent.content, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(s.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(s.subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        actions()
    }
}
