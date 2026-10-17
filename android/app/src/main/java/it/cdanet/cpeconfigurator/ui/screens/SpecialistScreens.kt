package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.ApiException
import it.cdanet.cpeconfigurator.data.SpecConnectorDto
import it.cdanet.cpeconfigurator.data.SpecJobDto
import it.cdanet.cpeconfigurator.data.SpecJobsDto
import it.cdanet.cpeconfigurator.data.SpecSiteDto
import it.cdanet.cpeconfigurator.data.SpecSummaryDto
import it.cdanet.cpeconfigurator.data.SpecUispStateDto
import it.cdanet.cpeconfigurator.data.specAuthorize
import it.cdanet.cpeconfigurator.data.specDeleteJob
import it.cdanet.cpeconfigurator.data.specJobs
import it.cdanet.cpeconfigurator.data.specSites
import it.cdanet.cpeconfigurator.data.specSummary
import it.cdanet.cpeconfigurator.data.specUispState
import it.cdanet.cpeconfigurator.field.AirosStatus
import it.cdanet.cpeconfigurator.specialist.SpecForm
import it.cdanet.cpeconfigurator.specialist.SpecState
import it.cdanet.cpeconfigurator.specialist.SpecialistRules
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.Dropdown
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.KeepScreenOn
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.ListHeader
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.PrimaryButton
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.Segmented
import it.cdanet.cpeconfigurator.ui.StatTile
import it.cdanet.cpeconfigurator.ui.StatusChip
import it.cdanet.cpeconfigurator.ui.Tone
import it.cdanet.cpeconfigurator.ui.WifiRequired
import it.cdanet.cpeconfigurator.ui.localTime
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.util.Locale

/** Tabs of the Specialist's area (pure: Home and the shortcuts open one of them). */
val SPECIALIST_TABS = listOf("Nuova CPE", "Storico", "Template")

/**
 * «Specialist» (owner, 17/10/2026): his own flow for the CPEs of the companies he works for, his
 * history and his templates. CDA Net's installation stays as it is, for the installers.
 */
@Composable
fun SpecialistHub(c: AppContainer, selected: Int, onSelect: (Int) -> Unit, onEditTemplate: () -> Unit) {
    if (!c.session.isSpecialist) {
        EmptyState(R.drawable.ic_lock, "Sezione dello Specialist", "La vede solo l'account Specialist.")
        return
    }
    TabbedHub(
        listOf(
            HubTab(SPECIALIST_TABS[0], R.drawable.ic_settings_input_antenna) { SpecialistFlow(c, onTemplates = { onSelect(2) }) },
            HubTab(SPECIALIST_TABS[1], R.drawable.ic_history) { SpecialistHistory(c) },
            HubTab(SPECIALIST_TABS[2], R.drawable.ic_memory) { SpecialistTemplateList(c, onEdit = onEditTemplate) },
        ),
        selected,
        onSelect,
    )
}

// ---- the flow ---------------------------------------------------------------------------------------

/**
 * First the configuration, then the CPE (owner, 17/10/2026): the configuration is prepared without
 * the management Wi-Fi (the model is the template's), then the CPE is found, read and written. Who
 * is already on the CPE's Wi-Fi may read it first: the configuration then is for that CPE.
 */
@Composable
fun SpecialistFlow(c: AppContainer, onTemplates: () -> Unit) {
    val s = c.specialist.state.collectAsState().value
    val f = c.specialist.form.collectAsState().value
    val refresh = c.refresh.collectAsState().value
    LaunchedEffect(refresh) { c.specialist.loadLists() }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(bottom = 16.dp)) {
        val done = s.done
        val pkg = s.pkg
        // a CPE already read or being looked for: the configuration is for it
        val withCpe = s.readFirst || s.cpe != null || s.device != null || s.candidates.isNotEmpty() || s.authFailed
        when {
            done != null && done.ok -> AfterWrite(c, s)
            pkg != null && pkg.needsCpe -> {
                // prepared before connecting to the CPE: now the CPE, its firmware, the write
                CpeCard(c, s, f, "2 · CPE collegata")
                if (s.cpe != null) FirmwareCard(c, s, "3 · Firmware")
                WriteCard(c, s, f, "4 · Scrittura nella CPE")
            }
            pkg != null -> WriteCard(c, s, f, "4 · Scrittura nella CPE")
            withCpe -> {
                CpeCard(c, s, f, "1 · CPE collegata")
                if (s.cpe == null) {
                    TextButton(onClick = { c.specialist.readFirst(false) }, enabled = s.busy == null) { Text("Prepara prima la configurazione, senza CPE") }
                } else {
                    FirmwareCard(c, s, "2 · Firmware")
                    ConfigCard(c, s, f, onTemplates, "3 · Configurazione")
                }
            }
            else -> {
                Notice(
                    "CPE di altre aziende, con i tuoi template e i tuoi connettori. Prima prepari la configurazione (serve Internet, non la Wi-Fi della CPE), poi ti colleghi alla CPE: l'app ne legge MAC, seriale, modello e firmware e la scrive. Il collaudo è facoltativo, senza NOC.",
                    NoticeKind.Info,
                )
                ConfigCard(c, s, f, onTemplates, "1 · Configurazione")
                SectionCard("2 · CPE", icon = R.drawable.ic_radar) {
                    Text(
                        "Dopo «Prepara la configurazione» ti colleghi alla Wi-Fi di management della CPE: l'app la trova, la legge e la scrive. Lì Internet non serve.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    TextButton(onClick = { c.specialist.readFirst(true) }) { Text("Sono già sulla Wi-Fi della CPE: leggila ora") }
                }
            }
        }
    }
}

/** The error of one step, under its card. */
@Composable
private fun StepError(s: SpecState, vararg steps: String) {
    val e = s.error ?: return
    val at = s.errorAt ?: return
    if (at in steps) Notice(e, NoticeKind.Bad)
}

/** The CPE on the phone's Wi-Fi: found by the discovery, read over SSH ([title]: its step in the flow). */
@Composable
private fun CpeCard(c: AppContainer, s: SpecState, f: SpecForm, title: String) {
    var showCurrent by remember { mutableStateOf(false) }
    WifiRequired(c, "alla Wi-Fi di management della CPE", "La discovery trova la CPE in rete locale, qualunque sia il suo IP.") {
        // at opening (and after «Cerca di nuovo»), then every 8 seconds while no CPE answers (its Wi-Fi may come later)
        val waiting = s.cpe == null && s.candidates.isEmpty() && !s.authFailed && s.device == null
        LaunchedEffect(waiting) {
            while (waiting) {
                c.specialist.search()
                val now = c.specialist.state.value
                if (now.cpe != null || now.candidates.isNotEmpty() || now.authFailed || now.device != null) break
                delay(8_000)
            }
        }
        SectionCard(title, icon = R.drawable.ic_radar) {
            val cpe = s.cpe
            when {
                cpe != null -> {
                    KeyValue("Modello", cpe.model ?: "${cpe.product} (non supportato)")
                    KeyValue("MAC", cpe.mac)
                    KeyValue("Seriale", cpe.serial)
                    KeyValue("Firmware", cpe.build?.version ?: cpe.firmware ?: "—")
                    cpe.board?.let { KeyValue("Board", it) }
                    KeyValue("IP", if (cpe.sshPort == 22) cpe.ip else "${cpe.ip} · SSH ${cpe.sshPort}")
                    KeyValue(
                        "Configurazione",
                        when (cpe.factory) {
                            true -> "di fabbrica"
                            false -> "già configurata: verrà sovrascritta"
                            null -> "—"
                        },
                    )
                    KeyValue("Accesso", cpe.loginLabel)
                    if (cpe.model == null) Notice("Modello non previsto dai template: ${cpe.product}.", NoticeKind.Bad)
                }
                s.busy == "read" -> Text("Lettura della CPE ${s.device?.ip.orEmpty()} via SSH…", style = MaterialTheme.typography.bodyMedium)
                s.busy == "search" -> Text("Ricerca della CPE sulla Wi-Fi…", style = MaterialTheme.typography.bodyMedium)
                s.candidates.isNotEmpty() -> {
                    Text("Rispondono ${s.candidates.size} apparati Ubiquiti: scegli la CPE da configurare.", style = MaterialTheme.typography.bodyMedium)
                    s.candidates.forEach { d ->
                        SecondaryButton(onClick = { c.scope.launch { c.specialist.read(d) } }, modifier = Modifier.fillMaxWidth(), enabled = s.busy == null) {
                            Text(listOfNotNull(d.product ?: d.model, d.ip, d.mac).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                else -> Text(
                    if (s.searched) "Nessuna CPE Ubiquiti risponde su questa Wi-Fi: riprovo da solo." else "Collegati alla Wi-Fi della CPE: l'app la cerca da sola.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (s.authFailed) Notice("La CPE rifiuta le credenziali di fabbrica: scrivi quelle che ha ora (per esempio dell'azienda che l'ha configurata).", NoticeKind.Warn)
            if (s.authFailed || showCurrent) {
                Field("Utente attuale della CPE", f.currentUser, { v -> c.specialist.updateForm { it.copy(currentUser = v.take(64)) } })
                Field(
                    "Password attuale della CPE",
                    f.currentPassword,
                    { v -> c.specialist.updateForm { it.copy(currentPassword = v.take(200)) } },
                    password = true,
                    supporting = "Solo per entrare ora nella CPE: mai salvata",
                )
            }
            StepError(s, "search", "read")
            val d = s.device
            if (d != null && cpe == null && s.busy == null && s.candidates.isEmpty()) {
                PrimaryButton(onClick = { c.scope.launch { c.specialist.read(d) } }, modifier = Modifier.fillMaxWidth()) { Text("Leggi la CPE") }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                SecondaryButton(onClick = { c.specialist.forgetCpe(); c.scope.launch { c.specialist.search() } }, enabled = s.busy == null) { Text("Cerca di nuovo") }
                Spacer(Modifier.weight(1f))
                if (!s.authFailed && !showCurrent) TextButton(onClick = { showCurrent = true }) { Text("Credenziali attuali") }
            }
        }
    }
}

/** The firmware: updated here when it is not the required one, or kept by choice. */
@Composable
private fun FirmwareCard(c: AppContainer, s: SpecState, title: String) {
    val cpe = s.cpe ?: return
    val build = cpe.build
    val list = c.firmware.savedList()
    val target = list?.target?.takeIf { it.isNotBlank() } ?: "8.7.4"
    var progress by remember { mutableStateOf<Float?>(null) }
    var confirm by remember { mutableStateOf(false) }
    // the CPE must not lose the phone halfway: display on while flashing
    if (s.busy == "firmware") KeepScreenOn()
    SectionCard(title, icon = R.drawable.ic_system_update) {
        when {
            build == null -> Notice("Versione del firmware non leggibile (${cpe.firmware ?: "—"}): la scrittura la controlla di nuovo.", NoticeKind.Warn)
            build.version == target -> Notice("Firmware ${build.version}: è quello richiesto.", NoticeKind.Good)
            s.keepFirmware -> {
                Notice("Tieni il firmware ${build.version}: la configurazione si scrive su questo.", NoticeKind.Info)
                TextButton(onClick = { c.specialist.keepFirmware(false) }, enabled = s.busy == null) { Text("Aggiorna invece a $target") }
            }
            else -> {
                Notice("Firmware ${build.version}: il richiesto è $target. Aggiornalo da qui (3-5 minuti) o tieni questo.", NoticeKind.Warn)
                val img = list?.items?.firstOrNull { it.platform == build.platform }
                when {
                    img == null -> Text("Nessun firmware $target per la piattaforma ${build.platform} sul server.", style = MaterialTheme.typography.bodySmall)
                    !c.firmware.has(img) -> BusyButton("Scarica il firmware ${img.version} (serve Internet)", s.busy == "download", Modifier.fillMaxWidth(), enabled = s.busy == null, primary = false) {
                        c.scope.launch {
                            progress = 0f
                            c.specialist.downloadFirmware(c.firmware) { p -> progress = p }
                            progress = null
                        }
                    }
                    else -> BusyButton("Aggiorna a ${img.version}", s.busy == "firmware", Modifier.fillMaxWidth(), enabled = s.busy == null) { confirm = true }
                }
                progress?.let { p -> LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth()) }
                SecondaryButton(onClick = { c.specialist.keepFirmware(true) }, modifier = Modifier.fillMaxWidth(), enabled = s.busy == null) { Text("Tieni ${build.version} e scrivi su questo") }
            }
        }
        s.firmwareStages.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall) }
        s.firmwareNote?.let { Notice(it, NoticeKind.Good) }
        StepError(s, "download", "firmware")
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Aggiornare il firmware della CPE?") },
            text = { Text("Da ${build?.version ?: "—"} a $target. La CPE si riavvia da sola in 3-5 minuti: tienila alimentata e il telefono vicino fino alla fine.") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    c.scope.launch { c.specialist.updateFirmware(c.firmware) }
                }) { Text("Aggiorna") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Annulla") } },
        )
    }
}

/**
 * The configuration: company, template, what is typed for this CPE, its credentials, where it is.
 * With the CPE read, the templates of its model; before connecting to it, all of them (the model
 * is the template's).
 */
@Composable
private fun ConfigCard(c: AppContainer, s: SpecState, f: SpecForm, onTemplates: () -> Unit, title: String) {
    val cpe = s.cpe
    val model = cpe?.model
    val all = s.templates.orEmpty()
    val mine = if (cpe != null) all.filter { it.model == model } else all
    var showErrors by remember { mutableStateOf(false) }
    var shown by remember { mutableStateOf(setOf<String>()) }
    // a template chosen by itself (the only one, or the first)
    LaunchedEffect(model, s.templates) {
        val cur = c.specialist.form.value.templateId
        if (mine.isNotEmpty() && mine.none { it.id == cur }) c.specialist.updateForm { it.copy(templateId = mine.first().id) }
    }
    LaunchedEffect(f.templateId, f.connectorId) { c.specialist.loadAsked() }
    val tpl = mine.firstOrNull { it.id == f.templateId }
    val current = s.askedFor?.first == f.templateId && s.askedFor?.second == f.connectorId
    val asked = s.asked?.asked?.takeIf { current }
    val placeholders = s.asked?.placeholders?.takeIf { current }.orEmpty()
    val target = c.firmware.savedList()?.target?.takeIf { it.isNotBlank() } ?: "8.7.4"
    val problems = SpecialistRules.problems(f, cpe, tpl, asked, SpecialistRules.firmwareReady(cpe, target, s.keepFirmware), placeholders)
    SectionCard(title, icon = R.drawable.ic_memory) {
        val conns = s.connectors.orEmpty().filter { it.enabled }
        val none = SpecConnectorDto(id = 0, name = "Nessuno: scrivo il nome dell'azienda")
        Dropdown(
            "Azienda (connettore UISP)",
            listOf(none) + conns,
            conns.firstOrNull { it.id == f.connectorId } ?: none,
            { it.name },
            { x -> c.specialist.updateForm { it.copy(connectorId = x.id.takeIf { id -> id != 0 }) } },
            Modifier.fillMaxWidth(),
        )
        if (f.connectorId == null) {
            Field("Nome dell'azienda (facoltativo)", f.company, { v -> c.specialist.updateForm { it.copy(company = v.take(80)) } }, placeholder = "es. Wireless Sud Srl")
            Text(
                "I connettori UISP delle aziende si aggiungono dalla console web (Specialist → I miei connettori).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        when {
            s.templates == null -> Text("Lettura dei tuoi template…", style = MaterialTheme.typography.bodySmall)
            cpe != null && model == null -> Unit
            mine.isEmpty() -> {
                Notice(
                    if (cpe != null) "Nessun tuo template per $model: crealo (anche dalla CPE collegata)." else "Nessun tuo template: crealo dalla scheda Template (dal modulo, dalla CPE o da un template CDA Net).",
                    NoticeKind.Warn,
                )
                SecondaryButton(onClick = onTemplates, modifier = Modifier.fillMaxWidth()) { Text("Vai ai template") }
            }
            else -> {
                // before connecting to the CPE the model is the template's: it is in the name
                Dropdown(
                    "Template",
                    mine,
                    tpl ?: mine.first(),
                    { t -> if (cpe == null) "${t.model} · ${t.name}" else t.name },
                    { t -> c.specialist.updateForm { it.copy(templateId = t.id) } },
                    Modifier.fillMaxWidth(),
                )
                tpl?.let { t ->
                    Text(
                        "${t.facts.mode} · LAN ${t.facts.lanIp ?: "—"}" + if (t.notes.isNotBlank()) "\n${t.notes}" else "",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (cpe == null && placeholders.any { it in SpecialistRules.FROM_CPE }) {
                    Notice("Questo template usa il MAC o il seriale della CPE: collegati prima alla CPE e leggila.", NoticeKind.Warn)
                }
            }
        }
        if (tpl != null) {
            when {
                asked == null -> Text("Lettura dei valori del template…", style = MaterialTheme.typography.bodySmall)
                asked.isEmpty() -> Text("Il template non ha valori da scrivere: ogni CPE riceve lo stesso file.", style = MaterialTheme.typography.bodySmall)
                else -> {
                    Text("Valori per questa CPE", style = MaterialTheme.typography.titleSmall)
                    asked.forEach { a ->
                        val v = f.values[a.name].orEmpty()
                        val visible = !a.secret || a.name in shown
                        Field(
                            a.label.ifBlank { a.name } + if (a.own) " (tuo)" else "",
                            v,
                            { nv -> c.specialist.updateForm { it.copy(values = it.values + (a.name to nv)) } },
                            password = !visible,
                            supporting = when {
                                a.name == "WPA2_PSK" -> "La chiave del tuo AP: solo per questa CPE, mai salvata"
                                a.secret -> "Solo per questa CPE, mai salvato"
                                a.own -> "\${${a.name}} del tuo template"
                                else -> null
                            },
                            isError = showErrors && v.isBlank(),
                            trailing = if (a.secret) {
                                { TextButton(onClick = { shown = if (a.name in shown) shown - a.name else shown + a.name }) { Text(if (visible) "Nascondi" else "Mostra") } }
                            } else {
                                null
                            },
                        )
                    }
                }
            }
        }
        Text("Credenziali admin della CPE dopo la configurazione", style = MaterialTheme.typography.titleSmall)
        Field("Utente admin", f.cpeUser, { v -> c.specialist.updateForm { it.copy(cpeUser = v.trim().take(64)) } }, placeholder = "es. admin", isError = showErrors && f.cpeUser.isBlank())
        Field(
            "Password admin",
            f.cpePassword,
            { v -> c.specialist.updateForm { it.copy(cpePassword = v.take(200)) } },
            password = true,
            supporting = "Va nel file della CPE: il server non la conserva",
            isError = showErrors && f.cpePassword.isEmpty(),
        )
        Field("Cliente (facoltativo)", f.customer, { v -> c.specialist.updateForm { it.copy(customer = v.take(120)) } })
        Field("Note (facoltative)", f.notes, { v -> c.specialist.updateForm { it.copy(notes = v.take(1000)) } })
        Text("Posizione (facoltativa: scritta nella CPE e nello storico)", style = MaterialTheme.typography.titleSmall)
        LocationPicker(c, f.location, f.locationLabel) { l, label -> c.specialist.updateForm { it.copy(location = l, locationLabel = label) } }
        if (showErrors && problems.isNotEmpty()) Notice(problems.joinToString("\n"), NoticeKind.Bad)
        BusyButton("Prepara la configurazione", s.busy == "prepare", Modifier.fillMaxWidth(), enabled = s.busy == null) {
            showErrors = true
            if (problems.isEmpty()) c.scope.launch { c.specialist.prepare() }
        }
        Text(
            if (cpe == null) {
                "Serve Internet, non la Wi-Fi della CPE: il server prepara il file con i valori scritti qui e non li conserva. Poi ti colleghi alla CPE e la scrivi senza Internet."
            } else {
                "Serve Internet (bastano i dati mobili anche sulla Wi-Fi della CPE): il server prepara il file con i valori scritti qui e non li conserva."
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        StepError(s, "prepare")
    }
}

/** The time left of a prepared configuration (a day by default): minutes, or hours and minutes. */
private fun leftText(left: Duration): String {
    val min = left.toMinutes()
    return if (min < 60) "$min min" else "${min / 60} h ${min % 60} min"
}

/**
 * The write: the configuration prepared goes into the CPE (no Internet needed any more). One
 * prepared before connecting to the CPE goes on the CPE read in the card above.
 */
@Composable
private fun WriteCard(c: AppContainer, s: SpecState, f: SpecForm, title: String) {
    val pkg = s.pkg ?: return
    val target = c.firmware.savedList()?.target?.takeIf { it.isNotBlank() } ?: "8.7.4"
    val blocking = SpecialistRules.writeProblems(pkg, s.cpe, SpecialistRules.firmwareReady(s.cpe, target, s.keepFirmware))
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = Instant.now()
            delay(5_000)
        }
    }
    val left = runCatching { Duration.between(now, Instant.parse(pkg.expiresAt)) }.getOrDefault(Duration.ZERO)
    val writing = s.busy == "write"
    if (writing) KeepScreenOn()
    val failed = s.done?.takeIf { !it.ok } != null
    SectionCard(title, icon = R.drawable.ic_settings_input_antenna) {
        val read = s.cpe
        KeyValue("CPE", "${pkg.summary.model} · " + if (pkg.needsCpe) (read?.mac ?: "da leggere") else pkg.summary.mac)
        if (pkg.summary.template.isNotBlank()) KeyValue("Template", pkg.summary.template)
        if (pkg.summary.ssid.isNotBlank()) KeyValue("SSID", pkg.summary.ssid)
        if (pkg.summary.deviceName.isNotBlank()) KeyValue("Nome", pkg.summary.deviceName)
        KeyValue("Valida ancora", if (left.isNegative) "SCADUTA" else leftText(left))
        Text(
            if (pkg.needsCpe) {
                "Internet non serve più: l'app entra nella CPE letta, verifica modello, board e MAC, scrive la configurazione, la salva e la riavvia."
            } else {
                "Internet non serve più: l'app entra nella CPE, verifica board e MAC, scrive la configurazione, la salva e la riavvia."
            },
            style = MaterialTheme.typography.bodySmall,
        )
        if (left.isNegative) Notice("Configurazione scaduta: annullala e preparala di nuovo.", NoticeKind.Bad)
        else if (blocking.isNotEmpty()) Notice(blocking.joinToString("\n"), NoticeKind.Warn)
        BusyButton(if (failed) "Riprova la scrittura" else "Scrivi nella CPE", writing, Modifier.fillMaxWidth(), enabled = s.busy == null && !left.isNegative && blocking.isEmpty()) {
            c.scope.launch { c.specialist.write() }
        }
        StepError(s, "write")
        s.stages.forEach { Text("✓ $it", style = MaterialTheme.typography.bodyMedium) }
        if (failed) Notice("Scrittura non riuscita: ${s.writeError ?: "errore"}", NoticeKind.Bad)
        if (failed && s.writeError.orEmpty().startsWith("Autenticazione")) {
            Field("Utente attuale della CPE", f.currentUser, { v -> c.specialist.updateForm { it.copy(currentUser = v.take(64)) } })
            Field("Password attuale della CPE", f.currentPassword, { v -> c.specialist.updateForm { it.copy(currentPassword = v.take(200)) } }, password = true)
        }
        TextButton(onClick = { c.specialist.cancelPackage() }, enabled = !writing) { Text("Annulla e torna alla configurazione") }
    }
}

private val VERDICTS = listOf("ok" to "Buono", "warn" to "Con riserva", "bad" to "Non buono")

/** 5-7 · after the write: the check with the new credentials, the acceptance test, the company's UISP. */
@Composable
private fun AfterWrite(c: AppContainer, s: SpecState) {
    val d = s.done ?: return
    val pending = c.specialist.results.pending.collectAsState().value
    SectionCard("Configurazione scritta", icon = R.drawable.ic_check_circle) {
        Notice("${d.summary.deviceName.ifBlank { d.summary.model }} · ${d.summary.mac}: la CPE si riavvia con la nuova configurazione (circa un minuto).", NoticeKind.Good)
        s.stages.forEach { Text("✓ $it", style = MaterialTheme.typography.bodySmall) }
        if (pending.any { it.jobId == d.jobId }) Notice("Esito in attesa di invio al server: parte appena c'è Internet.", NoticeKind.Info)
    }
    SectionCard("5 · Verifica (facoltativa)", icon = R.drawable.ic_troubleshoot) {
        Text(
            "Dopo il riavvio collegati alla Wi-Fi della CPE o del router del cliente: l'app entra con le credenziali nuove e legge collegamento, segnale e AP.",
            style = MaterialTheme.typography.bodySmall,
        )
        BusyButton(if (s.verify == null) "Verifica la CPE" else "Verifica di nuovo", s.busy == "verify", Modifier.fillMaxWidth(), enabled = s.busy == null, primary = s.verify == null) {
            c.scope.launch { c.specialist.verify() }
        }
        s.verify?.let { StatusSummary(it) }
        StepError(s, "verify")
    }
    AcceptanceCard(c, s)
    d.connectorId?.let { id -> SectionCard("7 · UISP dell'azienda", icon = R.drawable.ic_cell_tower) { SpecUispPanel(c, d.jobId, id) } }
    PrimaryButton(onClick = { c.specialist.nextCpe() }, modifier = Modifier.fillMaxWidth()) { Text("Configura un'altra CPE") }
}

@Composable
private fun StatusSummary(st: AirosStatus) {
    KeyValue("Collegata all'AP", if (st.associated) listOfNotNull(st.apName, st.essid).joinToString(" · ").ifBlank { "sì" } else "no")
    st.signal?.let { sig -> KeyValue("Segnale", "$sig dBm" + (st.noise?.let { n -> " · rumore $n dBm" } ?: "")) }
    st.snr?.let { KeyValue("SNR", "$it dB") }
    if (st.dlCapacityMbps != null || st.ulCapacityMbps != null) {
        val down = st.dlCapacityMbps?.let { String.format(Locale.ITALY, "%.0f", it) } ?: "—"
        val up = st.ulCapacityMbps?.let { String.format(Locale.ITALY, "%.0f", it) } ?: "—"
        KeyValue("Capacità", "$down / $up Mbit/s")
    }
    st.distanceM?.let { m -> KeyValue("Distanza", if (m >= 1000) String.format(Locale.ITALY, "%.1f km", m / 1000.0) else "$m m") }
    st.frequencyMhz?.let { fr -> KeyValue("Frequenza", "$fr MHz" + (st.channelWidthMhz?.let { w -> " · $w MHz" } ?: "")) }
    st.firmware?.let { KeyValue("Firmware", it) }
}

/** 6 · the optional acceptance test: his verdict, with the readings of the check when he made it. */
@Composable
private fun AcceptanceCard(c: AppContainer, s: SpecState) {
    val d = s.done ?: return
    var verdict by remember(d.jobId) { mutableStateOf("ok") }
    var height by remember(d.jobId) { mutableStateOf("") }
    var notes by remember(d.jobId) { mutableStateOf("") }
    val saved = s.job?.acceptance
    SectionCard("6 · Collaudo (facoltativo)", icon = R.drawable.ic_check_circle) {
        Text(
            "Il tuo giudizio, senza NOC" + if (s.verify != null) ", con le misure della verifica." else ": fai prima la verifica per salvare anche le misure.",
            style = MaterialTheme.typography.bodySmall,
        )
        Segmented(VERDICTS, verdict, { verdict = it })
        Field("Altezza della CPE in metri (facoltativa)", height, { height = it.take(6) }, keyboardType = KeyboardType.Decimal)
        Field("Note (facoltative)", notes, { notes = it.take(1000) })
        BusyButton(if (saved == null) "Salva il collaudo" else "Aggiorna il collaudo", s.busy == "acceptance", Modifier.fillMaxWidth(), enabled = s.busy == null, primary = false) {
            val h = height.replace(',', '.').toDoubleOrNull()?.takeIf { it in 0.0..500.0 }
            c.scope.launch { c.specialist.saveAcceptance(verdict, h, notes) }
        }
        saved?.let { a ->
            val label = VERDICTS.firstOrNull { it.first == a.verdict }?.second ?: a.verdict.orEmpty()
            Notice("Collaudo salvato: $label" + (a.radio?.signal?.let { " · segnale $it dBm" } ?: ""), NoticeKind.Good)
        }
        StepError(s, "acceptance")
    }
}

// ---- the company's UISP -----------------------------------------------------------------------------

/** The Specialist's errors in plain words: here the company's UISP is named (it is his, not CDA Net's). */
internal fun specialistError(e: Throwable): String = when ((e as? ApiException)?.code) {
    "uisp_device_not_found" -> "La CPE non è ancora nell'UISP dell'azienda (ricerca per MAC): dopo il riavvio possono servire alcuni minuti"
    "uisp_already_authorized" -> "La CPE è già autorizzata nell'UISP dell'azienda"
    "uisp_site_unknown" -> "Site dell'AP non determinabile: scegli il site"
    "uisp_auth_failed" -> "L'UISP dell'azienda rifiuta il token: controlla il connettore nella console"
    "uisp_unreachable" -> "UISP dell'azienda non raggiungibile dal server"
    "uisp_tls_error" -> "Certificato dell'UISP dell'azienda non valido: nel connettore scegli «Certificato non verificato»"
    "uisp_error" -> "L'UISP dell'azienda ha risposto con un errore"
    "connector_disabled" -> "Connettore disattivato: riattivalo nella console"
    "connector_incomplete" -> "Connettore senza token: completalo nella console"
    "job_not_completed" -> "L'esito della scrittura non è ancora sul server: riprova tra poco"
    "job_without_connector" -> "Installazione senza connettore UISP"
    else -> e.message ?: e.toString()
}

/**
 * The installed CPE in the company's UISP: found by MAC, then authorized in the site of its AP
 * (proposed by the server) or in the one he chooses.
 */
@Composable
fun SpecUispPanel(c: AppContainer, jobId: String, connectorId: Int, onChanged: (SpecJobDto) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    var state by remember(jobId) { mutableStateOf<SpecUispStateDto?>(null) }
    var sites by remember(jobId) { mutableStateOf<List<SpecSiteDto>?>(null) }
    var site by remember(jobId) { mutableStateOf<SpecSiteDto?>(null) }
    var busy by remember(jobId) { mutableStateOf(false) }
    var message by remember(jobId) { mutableStateOf<Pair<String, NoticeKind>?>(null) }
    suspend fun check() {
        busy = true
        message = null
        try {
            state = c.api.specUispState(jobId)
        } catch (e: Exception) {
            message = specialistError(e) to NoticeKind.Bad
        } finally {
            busy = false
        }
    }
    val st = state
    val dev = st?.device
    Text(
        "Dopo il riavvio la CPE si collega all'UISP dell'azienda: autorizzala nel site del suo AP (proposto) o in quello che scegli.",
        style = MaterialTheme.typography.bodySmall,
    )
    when {
        st == null -> BusyButton("Cerca la CPE nell'UISP", busy, Modifier.fillMaxWidth(), primary = false) { scope.launch { check() } }
        dev == null -> {
            Notice("La CPE non è ancora nell'UISP di ${st.connector}: dopo il riavvio possono servire alcuni minuti.", NoticeKind.Warn)
            BusyButton("Cerca di nuovo", busy, Modifier.fillMaxWidth(), primary = false) { scope.launch { check() } }
        }
        dev.authorized -> Notice("Autorizzata nell'UISP di ${st.connector}" + (dev.site?.let { " · site $it" } ?: "") + ".", NoticeKind.Good)
        else -> {
            KeyValue("In UISP", listOfNotNull(dev.name, dev.model, dev.status).joinToString(" · ").ifBlank { dev.id })
            val all = sites
            val choice = site ?: st.proposedSite ?: all?.firstOrNull()
            if (all == null) {
                Text(
                    st.proposedSite?.let { "Site proposto: ${it.name} (quello del suo AP)." } ?: "Site del suo AP non determinabile: scegli il site.",
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = {
                    scope.launch {
                        runCatching { c.api.specSites(connectorId) }
                            .onSuccess { sites = it }
                            .onFailure { e -> message = specialistError(e) to NoticeKind.Bad }
                    }
                }) { Text("Scegli un altro site") }
            } else if (all.isNotEmpty()) {
                Dropdown("Site", all, choice ?: all.first(), { it.name.ifBlank { it.id } }, { site = it }, Modifier.fillMaxWidth())
            }
            BusyButton("Autorizza" + (choice?.let { " nel site ${it.name}" } ?: ""), busy, Modifier.fillMaxWidth(), enabled = choice != null) {
                val pick = choice
                scope.launch {
                    busy = true
                    message = null
                    try {
                        val r = c.api.specAuthorize(jobId, pick?.id)
                        message = "Autorizzata nel site ${r.site}" to NoticeKind.Good
                        r.job?.let(onChanged)
                        state = runCatching { c.api.specUispState(jobId) }.getOrNull() ?: state
                    } catch (e: Exception) {
                        message = specialistError(e) to NoticeKind.Bad
                    } finally {
                        busy = false
                    }
                }
            }
        }
    }
    message?.let { (text, kind) -> Notice(text, kind) }
}

// ---- the history ------------------------------------------------------------------------------------

private val FILTERS = listOf<Pair<String?, String>>(
    null to "Tutte",
    "to_authorize" to "Da autorizzare",
    "no_acceptance" to "Senza collaudo",
    "failed" to "Non riuscite",
    "success" to "Scritte",
)

private fun statusOf(s: String): Pair<String, NoticeKind> = when (s) {
    "success" -> "scritta" to NoticeKind.Good
    "failed" -> "non riuscita" to NoticeKind.Bad
    else -> "preparata" to NoticeKind.Info
}

private fun verdictOf(v: String?): Pair<String, NoticeKind> = when (v) {
    "ok" -> "buono" to NoticeKind.Good
    "warn" -> "con riserva" to NoticeKind.Warn
    "bad" -> "non buono" to NoticeKind.Bad
    else -> "—" to NoticeKind.Info
}

/** «Storico Specialist»: his installations only, apart from CDA Net's history (the same as the console's). */
@Composable
fun SpecialistHistory(c: AppContainer) {
    val scope = rememberCoroutineScope()
    var summary by remember { mutableStateOf<SpecSummaryDto?>(null) }
    var data by remember { mutableStateOf<SpecJobsDto?>(null) }
    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<String?>(null) }
    val refused = c.specialist.results.refused.collectAsState().value
    val pending = c.specialist.results.pending.collectAsState().value
    val refresh = c.refresh.collectAsState().value
    suspend fun load() {
        busy = true
        runCatching { c.specialist.results.sync() }
        runCatching { c.api.specSummary() }.onSuccess { summary = it }
        runCatching { c.api.specJobs(query, filter) }
            .onSuccess {
                data = it
                error = null
            }
            .onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(refresh, filter, query) {
        if (query.isNotEmpty()) delay(400)
        load()
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 16.dp)) {
        summary?.let { sm ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatTile("CPE in 30 giorni", sm.jobs30d.toString(), Modifier.weight(1f), compact = true)
                StatTile("scritte", sm.success30d.toString(), Modifier.weight(1f), tone = Tone.Good, compact = true)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatTile(
                    "da autorizzare",
                    sm.toAuthorize.toString(),
                    Modifier.weight(1f),
                    tone = if (sm.toAuthorize > 0) Tone.Warn else Tone.Neutral,
                    active = filter == "to_authorize",
                    compact = true,
                    onClick = { filter = if (filter == "to_authorize") null else "to_authorize" },
                )
                StatTile(
                    "non riuscite",
                    sm.failed30d.toString(),
                    Modifier.weight(1f),
                    tone = if (sm.failed30d > 0) Tone.Bad else Tone.Neutral,
                    active = filter == "failed",
                    compact = true,
                    onClick = { filter = if (filter == "failed") null else "failed" },
                )
            }
        }
        Field("Cerca", query, { query = it.take(100) }, placeholder = "MAC, cliente, nome, SSID, azienda, template", leadingIcon = R.drawable.ic_search)
        Segmented(FILTERS, filter, { filter = it }, fill = false)
        ErrorBanner(error) { error = null }
        refused.forEach { r -> Notice(r, NoticeKind.Bad) { c.specialist.results.dismissRefused() } }
        if (pending.isNotEmpty()) Notice("${pending.size} esiti in attesa di invio: partono appena c'è Internet.", NoticeKind.Info)
        val items = data?.items
        val total = data?.total ?: 0
        ListHeader(
            when {
                items == null -> "Storico Specialist"
                items.isEmpty() -> "Nessuna installazione"
                total > items.size -> "$total installazioni (le ultime ${items.size})"
                else -> "${items.size} installazioni"
            },
            busy,
        ) { scope.launch { load() } }
        items?.forEach { j ->
            SpecJobRow(c, j, open == j.id, onToggle = { open = if (open == j.id) null else j.id }, onChanged = { scope.launch { load() } })
        }
        if (items != null && items.isEmpty()) {
            EmptyState(
                R.drawable.ic_history,
                "Nessuna installazione",
                if (filter == null && query.isBlank()) "Le CPE che configuri nel flusso Specialist compaiono qui e nella console web." else "Nessuna con questi filtri.",
            )
        }
    }
}

@Composable
private fun SpecJobRow(c: AppContainer, j: SpecJobDto, expanded: Boolean, onToggle: () -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var confirmDelete by remember(j.id) { mutableStateOf(false) }
    val (label, kind) = statusOf(j.status)
    // an installation of another member of the group (issue #275): read only, its author tests and authorizes it
    val me = c.session.state.collectAsState().value?.user?.id
    val mine = j.authorId == null || j.authorId == me
    Column(
        Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .clickable(onClick = onToggle)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(j.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOf(j.company, j.model, j.macLabel, if (mine) "" else "di ${j.author}").filter { it.isNotBlank() }.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(localTime(j.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(8.dp))
            StatusChip(label, kind)
        }
        val acceptance = j.acceptance
        if (j.toAuthorize || acceptance != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (j.toAuthorize) StatusChip("da autorizzare", NoticeKind.Warn)
                if (acceptance != null) {
                    val (v, k) = verdictOf(acceptance.verdict)
                    StatusChip("collaudo $v", k)
                }
            }
        }
        if (expanded) {
            KeyValue("Template", j.template.ifBlank { "—" })
            if (j.ssid.isNotBlank()) KeyValue("SSID", j.ssid)
            if (j.deviceName.isNotBlank()) KeyValue("Nome CPE", j.deviceName)
            if (j.pppoeUser.isNotBlank()) KeyValue("Utente PPPoE", j.pppoeUser)
            if (j.serial.isNotBlank()) KeyValue("Seriale", j.serial)
            (j.detected["firmware"] ?: j.firmware.ifBlank { null })?.let { KeyValue("Firmware", it) }
            j.location?.let { l -> KeyValue("Posizione", String.format(Locale.ROOT, "%.5f, %.5f", l.lat, l.lon)) }
            j.completedAt?.let { KeyValue("Scritta il", localTime(it)) }
            if (j.notes.isNotBlank()) KeyValue("Note", j.notes)
            if (j.error.isNotBlank()) Notice(j.error, NoticeKind.Bad)
            if (acceptance != null) {
                val parts = listOfNotNull(
                    acceptance.radio?.signal?.let { "segnale $it dBm" },
                    acceptance.radio?.apName?.let { "AP $it" },
                    acceptance.heightM?.let { "altezza ${it} m" },
                    acceptance.notes,
                )
                KeyValue("Collaudo", (listOf(verdictOf(acceptance.verdict).first) + parts).joinToString(" · "))
            }
            j.uisp.authorizedAt?.let { at ->
                KeyValue("UISP", "autorizzata " + localTime(at) + (j.uisp.site.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""))
            }
            val conn = j.connector
            if (mine && j.status == "success" && conn != null && j.uisp.authorizedAt == null) {
                SpecUispPanel(c, j.id, conn.id) { onChanged() }
            }
            if (j.stages.isNotEmpty()) Text(j.stages.joinToString("\n") { "✓ $it" }, style = MaterialTheme.typography.bodySmall)
            if (mine) {
                TextButton(onClick = { confirmDelete = true }) { Text("Elimina dallo storico") }
            } else {
                Notice("Installazione di ${j.author.ifBlank { "un altro specialist" }} del tuo gruppo di lavoro: in sola lettura. Collaudo e autorizzazione in UISP li fa chi l'ha installata, con i suoi connettori.", NoticeKind.Info)
            }
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Eliminare dallo storico?") },
            text = { Text(listOf(j.title, j.mac).filter { it.isNotBlank() }.distinct().joinToString(" · ") + ": l'installazione esce dal tuo storico (la CPE resta com'è).") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    scope.launch {
                        runCatching { c.api.specDeleteJob(j.id) }
                        onChanged()
                    }
                }) { Text("Elimina") }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Annulla") } },
        )
    }
}
