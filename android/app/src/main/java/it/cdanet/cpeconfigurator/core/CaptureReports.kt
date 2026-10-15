package it.cdanet.cpeconfigurator.core

import android.content.SharedPreferences
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.AppJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.IOException
import java.time.Instant

/**
 * Screenshots and screen recordings seen by Android on a blocked account: each one is kept on the
 * phone until the server has it (no network, a failed call), so the NOC's notice is never lost.
 * The last one seen stays readable in Impostazioni, to tell «Android did not say» from «not sent».
 */
class CaptureReports(private val prefs: SharedPreferences, private val api: ApiClient) {
    @Serializable
    data class Report(val at: String, val screen: String, val kind: String = "screenshot", val userId: Int = 0)

    @Serializable
    data class Seen(val at: String, val kind: String, val sent: Boolean)

    private val listSer = ListSerializer(Report.serializer())
    private val _last = MutableStateFlow(runCatching { AppJson.decodeFromString(Seen.serializer(), prefs.getString(LAST, null) ?: "") }.getOrNull())

    /** The last screenshot or recording Android reported on this phone (null = never). */
    val last: StateFlow<Seen?> = _last.asStateFlow()

    private fun pending(): List<Report> = runCatching { AppJson.decodeFromString(listSer, prefs.getString(PENDING, null) ?: "[]") }.getOrDefault(emptyList())

    @Synchronized
    private fun keep(list: List<Report>) {
        prefs.edit().putString(PENDING, AppJson.encodeToString(listSer, list.takeLast(MAX))).apply()
    }

    private fun mark(seen: Seen) {
        _last.value = seen
        prefs.edit().putString(LAST, AppJson.encodeToString(Seen.serializer(), seen)).apply()
    }

    /** Android said the screen was captured ([kind] screenshot or recording) on [screen] by [userId]. */
    @Synchronized
    fun seen(screen: String, kind: String, userId: Int, now: Instant = Instant.now()) {
        keep(pending() + Report(now.toString(), screen.take(80), kind, userId))
        mark(Seen(now.toString(), kind, sent = false))
    }

    /**
     * Sends what [userId] left waiting (another account's goes out only under that account); what
     * fails for the network stays for the next try.
     */
    suspend fun send(userId: Int) {
        val list = pending().filter { it.userId == userId }
        if (list.isEmpty()) return
        val left = list.filter { r -> retry(runCatching { api.reportScreenshot(r.screen, r.at, r.kind) }.exceptionOrNull()) }
        synchronized(this) { keep(pending().filterNot { it in list } + left) }
        if (left.isEmpty()) _last.value?.let { if (!it.sent) mark(it.copy(sent = true)) }
    }

    companion object {
        /** Kept for another try: no network or a server error; a refusal (4xx) is final. */
        fun retry(e: Throwable?): Boolean = when (e) {
            null -> false
            is it.cdanet.cpeconfigurator.data.ApiException -> e.status >= 500
            is IOException -> true
            else -> false
        }

        private const val PENDING = "capture-pending"
        private const val LAST = "capture-last"
        private const val MAX = 20
    }
}
