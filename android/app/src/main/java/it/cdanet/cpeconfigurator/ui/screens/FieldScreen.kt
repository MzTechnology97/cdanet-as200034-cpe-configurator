package it.cdanet.cpeconfigurator.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.field.AlignmentTone
import it.cdanet.cpeconfigurator.field.AirosStatus
import it.cdanet.cpeconfigurator.field.FieldDiagnosis
import it.cdanet.cpeconfigurator.field.FieldMode
import it.cdanet.cpeconfigurator.field.FieldThresholds
import it.cdanet.cpeconfigurator.field.Verdict
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.Banner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlin.math.roundToInt
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.field.SurveyAp

private fun verdictColor(v: Verdict, fallback: Color): Color = when (v) {
    Verdict.Ok -> GoodGreen
    Verdict.Warn -> WarnAmber
    Verdict.Bad -> BadRed
    Verdict.Info -> fallback
}

/** Connection header shared by the field tools: how the phone reaches the CPE, manual IP, errors. */
@Composable
private fun FieldConnection(c: AppContainer, mode: FieldMode) {
    val st by c.field.state.collectAsState()
    var manual by remember { mutableStateOf("") }
    var showManual by remember { mutableStateOf(false) }
    var showCreds by remember { mutableStateOf(false) }
    var user by remember { mutableStateOf("ubnt") }
    var pass by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when {
            st.connecting && st.status == null -> Banner("Ricerca della CPE sulla Wi-Fi collegata…", WarnAmber)
            st.error != null -> Banner(st.error ?: "", BadRed)
            st.target != null -> Text("CPE ${st.status?.hostname ?: ""} · ${st.target}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (st.status == null) {
            Text(
                "Collega il telefono alla Wi-Fi di management della CPE oppure alla Wi-Fi del router del cliente: l'app prova da sola il gateway, l'IP LAN e l'IP di management della CPE.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (st.running) OutlinedButton(onClick = { c.field.stop() }) { Text("Pausa") }
            else OutlinedButton(onClick = { c.field.start(mode, manual.ifBlank { null }) }) { Text("Riprendi") }
            TextButton(onClick = { showManual = !showManual }) { Text(if (showManual) "Nascondi IP" else "IP manuale") }
        }
        if (showManual) {
            Field("IP della CPE", manual, { manual = it.trim() }, keyboardType = KeyboardType.Uri, placeholder = "es. 192.168.1.254")
            OutlinedButton(onClick = { c.field.start(mode, manual.ifBlank { null }) }, enabled = manual.isNotBlank()) { Text("Collega a questo IP") }
        }
        st.credentialsUsed?.takeIf { st.status != null && it != "CDA Net" }?.let {
            Text("Collegata con credenziali $it: la CPE non usa le credenziali standard CDA Net.", style = MaterialTheme.typography.bodySmall, color = WarnAmber)
        }
        if (st.authFailed || showCreds) {
            SectionCard("Credenziali della CPE") {
                Text("Usate solo per questa sessione e tenute in memoria: non vengono salvate né inviate al server.", style = MaterialTheme.typography.bodySmall)
                Field("Utente", user, { user = it })
                Field("Password", pass, { pass = it }, password = true)
                OutlinedButton(onClick = {
                    c.field.useManualCredentials(user, pass)
                    pass = ""
                    c.field.start(mode, manual.ifBlank { null })
                }, enabled = user.isNotBlank() && pass.isNotEmpty()) { Text("Collega con queste credenziali") }
            }
        } else {
            TextButton(onClick = { showCreds = true }) { Text("Credenziali diverse") }
        }
    }
}

@Composable
private fun KeepScreenOnWhileRunning(c: AppContainer, mode: FieldMode) {
    val view = LocalView.current
    DisposableEffect(Unit) {
        view.keepScreenOn = true
        c.field.start(mode)
        onDispose {
            view.keepScreenOn = false
            c.field.onSample = null
            c.field.stop()
        }
    }
}

@Composable
private fun rememberFieldAccess(c: AppContainer): Boolean {
    var ready by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(Unit) { ready = c.field.prefetch("alignment") }
    if (ready == false) {
        Banner("Credenziali CPE non disponibili: accedi al server con Internet attivo e riapri lo strumento.", BadRed)
    }
    return ready == true
}

/** Antenna alignment: big live signal, pitch-following beep, peak hold, trend. */
@Composable
fun AlignmentScreen(c: AppContainer) {
    if (!rememberFieldAccess(c)) return
    val st by c.field.state.collectAsState()
    var sound by remember { mutableStateOf(true) }
    val tone = remember { AlignmentTone() }
    KeepScreenOnWhileRunning(c, FieldMode.Alignment)
    LaunchedEffect(sound) { c.field.onSample = if (sound) { s -> tone.beep(s.signal) } else null }
    val t = c.field.thresholds

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        FieldConnection(c, FieldMode.Alignment)
        st.status?.let { s ->
            AlignmentGauge(s, t, st.peak, st.history)
            SectionCard("Collegamento") {
                KeyValue("AP", listOfNotNull(s.apName, s.apMac).joinToString(" · ").ifBlank { "non agganciata" })
                KeyValue("SSID", s.essid ?: "—")
                s.distanceM?.let { KeyValue("Distanza", FieldDiagnosis.formatDistance(it)) }
                s.frequencyMhz?.let { KeyValue("Frequenza", "$it MHz${s.channelWidthMhz?.let { w -> " · $w MHz" } ?: ""}") }
                s.remoteSignal?.let { KeyValue("Segnale lato AP", "$it dBm") }
                s.cinrRx?.let { KeyValue("CINR", "$it dB") }
                s.dlCapacityMbps?.let { KeyValue("Capacità", "${it.roundToInt()} / ${s.ulCapacityMbps?.roundToInt() ?: "—"} Mbit/s") }
                s.noise?.let { KeyValue("Rumore", "$it dBm") }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Bip di puntamento (più acuto = segnale migliore)", modifier = Modifier.weight(1f))
            Switch(checked = sound, onCheckedChange = { sound = it })
        }
        OutlinedButton(onClick = { c.field.resetPeak() }) { Text("Azzera picco e grafico") }
        SurveyCard(c, st.status?.apMac)
    }
}

/** APs heard by the CPE's own radio (airOS site survey): pick the best one from the roof. */
@Composable
private fun SurveyCard(c: AppContainer, currentAp: String?) {
    val scope = rememberCoroutineScope()
    var aps by remember { mutableStateOf<List<SurveyAp>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    SectionCard("AP visibili dalla CPE") {
        Text("Scansione fatta dalla radio della CPE (site survey): mostra gli AP che l'antenna sente da qui. Durante la scansione il collegamento della CPE può interrompersi per qualche secondo.", style = MaterialTheme.typography.bodySmall)
        BusyButton("Scansiona AP dalla CPE", busy, Modifier.fillMaxWidth(), primary = false) {
            scope.launch {
                busy = true
                error = null
                runCatching { c.field.siteSurvey() }.onSuccess { aps = it }.onFailure { error = it.message }
                busy = false
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        aps?.let { list ->
            if (list.isEmpty()) Text("Nessun AP rilevato.", style = MaterialTheme.typography.bodySmall)
            val cda = list.filter { it.cdaNet != null }
            if (cda.isNotEmpty()) Text("${cda.size} AP CDA Net · migliore: ${cda.first().essid} (${cda.first().signal ?: "—"} dBm)", fontWeight = FontWeight.SemiBold, color = GoodGreen)
            list.forEach { a ->
                val mine = currentAp != null && a.mac.equals(currentAp, ignoreCase = true)
                Text(
                    "${a.essid.ifBlank { "(nascosto)" }}${if (mine) " · agganciato" else ""}",
                    fontWeight = if (a.cdaNet != null || mine) FontWeight.SemiBold else FontWeight.Normal,
                )
                Text(
                    listOfNotNull(
                        a.signal?.let { "$it dBm" },
                        a.snr?.let { "SNR $it dB" },
                        a.frequencyMhz?.let { "$it MHz" },
                        a.channel?.let { "ch $it" },
                        a.mode.ifBlank { null },
                        a.security.ifBlank { null },
                        a.airmax?.let { if (it) "airMAX" else null },
                        a.mac,
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun AlignmentGauge(s: AirosStatus, t: FieldThresholds, peak: Int?, history: List<Int>) {
    val v = FieldDiagnosis.signalVerdict(s.signal, t)
    val color = verdictColor(v, MaterialTheme.colorScheme.onSurface)
    SectionCard {
        Text(
            s.signal?.let { "$it dBm" } ?: "—",
            fontSize = 64.sp,
            fontWeight = FontWeight.Bold,
            color = color,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        val expected = s.expectedSignal?.let { e -> s.signal?.let { "atteso $e dBm (${FieldDiagnosis.signed(it - e)} dB)" } }
        Text(
            listOfNotNull(expected, peak?.let { "picco $it dBm" }).joinToString(" · ").ifBlank { if (s.associated) "" else "CPE non agganciata all'AP" },
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        if (s.chains.size >= 2) {
            val imbalance = s.chainImbalance ?: 0
            Text(
                "Catene ${s.chains.joinToString(" / ")} dBm" + if (imbalance > t.chainDelta) " · sbilanciate di $imbalance dB" else "",
                color = if (imbalance > t.chainDelta) WarnAmber else MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        SignalTrend(history, t)
    }
}

/** Last ~90 samples; dashed lines at the good/minimum thresholds. */
@Composable
private fun SignalTrend(history: List<Int>, t: FieldThresholds) {
    val line = MaterialTheme.colorScheme.primary
    Canvas(Modifier.fillMaxWidth().height(90.dp)) {
        val lo = -90f
        val hi = -35f
        fun y(v: Float) = size.height * (1 - ((v.coerceIn(lo, hi) - lo) / (hi - lo)))
        val dash = PathEffect.dashPathEffect(floatArrayOf(10f, 10f))
        drawLine(GoodGreen, Offset(0f, y(t.signalGood.toFloat())), Offset(size.width, y(t.signalGood.toFloat())), pathEffect = dash)
        drawLine(BadRed, Offset(0f, y(t.signalMin.toFloat())), Offset(size.width, y(t.signalMin.toFloat())), pathEffect = dash)
        if (history.size >= 2) {
            val step = size.width / (90 - 1)
            val start = size.width - step * (history.size - 1)
            history.zipWithNext().forEachIndexed { i, (a, b) ->
                drawLine(line, Offset(start + step * i, y(a.toFloat())), Offset(start + step * (i + 1), y(b.toFloat())), strokeWidth = 4f)
            }
        }
    }
}

/** Fault diagnosis: checklist with an actionable explanation for each item, shareable with the NOC. */
@Composable
fun DiagnosisScreen(c: AppContainer) {
    if (!rememberFieldAccess(c)) return
    val st by c.field.state.collectAsState()
    val context = LocalContext.current
    KeepScreenOnWhileRunning(c, FieldMode.Diagnosis)

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        FieldConnection(c, FieldMode.Diagnosis)
        val s = st.status ?: return@Column
        val summary = FieldDiagnosis.summary(st.checks)
        Banner(
            when (summary) {
                Verdict.Ok -> "Nessun problema rilevato sulla CPE"
                Verdict.Warn -> "Ci sono punti da verificare"
                else -> "Problema rilevato: vedi le voci in rosso"
            },
            verdictColor(summary, GoodGreen),
        )
        SectionCard("${s.hostname ?: "CPE"} · ${s.model ?: ""}") {
            st.checks.forEach { ch ->
                Column {
                    Text("${FieldDiagnosis.mark(ch.verdict)} ${ch.title}", fontWeight = FontWeight.SemiBold, color = verdictColor(ch.verdict, MaterialTheme.colorScheme.onSurface))
                    Text(ch.detail, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                val cm = context.getSystemService(ClipboardManager::class.java)
                cm.setPrimaryClip(ClipData.newPlainText("Diagnosi CPE", FieldDiagnosis.report(s, st.checks)))
            }) { Text("Copia") }
            OutlinedButton(onClick = {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, FieldDiagnosis.report(s, st.checks))
                context.startActivity(Intent.createChooser(send, "Invia diagnosi"))
            }) { Text("Condividi con il NOC") }
        }
    }
}
