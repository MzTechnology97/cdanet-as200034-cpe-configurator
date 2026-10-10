package it.cdanet.cpeconfigurator.field

import android.content.Context
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.ApiException
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.ResultQueue
import it.cdanet.cpeconfigurator.data.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.File
import java.util.UUID

@Serializable
data class QueuedPhoto(val file: String, val caption: String)

@Serializable
data class QueuedAcceptance(
    val jobId: String,
    val label: String,
    /** null once sent (photos may still be pending). */
    val report: AcceptanceReport? = null,
    val photos: List<QueuedPhoto> = emptyList(),
)

/**
 * Acceptance tests waiting to be sent: on a roof there is often no signal. Reports and photos
 * live in the app's private storage and are sent (after the provisioning result) when back online.
 */
class AcceptanceQueue(
    context: Context,
    private val api: ApiClient,
    private val session: Session,
    private val results: ResultQueue,
    private val scope: CoroutineScope,
) {
    private val dir = File(context.filesDir, "acceptance").apply { mkdirs() }
    private val index = File(dir, "queue.json")
    private val mutex = Mutex()
    private val serializer = ListSerializer(QueuedAcceptance.serializer())
    private val _pending = MutableStateFlow(load())
    val pending: StateFlow<List<QueuedAcceptance>> = _pending.asStateFlow()

    /** Reports the server refused for good (job id → reason): shown, never reported as saved. */
    private val _rejected = MutableStateFlow<Map<String, String>>(emptyMap())
    val rejected: StateFlow<Map<String, String>> = _rejected.asStateFlow()

    private fun load(): List<QueuedAcceptance> = runCatching { AppJson.decodeFromString(serializer, index.readText()) }.getOrDefault(emptyList())

    private fun save(items: List<QueuedAcceptance>) {
        val tmp = File(dir, "queue.json.tmp")
        tmp.writeText(AppJson.encodeToString(serializer, items))
        tmp.renameTo(index)
        _pending.value = items
    }

    /** Adds (or merges into) the queue entry of a job; photos are written to private files. */
    suspend fun enqueue(jobId: String, label: String, report: AcceptanceReport?, photos: List<Pair<ByteArray, String>>) = mutex.withLock {
        val files = withContext(Dispatchers.IO) {
            photos.map { (jpeg, caption) ->
                val f = File(dir, "${UUID.randomUUID()}.jpg")
                f.writeBytes(jpeg)
                QueuedPhoto(f.name, caption)
            }
        }
        val cur = _pending.value.firstOrNull { it.jobId == jobId }
        val merged = QueuedAcceptance(jobId, label, report ?: cur?.report, (cur?.photos ?: emptyList()) + files)
        _rejected.value = _rejected.value - jobId
        save(_pending.value.filterNot { it.jobId == jobId } + merged)
    }

    fun isPending(jobId: String) = _pending.value.any { it.jobId == jobId }

    /** Sends what it can; keeps items failing for network/temporary reasons. Returns items fully sent. */
    suspend fun sync(): Int = mutex.withLock {
        if (session.token == null || _pending.value.isEmpty()) return@withLock 0
        runCatching { results.sync() } // the job result must reach the server first
        var done = 0
        val left = mutableListOf<QueuedAcceptance>()
        for (item in _pending.value) {
            var report = item.report
            val photosLeft = item.photos.toMutableList()
            try {
                if (report != null) {
                    try {
                        api.putAcceptance(item.jobId, report)
                    } catch (e: ApiException) {
                        // 409 = result still queued, 401/429/5xx = retry later; other 4xx can never succeed.
                        if (e.status == 409 || e.status == 401 || e.status == 429 || e.status >= 500) throw e
                        try {
                            // a server older than the app does not know the CPE height yet: it goes in the notes
                            if (e.status != 400 || report.cpeHeightM == null) throw e
                            api.putAcceptance(item.jobId, withHeightInNotes(report))
                        } catch (e2: ApiException) {
                            if (e2.status == 409 || e2.status == 401 || e2.status == 429 || e2.status >= 500) throw e2
                            _rejected.value = _rejected.value + (item.jobId to (e2.message ?: e2.code))
                        }
                    }
                    report = null
                }
                for (p in item.photos) {
                    val f = File(dir, p.file)
                    if (f.exists()) {
                        try {
                            api.uploadPhoto(item.jobId, withContext(Dispatchers.IO) { f.readBytes() }, p.caption)
                        } catch (e: ApiException) {
                            if (e.status == 401 || e.status == 429 || e.status >= 500) throw e
                        }
                        f.delete()
                    }
                    photosLeft.remove(p)
                }
                done++
            } catch (_: Exception) {
                left += item.copy(report = report, photos = photosLeft)
            }
        }
        save(left)
        done
    }

    /** The CPE height written in the notes, for servers that do not have the field yet. */
    private fun withHeightInNotes(r: AcceptanceReport): AcceptanceReport {
        val h = "Altezza CPE dal suolo: ${r.cpeHeightM.toString().removeSuffix(".0").replace('.', ',')} m"
        return r.copy(cpeHeightM = null, notes = listOf(r.notes, h).filter { it.isNotBlank() }.joinToString("\n").take(1000))
    }

    fun syncInBackground() {
        scope.launch { runCatching { sync() } }
    }
}
