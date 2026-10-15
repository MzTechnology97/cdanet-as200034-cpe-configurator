package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.collectAsState
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.ui.localTime
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.ListHeader
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.NotificationDto
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.SectionCard
import kotlinx.coroutines.launch

private val ICONS = mapOf("screenshot_attempt" to "📵", "provisioning_failed" to "❌", "install_ko" to "⛔", "review_pending" to "📶", "install_activated" to "✅", "work_order_noc" to "📋", "network_advice" to "🛠️", "network_optimizer" to "🔧", "platform" to "🖥️", "repoint_unplanned" to "🎯")

/**
 * The user's notifications (NOC approvals, activations; for admins also failures, KO and
 * acceptance tests to approve). Which kinds also go to Telegram is chosen in the web console.
 */
@Composable
fun NotificationsScreen(c: AppContainer, onUnread: (Int) -> Unit) {
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf<List<NotificationDto>>(emptyList()) }
    var unread by remember { mutableStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var askAll by remember { mutableStateOf(false) }

    suspend fun load() {
        busy = true
        error = null
        runCatching { c.api.notifications() }
            .onSuccess { items = it.items; unread = it.unread; onUnread(it.unread) }
            .onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(c.refresh.collectAsState().value) { load() }
    val delete: (List<Long>?, String) -> Unit = { ids, which ->
        scope.launch {
            runCatching { c.api.deleteNotifications(ids, which) }.onFailure { error = it.message }
            load()
        }
    }

    // a lazy list: 14 days of notifications are composed only when they come on screen
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ErrorBanner(error) { error = null }
                if (items.isEmpty() && busy) it.cdanet.cpeconfigurator.ui.SkeletonRows(3)
                ListHeader(if (unread > 0) "$unread da leggere" else "Nessuna notifica da leggere", busy) { scope.launch { load() } }
                if (unread > 0) {
                    BusyButton("Segna tutte come lette", busy, Modifier.fillMaxWidth(), primary = false) {
                        scope.launch {
                            runCatching { c.api.markNotificationsRead() }
                            load()
                        }
                    }
                }
                if (items.isNotEmpty()) {
                    androidx.compose.foundation.layout.Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (items.any { it.readAt != null }) androidx.compose.material3.TextButton(onClick = { delete(null, "read") }, enabled = !busy) { Text("Elimina le lette") }
                        androidx.compose.material3.TextButton(onClick = { askAll = true }, enabled = !busy) { Text("Elimina tutte") }
                    }
                }
            }
        }
        items(items, key = { it.id }) { n ->
            val title = if (listOf("✅", "❌", "⚠️").any { n.title.startsWith(it) }) n.title else "${ICONS[n.kind] ?: "🔔"} ${n.title}"
            SectionCard {
                Column(
                    Modifier.fillMaxWidth().clickable(enabled = n.readAt == null) {
                        scope.launch {
                            runCatching { c.api.markNotificationsRead(listOf(n.id)) }
                            load()
                        }
                    },
                ) {
                    Text(title, fontWeight = if (n.readAt == null) FontWeight.Bold else FontWeight.Normal)
                    Text(localTime(n.createdAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (n.body.isNotBlank()) Text(n.body, style = MaterialTheme.typography.bodySmall)
                    androidx.compose.foundation.layout.Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        if (n.readAt == null) Text("Tocca per segnarla come letta", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
                        else androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
                        androidx.compose.material3.IconButton(onClick = { delete(listOf(n.id), "") }) {
                            androidx.compose.material3.Icon(androidx.compose.ui.res.painterResource(R.drawable.ic_delete), contentDescription = "Elimina la notifica", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (items.isEmpty() && !busy) EmptyState(R.drawable.ic_notifications, "Nessuna notifica", "Qui arrivano gli esiti delle tue installazioni: approvazioni e attivazioni del NOC (ultimi 14 giorni, poi si cancellano da sole).")
                // the outcome of your installations also reaches Telegram once linked (choices: console web → Notifiche)
                Text("Le notifiche su Telegram si collegano in Impostazioni.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    if (askAll) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { askAll = false },
            title = { Text("Eliminare tutte le notifiche?") },
            text = { Text("Spariscono da questo telefono e dalla console per il tuo account. Le notifiche degli altri non cambiano.") },
            confirmButton = { androidx.compose.material3.TextButton(onClick = { askAll = false; delete(null, "all") }) { Text("Elimina tutte") } },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { askAll = false }) { Text("Annulla") } },
        )
    }
}
