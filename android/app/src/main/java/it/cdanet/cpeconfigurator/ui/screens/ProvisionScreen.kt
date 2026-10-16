package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.ui.res.painterResource
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.PrimaryButton
import it.cdanet.cpeconfigurator.ui.WifiRequired
import android.content.Intent
import android.os.Build
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.JobDto
import it.cdanet.cpeconfigurator.data.TemplateDto
import it.cdanet.cpeconfigurator.provisioning.Phase
import it.cdanet.cpeconfigurator.provisioning.ProvisionForm
import it.cdanet.cpeconfigurator.provisioning.ProvisioningController
import it.cdanet.cpeconfigurator.provisioning.Validation
import it.cdanet.cpeconfigurator.ui.Banner
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.CheckRow
import it.cdanet.cpeconfigurator.ui.Dropdown
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

@Composable
fun ProvisionFormStep(c: AppContainer) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val form by c.provisioning.form.collectAsState()
    val state by c.provisioning.state.collectAsState()
    var models by remember { mutableStateOf(ProvisionForm.MODELS) }
    var showErrors by remember { mutableStateOf(false) }
    var configuredSsids by remember { mutableStateOf<Set<String>?>(null) }
    var templates by remember { mutableStateOf<List<TemplateDto>?>(null) }
    LaunchedEffect(Unit) {
        runCatching { c.api.meta() }.getOrNull()?.let { models = it.models }
        c.provisioning.stock.refresh(c.api)
        templates = runCatching { c.api.templates() }.getOrNull()
        configuredSsids = runCatching { c.api.wirelessNetworks() }.getOrNull()
    }
    val parsedMac = Validation.parseMac(form.mac)
    val stock by c.provisioning.stock.state.collectAsState()
    val stockProblem = c.provisioning.stock.problem(form.mac)
    // a CPE outside the installer's warehouse stops the preparation unless their account may skip the check
    val errors = form.errors() + listOfNotNull(stockProblem?.takeIf { it.blocking }?.text)

    if (form.workOrderId != null) {
        SectionCard("Intervento dell'ufficio", icon = it.cdanet.cpeconfigurator.R.drawable.ic_pending_actions) {
            Text(form.workOrderLabel, fontWeight = FontWeight.SemiBold)
            Text(
                "Cliente, utente PPPoE e posizione vengono dall'intervento. La password PPPoE la inserisce il server: non serve scriverla.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
    if (form.supersedes != null) {
        SectionCard("Modifica e riprova") {
            Text("Rifai: ${form.supersedesLabel}", fontWeight = FontWeight.SemiBold)
            Text(
                "I dati sono quelli dell'installazione non riuscita: correggi quello che serve (per esempio il MAC) e reinserisci la password PPPoE. " +
                    "Quando prepari, quella vecchia esce da «Da completare».",
                style = MaterialTheme.typography.bodySmall,
            )
            SecondaryButton(onClick = { c.provisioning.reset() }) { Text("Annulla") }
        }
    }
    if (form.replaces != null) {
        SectionCard("Sostituzione CPE") {
            Text("CPE sostituita: ${form.replacesLabel}", fontWeight = FontWeight.SemiBold)
            Text(
                "Cliente, SSID, posizione e template restano quelli della CPE guasta: inserisci MAC e seriale della nuova. " +
                    "La password PPPoE si può lasciare vuota: il server la recupera dall'ultimo backup della CPE sostituita.",
                style = MaterialTheme.typography.bodySmall,
            )
            SecondaryButton(onClick = { c.provisioning.reset() }) { Text("Annulla sostituzione") }
        }
    }

    SectionCard("1 · CPE") {
        Dropdown("Modello", models, form.model, { it }, { m -> c.provisioning.updateForm { it.copy(model = m, templateId = null) } }, Modifier.fillMaxWidth())
        val modelTemplates = templates?.filter { it.model == form.model }.orEmpty()
        when {
            templates != null && modelTemplates.isEmpty() -> Text(
                "Nessun template airOS per ${form.model}: un amministratore deve crearlo nella console web (Profili airOS).",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
            modelTemplates.size > 1 -> {
                val selected = modelTemplates.firstOrNull { it.id == form.templateId } ?: modelTemplates.firstOrNull { it.isDefault } ?: modelTemplates.first()
                Dropdown(
                    "Template",
                    modelTemplates,
                    selected,
                    { t -> t.name + listOfNotNull(if (t.isDefault) "predefinito" else null, if (t.personal) "riservato" else null).joinToString(", ").let { if (it.isEmpty()) "" else " ($it)" } },
                    { t -> c.provisioning.updateForm { it.copy(templateId = if (t.isDefault) null else t.id) } },
                    Modifier.fillMaxWidth(),
                )
            }
            modelTemplates.size == 1 -> KeyValue("Template", modelTemplates.first().name + if (modelTemplates.first().personal) " (riservato)" else "")
        }
        var scanMsg by remember { mutableStateOf<String?>(null) }
        // a new customer, an account that may not install CPEs outside its warehouse: the CPE comes
        // only from the warehouse, MAC and serial cannot be typed or scanned (owner, 14/10/2026)
        val pickOnly = stock?.linked == true && stock?.bypass == false && form.replaces == null
        if (pickOnly && stock?.items.isNullOrEmpty()) Notice("Nessuna CPE nel tuo magazzino: chiedi all'ufficio di caricarne una.", NoticeKind.Bad)
        // the list on the phone is old (offline for days): say when it was read
        c.provisioning.stock.staleNote()?.let { Notice(it, NoticeKind.Warn) }
        // the installer's own CPEs: one tap fills model, MAC and serial (no scan, no typing errors)
        stock?.takeIf { it.linked && it.items.isNotEmpty() }?.let { s ->
            val none = it.cdanet.cpeconfigurator.data.StockItemDto(model = "", mac = "")
            val picked = s.items.firstOrNull { x -> Validation.parseMac(form.mac)?.equals(x.mac, ignoreCase = true) == true } ?: none
            Dropdown(
                "Dal tuo magazzino (${s.items.size} CPE)",
                listOf(none) + s.items,
                picked,
                { x -> if (x.mac.isEmpty()) "Scegli una CPE…" else "${x.model} · ${x.mac}" },
                { x ->
                    if (x.mac.isNotEmpty()) c.provisioning.updateForm {
                        it.copy(model = x.model.takeIf { m -> m in models } ?: it.model, mac = x.mac, serial = x.serial.ifBlank { x.mac.replace(":", "") }, templateId = null)
                    }
                },
                Modifier.fillMaxWidth(),
            )
        }
        // one scan button per field: the code goes only where it belongs, checked at once
        val scan: (onCode: (String) -> Unit) -> Unit = { onCode ->
            GmsBarcodeScanning.getClient(context).startScan().addOnSuccessListener { b -> b.rawValue?.let(onCode) }
        }
        val scanIcon: @Composable (String, () -> Unit) -> Unit = { what, onClick ->
            androidx.compose.material3.IconButton(onClick = onClick) {
                androidx.compose.material3.Icon(painterResource(R.drawable.ic_qr_code_scanner), contentDescription = "Scansiona $what")
            }
        }
        if (pickOnly) {
            KeyValue("MAC", form.mac.ifBlank { "scegli la CPE dal magazzino" })
            KeyValue("Seriale", form.serial.ifBlank { "—" })
        } else {
        Field(
            "MAC",
            form.mac,
            { v -> c.provisioning.updateForm { it.copy(mac = v) } },
            placeholder = "24A43C112233 o 24:A4:3C:11:22:33",
            trailing = {
                scanIcon("il MAC") {
                    scan { raw ->
                        val (mac, problem) = Validation.scanMac(raw)
                        scanMsg = problem
                        if (mac != null) c.provisioning.updateForm { it.copy(mac = mac) }
                    }
                }
            },
            isError = (showErrors && parsedMac == null) || (parsedMac != null && !Validation.isDeviceMac(parsedMac)),
            supporting = when {
                // checked as soon as it is typed or scanned: 81:78:… from the box is not a MAC of a device
                parsedMac != null && !Validation.isDeviceMac(parsedMac) -> "Non è il MAC di un apparato: usa il codice «MAC» dell'etichetta della CPE"
                stockProblem != null -> stockProblem.text
                parsedMac != null && parsedMac != form.mac.trim() -> "Verrà usato $parsedMac"
                showErrors && parsedMac == null -> "12 cifre esadecimali, con o senza : - ."
                else -> null
            },
        )
        Field(
            "Seriale",
            form.serial,
            { v -> c.provisioning.updateForm { it.copy(serial = v) } },
            trailing = {
                scanIcon("il seriale") {
                    scan { raw ->
                        val (serial, warning) = Validation.scanSerial(raw)
                        scanMsg = warning
                        c.provisioning.updateForm { it.copy(serial = serial) }
                    }
                }
            },
            isError = Validation.serialLooksLikeMac(form.serial),
            // checked as soon as it is typed or scanned: MAC and serial must not be swapped
            supporting = when {
                Validation.serialLooksLikeMac(form.serial) -> "Questo è un MAC: va nel campo MAC"
                else -> Validation.serialMacMismatch(form)
            },
        )
        scanMsg?.let { Notice(it, NoticeKind.Warn) }
        Text("Scansiona MAC e seriale dall'etichetta della CPE con il tasto nel campo: prima di scrivere la configurazione l'app controlla che il MAC sia proprio quello della CPE collegata.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // MAC and serial come only from the label (or from the warehouse, where they come from the
        // label): the discovery checks the CPE on the Wi-Fi is that one, its firmware and model
        CpeDiscoveryCheck(c, form.mac, form.replacesMac)
    }

    SectionCard("Posizione CPE e AP consigliati") {
        Text("La posizione viene salvata nello storico e scritta nella CPE. Dal GPS del telefono l'app propone gli AP migliori per questa installazione.", style = MaterialTheme.typography.bodySmall)
        LocationPicker(c, form.location, form.locationLabel) { l, label -> c.provisioning.updateForm { it.copy(location = l, locationLabel = label) } }
        if (c.moduleOn("compass")) form.location?.let { l ->
            BestApsBeforeInstall(c, l, form.ssid) { ap ->
                ProvisioningController.SSID_PARTS.find(ap.ssid)?.let { m ->
                    c.provisioning.updateForm { it.copy(node = m.groupValues[1].toInt(), district = m.groupValues[2].toInt(), relay = m.groupValues[3].toIntOrNull()) }
                }
            }
        } else if (c.moduleOn("coverage")) form.location?.let { l ->
            NearbyAps(c, l, onPick = { ap -> c.provisioning.updateForm { it.copy(node = ap.node ?: it.node, district = ap.district ?: it.district, relay = ap.relay) } })
        }
    }

    SectionCard("2 · Wireless Station") {
        if (form.replaces == null) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Dropdown("Nodo", (2..99).toList(), form.node, { it.toString() }, { n -> c.provisioning.updateForm { it.copy(node = n) } }, Modifier.weight(1f))
            Dropdown("Distretto", (1..99).toList(), form.district, { it.toString().padStart(2, '0') }, { d -> c.provisioning.updateForm { it.copy(district = d) } }, Modifier.weight(1f))
        }
        if (form.replaces == null) {
            Dropdown("Rilancio", listOf<Int?>(null) + (1..9).toList(), form.relay, { r -> r?.let { "R$it" } ?: "nessuno (AP del distretto)" }, { r -> c.provisioning.updateForm { it.copy(relay = r) } }, Modifier.fillMaxWidth())
        }
        KeyValue("SSID", form.ssid)
        if (configuredSsids?.contains(form.ssid) == false) {
            Text(
                "Chiave WPA2 non ancora configurata per ${form.ssid}: un amministratore deve impostarla nella console web (Reti Wi-Fi).",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        KeyValue("Country", "Licensed")
    }

    SectionCard("3 · Router / PPPoE") {
        Field("Username RADIUS / PPPoE", form.pppoeUser, { v -> c.provisioning.updateForm { it.copy(pppoeUser = v.trim()) } },
            readOnly = form.replaces != null, placeholder = "cognome.nome@cda-net.it", supporting = form.customerName.takeIf { it.isNotBlank() }?.let { "Device Name / SNMP location: $it" })
        if (form.workOrderId == null) Field("Password PPPoE", form.pppoePassword, { v -> c.provisioning.updateForm { it.copy(pppoePassword = v) } }, password = true,
            supporting = if (form.replaces != null) "Facoltativa: vuota = presa dal backup della CPE sostituita" else "Usata solo per questo provisioning, mai salvata")
        else Text("Password PPPoE: dall'intervento (non visibile)", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }

    if (showErrors && errors.isNotEmpty()) Banner(errors.joinToString("\n"), MaterialTheme.colorScheme.error)

    state.plan?.let { plan ->
        SectionCard("Piano") {
            if (plan.readiness.missing.isNotEmpty()) {
                Banner("Configurazione server incompleta: ${plan.readiness.missing.joinToString { it.replace('_', ' ') }}", MaterialTheme.colorScheme.error)
            }
            plan.steps.forEachIndexed { i, s -> Text("${i + 1}. $s", style = MaterialTheme.typography.bodyMedium) }
        }
    }

    SectionCard("4 · Prepara (online)") {
        Text(
            "Il server genera la configurazione completa e la consegna solo a questa app, che la tiene cifrata sul telefono fino alla scadenza. Poi collegati alla Wi-Fi della CPE: Internet non serve più, anche se l'app viene chiusa.",
            style = MaterialTheme.typography.bodySmall,
        )
        BusyButton("Verifica piano", state.busy, Modifier.fillMaxWidth(), primary = false) {
            showErrors = true
            // The dry-run never uses the password: a placeholder keeps it valid in replacement mode.
            if (errors.isEmpty()) scope.launch { c.provisioning.plan(form.toRequest().let { r -> if (r.pppoePassword == null && r.workOrderId == null) r.copy(pppoePassword = "-") else r }) }
        }
        BusyButton("Prepara provisioning", state.busy, Modifier.fillMaxWidth()) {
            showErrors = true
            if (errors.isEmpty()) scope.launch { c.provisioning.prepare(form.toRequest()) }
        }
    }
}

@Composable
fun ProvisionApplyStep(c: AppContainer, onOpenCpeWeb: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val state by c.provisioning.state.collectAsState()
    val pkg = state.pkg ?: return
    var now by remember { mutableStateOf(Instant.now()) }
    var wifi by remember { mutableStateOf(c.network.wifiLink()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = Instant.now()
            wifi = c.network.wifiLink()
            delay(2000)
        }
    }
    val left = Duration.between(now, Instant.parse(pkg.expiresAt))
    val applying = state.phase == Phase.Applying

    SectionCard("Provisioning preparato") {
        KeyValue("Cliente", pkg.summary.deviceName)
        KeyValue("CPE", "${pkg.summary.model} · ${pkg.summary.mac.ifBlank { "da scansionare sul posto" }}")
        if (pkg.summary.template.isNotBlank()) KeyValue("Template", pkg.summary.template)
        c.provisioning.form.collectAsState().value.location?.let { KeyValue("Posizione", "%.5f, %.5f".format(it.latitude, it.longitude)) }
        if (pkg.alternatives.isEmpty()) KeyValue("SSID", pkg.summary.ssid)
        else Dropdown(
            "AP verso cui punti",
            c.provisioning.ssidOptions(),
            pkg.summary.ssid,
            { it },
            { s -> c.provisioning.chooseSsid(s) },
            Modifier.fillMaxWidth(),
        )
        KeyValue("Valido ancora", when { left.isNegative -> "SCADUTO"; left.toHours() >= 1 -> "${left.toHours()} h ${left.toMinutes() % 60} min"; else -> "${left.toMinutes()} min ${left.seconds % 60} s" })
        if (left.isNegative) Banner("Pacchetto scaduto: torna online e preparalo di nuovo.", MaterialTheme.colorScheme.error)
    }

    // prepared before the visit: the CPE is scanned here, even without Internet
    if (pkg.needsCpe || pkg.scannedOnSite) SiteCpeCard(c, pkg, enabled = !applying)

    SectionCard("1 · Collegati alla CPE") {
        Text("Collega il telefono alla Wi-Fi di management della CPE (IP ${pkg.target.host}). Se Android avvisa che la rete non ha Internet, scegli di restare connesso.",
            style = MaterialTheme.typography.bodySmall)
        KeyValue("Wi-Fi attuale", wifi?.let { "${it.wifiSsid ?: "connessa"} · ${it.addresses.firstOrNull { a -> !a.contains(':') } ?: "senza IPv4"}" } ?: "nessuna")
        SecondaryButton(onClick = {
            val i = if (Build.VERSION.SDK_INT >= 29) Intent(AndroidSettings.Panel.ACTION_WIFI) else Intent(AndroidSettings.ACTION_WIFI_SETTINGS)
            context.startActivity(i)
        }) { Text("Apri impostazioni Wi-Fi") }
        BusyButton("Rileva CPE", state.busy && !applying, Modifier.fillMaxWidth(), primary = false, enabled = !applying) {
            scope.launch { c.provisioning.probe() }
        }
        state.probe?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
    }

    SectionCard("2 · Installa sulla CPE") {
        Text(
            "Un solo tocco: l'app entra nella CPE (anche nuova o resettata, con le credenziali di fabbrica), la porta al firmware ${pkg.checks.firmware} se ne ha un altro, verifica board e MAC, scrive la configurazione e la riavvia.",
            style = MaterialTheme.typography.bodySmall,
        )
        if (pkg.needsCpe) Text("Prima scansiona MAC e seriale della CPE qui sopra.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        BusyButton("Installa sulla CPE", applying, Modifier.fillMaxWidth(), enabled = !left.isNegative && !state.busy && !pkg.needsCpe) {
            // the app's scope: a firmware update must not stop when the screen changes
            c.scope.launch { c.provisioning.install(c.firmware) }
        }
        state.stages.forEach { Text("✓ $it", style = MaterialTheme.typography.bodyMedium) }
    }

    SectionCard("Solo se l'app non entra nella CPE") {
        Text("Primo accesso a mano dall'interfaccia della CPE: Country Licensed, accetta i termini e imposta le credenziali CDA Net. Poi torna qui e tocca di nuovo «Installa sulla CPE».",
            style = MaterialTheme.typography.bodySmall)
        SecondaryButton(onClick = onOpenCpeWeb, enabled = !applying) { Text("Apri interfaccia CPE nell'app") }
    }

    TextButton(onClick = { c.provisioning.reset() }, enabled = !applying) { Text("Annulla e cancella il pacchetto") }
}

/**
 * MAC and serial of the CPE for a configuration prepared before the visit: scanned (or typed) on
 * site, even without Internet. The write then checks that the CPE has this MAC, and both go to the
 * server with the result.
 */
@Composable
private fun SiteCpeCard(c: AppContainer, pkg: it.cdanet.cpeconfigurator.data.ProvisionPackage, enabled: Boolean) {
    val context = LocalContext.current
    var mac by remember(pkg.jobId) { mutableStateOf(pkg.summary.mac) }
    var serial by remember(pkg.jobId) { mutableStateOf(pkg.summary.serial) }
    var message by remember { mutableStateOf<String?>(null) }
    val scan: (onCode: (String) -> Unit) -> Unit = { onCode ->
        GmsBarcodeScanning.getClient(context).startScan().addOnSuccessListener { b -> b.rawValue?.let(onCode) }
    }
    val scanIcon: @Composable (String, () -> Unit) -> Unit = { what, onClick ->
        androidx.compose.material3.IconButton(onClick = onClick, enabled = enabled) {
            androidx.compose.material3.Icon(painterResource(R.drawable.ic_qr_code_scanner), contentDescription = "Scansiona $what")
        }
    }
    val saved = pkg.scannedOnSite && Validation.normalizeMac(mac) == pkg.summary.mac && serial.trim() == pkg.summary.serial
    SectionCard("CPE di questo intervento") {
        Text(
            "La configurazione è stata preparata prima del sopralluogo: scansiona MAC e seriale dall'etichetta della CPE. Internet non serve; prima di scrivere l'app controlla che la CPE collegata abbia questo MAC.",
            style = MaterialTheme.typography.bodySmall,
        )
        val stock by c.provisioning.stock.state.collectAsState()
        stock?.takeIf { it.linked && it.items.isNotEmpty() }?.let { s ->
            val none = it.cdanet.cpeconfigurator.data.StockItemDto(model = "", mac = "")
            val picked = s.items.firstOrNull { x -> Validation.parseMac(mac)?.equals(x.mac, ignoreCase = true) == true } ?: none
            Dropdown("Dal tuo magazzino", listOf(none) + s.items, picked, { x -> if (x.mac.isEmpty()) "Scegli una CPE…" else "${x.model} · ${x.mac}" }, { x ->
                if (x.mac.isNotEmpty()) {
                    mac = x.mac
                    serial = x.serial.ifBlank { x.mac.replace(":", "") }
                }
            }, Modifier.fillMaxWidth())
        }
        c.provisioning.stock.problem(mac)?.let { p -> Notice(p.text, if (p.blocking) NoticeKind.Bad else NoticeKind.Warn) }
        // as at step 1: without the account's option the CPE comes only from the warehouse
        val pickOnly = stock?.linked == true && stock?.bypass == false
        if (pickOnly && stock?.items.isNullOrEmpty()) Notice("Nessuna CPE nel tuo magazzino: chiedi all'ufficio di caricarne una.", NoticeKind.Bad)
        // the list on the phone is old (offline for days): say when it was read
        c.provisioning.stock.staleNote()?.let { Notice(it, NoticeKind.Warn) }
        if (pickOnly) {
            KeyValue("MAC", mac.ifBlank { "scegli la CPE dal magazzino" })
            KeyValue("Seriale", serial.ifBlank { "—" })
        } else {
        Field("MAC", mac, { mac = it }, placeholder = "24A43C112233 o 24:A4:3C:11:22:33", trailing = {
            scanIcon("il MAC") {
                scan { raw ->
                    val (m, problem) = Validation.scanMac(raw)
                    message = problem
                    if (m != null) mac = m
                }
            }
        })
        Field("Seriale", serial, { serial = it }, trailing = {
            scanIcon("il seriale") {
                scan { raw ->
                    val (v, warning) = Validation.scanSerial(raw)
                    message = warning
                    serial = v
                }
            }
        })
        }
        message?.let { Notice(it, NoticeKind.Warn) }
        if (saved) {
            Text("✓ CPE ${pkg.summary.mac} indicata per questa configurazione", style = MaterialTheme.typography.bodyMedium)
        } else {
            BusyButton("Conferma la CPE", false, Modifier.fillMaxWidth(), enabled = enabled) {
                message = c.provisioning.setSiteCpe(mac, serial)
            }
        }
    }
}

/**
 * The CPE on the phone's Wi-Fi, checked by itself with the Ubiquiti discovery (at opening, then
 * every few seconds until a CPE answers): model (set in the form), MAC against the label, firmware,
 * factory or configured, the CPE being replaced, and the CPE of the installer's warehouse (its MAC
 * and serial filled in from there). The button runs it again.
 */
@Composable
private fun CpeDiscoveryCheck(c: AppContainer, labelMac: String, replacedMac: String) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    var found by remember { mutableStateOf<List<it.cdanet.cpeconfigurator.tools.UbntDevice>?>(null) }
    var round by remember { mutableStateOf(0) }
    val stock by c.provisioning.stock.state.collectAsState()
    suspend fun search() {
        busy = true
        runCatching { it.cdanet.cpeconfigurator.tools.UbntDiscovery.discover(c.network, 2_500) }
            .onSuccess { list -> found = list.filter { d -> !d.unifi } }
            .onFailure { e -> msg = e.message }
        busy = false
    }
    // at opening and again every 8 seconds while no CPE answers (the Wi-Fi of the CPE may come later)
    LaunchedEffect(round) {
        while (true) {
            search()
            if (!found.isNullOrEmpty()) break
            kotlinx.coroutines.delay(8_000)
        }
    }
    val list = found
    // several on the Wi-Fi (a customer's LAN): the one of the label, if it is there
    val d = list?.firstOrNull { d -> it.cdanet.cpeconfigurator.provisioning.DiscoveryCheck.sameDevice(d, labelMac) } ?: list?.singleOrNull()
    val result = d?.let { x -> it.cdanet.cpeconfigurator.provisioning.DiscoveryCheck.evaluate(x, labelMac, stock?.items.orEmpty(), c.field.targetFirmware ?: "8.7.4", replacedMac) }
    // the model of the CPE goes into the form by itself; the CPE becomes the one the tools work on
    LaunchedEffect(result?.model) { result?.model?.let { m -> c.provisioning.updateForm { f -> if (f.model == m) f else f.copy(model = m) } } }
    LaunchedEffect(d?.mac, d?.ip) { d?.let { x -> if (c.field.selected.value?.mac != x.mac || c.field.selected.value?.ip != x.ip) c.field.select(x) } }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            when {
                busy && result == null -> "Ricerca della CPE collegata…"
                // nothing answers: the CPE still comes from the warehouse menu above (or the label)
                list.isNullOrEmpty() -> (msg?.let { "$it. " } ?: "Nessuna CPE Ubiquiti risponde (riprovo da solo). ") +
                    if (stock?.items.isNullOrEmpty()) "Scansiona MAC e seriale dall'etichetta." else "Puoi scegliere la CPE dal tuo magazzino qui sopra."
                d == null -> "Rispondono ${list.size} apparati Ubiquiti: scansiona il MAC dall'etichetta per riconoscere la CPE"
                else -> "CPE collegata: ${d.product ?: d.model ?: "Ubiquiti"} ${d.ip.orEmpty()}"
            },
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
        )
        TextButton(enabled = !busy, onClick = { msg = null; round++ }) { Text("Controlla di nuovo") }
    }
    result?.let { r ->
        r.checks.forEach { ch -> CheckRow(ch.title, ch.verdict, ch.detail) }
        // firmware not the required one: updated from here, without leaving the installation
        val build = d?.firmware?.let { f -> it.cdanet.cpeconfigurator.firmware.AirosImage.parseBuild(f) }
        if (build != null && r.checks.any { ch -> ch.title == "Firmware" && ch.verdict != it.cdanet.cpeconfigurator.field.Verdict.Ok }) {
            CpeFirmwareUpdater(c, build, c.firmware.savedList()) { _ ->
                // the CPE is back: the discovery reads it again (new firmware, same MAC)
                c.field.forgetSelection()
                round++
            }
        }
        r.stock?.let { item ->
            Text("CPE del tuo magazzino: ${item.model} · MAC ${item.mac}${item.serial.takeIf { s -> s.isNotBlank() }?.let { s -> " · S/N $s" }.orEmpty()}", style = MaterialTheme.typography.bodySmall)
            if (Validation.normalizeMac(labelMac) != Validation.normalizeMac(item.mac)) {
                SecondaryButton(onClick = { c.provisioning.updateForm { f -> f.copy(mac = item.mac, serial = item.serial.ifBlank { f.serial }) } }) { Text("Usa MAC e seriale del magazzino") }
            }
        }
    }
}
