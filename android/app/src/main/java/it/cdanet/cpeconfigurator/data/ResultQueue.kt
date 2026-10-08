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

    private fun load(): List<PendingResult> =
        runCatching { AppJson.decodeFromString(serializer, file.readText()) }.getOrDefault(emptyList())

    private fun save(items: List<PendingResult>) {
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(AppJson.encodeToString(serializer, items))
        tmp.renameTo(file)
        _pending.value = items
    }

    suspend fun enqueue(item: PendingResult) = mutex.withLock {
        save((_pending.value.filterNot { it.jobId == item.jobId } + item).takeLast(200))
    }

    /** Sends queued results; keeps the ones that fail for network reasons. */
    suspend fun sync(): Int = mutex.withLock {
        if (session.token == null) return@withLock 0
        var sent = 0
        val left = mutableListOf<PendingResult>()
        for (item in _pending.value) {
            try {
                api.sendResult(item.jobId, item.result)
                sent++
            } catch (e: ApiException) {
                // 4xx (job unknown/conflict) cannot succeed later: drop it. 401/5xx: retry.
                if (e.status == 401 || e.status >= 500) left += item
            } catch (_: Exception) {
                left += item
            }
        }
        save(left)
        sent
    }

    fun syncInBackground() {
        scope.launch { runCatching { sync() } }
    }
}
