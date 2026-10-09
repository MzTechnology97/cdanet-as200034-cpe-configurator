package it.cdanet.cpeconfigurator.ui.screens

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.PrivacyDto
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SectionCard
import kotlinx.coroutines.launch

/**
 * The privacy notice at the first login (and whenever it changes): read, tick, accept. The server
 * keeps the acceptance as an attestation; without it the app cannot be used.
 */
@Composable
fun PrivacyScreen(c: AppContainer, p: PrivacyDto, onAccepted: () -> Unit, onLogout: () -> Unit) {
    val scope = rememberCoroutineScope()
    var read by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val n = p.notice ?: return
    Column(Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Informativa privacy", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("Prima di usare l'app leggi come vengono trattati i tuoi dati, in particolare la posizione durante gli interventi.", style = MaterialTheme.typography.bodyMedium)
        SectionCard(n.title, icon = R.drawable.ic_lock) {
            n.sections.forEach { s ->
                Text(s.title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleSmall)
                s.paragraphs.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = read, onCheckedChange = { read = it })
            Text("Ho letto e compreso l'informativa e ne accetto le condizioni per l'uso dell'app.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        }
        error?.let { Notice(it, NoticeKind.Bad) }
        BusyButton("Accetto", busy, Modifier.fillMaxWidth(), enabled = read) {
            scope.launch {
                busy = true
                error = null
                runCatching { c.api.acceptPrivacy(p.sha256 ?: "", "${Build.MANUFACTURER} ${Build.MODEL}".trim()) }
                    .onSuccess { onAccepted() }
                    .onFailure { error = it.message }
                busy = false
            }
        }
        Text(
            "La tua accettazione viene registrata con data, ora e dispositivo: l'attestazione la trovi in Il mio account nella console web.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = onLogout) { Text("Non accetto: esci") }
    }
}
