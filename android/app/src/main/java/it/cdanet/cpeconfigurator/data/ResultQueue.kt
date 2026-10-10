package it.cdanet.cpeconfigurator.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import java.io.File

/**
 * Provisioning outcomes recorded while the phone is offline (connected to the
 * CPE management Wi-Fi). Contains metadata only: never passwords or configs.
 */
class ResultQueue(
    context: Context,
    private val api: ApiClient,
    private val session: Session,
    private val scope: CoroutineScope,
) {
    private val file = File(context.filesDir, "pending-results.json")
    private val mutex = Mutex()
    private val serializer = ListSerializer(PendingResult.serializer())
    private val _pending = MutableStateFlow(load())
    val pending: StateFlow<List<PendingResult>> = _pending.asStateFlow()

    /** Results the server refused for good (validation, job unknown or not yours): shown until dismissed. */
    private val rejectedFile = File(context.filesDir, "rejected-results.json")
    private val rejectedSerializer = ListSerializer(RejectedResult.serializer())
    private val _rejected = MutableStateFlow(
        runCatching { AppJson.decodeFromString(rejectedSerializer, rejectedFile.readText()) }.getOrDefault(emptyList()),
    )
    val rejected: StateFlow<List<RejectedResult>> = _rejected.asStateFlow()

    private fun saveRejected(items: List<RejectedResult>) {
        runCatching { rejectedFile.writeText(AppJson.encodeToString(rejectedSerializer, items)) }
        _rejected.value = items
    }

    suspend fun dismissRejected(jobId: String) = mutex.withLock { saveRejected(_rejected.value.filterNot { it.jobId == jobId }) }

    private fun load(): List<PendingResult> =
        runCatching { AppJson.decodeFromString(serializer, file.readText()) }.getOrDefault(emptyList())

    private fun save(items: List<PendingResult>) {
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(AppJson.encodeToString(serializer, items))
        tmp.renameTo(file)
        _pending.value = items
    }

    suspend fun enqueue(item: PendingResult) = mutex.withLock {
        if (_rejected.value.any { it.jobId == item.jobId }) saveRejected(_rejected.value.filterNot { it.jobId == item.jobId })
        save((_pending.value.filterNot { it.jobId == item.jobId } + item).takeLast(200))
    }

    /**
     * Sends queued results; keeps the ones that fail for network reasons (401, 429, 5xx too).
     * 409 = the job is already completed: nothing to send. Other 4xx can never succeed: they are
     * kept in [rejected] with the reason, never dropped silently.
     */
    suspend fun sync(): Int = mutex.withLock {
        if (session.token == null) return@withLock 0
        var sent = 0
        val left = mutableListOf<PendingResult>()
        val refused = mutableListOf<RejectedResult>()
        for (item in _pending.value) {
            try {
                api.sendResult(item.jobId, item.result)
                sent++
            } catch (e: ApiException) {
                when {
                    e.status == 401 || e.status == 429 || e.status >= 500 -> left += item
                    e.status == 409 -> {}
                    else -> refused += RejectedResult(item.jobId, item.label, e.message ?: "errore ${e.status}")
                }
            } catch (_: Exception) {
                left += item
            }
        }
        save(left)
        if (refused.isNotEmpty()) saveRejected((_rejected.value.filterNot { r -> refused.any { it.jobId == r.jobId } } + refused).takeLast(50))
        sent
    }

    fun syncInBackground() {
        scope.launch { runCatching { sync() } }
    }
}
