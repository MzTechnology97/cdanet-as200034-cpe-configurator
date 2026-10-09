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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.FirmwareImageDto
import it.cdanet.cpeconfigurator.data.FirmwareListDto
import it.cdanet.cpeconfigurator.firmware.AirosBuild
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
    var cpe by remember { mutableStateOf<AirosBuild?>(null) }
    var reading by remember { mutableStateOf(false) }
    var flashing by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<FirmwareImageDto?>(null) }
    val stages = remember { mutableStateListOf<String>() }
    var outcome by remember { mutableStateOf<Pair<String, NoticeKind>?>(null) }

    // the CPE must not lose the phone halfway: display on while reading or flashing
    val view = LocalView.current
    DisposableEffect(flashing) {
        view.keepScreenOn = flashing
        onDispose { view.keepScreenOn = false }
    }

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
        BusyButton("Leggi la versione della CPE", reading, enabled = !flashing, primary = false) {
            scope.launch {
                reading = true
                outcome = null
                runCatching { c.field.withCpeSsh { open -> open().use { CpeFirmwareFlasher {}.readVersion(it) } } }
                    .onSuccess {
                        cpe = it
                        if (it == null) outcome = "Versione della CPE non leggibile" to NoticeKind.Bad
                    }
                    .onFailure { outcome = (it.message ?: it.toString()) to NoticeKind.Bad }
                reading = false
            }
        }
        cpe?.let { b ->
            KeyValue("Firmware attuale", "${b.platform} · ${b.version}")
            val target = l?.target
            val img = l?.items?.firstOrNull { it.platform == b.platform }
            when {
                target != null && b.version == target -> Notice("La CPE ha già il firmware richiesto ($target).", NoticeKind.Good)
                img == null -> Notice("Nessun firmware ${target ?: ""} per la piattaforma ${b.platform}: chiedi all'amministratore di caricarlo.", NoticeKind.Bad)
                !c.firmware.has(img) -> Notice("Il firmware ${img.platform} ${img.version} non è sul telefono: scaricalo con Internet, poi torna sulla Wi-Fi della CPE.", NoticeKind.Warn)
                else -> BusyButton("Aggiorna a ${img.version}", flashing) { confirm = img }
            }
        }
        stages.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall) }
        outcome?.let { (text, kind) -> Notice(text, kind) }
    }

    confirm?.let { img ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Aggiornare la CPE a ${img.version}?") },
            text = { Text("Da ${cpe?.version ?: "?"} a ${img.version} (${img.platform}). La CPE si riavvia da sola. Tieni la CPE alimentata e il telefono vicino fino alla fine.") },
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
                                before = open().use { flasher.start(it, c.firmware.fileOf(img), img) }
                                flasher.waitBack(open)
                            }
                        }
                        val after = result.getOrNull()
                        val failure = result.exceptionOrNull()
                        outcome = when {
                            failure is CpeFirmwareFlasher.AlreadyUpToDate -> "La CPE ha già il firmware ${img.version}." to NoticeKind.Good
                            failure != null -> (failure.message ?: failure.toString()) to NoticeKind.Bad
                            after == null -> "La CPE non è tornata raggiungibile entro 9 minuti: attendi ancora, ricollegati alla sua Wi-Fi e rileggi la versione. Non toglierle alimentazione." to NoticeKind.Warn
                            after.version == img.version -> "Aggiornata: ${after.build}. Ora puoi procedere con il provisioning." to NoticeKind.Good
                            else -> "La CPE è ripartita con ${after.version} invece di ${img.version}: aggiornamento non applicato (vedi /tmp/fwupdate.log)." to NoticeKind.Bad
                        }
                        if (after != null) cpe = after
                        val from = before
                        if (from != null) {
                            // the flash started: activity log on the server (best effort, there may be no Internet here)
                            val ok = after?.version == img.version
                            val note = if (ok) null else outcome?.first
                            scope.launch { runCatching { c.api.firmwareReport(null, from.build, img.version, ok, note) } }
                        }
                        flashing = false
                    }
                }) { Text("Aggiorna") }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Annulla") } },
        )
    }
}
