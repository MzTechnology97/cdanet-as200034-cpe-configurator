package it.cdanet.cpeconfigurator.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.field.Acceptance
import it.cdanet.cpeconfigurator.field.AirosStatus
import it.cdanet.cpeconfigurator.field.FieldMode
import it.cdanet.cpeconfigurator.field.PhotoCapture
import it.cdanet.cpeconfigurator.field.parseCpeHeight
import it.cdanet.cpeconfigurator.install.RoofPhoto
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** Photos taken from the roof; the customer's router is photographed later, in the house. */
private val ROOF_CAPTIONS = listOf("Antenna", "Staffa / palo", "Cablaggio", "Altro")

/**
 * «Fine lavori sul tetto», right after the pointing: the radio readings of the acceptance test
 * (the phone is still on the CPE's Wi-Fi), the height of the CPE and the photos of the antenna, so
 * the technician comes down once. The house follows: router, speed test, acceptance test.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RoofStep(c: AppContainer, onNext: () -> Unit) {
    val roof = c.install.state.collectAsState().value.roof
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var shot by remember { mutableStateOf<Pair<File, String>?>(null) }
    var photoError by remember { mutableStateOf<String?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val (file, caption) = shot ?: return@rememberLauncherForActivityResult
        shot = null
        if (!ok) {
            file.delete()
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            runCatching { withContext(Dispatchers.Default) { PhotoCapture.compress(file) } }
                .onSuccess { jpeg -> c.install.roof { it.copy(photos = it.photos + RoofPhoto(caption, jpeg, PhotoCapture.thumbnail(jpeg))) } }
                .onFailure { photoError = it.message }
        }
    }

    RadioMeasureCard(c)

    SectionCard("2 · Altezza della CPE dal suolo") {
        val height = parseCpeHeight(roof.heightText)
        it.cdanet.cpeconfigurator.ui.Field(
            "Altezza (m)",
            roof.heightText,
            { v -> c.install.roof { it.copy(heightText = v.filter { ch -> ch.isDigit() || ch == ',' || ch == '.' }.take(5)) } },
            modifier = Modifier.fillMaxWidth(),
            keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal,
            placeholder = "es. 7,5",
            supporting = if (roof.heightText.isNotBlank() && height == null) "Da 0,5 a 100 m" else "Dal terreno all'antenna montata: va nel verbale del collaudo.",
            isError = roof.heightText.isNotBlank() && height == null,
        )
    }

    SectionCard("3 · Foto dal tetto (${roof.photos.size})") {
        Text("Antenna, staffa o palo e cablaggio adesso; il router del cliente lo fotografi in casa, nel collaudo.", style = MaterialTheme.typography.bodySmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ROOF_CAPTIONS.forEach { cap ->
                SecondaryButton(onClick = { val (f, u) = PhotoCapture.newTarget(context); shot = f to cap; camera.launch(u) }, enabled = roof.photos.size < 7) { Text(cap, maxLines = 1, softWrap = false) }
            }
        }
        roof.photos.forEach { p ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                p.thumb?.let { Image(it.asImageBitmap(), contentDescription = p.caption, modifier = Modifier.size(64.dp), contentScale = ContentScale.Crop) }
                Text("${p.caption} · ${p.jpeg.size / 1024} KB", modifier = Modifier.weight(1f))
                TextButton(onClick = { c.install.roof { r -> r.copy(photos = r.photos - p) } }) { Text("Rimuovi") }
            }
        }
        photoError?.let { Text(it, color = WarnAmber, style = MaterialTheme.typography.bodySmall) }
    }

    if (!roof.done) Text("Fai le misure radio prima di scendere: dopo il telefono passa alla Wi-Fi del router.", color = WarnAmber, style = MaterialTheme.typography.bodySmall)
    else if (parseCpeHeight(roof.heightText) == null) Text("Manca l'altezza della CPE: puoi scriverla anche nel collaudo.", color = WarnAmber, style = MaterialTheme.typography.bodySmall)
    BusyButton("Scendi: router del cliente", false, Modifier.fillMaxWidth(), enabled = roof.done) { onNext() }
}

/** «1 · Misure radio»: the ten readings of the acceptance test, from the CPE's Wi-Fi. */
@Composable
private fun RadioMeasureCard(c: AppContainer) {
    val roof = c.install.state.collectAsState().value.roof
    val st by c.field.state.collectAsState()
    var samples by remember { mutableStateOf<List<AirosStatus>>(emptyList()) }
    var measuring by remember { mutableStateOf(false) }
    val n = Acceptance.SAMPLES
    DisposableEffect(Unit) {
        onDispose {
            if (measuring) {
                c.field.onSample = null
                c.field.stop()
            }
        }
    }
    SectionCard("1 · Misure radio") {
        Text("$n letture in $n secondi dalla CPE, adesso che il telefono è ancora sulla sua Wi-Fi: vanno nel collaudo.", style = MaterialTheme.typography.bodySmall)
        if (measuring) {
            LinearProgressIndicator(progress = { samples.size / n.toFloat() }, modifier = Modifier.fillMaxWidth())
            Text(st.error ?: (st.status?.signal?.let { "Segnale $it dBm · lettura ${samples.size}/$n" } ?: "Ricerca della CPE…"), style = MaterialTheme.typography.bodySmall)
        }
        roof.radio?.let { list ->
            val sig = list.mapNotNull { it.signal }.takeIf { it.isNotEmpty() }?.average()?.let { Math.round(it) }
            Text("Misure fatte: segnale medio ${sig ?: "—"} dBm su ${list.size} letture.", color = GoodGreen, style = MaterialTheme.typography.bodySmall)
        }
        BusyButton(if (roof.radio == null) "Avvia misura" else "Ripeti misura", measuring, Modifier.fillMaxWidth()) {
            samples = emptyList()
            measuring = true
            c.field.onSample = { s ->
                if (samples.size < n) samples = samples + s
                if (samples.size >= n) {
                    c.field.onSample = null
                    c.field.stop()
                    measuring = false
                    c.install.roof { it.copy(radio = samples, radioSkipped = false) }
                }
            }
            c.field.start(FieldMode.Alignment)
        }
        if (roof.radio == null && !roof.radioSkipped && !measuring) {
            TextButton(onClick = { c.install.roof { it.copy(radioSkipped = true) } }) { Text("Le faccio nel collaudo") }
        }
    }
}
