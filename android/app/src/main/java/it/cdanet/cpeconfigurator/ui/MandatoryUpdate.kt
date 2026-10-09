package it.cdanet.cpeconfigurator.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.BuildConfig
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.update.UpdateInfo
import it.cdanet.cpeconfigurator.update.UpdateState
import kotlinx.coroutines.launch

/** Downloads the APK (SHA-256 checked) and opens the Android installer; reports each step. */
suspend fun startUpdate(c: AppContainer, info: UpdateInfo, onState: (UpdateState) -> Unit) {
    if (!c.updater.canInstall()) {
        onState(UpdateState.PermissionRequired)
        c.updater.openInstallPermissionSettings()
        return
    }
    onState(UpdateState.Downloading(info))
    onState(
        runCatching { c.updater.download(info) }.fold(
            onSuccess = { apk ->
                c.updater.install(apk)
                UpdateState.ReadyToInstall(info)
            },
            onFailure = { UpdateState.Failed(it.message ?: "Download non riuscito") },
        ),
    )
}

/**
 * The app is too old for the server ("App sempre all'ultima versione"): nothing else is usable,
 * neither login nor tools, until the new version is installed. The download starts by itself.
 */
@Composable
fun MandatoryUpdateScreen(c: AppContainer, info: UpdateInfo?, minVersion: String?, state: UpdateState, onState: (UpdateState) -> Unit, onRecheck: () -> Unit) {
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(painterResource(R.drawable.cda_net_logo), contentDescription = "CDA Net", modifier = Modifier.fillMaxWidth(0.6f).padding(top = 24.dp))
        Text("Aggiornamento obbligatorio", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(
            "È disponibile la versione ${info?.versionName ?: minVersion ?: "nuova"} dell'app: va installata per accedere e usare gli strumenti. " +
                "Versione installata: ${BuildConfig.VERSION_NAME}.",
            style = MaterialTheme.typography.bodyMedium,
        )
        when (state) {
            is UpdateState.Downloading -> {
                Text("Download e verifica dell'aggiornamento…")
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            is UpdateState.ReadyToInstall -> {
                Text("Conferma l'installazione nella schermata di Android. Al termine riapri l'app.")
                OutlinedButton(onClick = { scope.launch { startUpdate(c, state.info, onState) } }, modifier = Modifier.fillMaxWidth()) { Text("Installa di nuovo") }
            }
            is UpdateState.PermissionRequired -> {
                Text("Consenti a CDA Net di installare app (\"Installa app sconosciute\"), poi torna qui.")
                OutlinedButton(onClick = { c.updater.openInstallPermissionSettings() }, modifier = Modifier.fillMaxWidth()) { Text("Apri l'autorizzazione") }
                BusyButton("Ho autorizzato, installa", false, Modifier.fillMaxWidth()) { info?.let { i -> scope.launch { startUpdate(c, i, onState) } } ?: onRecheck() }
            }
            is UpdateState.Failed -> {
                Banner("Aggiornamento non riuscito: ${state.message}", BadRed)
                BusyButton("Riprova", false, Modifier.fillMaxWidth()) { info?.let { i -> scope.launch { startUpdate(c, i, onState) } } ?: onRecheck() }
            }
            else -> if (info != null) {
                BusyButton("Scarica e installa", false, Modifier.fillMaxWidth()) { scope.launch { startUpdate(c, info, onState) } }
            } else {
                Text("Non riesco a scaricare l'aggiornamento dal server: controlla la connessione.", color = MaterialTheme.colorScheme.error)
                BusyButton("Riprova", false, Modifier.fillMaxWidth()) { onRecheck() }
            }
        }
    }
}
