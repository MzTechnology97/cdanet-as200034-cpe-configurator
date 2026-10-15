package it.cdanet.cpeconfigurator.tools.speedtest

import android.content.SharedPreferences
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.ApiException
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.network.NetworkHelper
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.IOException
import java.time.Instant
import java.util.UUID

/** Body of POST /api/speedtests: one test, made by the phone ([id]) so that a repeat is kept once. */
@Serializable
data class SpeedtestPost(
    val id: String,
    val at: String,
    /** acceptance | work_order | cpe | tool */
    val context: String,
    val jobId: String? = null,
    val workOrderId: Long? = null,
    val mac: String? = null,
    val downMbps: Double?,
    val upMbps: Double?,
    val pingMs: Double? = null,
    val jitterMs: Double? = null,
    val server: String = "",
    val wifi: RouterWifi? = null,
    val attempt: Int = 1,
)

@Serializable
data class SpeedtestSaved(val id: String = "", val passed: Boolean? = null, val target: SpeedTarget? = null)

@Serializable
data class SpeedtestTargetDto(val target: SpeedTarget? = null)

/** A test saved on the server (Storico, Gestione CPE). */
@Serializable
data class SpeedtestRow(
    val id: String = "",
    val at: String = "",
    val context: String = "",
    val downMbps: Double? = null,
    val upMbps: Double? = null,
    val pingMs: Double? = null,
    val jitterMs: Double? = null,
    val wifi: RouterWifi? = null,
    val target: SpeedTarget? = null,
    val passed: Boolean? = null,
    val attempt: Int = 1,
    val username: String? = null,
)

@Serializable
data class SpeedtestRows(val items: List<SpeedtestRow> = emptyList())

/** What the app asks the test for: the job, the work order, the CPE, or nothing (tool). */
data class SpeedtestSubject(val context: String, val jobId: String? = null, val workOrderId: Long? = null, val mac: String? = null)

/**
 * Speed tests of the app: the server's settings (the last ones kept for offline use), the test over
 * the customer's router Wi-Fi, and every result sent to the server, kept on the phone until it is.
 */
class Speedtests(private val prefs: SharedPreferences, private val api: ApiClient, private val network: NetworkHelper) {
    private val listSer = ListSerializer(SpeedtestPost.serializer())

    /** The last settings read from the server (defaults before the first read). */
    fun config(): SpeedtestConfig = runCatching { AppJson.decodeFromString(SpeedtestConfig.serializer(), prefs.getString(CONFIG, null) ?: "") }.getOrDefault(SpeedtestConfig())

    /** Reads the settings again (every run: the admin may have changed them); offline the saved ones. */
    suspend fun refreshConfig(): SpeedtestConfig {
        val fresh = runCatching { AppJson.decodeFromString(SpeedtestConfig.serializer(), api.request("GET", "/api/speedtest/config")) }.getOrNull()
        if (fresh != null) prefs.edit().putString(CONFIG, AppJson.encodeToString(SpeedtestConfig.serializer(), fresh)).apply()
        return fresh ?: config()
    }

    /** The plan's speeds for [s] (null: plan unknown, the test still counts without a comparison). */
    suspend fun target(s: SpeedtestSubject): SpeedTarget? {
        val q = listOfNotNull(s.jobId?.let { "jobId=$it" }, s.workOrderId?.let { "workOrderId=$it" }, s.mac?.let { "mac=$it" }).firstOrNull() ?: return null
        return runCatching { AppJson.decodeFromString(SpeedtestTargetDto.serializer(), api.request("GET", "/api/speedtest/target?$q")).target }.getOrNull()
    }

    /** One test with the server's settings, over [net] (the router Wi-Fi). */
    suspend fun measure(cfg: SpeedtestConfig, net: android.net.Network, onProgress: (SpeedProgress) -> Unit): SpeedResult =
        OoklaClient(net.socketFactory, cfg.host, cfg.port, cfg.seconds.coerceIn(3, 30), cfg.streams.coerceIn(1, 8)).run(onProgress)

    fun post(subject: SpeedtestSubject, r: SpeedResult?, wifi: RouterWifi?, attempt: Int, at: Instant = Instant.now()): SpeedtestPost = SpeedtestPost(
        id = UUID.randomUUID().toString(),
        at = at.toString(),
        context = subject.context,
        jobId = subject.jobId,
        workOrderId = subject.workOrderId,
        mac = subject.mac,
        downMbps = r?.downMbps?.let { Math.round(it * 10) / 10.0 },
        upMbps = r?.upMbps?.let { Math.round(it * 10) / 10.0 },
        pingMs = r?.pingMs?.let { Math.round(it * 10) / 10.0 },
        jitterMs = r?.jitterMs?.let { Math.round(it * 10) / 10.0 },
        server = r?.server.orEmpty(),
        wifi = wifi,
        attempt = attempt,
    )

    /** Saves [p] on the server; without network it waits on the phone (see [sendPending]). */
    suspend fun save(p: SpeedtestPost): SpeedtestSaved? {
        val sent = runCatching { send(p) }
        sent.exceptionOrNull()?.let { if (retry(it)) keep(pending() + p) }
        return sent.getOrNull()
    }

    private suspend fun send(p: SpeedtestPost): SpeedtestSaved =
        AppJson.decodeFromString(SpeedtestSaved.serializer(), api.request("POST", "/api/speedtests", AppJson.encodeToJsonElement(SpeedtestPost.serializer(), p)))

    /** The results that could not be sent yet: tried again (login, every 2 minutes). */
    suspend fun sendPending() {
        val list = pending()
        if (list.isEmpty()) return
        val left = list.filter { p -> runCatching { send(p) }.exceptionOrNull()?.let(::retry) == true }
        synchronized(this) { keep(pending().filterNot { it in list } + left) }
    }

    suspend fun history(jobId: String? = null, mac: String? = null): List<SpeedtestRow> {
        val q = listOfNotNull(jobId?.let { "jobId=$it" }, mac?.let { "mac=$it" }).joinToString("&")
        return AppJson.decodeFromString(SpeedtestRows.serializer(), api.request("GET", "/api/speedtests?$q&limit=50")).items
    }

    private fun pending(): List<SpeedtestPost> = runCatching { AppJson.decodeFromString(listSer, prefs.getString(PENDING, null) ?: "[]") }.getOrDefault(emptyList())

    @Synchronized
    private fun keep(list: List<SpeedtestPost>) {
        prefs.edit().putString(PENDING, AppJson.encodeToString(listSer, list.takeLast(50))).apply()
    }

    companion object {
        private const val CONFIG = "speedtest-config"
        private const val PENDING = "speedtest-pending"

        /** No network or a server error: try again; a refusal (4xx) is final. */
        fun retry(e: Throwable): Boolean = when (e) {
            is ApiException -> e.status >= 500
            is IOException -> true
            else -> false
        }
    }
}
