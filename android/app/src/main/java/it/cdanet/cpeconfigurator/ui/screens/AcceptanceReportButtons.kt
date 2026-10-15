package it.cdanet.cpeconfigurator.ui.screens

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import it.cdanet.cpeconfigurator.core.AppContainer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** The acceptance report (PDF) of a job: shown with the phone's reader or saved in Download/CDA Net. */
object AcceptancePdf {
    /** «rapporto-collaudo-ROSSI-MARIO-8c1f2a3b.pdf»: who it is for, and which job. */
    fun fileName(customer: String, jobId: String): String {
        val who = customer.uppercase().replace(Regex("[^A-Z0-9]+"), "-").trim('-').take(40).ifBlank { "CPE" }
        return "rapporto-collaudo-$who-${jobId.take(8)}.pdf"
    }

    private fun cacheFile(context: Context, name: String, bytes: ByteArray): File =
        File(context.cacheDir, "exports").apply { mkdirs() }.resolve(name).apply { writeBytes(bytes) }

    /** Opens the report with the phone's PDF reader (from the app's cache, nothing left in Download). */
    fun view(context: Context, name: String, bytes: ByteArray) {
        val f = cacheFile(context, name, bytes)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", f)
        TopologyExport.open(context, uri, "application/pdf")
    }

    /** Saves the report in Download/CDA Net and opens it; older Android: shares it instead. */
    fun download(context: Context, name: String, bytes: ByteArray): String {
        val f = cacheFile(context, name, bytes)
        val uri = TopologyExport.saveToDownloads(context, f, "application/pdf")
        if (uri == null) {
            val shared = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", f)
            val send = Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, shared).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            context.startActivity(Intent.createChooser(send, "Rapporto di collaudo").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return "Rapporto pronto da condividere."
        }
        return "Salvato in ${TopologyExport.DOWNLOAD_FOLDER}/$name"
    }
}

/**
 * «Visualizza rapporto» and «Scarica PDF» for a job with an acceptance test: the same PDF as the
 * console (logo, measures, photos). The server decides who may: the installer their own jobs, admins all.
 */
@Composable
fun AcceptanceReportButtons(c: AppContainer, jobId: String, customer: String) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val name = AcceptancePdf.fileName(customer, jobId)

    fun fetch(then: (ByteArray) -> String?) {
        if (busy) return
        busy = true
        note = null
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { c.api.acceptancePdf(jobId) } }
                .onSuccess { bytes -> note = then(bytes) }
                .onFailure { note = it.message ?: "Rapporto non disponibile" }
            busy = false
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { fetch { AcceptancePdf.view(context, name, it); null } }, enabled = !busy) { Text(if (busy) "Preparo il rapporto…" else "Visualizza rapporto") }
            TextButton(onClick = { fetch { AcceptancePdf.download(context, name, it) } }, enabled = !busy) { Text("Scarica PDF") }
        }
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}
