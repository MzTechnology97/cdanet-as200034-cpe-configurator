package it.cdanet.cpeconfigurator.ui.screens

import it.cdanet.cpeconfigurator.ui.CheckRow
import it.cdanet.cpeconfigurator.ui.WifiRequired
import android.graphics.Bitmap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.KoMeasures
import it.cdanet.cpeconfigurator.field.Acceptance
import it.cdanet.cpeconfigurator.field.AcceptanceReport
import it.cdanet.cpeconfigurator.field.AirosStatus
import it.cdanet.cpeconfigurator.field.FieldDiagnosis
import it.cdanet.cpeconfigurator.field.FieldMode
import it.cdanet.cpeconfigurator.field.InternetProbe
import it.cdanet.cpeconfigurator.field.InternetTest
import it.cdanet.cpeconfigurator.field.PhotoCapture
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.Banner
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

private class PendingPhoto(val caption: String, val jpeg: ByteArray, val thumb: Bitmap?)

private val CAPTIONS = listOf("Antenna", "Staffa / palo", "Cablaggio", "Router cliente", "Altro")

/**
 * Final acceptance test of an installation: 10 CPE readings (signal averaged), Internet
 * through the customer Wi-Fi, photos and notes, saved in the job (printable report on the web).
 */
@Composable
fun AcceptanceScreen(c: AppContainer) {
    val job by c.selectedJob.collectAsState()
    val j = job ?: run {
        Text("Apri il collaudo da Storico → job completato.")
        return
    }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val st by c.field.state.collectAsState()
    val samples = remember { mutableStateListOf<AirosStatus>() }
    var measuring by remember { mutableStateOf(false) }
    var internet by remember { mutableStateOf<InternetTest?>(null) }
    var testingInternet by remember { mutableStateOf(false) }
    val photos = remember { mutableStateListOf<PendingPhoto>() }
    var notes by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf<String?>(null) }
    var shot by remember { mutableStateOf<Pair<File, String>?>(null) }
    var ready by remember { mutableStateOf<Boolean?>(null) }
    var ko by remember { mutableStateOf(false) }

    it.cdanet.cpeconfigurator.ui.KeepScreenOn()
    DisposableEffect(Unit) {
        scope.launch { ready = c.field.prefetch("acceptance") }
        onDispose {
            c.field.onSample = null
            c.field.stop()
        }
    }

    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val (file, caption) = shot ?: return@rememberLauncherForActivityResult
        shot = null
        if (!ok) {
            file.delete()
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            runCatching { withContext(Dispatchers.Default) { PhotoCapture.compress(file) } }
                .onSuccess { photos += PendingPhoto(caption, it, PhotoCapture.thumbnail(it)) }
                .onFailure { error = it.message }
        }
    }

    fun startMeasure() {
        samples.clear()
        measuring = true
        c.field.onSample = { s ->
            if (samples.size < Acceptance.SAMPLES) samples += s
            if (samples.size >= Acceptance.SAMPLES) {
                c.field.onSample = null
                c.field.stop()
                measuring = false
            }
        }
        c.field.start(FieldMode.Alignment)
    }

    val report: AcceptanceReport? = if (samples.size >= Acceptance.SAMPLES) {
        Acceptance.build(samples.toList(), c.field.thresholds, c.field.targetFirmware, internet ?: InternetTest(false, note = "Non misurato"), notes)
    } else {
        null
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ErrorBanner(error) { error = null }
        done?.let { Banner(it, GoodGreen) }
        if (ready == false) Banner("Credenziali CPE non disponibili: accedi con Internet attivo e riapri il collaudo.", BadRed)
        SectionCard("Installazione") {
            KeyValue("Cliente", j.deviceName.ifBlank { j.pppoeUser })
            KeyValue("CPE", "${j.model} · ${j.mac}")
            KeyValue("SSID", j.ssid)
        }

        WifiRequired(c, "alla Wi-Fi della CPE (management, es. \"LBE-5AC-Gen2:xxxx\") oppure a quella del router del cliente", "Misure e test Internet richiedono la rete locale; foto e note funzionano comunque.") {
        SectionCard("1 · Misure radio") {
            Text("${Acceptance.SAMPLES} letture in ${Acceptance.SAMPLES} secondi dalla CPE: il segnale viene mediato.", style = MaterialTheme.typography.bodySmall)
            if (measuring) {
                LinearProgressIndicator(progress = { samples.size / Acceptance.SAMPLES.toFloat() }, modifier = Modifier.fillMaxWidth())
                Text(st.error ?: (st.status?.signal?.let { "Segnale $it dBm · lettura ${samples.size}/${Acceptance.SAMPLES}" } ?: "Ricerca della CPE…"))
            }
            report?.let { r ->
                KeyValue("Segnale medio", "${r.radio.signal ?: "—"} dBm (min ${r.radio.signalMin ?: "—"} / max ${r.radio.signalMax ?: "—"})")
                r.radio.dlCapacityMbps?.let { KeyValue("Capacità", "${it.toInt()} / ${r.radio.ulCapacityMbps?.toInt() ?: "—"} Mbit/s") }
                r.lan?.let { KeyValue("Porta LAN", if (it.plugged == true) "${it.speedMbps} Mbit/s ${if (it.fullDuplex == true) "full" else "half"}" else "scollegata") }
                r.pppoe?.let { KeyValue("PPPoE", it.ip ?: "non attivo") }
            }
            BusyButton(if (report == null) "Avvia misura" else "Ripeti misura", measuring, Modifier.fillMaxWidth(), enabled = ready == true) { startMeasure() }
        }

        SectionCard("2 · Internet dal lato cliente") {
            Text("Collega il telefono alla Wi-Fi del router del cliente: velocità e ping verso il server CDA Net passano dalla nuova linea.", style = MaterialTheme.typography.bodySmall)
            internet?.let { i ->
                if (i.tested) {
                    KeyValue("Download", "%.1f Mbit/s".format(i.downloadMbps ?: 0.0))
                    KeyValue("Upload", "%.1f Mbit/s".format(i.uploadMbps ?: 0.0))
                    KeyValue("Ping / jitter", "%.0f / %.0f ms".format(i.pingMs ?: 0.0, i.jitterMs ?: 0.0))
                } else {
                    Text(i.note ?: "Non misurato", color = WarnAmber)
                }
            }
            BusyButton("Misura Internet", testingInternet, Modifier.fillMaxWidth(), primary = false) {
                scope.launch {
                    testingInternet = true
                    internet = InternetProbe.measure(c.network, c.api.base(), c.session.token)
                    testingInternet = false
                }
            }
        }

        }

        SectionCard("3 · Foto (${photos.size}/8)") {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                CAPTIONS.take(3).forEach { cap -> OutlinedButton(onClick = { val (f, u) = PhotoCapture.newTarget(context); shot = f to cap; camera.launch(u) }, enabled = photos.size < 8) { Text(cap) } }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                CAPTIONS.drop(3).forEach { cap -> OutlinedButton(onClick = { val (f, u) = PhotoCapture.newTarget(context); shot = f to cap; camera.launch(u) }, enabled = photos.size < 8) { Text(cap) } }
            }
            photos.toList().forEach { p ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    p.thumb?.let { Image(it.asImageBitmap(), contentDescription = p.caption, modifier = Modifier.size(72.dp), contentScale = ContentScale.Crop) }
                    Text("${p.caption} · ${p.jpeg.size / 1024} KB", modifier = Modifier.weight(1f))
                    TextButton(onClick = { photos.remove(p) }) { Text("Rimuovi") }
                }
            }
        }

        SectionCard("4 · Note") {
            OutlinedTextField(notes, { notes = it.take(1000) }, label = { Text("Note per il NOC (facoltative)") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
        }

        report?.let { r ->
            val color = when (r.verdict) { "ok" -> GoodGreen; "warn" -> WarnAmber; else -> BadRed }
            SectionCard("Esito: ${mapOf("ok" to "superato", "warn" to "con riserva", "bad" to "non superato")[r.verdict]}") {
                r.checks.forEach { ch -> CheckRow(ch.title, enumValueOf(ch.verdict.replaceFirstChar { it.uppercase() }), ch.detail) }
                Text("Verdetto calcolato dalle soglie del NOC.", style = MaterialTheme.typography.bodySmall, color = color)
                val noc = nocApprovalReason(r.radio.signal, c.field.thresholds.signalMin, r.checks.filter { it.verdict == "bad" }.map { it.title })
                if (noc != null) Banner("Approvazione NOC necessaria: $noc. $NOC_APPROVAL_TEXT", WarnAmber)
                if (noc != null || r.verdict == "bad") {
                    OutlinedButton(onClick = { ko = true }, modifier = Modifier.fillMaxWidth()) { Text("Segnala KO o rimanda l'installazione", color = BadRed) }
                }
            }
            if (ko) {
                KoDialog(
                    c,
                    KoContext(
                        jobId = j.id,
                        mode = "new",
                        step = "final",
                        mac = j.mac,
                        ssid = r.cpe.essid ?: j.ssid,
                        measures = KoMeasures(signal = r.radio.signal, expectedSignal = r.radio.expectedSignal, distanceM = r.cpe.distanceM, apName = r.cpe.apName, associated = true),
                    ),
                    onDismiss = { ko = false },
                    onRetry = { ko = false },
                    onClose = { ko = false },
                )
            }
        }

        val queued by c.acceptanceQueue.pending.collectAsState()
        if (queued.any { it.jobId == j.id }) {
            Banner("Collaudo salvato sul telefono: verrà inviato appena c'è rete (anche chiudendo questa schermata).", WarnAmber)
        }
        BusyButton("Salva e invia collaudo", sending, Modifier.fillMaxWidth(), enabled = report != null || photos.isNotEmpty()) {
            scope.launch {
                sending = true
                error = null
                try {
                    // Always through the on-device queue: nothing is lost if the roof has no signal.
                    val n = photos.size
                    c.acceptanceQueue.enqueue(j.id, j.deviceName.ifBlank { j.mac }, report, photos.map { it.jpeg to it.caption })
                    photos.clear()
                    c.acceptanceQueue.sync()
                    done = if (c.acceptanceQueue.isPending(j.id)) {
                        "Senza rete: collaudo${if (n > 0) " e $n foto" else ""} in coda sul telefono, invio automatico appena torna la connessione."
                    } else {
                        "Collaudo registrato${if (n > 0) " con $n foto" else ""}: il verbale si stampa dalla console web (Storico → job)." +
                            if (report?.let { r -> nocApprovalReason(r.radio.signal, c.field.thresholds.signalMin, r.checks.filter { it.verdict == "bad" }.map { it.title }) } != null) " In attesa dell'approvazione del NOC: l'esito arriva nelle Notifiche." else ""
                    }
                } catch (e: Exception) {
                    error = e.message
                } finally {
                    sending = false
                }
            }
        }
    }
}
