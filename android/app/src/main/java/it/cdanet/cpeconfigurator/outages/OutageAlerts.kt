package it.cdanet.cpeconfigurator.outages

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import it.cdanet.cpeconfigurator.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

@Serializable
data class FeedOutage(
    val id: Long,
    val kind: String,
    val label: String = "",
    val place: String = "",
    val province: String = "",
    val customers: Int = 0,
    val expectedRestore: String? = null,
    val zone: String = "",
)

@Serializable
data class OutageFeed(val generatedAt: String? = null, val active: List<FeedOutage> = emptyList())

/**
 * Background notifications for "Guasti Enel": a WorkManager job (every 15 minutes, the Android
 * minimum) reads the server feed with a read-only token that cannot open a session.
 */
object OutageAlerts {
    private const val PREFS = "outage_alerts"
    private const val WORK = "outage-feed"
    private const val CHANNEL = "power_outages"
    private val json = Json { ignoreUnknownKeys = true }

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isEnabled(c: Context) = prefs(c).getString("token", null) != null

    fun canNotify(c: Context) =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun enable(c: Context, backend: String, token: String, includePlanned: Boolean) {
        prefs(c).edit().putString("token", token).putString("backend", backend).putBoolean("planned", includePlanned).apply()
        channel(c)
        val req = PeriodicWorkRequestBuilder<OutageWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, req)
    }

    fun disable(c: Context) {
        WorkManager.getInstance(c).cancelUniqueWork(WORK)
        prefs(c).edit().clear().apply()
    }

    fun includePlanned(c: Context) = prefs(c).getBoolean("planned", false)

    private fun channel(c: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            c.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Guasti Enel", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Guasti e lavori e-distribuzione nelle zone CDA Net" },
            )
        }
    }

    /** New outages since the last check (pure, unit-tested). */
    fun newOnes(feed: List<FeedOutage>, known: Set<String>, includePlanned: Boolean): List<FeedOutage> =
        feed.filter { (includePlanned || it.kind != "lavoro") && it.id.toString() !in known }

    internal suspend fun check(c: Context): Boolean = withContext(Dispatchers.IO) {
        val p = prefs(c)
        val token = p.getString("token", null) ?: return@withContext true
        val backend = p.getString("backend", null) ?: return@withContext true
        val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
        http.newCall(Request.Builder().url("$backend/api/outages/feed").header("Authorization", "Bearer $token").build()).execute().use { r ->
            if (r.code == 401 || r.code == 404) {
                // token revoked (password change, logout everywhere) or module disabled
                notify(c, 1, "Notifiche guasti sospese", "Riaprile dall'app: Guasti Enel → notifiche sul telefono.")
                disable(c)
                return@withContext true
            }
            if (!r.isSuccessful) return@withContext false
            val feed = json.decodeFromString(OutageFeed.serializer(), r.body?.string().orEmpty())
            val known = p.getStringSet("known", emptySet()).orEmpty()
            val fresh = newOnes(feed.active, known, includePlanned(c))
            fresh.take(5).forEach { o ->
                notify(
                    c,
                    o.id.toInt(),
                    "${if (o.kind == "lavoro") "🛠️" else "⚡"} ${o.label}: ${o.place}",
                    "${o.zone.ifBlank { o.province }} · ${o.customers} clienti Enel" + (o.expectedRestore?.let { " · ripristino previsto ${it.replace('T', ' ').substring(11)}" } ?: ""),
                )
            }
            if (fresh.size > 5) notify(c, 2, "Altri ${fresh.size - 5} guasti nelle zone", "Apri Guasti Enel nell'app per l'elenco completo.")
            // remember only what is still active, so the set does not grow forever
            p.edit().putStringSet("known", feed.active.map { it.id.toString() }.toSet()).apply()
            true
        }
    }

    private fun notify(c: Context, id: Int, title: String, text: String) {
        if (!canNotify(c)) return
        channel(c)
        val open = c.packageManager.getLaunchIntentForPackage(c.packageName)?.apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val pi = open?.let { PendingIntent.getActivity(c, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        val n = NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .apply { if (pi != null) setContentIntent(pi) }
            .build()
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(c).notify(id, n)
    }
}

class OutageWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = runCatching { OutageAlerts.check(applicationContext) }.fold(
        onSuccess = { if (it) Result.success() else Result.retry() },
        onFailure = { Result.retry() },
    )
}
