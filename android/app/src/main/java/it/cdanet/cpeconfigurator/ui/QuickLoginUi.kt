package it.cdanet.cpeconfigurator.ui

import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.ApiException
import it.cdanet.cpeconfigurator.security.QuickLoginCancelled
import kotlinx.coroutines.launch

tailrec fun Context.fragmentActivity(): FragmentActivity? = when (this) {
    is FragmentActivity -> this
    is ContextWrapper -> baseContext.fragmentActivity()
    else -> null
}

private fun phoneName() = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

/** Codes after which the phone's key is useless: it is forgotten and the password is needed. */
private fun keyGone(e: Throwable) = (e as? ApiException)?.code in setOf("device_revoked", "device_expired")

/** Drops the key this phone had on the server (best effort) before a new one replaces it. */
private suspend fun dropOldKey(c: AppContainer) {
    c.quickLogin.saved()?.let { old -> runCatching { c.api.removeDevice(old.deviceId) } }
}

/**
 * After a login with the password: the phone stays signed in (persistent key, no prompt), unless
 * "Sblocco a ogni apertura" is on: then fingerprint/face is offered instead.
 */
fun afterPasswordLogin(c: AppContainer) {
    if (c.quickLogin.lockAtOpen() && c.quickLogin.capability() != null) c.offerQuickLogin.value = true
    // otherwise AppRoot keeps the phone signed in as soon as the session is there (ensureRemembered)
}

/** Signed in without a key on this phone (and no fingerprint/face option): keep it signed in. */
suspend fun ensureRemembered(c: AppContainer) {
    val user = c.session.state.value?.user ?: return
    if (c.quickLogin.lockAtOpen()) return
    val s = c.quickLogin.saved()
    if (s != null && s.username == user.username) return
    runCatching { rememberPhone(c) }
}

/** Persistent login for the signed-in user: the server issues a key, the keystore keeps it. */
suspend fun rememberPhone(c: AppContainer) {
    val user = c.session.state.value?.user ?: return
    dropOldKey(c)
    val key = c.api.registerDevice(phoneName(), persistent = true)
    c.quickLogin.savePersistent(c.settings.backendUrlNow(), user.username, key.id, key.secret, key.expiresAt)
}

/**
 * Opening the app with a persistent key: a new session without asking anything. Returns null when
 * signed in, else the message to show (the key is forgotten when the server refuses it).
 */
suspend fun autoLogin(c: AppContainer): String? {
    val s = c.quickLogin.saved()?.takeIf { it.persistent } ?: return "Accesso automatico non attivo"
    val secret = c.quickLogin.persistentSecret(s) ?: run {
        c.quickLogin.clear()
        return "Chiave del telefono non più leggibile: accedi con la password"
    }
    return try {
        c.quickLogin.setExpiry(c.api.deviceLogin(s.deviceId, secret))
        null
    } catch (e: Exception) {
        if (keyGone(e)) c.quickLogin.clear()
        e.message ?: e.toString()
    }
}

/** "Esci": the phone forgets the key (and removes it on the server when reachable). */
suspend fun logoutPhone(c: AppContainer) {
    if (c.session.token != null) dropOldKey(c)
    c.quickLogin.clear()
    c.session.clear()
}

/**
 * Fingerprint/face login for the signed-in user ("Sblocco a ogni apertura"): the server issues a
 * key for this phone, the biometric prompt unlocks the keystore key that encrypts it.
 */
suspend fun enableQuickLogin(c: AppContainer, activity: FragmentActivity) {
    val user = c.session.state.value?.user ?: throw IllegalStateException("Accedi prima con la password")
    val cap = c.quickLogin.capability() ?: throw IllegalStateException("Nessuna impronta o volto registrato nelle impostazioni del telefono")
    val strong = cap == BIOMETRIC_STRONG
    val previous = c.quickLogin.saved()
    val key = c.api.registerDevice(phoneName())
    try {
        val cipher = c.quickLogin.authenticate(activity, "Sblocco CDA Net", "Conferma con impronta o volto per ${user.username}", strong, c.quickLogin.encryptCipher(strong))
        c.quickLogin.save(c.settings.backendUrlNow(), user.username, key.id, key.secret, cipher, strong, key.expiresAt)
        previous?.let { old -> runCatching { c.api.removeDevice(old.deviceId) } }
    } catch (e: Exception) {
        runCatching { c.api.removeDevice(key.id) }
        throw e
    }
}

/** Fingerprint/face login on the login screen: biometric prompt, then a session with the phone's key. */
suspend fun quickLogin(c: AppContainer, activity: FragmentActivity) {
    val s = c.quickLogin.saved()?.takeIf { !it.persistent } ?: throw IllegalStateException("Sblocco con impronta o volto non attivo")
    val cipher = c.quickLogin.decryptCipher(s) ?: throw IllegalStateException("Impronte o volti del telefono cambiati: accedi con la password")
    val unlocked = c.quickLogin.authenticate(activity, "Accesso a CDA Net", s.username, s.strong, cipher)
    val secret = c.quickLogin.secret(s, unlocked)
    try {
        c.quickLogin.setExpiry(c.api.deviceLogin(s.deviceId, secret))
    } catch (e: Exception) {
        if (keyGone(e)) c.quickLogin.clear()
        throw e
    }
}

/** With "Sblocco a ogni apertura" on, after a login with the password: set up fingerprint/face. */
@Composable
fun QuickLoginOffer(c: AppContainer) {
    val offer by c.offerQuickLogin.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    val session by c.session.state.collectAsState()
    val user = session?.user
    if (!offer || user == null) return
    AlertDialog(
        onDismissRequest = { c.offerQuickLogin.value = false },
        title = { Text("Sblocco con impronta o volto") },
        text = {
            Text(
                (error?.let { "$it\n\n" } ?: "") +
                    "Hai scelto di sbloccare l'app con impronta o volto a ogni apertura. Confermalo ora: la password non viene salvata, " +
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
            }) { Text("Conferma") }
        },
        dismissButton = { TextButton(onClick = { c.offerQuickLogin.value = false }) { Text("Non ora") } },
    )
}

private fun expiryText(iso: String?): String? = iso?.let {
    runCatching {
        val d = java.time.Instant.parse(it).atZone(java.time.ZoneId.systemDefault()).toLocalDate()
        d.format(java.time.format.DateTimeFormatter.ofPattern("d MMMM yyyy", java.util.Locale.ITALIAN))
    }.getOrNull()
}

/** Settings: how this phone stays signed in, the fingerprint/face option at every opening. */
@Composable
fun QuickLoginCard(c: AppContainer) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val session by c.session.state.collectAsState()
    var saved by remember { mutableStateOf(c.quickLogin.saved()) }
    var lock by remember { mutableStateOf(c.quickLogin.lockAtOpen()) }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    val user = session?.user ?: return
    val mine = saved?.takeIf { it.username == user.username }
    val bio = c.quickLogin.capability() != null
    SectionCard("Accesso su questo telefono", icon = R.drawable.ic_fingerprint) {
        Text(
            when {
                mine == null -> "Al prossimo avvio servirà la password."
                mine.persistent -> "Resti collegato come ${mine.username}: l'app si apre senza password. " +
                    (expiryText(mine.expiresAt)?.let { "La sessione si rinnova a ogni apertura (scade il $it se non usi l'app per 30 giorni)." } ?: "")
                else -> "A ogni apertura l'app chiede impronta o volto di ${mine.username}."
            },
            style = MaterialTheme.typography.bodySmall,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Sblocco con impronta o volto a ogni apertura", style = MaterialTheme.typography.bodyLarge)
                Text(
                    if (bio) "Più sicurezza se il telefono viene perso o prestato." else "Registra un'impronta o il volto nelle impostazioni di sicurezza del telefono.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = lock,
                enabled = !busy && (bio || lock),
                onCheckedChange = { on ->
                    val activity = context.fragmentActivity() ?: return@Switch
                    scope.launch {
                        busy = true
                        msg = null
                        try {
                            if (on) enableQuickLogin(c, activity) else rememberPhone(c)
                            c.quickLogin.setLockAtOpen(on)
                            lock = on
                        } catch (_: QuickLoginCancelled) {
                        } catch (e: Exception) {
                            msg = e.message
                        } finally {
                            saved = c.quickLogin.saved()
                            busy = false
                        }
                    }
                },
            )
        }
        if (mine == null && !lock) {
            BusyButton("Resta collegato su questo telefono", busy, Modifier.fillMaxWidth(), primary = false) {
                scope.launch {
                    busy = true
                    msg = runCatching { rememberPhone(c) }.exceptionOrNull()?.message
                    saved = c.quickLogin.saved()
                    busy = false
                }
            }
        }
        msg?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }
}

/**
 * Login screen: with a persistent key the app signs in by itself; with fingerprint/face the
 * prompt opens at once. The button stays for a retry (no network, cancelled prompt).
 */
@Composable
fun QuickLoginButton(c: AppContainer, backend: String, onError: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(c.quickLogin.saved()) }
    val s = saved ?: return
    if (backend.isNotBlank() && s.backend != backend) return
    fun go() {
        scope.launch {
            busy = true
            try {
                if (s.persistent) {
                    autoLogin(c)?.let(onError)
                } else {
                    val activity = context.fragmentActivity() ?: return@launch
                    quickLogin(c, activity)
                }
            } catch (_: QuickLoginCancelled) {
            } catch (e: Exception) {
                onError(e.message ?: e.toString())
            } finally {
                saved = c.quickLogin.saved()
                busy = false
            }
        }
    }
    LaunchedEffect(s.deviceId) {
        // once per process: a cancelled prompt or a failed attempt does not loop
        if (!autoTried) {
            autoTried = true
            if (s.persistent || c.quickLogin.lockAtOpen()) go()
        }
    }
    BusyButton(if (s.persistent) "Entra come ${s.username}" else "Accedi con impronta o volto · ${s.username}", busy, Modifier.fillMaxWidth()) { go() }
    Text("oppure con la password", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Set when the login screen already tried the automatic login since the last session. */
@Volatile private var autoTried = false

/** A session is open: if it ends (expired token), the login screen may sign in by itself again. */
fun allowAutoLogin() {
    autoTried = false
}

/** The app came back after a while with "Sblocco a ogni apertura" on: fingerprint/face to go on. */
@Composable
fun LockScreen(c: AppContainer, onLogout: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    fun unlock() {
        val activity = context.fragmentActivity() ?: return
        val s = c.quickLogin.saved()
        if (s == null || s.persistent) {
            c.locked.value = false
            return
        }
        scope.launch {
            error = null
            try {
                val cipher = c.quickLogin.decryptCipher(s) ?: throw IllegalStateException("Impronte o volti del telefono cambiati: accedi con la password")
                c.quickLogin.authenticate(activity, "Sblocca CDA Net", s.username, s.strong, cipher)
                c.locked.value = false
            } catch (_: QuickLoginCancelled) {
            } catch (e: Exception) {
                error = e.message
            }
        }
    }
    LaunchedEffect(Unit) { unlock() }
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
        Column(Modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Icon(painterResource(R.drawable.ic_fingerprint), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(72.dp))
            Text("CDA Net è bloccata", style = MaterialTheme.typography.titleLarge)
            Text("Sblocca con impronta o volto per continuare.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            BusyButton("Sblocca", false, Modifier.fillMaxWidth()) { unlock() }
            TextButton(onClick = onLogout) { Text("Esci e accedi con la password") }
        }
    }
}
