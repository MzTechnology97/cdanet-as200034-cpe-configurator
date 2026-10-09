package it.cdanet.cpeconfigurator.ui.screens

import it.cdanet.cpeconfigurator.ui.CheckRow
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import it.cdanet.cpeconfigurator.R
import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.CpeLocation
import it.cdanet.cpeconfigurator.data.JobDto
import it.cdanet.cpeconfigurator.data.KoMeasures
import it.cdanet.cpeconfigurator.field.AirosStatus
import it.cdanet.cpeconfigurator.field.AlignmentTone
import it.cdanet.cpeconfigurator.field.CompassTarget
import it.cdanet.cpeconfigurator.field.FieldDiagnosis
import it.cdanet.cpeconfigurator.field.FieldMode
import it.cdanet.cpeconfigurator.field.Verdict
import it.cdanet.cpeconfigurator.install.ApAdvisor
import it.cdanet.cpeconfigurator.install.ApChoice
import it.cdanet.cpeconfigurator.install.InstallMode
import it.cdanet.cpeconfigurator.install.InstallStep
import it.cdanet.cpeconfigurator.network.LocationHelper
import it.cdanet.cpeconfigurator.provisioning.Phase
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.Banner
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import it.cdanet.cpeconfigurator.ui.WifiRequired
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private const val CPE_WIFI = "alla Wi-Fi della CPE (management, es. \"LBE-5AC-Gen2:xxxx\") oppure a quella del router del cliente"

/**
 * Installazione CPE: guided steps from the .cfg to the acceptance test. "Ripuntamento" skips the
 * configuration and starts from the CPE already on the roof (re-aim or move it to a better AP).
 */
@Composable
fun InstallScreen(
    c: AppContainer,
    onOpenCpeWeb: () -> Unit,
    onLogin: () -> Unit,
    onAim: (CompassTarget) -> Unit,
    onCompass: (CompassTarget) -> Unit,
    onPointing: () -> Unit,
    onAlignment: () -> Unit,
    onAcceptance: () -> Unit,
) {
    val st by c.install.state.collectAsState()
    val prov by c.provisioning.state.collectAsState()
    val form by c.provisioning.form.collectAsState()

    // a replacement (Storico → Sostituisci) or a package already prepared: straight into the new installation
    LaunchedEffect(Unit) {
        if (st.mode == null && (form.replaces != null || prov.phase != Phase.Form)) c.install.start(InstallMode.New)
    }
    // the provisioning phases drive the first two steps
    LaunchedEffect(prov.phase, st.mode) {
        if (st.mode != InstallMode.New) return@LaunchedEffect
        when (prov.phase) {
            Phase.Prepared, Phase.Applying -> if (st.step == InstallStep.Config) c.install.go(InstallStep.Write)
            Phase.Form -> if (st.step == InstallStep.Write) c.install.go(InstallStep.Config)
            Phase.Done -> Unit
        }
    }

    val mode = st.mode
    if (mode == null) {
        ModeChooser(c)
        return
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        StepHeader(c, mode, st.step)
        when (st.step) {
            InstallStep.Config -> ConfigStep(c, onLogin)
            InstallStep.Write -> WriteStep(c, onOpenCpeWeb)
            InstallStep.Verify -> CpeStep(c) { VerifyStep(c, mode) }
            InstallStep.Link -> CpeStep(c) { LinkStep(c) }
            InstallStep.Aim -> CpeStep(c) { AimStep(c, onAim, onCompass, onPointing, onAlignment) }
            InstallStep.Final -> FinalStep(c, onAcceptance)
        }
    }
}

@Composable
private fun ModeChooser(c: AppContainer) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Che intervento devi fare?", style = MaterialTheme.typography.titleMedium)
        ModeCard(
            "Nuova installazione",
            "Configurazione (.cfg) con gli AP consigliati dalla tua posizione, scrittura nella CPE, verifica, aggancio all'AP, puntamento con mirino in realtà aumentata, verifica finale e collaudo con foto.",
            primary = true,
        ) { c.install.start(InstallMode.New) }
        ModeCard(
            "CPE già installata: ripuntamento o cambio AP",
            "Salta la configurazione: ti colleghi alla CPE, vedi gli AP che sente, la sposti su un AP migliore se serve, la ripunti e rifai collaudo e foto.",
        ) { c.install.start(InstallMode.Repoint) }
    }
}

@Composable
private fun ModeCard(title: String, text: String, primary: Boolean = false, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = if (primary) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun StepHeader(c: AppContainer, mode: InstallMode, step: InstallStep) {
    val steps = InstallStep.of(mode)
    val current = steps.indexOf(step)
    var leave by remember { mutableStateOf(false) }
    var ko by remember { mutableStateOf(false) }
    val progress by animateFloatAsState((current + 1f) / steps.size, tween(450), label = "step")
    Column(
        Modifier.fillMaxWidth().padding(top = 4.dp).clip(MaterialTheme.shapes.large).background(MaterialTheme.colorScheme.surfaceContainerLow).padding(start = 16.dp, end = 4.dp, top = 14.dp, bottom = 4.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("${mode.title.uppercase()} · PASSO ${current + 1} DI ${steps.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        Text(step.title, style = MaterialTheme.typography.titleLarge)
        LinearProgressIndicator(
            progress = { progress },
            modifier = Modifier.fillMaxWidth().padding(end = 12.dp).height(6.dp).clip(RoundedCornerShape(50)),
            trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            drawStopIndicator = {},
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            if (c.session.state.collectAsState().value != null) TextButton(onClick = { ko = true }) { Text("Segnala KO", color = BadRed) }
            TextButton(onClick = { leave = true }) { Text("Termina") }
        }
    }
    if (ko) {
        KoDialog(
            c,
            installKoContext(c, mode, step),
            onDismiss = { ko = false },
            onRetry = { ko = false },
            onClose = {
                ko = false
                if (c.provisioning.state.value.phase != Phase.Applying) c.provisioning.reset()
                c.install.close()
            },
        )
    }
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        steps.forEachIndexed { i, s ->
            // back to any step already done; the two configuration steps follow the provisioning
            val canGo = i < current && s != InstallStep.Config && s != InstallStep.Write
            AssistChip(
                onClick = { if (canGo) c.install.go(s) },
                label = { Text("${i + 1} · ${s.title}", fontWeight = if (i == current) FontWeight.Bold else FontWeight.Normal) },
                leadingIcon = if (i < current) ({ Icon(painterResource(R.drawable.ic_check_circle_filled), contentDescription = "fatto", tint = GoodGreen, modifier = Modifier.size(18.dp)) }) else null,
                colors = if (i == current) AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.primaryContainer) else AssistChipDefaults.assistChipColors(),
            )
        }
    }
    if (leave) {
        AlertDialog(
            onDismissRequest = { leave = false },
            title = { Text("Terminare l'intervento?") },
            text = { Text("Si torna alla scelta dell'intervento. Un pacchetto di configurazione non ancora scritto viene cancellato.") },
            confirmButton = {
                TextButton(onClick = {
                    leave = false
                    if (c.provisioning.state.value.phase != Phase.Applying) c.provisioning.reset()
                    c.install.close()
                }) { Text("Termina") }
            },
            dismissButton = { TextButton(onClick = { leave = false }) { Text("Continua") } },
        )
    }
}

/** Installation, CPE and last measures known at this step: attached to the KO report by the app. */
private fun installKoContext(c: AppContainer, mode: InstallMode, step: InstallStep): KoContext {
    val st = c.install.state.value
    val prov = c.provisioning.state.value
    val s = c.field.state.value.status
    val ap = st.pointing?.aps?.firstOrNull { it.ssid.equals(s?.essid ?: st.expectedSsid, ignoreCase = true) }
    return KoContext(
        jobId = st.job?.id ?: prov.pkg?.jobId ?: prov.doneJobId,
        mode = if (mode == InstallMode.New) "new" else "repoint",
        step = step.name.lowercase(),
        mac = s?.macs?.firstOrNull() ?: st.job?.mac ?: c.provisioning.form.value.mac.ifBlank { null },
        ssid = s?.essid?.takeIf { s.associated } ?: st.expectedSsid,
        measures = KoMeasures(
            signal = s?.signal?.takeIf { s.associated },
            expectedSignal = s?.expectedSignal,
            distanceM = s?.distanceM ?: ap?.distanceM,
            apName = s?.apName ?: ap?.name,
            associated = s?.associated,
        ),
    )
}

@Composable
private fun NextButton(c: AppContainer, label: String, enabled: Boolean = true) {
    BusyButton(label, false, Modifier.fillMaxWidth(), enabled = enabled) { c.install.next() }
}

// ---- 1 · Configurazione ---------------------------------------------------------------------

@Composable
private fun ConfigStep(c: AppContainer, onLogin: () -> Unit) {
    val session by c.session.state.collectAsState()
    val prov by c.provisioning.state.collectAsState()
    ErrorBanner(prov.error) { c.provisioning.clearError() }
    if (session == null) {
        Banner("Per preparare la configurazione accedi al server mentre sei online.", WarnAmber)
        OutlinedButton(onClick = onLogin) { Text("Accedi") }
        return
    }
    ProvisionFormStep(c)
}

/** AP consigliati prima dell'installazione: from the position, by expected signal and distance. */
@Composable
fun BestApsBeforeInstall(c: AppContainer, location: CpeLocation, selectedSsid: String, onPick: (ApChoice) -> Unit) {
    val st by c.install.state.collectAsState()
    var configured by remember { mutableStateOf<Set<String>?>(null) }
    LaunchedEffect(location) {
        c.install.locate(location)
        if (configured == null) configured = runCatching { c.api.wirelessNetworks() }.getOrNull()
    }
    ErrorBanner(st.pointingError)
    val p = st.pointing
    if (p == null) {
        if (st.pointingError == null) Text("Ricerca degli AP migliori…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    val choices = ApAdvisor.beforeInstall(p.aps, configured).take(5)
    if (choices.isEmpty()) {
        Text(
            if (p.restricted && p.assignedCount == 0) "Nessun POP/AP assegnato al tuo account: chiedi all'amministratore." else "Nessun AP CDA Net entro ${p.maxKm} km.",
            color = MaterialTheme.colorScheme.error,
        )
        return
    }
    Text("AP consigliati da qui", fontWeight = FontWeight.SemiBold)
    choices.forEachIndexed { i, a ->
        if (i > 0) HorizontalDivider()
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    "${a.name}${if (a.recommended) " · consigliato" else ""}",
                    fontWeight = FontWeight.SemiBold,
                    color = if (a.recommended) GoodGreen else MaterialTheme.colorScheme.onSurface,
                )
                Text(a.ssid, style = MaterialTheme.typography.bodySmall)
                Text(a.describe(), style = MaterialTheme.typography.bodySmall)
                a.ap?.estimate?.describe()?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            if (a.ssid.equals(selectedSsid, ignoreCase = true)) Text("scelto", color = GoodGreen, fontWeight = FontWeight.SemiBold)
            else OutlinedButton(onClick = { onPick(a) }, enabled = a.usable) { Text("Usa") }
        }
    }
}

// ---- 2 · Scrittura nella CPE ----------------------------------------------------------------

@Composable
private fun WriteStep(c: AppContainer, onOpenCpeWeb: () -> Unit) {
    val prov by c.provisioning.state.collectAsState()
    val pending by c.resultQueue.pending.collectAsState()
    ErrorBanner(prov.error.takeIf { prov.phase != Phase.Done }) { c.provisioning.clearError() }
    when (prov.phase) {
        Phase.Prepared, Phase.Applying -> WifiRequired(
            c,
            "alla Wi-Fi di management della CPE nuova (es. \"LBE-5AC-Gen2:xxxx\", IP ${prov.pkg?.target?.host ?: "192.168.172.1"})",
            "La configurazione preparata viene scritta sulla CPE in rete locale: Internet non serve.",
        ) { ProvisionApplyStep(c, onOpenCpeWeb) }
        Phase.Done -> {
            val ok = prov.success == true
            SectionCard(if (ok) "Configurazione scritta" else "Scrittura non riuscita") {
                Banner(
                    if (ok) "La CPE si sta riavviando con la nuova configurazione (1-2 minuti)." else prov.error ?: "Errore sconosciuto",
                    if (ok) GoodGreen else BadRed,
                )
                prov.stages.forEach { Text("✓ $it", style = MaterialTheme.typography.bodyMedium) }
                Text(
                    if (pending.isEmpty()) "Esito registrato sul server." else "Esito salvato sul telefono: verrà inviato al server quando torni online.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (ok) {
                Text("Dopo il riavvio ricollegati alla Wi-Fi di management della CPE (o a quella del router del cliente) per le verifiche.", style = MaterialTheme.typography.bodySmall)
                BusyButton("Avanti: verifica della CPE", false, Modifier.fillMaxWidth()) {
                    val s = prov.doneSummary
                    val id = prov.doneJobId
                    if (s != null && id != null) {
                        c.install.provisioned(
                            JobDto(id = id, createdAt = "", status = "success", model = s.model, template = s.template, mac = s.mac, serial = s.serial, ssid = s.ssid, pppoeUser = s.pppoeUser, deviceName = s.deviceName),
                        )
                    }
                    c.install.next()
                }
            } else if (prov.pkg != null) {
                BusyButton("Riprova con lo stesso pacchetto", false, Modifier.fillMaxWidth()) { c.provisioning.retry() }
            } else {
                BusyButton("Torna alla configurazione", false, Modifier.fillMaxWidth(), primary = false) { c.provisioning.reset() }
            }
        }
        Phase.Form -> Text("Prepara prima la configurazione.")
    }
}

// ---- Live CPE (steps 3-6) -------------------------------------------------------------------

/** Credentials, Wi-Fi and live polling of the CPE for the steps that talk to it. */
@Composable
private fun CpeStep(c: AppContainer, content: @Composable () -> Unit) {
    var ready by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(Unit) { ready = c.field.prefetch("alignment") }
    if (ready == false) {
        Banner("Credenziali CPE non disponibili: accedi al server con Internet attivo e riapri l'installazione.", BadRed)
        return
    }
    if (ready == null) return
    WifiRequired(c, CPE_WIFI, "Segnale e configurazione si leggono direttamente dalla CPE.") {
        val view = LocalView.current
        val relink by c.install.state.collectAsState()
        DisposableEffect(Unit) {
            view.keepScreenOn = true
            if (relink.relink?.running != true) c.field.start(FieldMode.Alignment)
            onDispose {
                view.keepScreenOn = false
                c.field.onSample = null
                c.field.stop()
            }
        }
        RememberPhonePosition(c)
        content()
    }
}

/** Phone GPS once per installation: distance, direction and tilt of the APs from here. */
@Composable
private fun RememberPhonePosition(c: AppContainer) {
    val context = LocalContext.current
    val st by c.install.state.collectAsState()
    val gps = remember { LocationHelper(context) }
    LaunchedEffect(Unit) {
        if (st.pointing == null && c.moduleOn("compass") && gps.hasPermission()) {
            runCatching { gps.current() }.onSuccess { c.install.locate(it) }
        }
    }
}

@Composable
private fun LinkSummary(s: AirosStatus, c: AppContainer) {
    val t = c.field.thresholds
    val v = FieldDiagnosis.signalVerdict(s.signal, t)
    if (!s.associated) {
        Banner("CPE non agganciata${s.essid?.let { " (SSID configurato: $it)" } ?: ""}.", BadRed)
        return
    }
    KeyValue("AP", listOfNotNull(s.apName, s.apMac).joinToString(" · ").ifBlank { "—" })
    KeyValue("SSID", s.essid ?: "—")
    Text(
        "${s.signal ?: "—"} dBm" + (s.snr?.let { " · SNR $it dB" } ?: ""),
        style = MaterialTheme.typography.titleLarge,
        fontWeight = FontWeight.Bold,
        color = when (v) { Verdict.Ok -> GoodGreen; Verdict.Warn -> WarnAmber; else -> BadRed },
    )
    s.rxModulation?.let { KeyValue("Modulazione", "↓ $it" + (s.txModulation?.let { tx -> " · ↑ $tx" } ?: "")) }
    s.distanceM?.let { KeyValue("Distanza", FieldDiagnosis.formatDistance(it)) }
}

// ---- 3 · Verifica della CPE -----------------------------------------------------------------

@Composable
private fun VerifyStep(c: AppContainer, mode: InstallMode) {
    val f by c.field.state.collectAsState()
    val st by c.install.state.collectAsState()
    FieldConnection(c, FieldMode.Alignment)
    val s = f.status ?: return
    LaunchedEffect(s.macs) { if (mode == InstallMode.Repoint) c.install.lookupJob(s.macs) }

    SectionCard("CPE collegata") {
        KeyValue("Nome", s.hostname ?: "—")
        KeyValue("Modello", s.model ?: "—")
        KeyValue("Firmware", s.firmware ?: "—")
        if (s.macs.isNotEmpty()) KeyValue("MAC", s.macs.first())
        s.uptimeSec?.let { KeyValue("Accesa da", FieldDiagnosis.formatDuration(it)) }
        KeyValue("SSID configurato", s.essid ?: "—")
    }

    val job = st.job
    if (mode == InstallMode.New && job != null) {
        val checks = buildList {
            add(
                if (s.essid.equals(job.ssid, ignoreCase = true)) Triple("SSID", Verdict.Ok, job.ssid)
                else Triple("SSID", Verdict.Bad, "La CPE ha ${s.essid ?: "nessun SSID"} invece di ${job.ssid}: la configurazione non risulta applicata"),
            )
            if (job.deviceName.isNotBlank()) add(
                if (s.hostname.equals(job.deviceName, ignoreCase = true)) Triple("Nome dispositivo", Verdict.Ok, job.deviceName)
                else Triple("Nome dispositivo", Verdict.Warn, "${s.hostname ?: "—"} invece di ${job.deviceName}"),
            )
            add(
                if (f.credentialsUsed == "CDA Net") Triple("Credenziali", Verdict.Ok, "Credenziali CDA Net attive")
                else Triple("Credenziali", Verdict.Bad, "La CPE risponde con credenziali ${f.credentialsUsed ?: "diverse"}: la configurazione non è stata salvata"),
            )
        }
        val fw = FieldDiagnosis.checks(s, c.field.thresholds, c.field.targetFirmware).filter { it.title == "Firmware" || it.title == "PPPoE" || it.title == "Porta LAN (cavo)" }
        SectionCard("Convalida della configurazione") {
            checks.forEach { (title, v, detail) -> CheckLine(title, v, detail) }
            fw.forEach { CheckLine(it.title, it.verdict, it.detail) }
        }
    }
    if (mode == InstallMode.Repoint) {
        SectionCard("Installazione") {
            when {
                !st.jobLooked -> Text("Ricerca della CPE nello storico…", style = MaterialTheme.typography.bodySmall)
                job != null -> {
                    KeyValue("Cliente", job.deviceName.ifBlank { job.pppoeUser })
                    KeyValue("Installata il", job.createdAt.take(10).split('-').reversed().joinToString("/"))
                    KeyValue("SSID originale", job.ssid)
                    Text("Collaudo e foto finali verranno aggiunti a questa installazione.", style = MaterialTheme.typography.bodySmall)
                }
                else -> Text(
                    "CPE non presente tra le installazioni a te visibili (installata prima dell'app o da altri): ripuntamento e cambio AP funzionano, il collaudo finale si potrà condividere ma non salvare sul server.",
                    style = MaterialTheme.typography.bodySmall,
                    color = WarnAmber,
                )
            }
        }
    }
    if ((s.uptimeSec ?: Long.MAX_VALUE) < 120 && !s.associated) Banner("CPE appena riavviata: l'aggancio all'AP può richiedere ancora qualche decina di secondi.", WarnAmber)
    NextButton(c, "Avanti: aggancio all'AP")
}

@Composable
private fun CheckLine(title: String, v: Verdict, detail: String) = CheckRow(title, v, detail)

// ---- 4 · Aggancio all'AP --------------------------------------------------------------------

@Composable
private fun LinkStep(c: AppContainer) {
    val scope = rememberCoroutineScope()
    val f by c.field.state.collectAsState()
    val st by c.install.state.collectAsState()
    var configured by remember { mutableStateOf<Set<String>?>(null) }
    var scanning by remember { mutableStateOf(false) }
    var showOthers by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<ApChoice?>(null) }
    LaunchedEffect(Unit) { configured = runCatching { c.api.wirelessNetworks() }.getOrNull() }

    FieldConnection(c, FieldMode.Alignment)
    val s = f.status

    // after a change of AP: the CPE reboots, polling resumes by itself
    val r = st.relink
    if (r != null) {
        SectionCard("Cambio AP: ${r.target.name}") {
            r.stages.forEach { Text("✓ $it", style = MaterialTheme.typography.bodyMedium) }
            r.error?.let { Banner(it, BadRed) }
            if (r.done) {
                val linked = s?.associated == true && s.essid.equals(r.target.ssid, ignoreCase = true)
                Banner(
                    if (linked) "Agganciata a ${r.target.ssid}." else "In attesa che la CPE si riavvii e si agganci a ${r.target.ssid}… Se il telefono si scollega, ricollegalo alla Wi-Fi della CPE o del router.",
                    if (linked) GoodGreen else WarnAmber,
                )
            }
            if (!r.running) TextButton(onClick = { c.install.clearRelink() }) { Text("Chiudi") }
        }
        LaunchedEffect(r.done) {
            if (r.done) {
                delay(5_000)
                c.field.start(FieldMode.Alignment)
            }
        }
    }

    s?.let { SectionCard("Collegamento attuale") { LinkSummary(it, c) } }

    val expected = st.expectedSsid
    if (s != null && s.associated && expected != null && !s.essid.equals(expected, ignoreCase = true)) {
        Banner("La CPE è su ${s.essid}, previsto $expected.", WarnAmber)
    }

    // not linked: show at once what the CPE hears
    LaunchedEffect(s?.associated) {
        if (s != null && !s.associated && st.survey == null && st.relink == null && !scanning) {
            scanning = true
            c.install.survey()
            scanning = false
        }
    }

    SectionCard("AP CDA Net visibili dalla CPE") {
        Text("Scansione fatta dalla radio della CPE: durante la scansione il collegamento può interrompersi per qualche secondo.", style = MaterialTheme.typography.bodySmall)
        BusyButton(if (st.survey == null) "Scansiona dalla CPE" else "Ripeti la scansione", scanning, Modifier.fillMaxWidth(), primary = false, enabled = s != null && r?.running != true) {
            scope.launch {
                scanning = true
                c.install.survey()
                scanning = false
            }
        }
        st.surveyError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        val survey = st.survey
        if (survey != null) {
            val choices = ApAdvisor.fromSurvey(survey, st.pointing?.aps.orEmpty(), s?.takeIf { it.associated }?.essid, configured)
            if (choices.isEmpty()) Text("Nessun AP CDA Net sentito dalla CPE: controlla direzione e ostacoli, poi ripeti.", color = BadRed)
            ApAdvisor.betterThanCurrent(choices)?.let { b ->
                if (s?.associated == true) Banner("AP migliore disponibile: ${b.name} (${b.measured ?: "—"} dBm).", WarnAmber)
            }
            choices.forEachIndexed { i, a ->
                if (i > 0) HorizontalDivider()
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            a.name + listOfNotNull(if (a.current) "agganciato" else null, if (a.recommended) "consigliato" else null).joinToString(" · ", prefix = " · ").takeIf { a.current || a.recommended }.orEmpty(),
                            fontWeight = FontWeight.SemiBold,
                            color = if (a.recommended) GoodGreen else MaterialTheme.colorScheme.onSurface,
                        )
                        Text(a.ssid, style = MaterialTheme.typography.bodySmall)
                        Text(a.describe(), style = MaterialTheme.typography.bodySmall)
                    }
                    if (!a.current) OutlinedButton(onClick = { confirm = a }, enabled = a.usable && r?.running != true) { Text("Aggancia") }
                }
            }
            val others = survey.filter { !ApAdvisor.isCdaNet(it.essid) }
            if (others.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Altre reti sentite (${others.size})", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    Switch(checked = showOthers, onCheckedChange = { showOthers = it })
                }
                if (showOthers) others.forEach { o ->
                    Text("${o.essid.ifBlank { "(nascosta)" }} · ${o.signal ?: "—"} dBm · ${o.frequencyMhz ?: "—"} MHz", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }

    confirm?.let { a ->
        var lock by remember(a) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Agganciare la CPE a ${a.name}?") },
            text = {
                Column {
                    Text("La CPE passa da ${s?.essid ?: "—"} a ${a.ssid} (chiave WPA2 dal server), salva la configurazione e si riavvia: 1-2 minuti senza collegamento.")
                    if (a.bssid != null) Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = lock, onCheckedChange = { lock = it })
                        Text("Blocca la CPE su questo AP (Lock to AP)", style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    scope.launch { c.install.relink(a, s?.macs?.firstOrNull(), s?.essid, lock) }
                }) { Text("Aggancia") }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Annulla") } },
        )
    }

    NextButton(c, if (s?.associated == true) "Avanti: puntamento" else "Avanti comunque: puntamento", enabled = r?.running != true)
}

// ---- 5 · Puntamento -------------------------------------------------------------------------

@Composable
private fun AimStep(c: AppContainer, onAim: (CompassTarget) -> Unit, onCompass: (CompassTarget) -> Unit, onPointing: () -> Unit, onAlignment: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val f by c.field.state.collectAsState()
    val st by c.install.state.collectAsState()
    var sound by remember { mutableStateOf(true) }
    var locating by remember { mutableStateOf(false) }
    val tone = remember { AlignmentTone() }
    LaunchedEffect(sound) { c.field.onSample = if (sound) { smp -> tone.beep(smp.signal) } else null }

    FieldConnection(c, FieldMode.Alignment)
    val s = f.status
    s?.let { AlignmentGauge(it, c.field.thresholds, f.peak, f.history) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Bip di puntamento", modifier = Modifier.weight(1f))
        Switch(checked = sound, onCheckedChange = { sound = it })
    }
    s?.let { cur -> cur.rxModulation?.let { KeyValue("Modulazione", "↓ $it" + (cur.txModulation?.let { tx -> " · ↑ $tx" } ?: "")) } }

    val ssid = s?.takeIf { it.associated }?.essid ?: st.expectedSsid
    val target = c.install.aimTarget(ssid)
    SectionCard("Direzione dell'AP${target?.let { " · ${it.name}" } ?: ""}") {
        if (target != null) {
            KeyValue("Azimut", "${target.bearing}°")
            target.tiltDeg?.let { KeyValue("Tilt", "%+.1f°".format(java.util.Locale.ITALY, it)) }
            target.distanceM?.let { KeyValue("Distanza", FieldDiagnosis.formatDistance(it)) }
            st.pointing?.aps?.firstOrNull { it.ssid.equals(ssid, ignoreCase = true) }?.estimate?.describe()?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            BusyButton("Mirino in realtà aumentata (con segnale)", false, Modifier.fillMaxWidth()) { onAim(target) }
            OutlinedButton(onClick = { onCompass(target) }, modifier = Modifier.fillMaxWidth()) { Text("Bussola verso l'AP") }
        } else {
            Text(
                when {
                    !c.moduleOn("compass") -> "Direzione dell'AP non disponibile per il tuo account."
                    st.pointing == null -> "Serve la posizione del telefono per calcolare direzione e tilt dell'AP."
                    else -> "AP ${ssid ?: ""} non trovato tra quelli vicini a te."
                },
                style = MaterialTheme.typography.bodySmall,
            )
            if (c.moduleOn("compass")) BusyButton("Rileva posizione (GPS)", locating, Modifier.fillMaxWidth(), primary = false) {
                scope.launch {
                    locating = true
                    runCatching { LocationHelper(context).current() }.onSuccess { c.install.locate(it) }
                    locating = false
                }
            }
        }
        if (c.moduleOn("compass")) TextButton(onClick = onPointing) { Text("Mappa e lista degli AP (Trova l'AP)") }
        if (c.moduleOn("field_alignment")) TextButton(onClick = onAlignment) { Text("Puntamento a schermo intero") }
    }
    OutlinedButton(onClick = { c.field.resetPeak() }) { Text("Azzera picco e grafico") }
    NextButton(c, "Avanti: verifica finale")
}

// ---- 6 · Verifica finale e collaudo ---------------------------------------------------------

@Composable
private fun FinalStep(c: AppContainer, onAcceptance: () -> Unit) {
    val context = LocalContext.current
    val f by c.field.state.collectAsState()
    val st by c.install.state.collectAsState()
    CpeStep(c) {
        val s = f.status
        if (s == null) {
            FieldConnection(c, FieldMode.Alignment)
            return@CpeStep
        }
        val checks = FieldDiagnosis.checks(s, c.field.thresholds, c.field.targetFirmware)
        val v = FieldDiagnosis.summary(checks)
        Banner(
            when (v) {
                Verdict.Ok -> "Installazione nei parametri"
                Verdict.Warn -> "Ci sono punti da verificare"
                else -> "Problema rilevato: vedi le voci in rosso"
            },
            when (v) { Verdict.Ok -> GoodGreen; Verdict.Warn -> WarnAmber; else -> BadRed },
        )
        nocApprovalReason(s.signal, c.field.thresholds.signalMin, checks.filter { it.verdict == Verdict.Bad }.map { it.title })?.let {
            Banner("Approvazione NOC necessaria ($it). $NOC_APPROVAL_TEXT", WarnAmber)
        }
        SectionCard("Radio") {
            LinkSummary(s, c)
            s.cinrRx?.let { KeyValue("CINR", "$it dB") }
            s.remoteSignal?.let { KeyValue("Segnale lato AP", "$it dBm") }
            if (s.chains.size >= 2) KeyValue("Catene", s.chains.joinToString(" / ") + " dBm")
            s.dlCapacityMbps?.let { KeyValue("Capacità airMAX", "${it.roundToInt()} / ${s.ulCapacityMbps?.roundToInt() ?: "—"} Mbit/s") }
            s.noise?.let { KeyValue("Rumore", "$it dBm") }
        }
        SectionCard("Controlli") { checks.forEach { CheckLine(it.title, it.verdict, it.detail) } }

        val job = st.job
        SectionCard("Collaudo") {
            if (job != null && c.moduleOn("acceptance")) {
                Text("Misure mediate, test di velocità dal lato cliente, foto e note: il verbale si stampa dalla console.", style = MaterialTheme.typography.bodySmall)
                BusyButton("Apri il collaudo", false, Modifier.fillMaxWidth()) {
                    c.selectedJob.value = job
                    onAcceptance()
                }
            } else {
                Text(
                    if (job == null) "CPE non presente tra le tue installazioni: il collaudo non si salva sul server, puoi condividere il rapporto con il NOC."
                    else "Collaudo non disponibile per il tuo account.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            OutlinedButton(onClick = {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, FieldDiagnosis.report(s, checks))
                context.startActivity(Intent.createChooser(send, "Invia rapporto"))
            }, modifier = Modifier.fillMaxWidth()) { Text("Condividi rapporto") }
        }
        BusyButton("Fine intervento", false, Modifier.fillMaxWidth(), primary = false) {
            if (c.provisioning.state.value.phase == Phase.Done) c.provisioning.reset()
            c.install.close()
        }
    }
}
