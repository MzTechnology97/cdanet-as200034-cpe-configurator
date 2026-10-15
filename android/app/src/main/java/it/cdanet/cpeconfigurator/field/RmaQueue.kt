package it.cdanet.cpeconfigurator.field

import android.content.Context
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.ApiException
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.ResultQueue
import it.cdanet.cpeconfigurator.data.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.File

/** What the technician says of the CPE taken off in a replacement: working, broken, unknown. */
@Serializable
data class RmaAnswer(val jobId: String, val condition: String, val note: String = "")

/**
 * The answers about removed CPEs, kept on the phone until the server has them (the roof often has
 * no signal). Sent after the replacement's result; the server overwrites, so sending twice is fine.
 */
class RmaQueue(
    filesDir: File,
    private val api: ApiClient,
    private val session: Session,
    private val results: ResultQueue,
    private val scope: CoroutineScope,
) {
    constructor(context: Context, api: ApiClient, session: Session, results: ResultQueue, scope: CoroutineScope) : this(context.filesDir, api, session, results, scope)

    private val file = File(filesDir, "rma-queue.json")
    private val mutex = Mutex()
    private val serializer = ListSerializer(RmaAnswer.serializer())
    private val _pending = MutableStateFlow(runCatching { AppJson.decodeFromString(serializer, file.readText()) }.getOrDefault(emptyList()))
    val pending: StateFlow<List<RmaAnswer>> = _pending.asStateFlow()

    /** Answers already on the server in this run of the app (job id → condition): shown as given. */
    private val _sent = MutableStateFlow<Map<String, String>>(emptyMap())
    val sent: StateFlow<Map<String, String>> = _sent.asStateFlow()

    private fun save(items: List<RmaAnswer>) {
        runCatching { file.writeText(AppJson.encodeToString(serializer, items)) }
        _pending.value = items
    }

    suspend fun answer(a: RmaAnswer) = mutex.withLock { save(_pending.value.filterNot { it.jobId == a.jobId } + a) }

    /** Sends what it can; 404 = not a successful replacement (yet: the result may still be queued). */
    suspend fun sync(): Int = mutex.withLock {
        if (session.token == null || _pending.value.isEmpty()) return@withLock 0
        runCatching { results.sync() }
        val queuedResults = results.pending.value.map { it.jobId }.toSet()
        var done = 0
        val left = mutableListOf<RmaAnswer>()
        for (a in _pending.value) {
            try {
                api.reportRma(a.jobId, a.condition, a.note)
                _sent.value = _sent.value + (a.jobId to a.condition)
                done++
            } catch (e: ApiException) {
                // the replacement's result has not reached the server yet: later; otherwise it can never be accepted
                if (e.status == 401 || e.status == 429 || e.status >= 500 || (e.status == 404 && a.jobId in queuedResults)) left += a
            } catch (_: Exception) {
                left += a
            }
        }
        save(left)
        done
    }

    fun syncInBackground() {
        scope.launch { runCatching { sync() } }
    }
}
