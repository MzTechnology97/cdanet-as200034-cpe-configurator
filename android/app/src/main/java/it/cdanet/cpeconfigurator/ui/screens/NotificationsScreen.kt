package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.runtime.collectAsState
import it.cdanet.cpeconfigurator.R
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

private val ICONS = mapOf("provisioning_failed" to "❌", "install_ko" to "⛔", "review_pending" to "📶", "install_activated" to "✅", "work_order_noc" to "📋")

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

    suspend fun load() {
        busy = true
        error = null
        runCatching { c.api.notifications() }
            .onSuccess { items = it.items; unread = it.unread; onUnread(it.unread) }
            .onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(c.refresh.collectAsState().value) { load() }

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
        items.forEach { n ->
            val title = if (n.title.startsWith("✅") || n.title.startsWith("❌")) n.title else "${ICONS[n.kind] ?: "🔔"} ${n.title}"
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
                    Text(n.createdAt.replace('T', ' ').take(16), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (n.body.isNotBlank()) Text(n.body, style = MaterialTheme.typography.bodySmall)
                    if (n.readAt == null) Text("Tocca per segnarla come letta", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
        if (items.isEmpty() && !busy) EmptyState(R.drawable.ic_notifications, "Nessuna notifica", "Qui arrivano gli esiti delle tue installazioni: approvazioni e attivazioni del NOC (ultimi 90 giorni).")
        // the outcome of your installations also reaches Telegram once linked (choices: console web → Notifiche)
        Text("Le notifiche su Telegram si collegano in Impostazioni.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
