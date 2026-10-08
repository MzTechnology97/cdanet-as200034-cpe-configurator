package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.BuildConfig
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.Settings
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.update.UpdateState
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(c: AppContainer, update: UpdateState, onUpdate: (UpdateState) -> Unit, onOffline: () -> Unit) {
    val scope = rememberCoroutineScope()
    val savedBackend by c.settings.backendUrl.collectAsState(initial = "")
    val savedUser by c.settings.lastUsername.collectAsState(initial = "")
    var backend by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var serverInfo by remember { mutableStateOf<String?>(null) }
    var editBackend by remember { mutableStateOf(false) }

    LaunchedEffect(savedBackend) { if (backend.isBlank()) backend = savedBackend }
    LaunchedEffect(savedUser) { if (username.isBlank()) username = savedUser }

    Column(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(110.dp))
        Text("CDA Net CPE Configurator", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("v${BuildConfig.VERSION_NAME}", color = MaterialTheme.colorScheme.onSurfaceVariant)

        UpdateBanner(c, update, onUpdate)
        ErrorBanner(error) { error = null }

        SectionCard("Accesso installatore") {
            Field("Username", username, { username = it.trim() })
            Field("Password", password, { password = it }, password = true)
            BusyButton("Accedi", busy, Modifier.fillMaxWidth(), enabled = username.isNotBlank() && password.isNotBlank()) {
                scope.launch {
                    busy = true
                    error = null
                    try {
                        if (backend != savedBackend) c.settings.setBackendUrl(backend)
                        c.api.login(username, password)
                        c.settings.setLastUsername(username)
                    } catch (e: Exception) {
                        error = e.message ?: e.toString()
                    } finally {
                        password = ""
                        busy = false
                    }
                }
            }
        }

        SectionCard("Server CDA Net") {
            if (editBackend) {
                Field("URL server", backend, { backend = it.trim() }, keyboardType = KeyboardType.Uri, placeholder = "https://cpe.cda-net.it")
            } else {
                Text(backend.ifBlank { "—" }, style = MaterialTheme.typography.bodyLarge)
            }
            serverInfo?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { editBackend = !editBackend }) { Text(if (editBackend) "Chiudi modifica" else "Modifica URL") }
                TextButton(onClick = {
                    scope.launch {
                        serverInfo = try {
                            Settings.normalizeBackendUrl(backend)
                            c.settings.setBackendUrl(backend)
                            val h = c.api.health()
                            "Online · server v${h.version} · firmware target ${h.targetFirmware}"
                        } catch (e: Exception) {
                            "Non raggiungibile: ${e.message}"
                        }
                    }
                }) { Text("Verifica collegamento") }
            }
        }

        TextButton(onClick = onOffline) { Text("Continua senza accesso (solo strumenti locali)") }
        Text(
            "Il provisioning richiede l'accesso online per preparare la configurazione. Gli strumenti di diagnostica locale funzionano anche offline.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
