package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.FirmwareImageDto
import it.cdanet.cpeconfigurator.data.FirmwareListDto
import it.cdanet.cpeconfigurator.firmware.AirosBuild
import it.cdanet.cpeconfigurator.firmware.AirosImage
import it.cdanet.cpeconfigurator.firmware.CpeFirmwareFlasher
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.StatusChip
import kotlinx.coroutines.launch

private fun mb(bytes: Long) = "%.1f MB".format(java.util.Locale.ITALY, bytes / 1024.0 / 1024.0)

/**
 * "Firmware": the images of the required airOS version are downloaded with Internet and kept on
 * the phone; on the CPE's Wi-Fi the CPE is read and, after confirmation, flashed. The screen stays
 * on while it works and every check (platform, room, MD5) stops it before touching the flash.
 */
@Composable
fun FirmwareScreen(c: AppContainer) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<FirmwareListDto?>(c.firmware.savedList()) }
    var listError by remember { mutableStateOf<String?>(null) }
    val progress = remember { mutableStateMapOf<Int, Float>() }
    var downloaded by remember { mutableStateOf(0) }
    // the version the Ubiquiti discovery read (no SSH needed); «Leggi la versione» reads it over SSH
    val selected by c.field.selected.collectAsState()
    var cpe by remember { mutableStateOf<AirosBuild?>(null) }
    LaunchedEffect(selected?.firmware) { selected?.firmware?.let { AirosImage.parseBuild(it) }?.let { cpe = it } }
    var reading by remember { mutableStateOf(false) }
    var readError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { c.api.firmwareList() }
            .onSuccess {
                c.firmware.saveList(it)
                list = it
            }
            .onFailure { if (list == null) listError = it.message }
    }

    val l = list
    SectionCard("Firmware sul telefono", icon = R.drawable.ic_system_update) {
        when {
            l == null -> Text(listError?.let { "Elenco non disponibile: $it. Aprilo una volta con Internet." } ?: "Caricamento…")
            l.items.isEmpty() -> Notice("Nessun firmware ${l.target} pubblicato dall'amministratore.", NoticeKind.Warn)
            else -> {
                Text("Versione richiesta: ${l.target}. Scaricali con Internet: sul tetto la CPE si aggiorna senza rete.", style = MaterialTheme.typography.bodySmall)
                l.items.forEach { img ->
                    HorizontalDivider()
                    val have = downloaded >= 0 && c.firmware.has(img)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("${img.platform} · ${img.version}", fontWeight = FontWeight.SemiBold)
                            Text(mb(img.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (have) StatusChip("sul telefono", NoticeKind.Good)
                        else BusyButton("Scarica", progress.containsKey(img.id), primary = false, tonal = true) {
                            scope.launch {
                                progress[img.id] = 0f
                                runCatching { c.firmware.download(c.api, img) { p -> progress[img.id] = p } }
                                    .onFailure { listError = it.message }
                                progress.remove(img.id)
                                downloaded++
                            }
                        }
                    }
                    progress[img.id]?.let { p -> LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth()) }
                }
                listError?.let { Notice(it, NoticeKind.Bad) }
            }
        }
    }

    SectionCard("Aggiorna la CPE collegata") {
        Notice(
            "Collegati alla Wi-Fi della CPE. Durante l'aggiornamento (3-5 minuti) non togliere alimentazione alla CPE e non chiudere l'app: se la scrittura si interrompe la CPE può non ripartire.",
            NoticeKind.Warn,
        )
        BusyButton(if (cpe == null) "Leggi la versione della CPE" else "Rileggi la versione via SSH", reading, primary = false) {
            scope.launch {
                reading = true
                readError = null
                runCatching { c.field.withCpeSsh { open -> open().use { CpeFirmwareFlasher {}.readVersion(it) } } }
                    .onSuccess {
                        cpe = it
                        if (it == null) readError = "Versione della CPE non leggibile"
                    }
                    .onFailure { readError = it.message ?: it.toString() }
                reading = false
            }
        }
        readError?.let { Notice(it, NoticeKind.Bad) }
        cpe?.let { b -> CpeFirmwareUpdater(c, b, l) { after -> if (after != null) cpe = after } }
    }
}

/**
 * The update of the CPE on the phone's Wi-Fi to the required airOS version, from [current] (read
 * over SSH or by the Ubiquiti discovery): the image of its platform (downloaded with Internet if
 * missing), confirmation, then send, MD5 check, write, wait for the reboot and read the version
 * again. Used by «Firmware» and inside the installation, without leaving it. [onDone]: the build
 * after the update (null when the CPE did not come back in time).
 */
@Composable
fun CpeFirmwareUpdater(c: AppContainer, current: AirosBuild, list: FirmwareListDto?, onDone: (AirosBuild?) -> Unit) {
    val scope = rememberCoroutineScope()
    var flashing by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<FirmwareImageDto?>(null) }
    var downloading by remember { mutableStateOf<Float?>(null) }
    var downloaded by remember { mutableStateOf(0) }
    val stages = remember { mutableStateListOf<String>() }
    var outcome by remember { mutableStateOf<Pair<String, NoticeKind>?>(null) }
    // the CPE must not lose the phone halfway: display on while flashing
    if (flashing) it.cdanet.cpeconfigurator.ui.KeepScreenOn()

    KeyValue("Firmware attuale", "${current.platform} · ${current.version}")
    val target = list?.target
    val img = list?.items?.firstOrNull { it.platform == current.platform }
    when {
        list == null -> Notice("Elenco dei firmware non disponibile: apri una volta CPE collegata → Firmware con Internet.", NoticeKind.Warn)
        target != null && current.version == target -> if (outcome == null) Notice("La CPE ha già il firmware richiesto ($target).", NoticeKind.Good)
        img == null -> Notice("Nessun firmware ${target ?: ""} per la piattaforma ${current.platform}: chiedi all'amministratore di caricarlo.", NoticeKind.Bad)
        downloaded >= 0 && !c.firmware.has(img) -> {
            Text("Il firmware ${img.platform} ${img.version} (${mb(img.size)}) non è sul telefono.", style = MaterialTheme.typography.bodySmall)
            BusyButton("Scarica il firmware", downloading != null, primary = false, tonal = true) {
                scope.launch {
                    downloading = 0f
                    outcome = null
                    runCatching { c.firmware.download(c.api, img) { p -> downloading = p } }
                        .onFailure { outcome = "Download non riuscito: ${it.message}. Serve Internet: poi torna sulla Wi-Fi della CPE." to NoticeKind.Bad }
                    downloading = null
                    downloaded++
                }
            }
            downloading?.let { p -> LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth()) }
        }
        else -> BusyButton("Aggiorna a ${img.version}", flashing) { confirm = img }
    }
    stages.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall) }
    outcome?.let { (text, kind) -> Notice(text, kind) }

    confirm?.let { image ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Aggiornare la CPE a ${image.version}?") },
            text = { Text("Da ${current.version} a ${image.version} (${image.platform}). La CPE si riavvia da sola in 3-5 minuti. Tieni la CPE alimentata e il telefono vicino fino alla fine.") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    scope.launch {
                        flashing = true
                        stages.clear()
                        outcome = null
                        val flasher = CpeFirmwareFlasher { s -> scope.launch { stages += s } }
                        var before: AirosBuild? = null
                        val result = runCatching {
                            c.field.withCpeSsh { open ->
                                before = open().use { flasher.start(it, c.firmware.fileOf(image), image) }
                                flasher.waitBack(open)
                            }
                        }
                        val after = result.getOrNull()
                        val failure = result.exceptionOrNull()
                        outcome = when {
                            failure is CpeFirmwareFlasher.AlreadyUpToDate -> "La CPE ha già il firmware ${image.version}." to NoticeKind.Good
                            failure != null -> (failure.message ?: failure.toString()) to NoticeKind.Bad
                            after == null -> "La CPE non è tornata raggiungibile entro 9 minuti: attendi ancora, ricollegati alla sua Wi-Fi e ricontrolla. Non toglierle alimentazione." to NoticeKind.Warn
                            after.version == image.version -> "Aggiornata: ${after.build}. Puoi procedere." to NoticeKind.Good
                            else -> "La CPE è ripartita con ${after.version} invece di ${image.version}: aggiornamento non applicato (vedi /tmp/fwupdate.log)." to NoticeKind.Bad
                        }
                        val from = before
                        if (from != null) {
                            // the flash started: activity log on the server (best effort, there may be no Internet here)
                            val ok = after?.version == image.version
                            val note = if (ok) null else outcome?.first
                            scope.launch { runCatching { c.api.firmwareReport(null, from.build, image.version, ok, note) } }
                        }
                        flashing = false
                        when {
                            failure is CpeFirmwareFlasher.AlreadyUpToDate -> onDone(failure.build)
                            failure == null -> onDone(after)
                        }
                    }
                }) { Text("Aggiorna") }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Annulla") } },
        )
    }
}
