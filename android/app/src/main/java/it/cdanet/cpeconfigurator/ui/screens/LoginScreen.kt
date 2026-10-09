package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.runtime.DisposableEffect
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import it.cdanet.cpeconfigurator.ui.CdaOrange
import it.cdanet.cpeconfigurator.ui.QuickLoginButton
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
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
    var mfaToken by remember { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf("") }

    LaunchedEffect(savedBackend) { if (backend.isBlank()) backend = savedBackend }
    LaunchedEffect(savedUser) { if (username.isBlank()) username = savedUser }

    val view = androidx.compose.ui.platform.LocalView.current
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    DisposableEffect(dark) {
        // white status bar icons over the orange header, back to the theme ones after login
        val w = (view.context as? android.app.Activity)?.window
        w?.let { androidx.core.view.WindowCompat.getInsetsController(it, view).isAppearanceLightStatusBars = false }
        onDispose { w?.let { androidx.core.view.WindowCompat.getInsetsController(it, view).isAppearanceLightStatusBars = !dark } }
    }
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        // brand header behind the form, with the CDA Net symbol as a watermark
        Box(
            Modifier
                .fillMaxWidth()
                .height(330.dp)
                .clip(RoundedCornerShape(bottomStart = 40.dp, bottomEnd = 40.dp))
                .background(Brush.linearGradient(listOf(CdaOrange, Color(0xFFD9431A), Color(0xFF8E2A0C)))),
        ) {
            Icon(
                painterResource(R.drawable.ic_launcher_foreground),
                contentDescription = null,
                tint = Color.White.copy(alpha = 0.12f),
                modifier = Modifier.size(300.dp).align(Alignment.TopEnd).offset(x = 90.dp, y = (-30).dp),
            )
        }
    Column(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            painterResource(R.drawable.ic_launcher_foreground),
            contentDescription = "CDA Net",
            tint = Color.White,
            modifier = Modifier.padding(top = 8.dp).size(104.dp),
        )
        Text("CDA Net", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, color = Color.White)
        Text("CPE Configurator · v${BuildConfig.VERSION_NAME}", color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(18.dp))

        UpdateBanner(c, update, onUpdate)
        ErrorBanner(error) { error = null }

        mfaToken?.let { token ->
            SectionCard("Verifica in due passaggi", icon = R.drawable.ic_lock) {
                Text("Inserisci il codice di 6 cifre dell'app di autenticazione (o un codice di recupero).", style = MaterialTheme.typography.bodySmall)
                Field("Codice", code, { code = it.trim().take(9) }, keyboardType = KeyboardType.Number)
                BusyButton("Verifica", busy, Modifier.fillMaxWidth(), enabled = code.length >= 6) {
                    scope.launch {
                        busy = true
                        error = null
                        try {
                            c.api.loginTotp(token, code)
                            c.settings.setLastUsername(username)
                            c.offerQuickLogin.value = true
                        } catch (e: Exception) {
                            error = e.message ?: e.toString()
                            if ((e as? it.cdanet.cpeconfigurator.data.ApiException)?.code == "mfa_expired") mfaToken = null
                        } finally {
                            code = ""
                            busy = false
                        }
                    }
                }
                TextButton(onClick = { mfaToken = null; code = "" }) { Text("Torna indietro") }
            }
        }

        if (mfaToken == null) SectionCard("Accedi", icon = R.drawable.ic_person) {
            QuickLoginButton(c, savedBackend) { error = it }
            Field("Username", username, { username = it.trim() }, leadingIcon = R.drawable.ic_person)
            Field("Password", password, { password = it }, password = true, leadingIcon = R.drawable.ic_lock)
            BusyButton("Accedi", busy, Modifier.fillMaxWidth(), enabled = username.isNotBlank() && password.isNotBlank()) {
                scope.launch {
                    busy = true
                    error = null
                    try {
                        if (backend != savedBackend) c.settings.setBackendUrl(backend)
                        mfaToken = c.api.login(username, password)
                        if (mfaToken == null) {
                            c.settings.setLastUsername(username)
                            c.offerQuickLogin.value = true
                        }
                    } catch (e: Exception) {
                        error = e.message ?: e.toString()
                    } finally {
                        password = ""
                        busy = false
                    }
                }
            }
        }

        SectionCard("Server CDA Net", icon = R.drawable.ic_dns) {
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
}
