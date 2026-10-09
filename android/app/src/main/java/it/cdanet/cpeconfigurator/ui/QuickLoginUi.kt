package it.cdanet.cpeconfigurator.ui

import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.security.QuickLoginCancelled
import kotlinx.coroutines.launch

tailrec fun Context.fragmentActivity(): FragmentActivity? = when (this) {
    is FragmentActivity -> this
    is ContextWrapper -> baseContext.fragmentActivity()
    else -> null
}

/**
 * Turns on the quick login for the signed-in user: the server issues a key for this phone, the
 * biometric prompt unlocks the keystore key that encrypts it. Cancelled prompt = nothing kept.
 */
suspend fun enableQuickLogin(c: AppContainer, activity: FragmentActivity) {
    val user = c.session.state.value?.user ?: throw IllegalStateException("Accedi prima con la password")
    val cap = c.quickLogin.capability() ?: throw IllegalStateException("Nessuna impronta o volto registrato nelle impostazioni del telefono")
    val strong = cap == BIOMETRIC_STRONG
    val key = c.api.registerDevice("${Build.MANUFACTURER} ${Build.MODEL}".trim())
    try {
        val cipher = c.quickLogin.authenticate(activity, "Accesso rapido CDA Net", "Conferma con impronta o volto per ${user.username}", strong, c.quickLogin.encryptCipher(strong))
        c.quickLogin.save(c.settings.backendUrlNow(), user.username, key.id, key.secret, cipher, strong)
    } catch (e: Exception) {
        c.quickLogin.clear()
        runCatching { c.api.removeDevice(key.id) }
        throw e
    }
}

/** Quick login on the login screen: biometric prompt, then a session with the phone's key. */
suspend fun quickLogin(c: AppContainer, activity: FragmentActivity) {
    val s = c.quickLogin.saved() ?: throw IllegalStateException("Accesso rapido non attivo")
    val cipher = c.quickLogin.decryptCipher(s) ?: throw IllegalStateException("Impronte o volti del telefono cambiati: accedi con la password e riattiva l'accesso rapido")
    val unlocked = c.quickLogin.authenticate(activity, "Accesso a CDA Net", s.username, s.strong, cipher)
    val secret = c.quickLogin.secret(s, unlocked)
    try {
        c.api.deviceLogin(s.deviceId, secret)
    } catch (e: it.cdanet.cpeconfigurator.data.ApiException) {
        if (e.code == "device_revoked") c.quickLogin.clear()
        throw e
    }
}

/** After a login with the password: one question, then never again unless asked from Settings. */
@Composable
fun QuickLoginOffer(c: AppContainer) {
    val offer by c.offerQuickLogin.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    val session by c.session.state.collectAsState()
    val user = session?.user
    val saved = c.quickLogin.saved()
    val pointless = user == null || c.quickLogin.capability() == null || (saved != null && saved.username == user.username) || c.quickLogin.declined(user.username)
    LaunchedEffect(offer, pointless) { if (offer && pointless) c.offerQuickLogin.value = false }
    if (!offer || pointless || user == null) return
    AlertDialog(
        onDismissRequest = { c.offerQuickLogin.value = false },
        title = { Text("Accesso rapido") },
        text = {
            Text(
                (error?.let { "$it\n\n" } ?: "") +
                    "Le prossime volte entri con impronta o riconoscimento del volto, senza password. La password non viene salvata: " +
                    "il telefono riceve una chiave che puoi revocare da Il mio account o con \"Esci da tutti i dispositivi\".",
            )
        },
        confirmButton = {
            TextButton(onClick = {
                val activity = context.fragmentActivity() ?: return@TextButton
                scope.launch {
                    try {
                        enableQuickLogin(c, activity)
                        c.offerQuickLogin.value = false
                    } catch (e: QuickLoginCancelled) {
                        c.offerQuickLogin.value = false
                    } catch (e: Exception) {
                        error = e.message
                    }
                }
            }) { Text("Attiva") }
        },
        dismissButton = {
            TextButton(onClick = {
                c.quickLogin.decline(user.username)
                c.offerQuickLogin.value = false
            }) { Text("Non ora") }
        },
    )
}

/** Settings: state of the quick login on this phone, turn it on or off. */
@Composable
fun QuickLoginCard(c: AppContainer) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val session by c.session.state.collectAsState()
    var saved by remember { mutableStateOf(c.quickLogin.saved()) }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    val user = session?.user ?: return
    val mine = saved?.takeIf { it.username == user.username }
    SectionCard("Accesso rapido (impronta o volto)", icon = it.cdanet.cpeconfigurator.R.drawable.ic_fingerprint) {
        msg?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        when {
            c.quickLogin.capability() == null -> Text("Registra un'impronta o il volto nelle impostazioni di sicurezza del telefono per usarlo.", style = MaterialTheme.typography.bodySmall)
            mine != null -> {
                Text("Attivo su questo telefono per ${mine.username}: al login basta impronta o volto.", style = MaterialTheme.typography.bodySmall)
                BusyButton("Disattiva", busy, Modifier.fillMaxWidth(), primary = false) {
                    scope.launch {
                        busy = true
                        runCatching { c.api.removeDevice(mine.deviceId) }
                        c.quickLogin.clear()
                        saved = null
                        busy = false
                    }
                }
            }
            else -> {
                Text("Entra con impronta o riconoscimento del volto invece della password. La password non viene salvata sul telefono.", style = MaterialTheme.typography.bodySmall)
                BusyButton("Attiva", busy, Modifier.fillMaxWidth()) {
                    val activity = context.fragmentActivity() ?: return@BusyButton
                    scope.launch {
                        busy = true
                        msg = null
                        try {
                            enableQuickLogin(c, activity)
                            saved = c.quickLogin.saved()
                        } catch (_: QuickLoginCancelled) {
                        } catch (e: Exception) {
                            msg = e.message
                        } finally {
                            busy = false
                        }
                    }
                }
            }
        }
    }
}

/** Login screen: the quick login button, when this phone has it for the configured server. */
@Composable
fun QuickLoginButton(c: AppContainer, backend: String, onError: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(c.quickLogin.saved()) }
    val s = saved ?: return
    if (backend.isNotBlank() && s.backend != backend) return
    BusyButton("Accedi con impronta o volto · ${s.username}", busy, Modifier.fillMaxWidth()) {
        val activity = context.fragmentActivity() ?: return@BusyButton
        scope.launch {
            busy = true
            try {
                quickLogin(c, activity)
            } catch (_: QuickLoginCancelled) {
            } catch (e: Exception) {
                onError(e.message ?: e.toString())
                saved = c.quickLogin.saved()
            } finally {
                busy = false
            }
        }
    }
    Text("oppure con la password", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
