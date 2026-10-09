package it.cdanet.cpeconfigurator.ui.screens

import it.cdanet.cpeconfigurator.ui.WifiRequired
import android.content.Intent
import android.os.Build
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
        templates = runCatching { c.api.templates() }.getOrNull()
        configuredSsids = runCatching { c.api.wirelessNetworks() }.getOrNull()
    }
    val parsedMac = Validation.parseMac(form.mac)
    val errors = form.errors()

    if (form.replaces != null) {
        SectionCard("Sostituzione CPE") {
            Text("CPE sostituita: ${form.replacesLabel}", fontWeight = FontWeight.SemiBold)
            Text(
                "Cliente, SSID, posizione e template restano quelli della CPE guasta: inserisci MAC e seriale della nuova. " +
                    "La password PPPoE si può lasciare vuota: il server la recupera dall'ultimo backup della CPE sostituita.",
                style = MaterialTheme.typography.bodySmall,
            )
            OutlinedButton(onClick = { c.provisioning.reset() }) { Text("Annulla sostituzione") }
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
        Field(
            "MAC",
            form.mac,
            { v -> c.provisioning.updateForm { it.copy(mac = v) } },
            placeholder = "24A43C112233 o 24:A4:3C:11:22:33",
            isError = showErrors && parsedMac == null,
            supporting = when {
                parsedMac != null && parsedMac != form.mac.trim() -> "Verrà usato $parsedMac"
                showErrors && parsedMac == null -> "12 cifre esadecimali, con o senza : - ."
                else -> null
            },
        )
        Field("Seriale", form.serial, { v -> c.provisioning.updateForm { it.copy(serial = v) } })
        OutlinedButton(onClick = {
            GmsBarcodeScanning.getClient(context).startScan()
                .addOnSuccessListener { b -> b.rawValue?.let { raw -> c.provisioning.updateForm { Validation.applyScan(it, raw) } } }
        }) { Text("Scansiona etichetta (barcode/QR)") }
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
        Field("Password PPPoE", form.pppoePassword, { v -> c.provisioning.updateForm { it.copy(pppoePassword = v) } }, password = true,
            supporting = if (form.replaces != null) "Facoltativa: vuota = presa dal backup della CPE sostituita" else "Usata solo per questo provisioning, mai salvata")
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
            "Il server genera la configurazione completa e la consegna solo a questa app, in memoria. Poi collegati alla Wi-Fi della CPE: Internet non serve più.",
            style = MaterialTheme.typography.bodySmall,
        )
        BusyButton("Verifica piano", state.busy, Modifier.fillMaxWidth(), primary = false) {
            showErrors = true
            // The dry-run never uses the password: a placeholder keeps it valid in replacement mode.
            if (errors.isEmpty()) scope.launch { c.provisioning.plan(form.toRequest().let { r -> if (r.pppoePassword.isEmpty()) r.copy(pppoePassword = "-") else r }) }
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
        KeyValue("CPE", "${pkg.summary.model} · ${pkg.summary.mac}")
        if (pkg.summary.template.isNotBlank()) KeyValue("Template", pkg.summary.template)
        c.provisioning.form.collectAsState().value.location?.let { KeyValue("Posizione", "%.5f, %.5f".format(it.latitude, it.longitude)) }
        KeyValue("SSID", pkg.summary.ssid)
        KeyValue("Valido ancora", if (left.isNegative) "SCADUTO" else "${left.toMinutes()} min ${left.seconds % 60} s")
        if (left.isNegative) Banner("Pacchetto scaduto: torna online e preparalo di nuovo.", MaterialTheme.colorScheme.error)
    }

    SectionCard("1 · Collegati alla CPE") {
        Text("Collega il telefono alla Wi-Fi di management della CPE (IP ${pkg.target.host}). Se Android avvisa che la rete non ha Internet, scegli di restare connesso.",
            style = MaterialTheme.typography.bodySmall)
        KeyValue("Wi-Fi attuale", wifi?.let { "${it.wifiSsid ?: "connessa"} · ${it.addresses.firstOrNull { a -> !a.contains(':') } ?: "senza IPv4"}" } ?: "nessuna")
        OutlinedButton(onClick = {
            val i = if (Build.VERSION.SDK_INT >= 29) Intent(AndroidSettings.Panel.ACTION_WIFI) else Intent(AndroidSettings.ACTION_WIFI_SETTINGS)
            context.startActivity(i)
        }) { Text("Apri impostazioni Wi-Fi") }
        BusyButton("Rileva CPE", state.busy && !applying, Modifier.fillMaxWidth(), primary = false, enabled = !applying) {
            scope.launch { c.provisioning.probe() }
        }
        state.probe?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
    }

    SectionCard("2 · Primo avvio airOS") {
        Text("Se la CPE è appena resettata completa il primo accesso: Country Licensed, accetta i termini e imposta le credenziali CDA Net.",
            style = MaterialTheme.typography.bodySmall)
        OutlinedButton(onClick = onOpenCpeWeb, enabled = !applying) { Text("Apri interfaccia CPE nell'app") }
    }

    SectionCard("3 · Applica configurazione") {
        Text("Verifica firmware 8.7.4, board e MAC, scrive system.cfg, salva con cfgmtd e riavvia.", style = MaterialTheme.typography.bodySmall)
        BusyButton("Applica alla CPE", applying, Modifier.fillMaxWidth(), enabled = !left.isNegative && !state.busy) {
            scope.launch { c.provisioning.apply() }
        }
        state.stages.forEach { Text("✓ $it", style = MaterialTheme.typography.bodyMedium) }
    }

    TextButton(onClick = { c.provisioning.reset() }, enabled = !applying) { Text("Annulla e cancella il pacchetto") }
}
