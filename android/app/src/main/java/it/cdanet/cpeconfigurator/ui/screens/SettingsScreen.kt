package it.cdanet.cpeconfigurator.ui.screens

import it.cdanet.cpeconfigurator.ui.localTime
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.QuickLoginCard
import android.content.Intent
import android.net.Uri
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.BuildConfig
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.ui.Banner
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import it.cdanet.cpeconfigurator.ui.startUpdate
import it.cdanet.cpeconfigurator.update.UpdateInfo
import it.cdanet.cpeconfigurator.update.UpdateState
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Switch
import androidx.compose.ui.Alignment

@Composable
fun UpdateBanner(c: AppContainer, state: UpdateState, onState: (UpdateState) -> Unit) {
    val scope = rememberCoroutineScope()
    fun install(info: UpdateInfo) {
        scope.launch { startUpdate(c, info, onState) }
    }
    when (state) {
        is UpdateState.Available -> SectionCard("Aggiornamento disponibile", icon = it.cdanet.cpeconfigurator.R.drawable.ic_rocket_launch) {
            Text("Versione ${state.info.versionName}${if (state.info.mandatory) " (obbligatorio)" else ""}")
            BusyButton(if (c.updater.fromStore) "Aggiorna dal Play Store" else "Scarica e installa", busy = false, modifier = Modifier.fillMaxWidth()) { install(state.info) }
        }
        is UpdateState.Downloading -> Banner("Download ${state.info.versionName} e verifica SHA-256…", WarnAmber)
        is UpdateState.ReadyToInstall -> SectionCard("Aggiornamento pronto", icon = it.cdanet.cpeconfigurator.R.drawable.ic_rocket_launch) {
            Text(if (c.updater.fromStore) "Aggiorna l'app dal Play Store, poi riaprila." else "Conferma l'installazione nella schermata di Android.")
            SecondaryButton(onClick = { install(state.info) }) { Text("Riprova") }
        }
        is UpdateState.PermissionRequired -> SectionCard("Autorizzazione richiesta", icon = it.cdanet.cpeconfigurator.R.drawable.ic_lock) {
            Text("Consenti a CDA Net di installare app (\"Installa app sconosciute\"), poi torna qui.")
            SecondaryButton(onClick = { scope.launch { onState(runCatching { c.updater.check() }.getOrNull()?.let { UpdateState.Available(it) } ?: UpdateState.UpToDate) } }) {
                Text("Ho autorizzato, riprova")
            }
        }
        is UpdateState.Failed -> Banner("Aggiornamento non riuscito: ${state.message}", BadRed) { onState(UpdateState.Idle) }
        else -> Unit
    }
}

@Composable
private fun PasswordCard(c: AppContainer, onDone: (String) -> Unit, onError: (String?) -> Unit) {
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val tooShort = next.isNotEmpty() && next.length < 12
    val mismatch = again.isNotEmpty() && again != next
    SectionCard("Cambia password", icon = it.cdanet.cpeconfigurator.R.drawable.ic_lock) {
        Field("Password attuale", current, { current = it }, password = true)
        Field("Nuova password", next, { next = it }, password = true, isError = tooShort, supporting = "Almeno 12 caratteri")
        Field("Ripeti la nuova password", again, { again = it }, password = true, isError = mismatch, supporting = if (mismatch) "Le password non coincidono" else null)
        BusyButton(
            "Cambia password",
            busy,
            Modifier.fillMaxWidth(),
            enabled = current.isNotEmpty() && next.length >= 12 && next == again,
        ) {
            scope.launch {
                busy = true
                try {
                    c.api.changePassword(current, next)
                    current = ""; next = ""; again = ""
                    onDone("Password cambiata: le altre sessioni sono state chiuse")
                } catch (e: Exception) {
                    onError(e.message)
                } finally {
                    busy = false
                }
            }
        }
    }
}

@Composable
fun SettingsScreen(c: AppContainer, update: UpdateState, onUpdate: (UpdateState) -> Unit, onLogout: () -> Unit, onComponents: () -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val session by c.session.state.collectAsState()
    val pending by c.resultQueue.pending.collectAsState()
    var msg by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        msg?.let { Banner(it, GoodGreen) { msg = null } }
        UpdateBanner(c, update, onUpdate)

        SectionCard("Account", icon = it.cdanet.cpeconfigurator.R.drawable.ic_person) {
            KeyValue("Utente", session?.user?.let { "${it.username} (${if (it.role == "admin") "amministratore" else "installatore"})" } ?: "non connesso")
            // with the persistent login the session renews by itself: its expiry is in "Accesso su questo telefono"
            if (c.quickLogin.saved() == null) KeyValue("Sessione fino a", session?.expiresAt?.let { localTime(it) } ?: "—")
            SecondaryButton(onClick = onLogout) { Text(if (session != null) "Esci" else "Torna al login") }
        }

        if (session != null) {
            PasswordCard(c, onDone = { msg = it }, onError = { error = it })
            QuickLoginCard(c)
            PersonalTelegramCard(c)
            SectionCard("Sessioni", icon = it.cdanet.cpeconfigurator.R.drawable.ic_logout) {
                Text("Telefono perso o accesso da un dispositivo condiviso? Chiudi tutte le sessioni dell'account, anche questa.", style = MaterialTheme.typography.bodySmall)
                SecondaryButton(onClick = {
                    scope.launch {
                        runCatching { c.api.logoutAll() }.onFailure { error = it.message }.onSuccess { onLogout() }
                    }
                }) { Text("Esci da tutti i dispositivi") }
            }
            // screenshots blocked on this account: whether Android tells the app about the attempts
            if (c.secureScreen.collectAsState().value) SectionCard("Screenshot", icon = it.cdanet.cpeconfigurator.R.drawable.ic_logout) {
                Text("Su questo account screenshot e registrazioni dello schermo sono bloccati: l'immagine esce nera e il NOC riceve un avviso.", style = MaterialTheme.typography.bodySmall)
                val last = c.captureReports.last.collectAsState().value
                KeyValue(
                    "Ultimo rilevato",
                    last?.let { seen ->
                        (if (seen.kind == "recording") "registrazione · " else "screenshot · ") + it.cdanet.cpeconfigurator.ui.localTime(seen.at) +
                            if (seen.sent) " · avviso inviato" else " · avviso in attesa di rete"
                    } ?: "nessuno su questo telefono",
                )
            }
        }

        // the server is built into the app (address and certificate): only whether it answers
        SectionCard("Server", icon = it.cdanet.cpeconfigurator.R.drawable.ic_dns) {
            BusyButton("Verifica collegamento", busy, Modifier.fillMaxWidth()) {
                scope.launch {
                    busy = true
                    try {
                        val h = c.api.health()
                        msg = "Server raggiungibile · v${h.version}"
                    } catch (e: Exception) {
                        error = e.message
                    } finally {
                        busy = false
                    }
                }
            }
        }

        SectionCard("Esiti in coda", icon = it.cdanet.cpeconfigurator.R.drawable.ic_cloud_off) {
            Text("${pending.size} esiti di provisioning in attesa di invio.")
            val acc by c.acceptanceQueue.pending.collectAsState()
            if (acc.isNotEmpty()) {
                Text("${acc.size} collaudi in coda (${acc.sumOf { it.photos.size }} foto).")
                acc.forEach { Text("• ${it.label}${if (it.report != null) " · misure" else ""}${if (it.photos.isNotEmpty()) " · ${it.photos.size} foto" else ""}", style = MaterialTheme.typography.bodySmall) }
                BusyButton("Invia collaudi ora", busy, Modifier.fillMaxWidth(), enabled = session != null) {
                    scope.launch {
                        busy = true
                        val n = runCatching { c.acceptanceQueue.sync() }.getOrDefault(0)
                        msg = "Collaudi inviati: $n"
                        busy = false
                    }
                }
            }
            pending.forEach { Text("• ${it.label} · ${it.result.result}", style = MaterialTheme.typography.bodySmall) }
            if (pending.isNotEmpty()) {
                BusyButton("Invia ora", busy, Modifier.fillMaxWidth(), enabled = session != null) {
                    scope.launch {
                        busy = true
                        val n = runCatching { c.resultQueue.sync() }.getOrDefault(0)
                        msg = "Inviati $n esiti"
                        busy = false
                    }
                }
            }
        }

        SectionCard("App", icon = it.cdanet.cpeconfigurator.R.drawable.ic_info) {
            KeyValue("Versione", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            SecondaryButton(onClick = {
                scope.launch {
                    onUpdate(UpdateState.Checking)
                    val next = runCatching { c.updater.check() }.fold(
                        onSuccess = { it?.let { info -> UpdateState.Available(info) } ?: UpdateState.UpToDate },
                        onFailure = { UpdateState.Failed(it.message ?: "Verifica non riuscita") },
                    )
                    onUpdate(next)
                    if (next is UpdateState.UpToDate) msg = "L'app è aggiornata"
                }
            }) { Text("Verifica aggiornamenti") }
            SecondaryButton(onClick = {
                context.startActivity(Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
            }) { Text("Permessi dell'app") }
            if (BuildConfig.DEBUG) SecondaryButton(onClick = onComponents) { Text("Componenti dell'interfaccia") }
        }
    }
}
