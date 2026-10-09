package it.cdanet.cpeconfigurator.alerts

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
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.data.Settings
import it.cdanet.cpeconfigurator.network.TestTls
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.time.Instant
import java.util.concurrent.TimeUnit

@Serializable
data class FeedItem(val id: Long, val kind: String = "", val title: String = "", val body: String = "")

@Serializable
data class FeedOrder(val id: Int, val customer: String = "", val address: String = "", val slot: String = "", val kindLabel: String = "", val startAt: String, val updatedAt: String = "")

@Serializable
data class PhoneFeed(val items: List<FeedItem> = emptyList(), val workOrders: List<FeedOrder> = emptyList())

/** A reminder to show at [atMs] for a work order. */
data class Reminder(val orderId: Int, val offsetMin: Int, val atMs: Long, val title: String, val text: String)

/**
 * The installer's alerts on the phone, also with the app closed: a WorkManager job (every 15
 * minutes) reads the server's notifications with a read-only token (assignments, late or missed
 * orders, NOC decisions…) and schedules the reminders of the next work orders on the phone itself,
 * at the minute (24 h, 2 h, 1 h, 30 min before), so they do not depend on the 15-minute check.
 */
object PhoneAlerts {
    private const val PREFS = "phone_alerts"
    private const val WORK = "phone-feed"
    const val CHANNEL = "work_orders"
    val OFFSETS = listOf(24 * 60, 120, 60, 30)
    private val json = Json { ignoreUnknownKeys = true }

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isEnabled(c: Context) = prefs(c).getString("token", null) != null

    fun canNotify(c: Context) =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun enable(c: Context, backend: String, token: String) {
        prefs(c).edit().putString("token", token).putString("backend", backend).apply()
        channel(c)
        val req = PeriodicWorkRequestBuilder<PhoneFeedWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, req)
        // first check right away (the periodic one may wait up to 15 minutes)
        WorkManager.getInstance(c).enqueueUniqueWork("$WORK-now", ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<PhoneFeedWorker>().build())
    }

    /** Logout: no more alerts for this account on this phone. */
    fun disable(c: Context) {
        val wm = WorkManager.getInstance(c)
        wm.cancelUniqueWork(WORK)
        prefs(c).getStringSet("scheduled", emptySet()).orEmpty().forEach { wm.cancelUniqueWork(it) }
        prefs(c).edit().clear().apply()
    }

    private fun channel(c: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            c.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Interventi e NOC", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Interventi assegnati, promemoria, ritardi ed esiti del NOC"
                },
            )
        }
    }

    /**
     * Reminders still to come for the orders (pure, unit-tested): one per offset, only in the
     * future, the closest one when the order is already within a later offset.
     */
    fun reminders(orders: List<FeedOrder>, nowMs: Long): List<Reminder> = orders.flatMap { o ->
        val start = runCatching { Instant.parse(o.startAt).toEpochMilli() }.getOrNull() ?: return@flatMap emptyList()
        if (start <= nowMs) return@flatMap emptyList()
        OFFSETS.mapNotNull { off ->
            val at = start - off * 60_000L
            if (at <= nowMs) null else Reminder(o.id, off, at, "⏰ Intervento ${inWords(off)}: ${o.customer}", listOf(o.slot, o.kindLabel, o.address).filter { it.isNotBlank() }.joinToString(" · "))
        }
    }

    fun inWords(off: Int) = when {
        off >= 24 * 60 -> "domani a quest'ora"
        off >= 60 -> "tra ${off / 60} ${if (off == 60) "ora" else "ore"}"
        else -> "tra $off minuti"
    }

    internal suspend fun check(c: Context): Boolean = withContext(Dispatchers.IO) {
        val p = prefs(c)
        val token = p.getString("token", null) ?: return@withContext true
        val backend = p.getString("backend", null) ?: return@withContext true
        TestTls.enabled = Settings(c).insecureTlsNow()
        val http = TestTls.apply(OkHttpClient.Builder()).connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
        val after = p.getLong("after", 0L)
        http.newCall(Request.Builder().url("$backend/api/notifications/feed?after=$after").header("Authorization", "Bearer $token").build()).execute().use { r ->
            if (r.code == 401 || r.code == 404) {
                // token revoked (password changed, logged out everywhere): the app asks again at the next login
                disable(c)
                return@withContext true
            }
            if (!r.isSuccessful) return@withContext false
            val feed = json.decodeFromString(PhoneFeed.serializer(), r.body?.string().orEmpty())
            // reminders are scheduled here at the minute: the server's ones would arrive twice
            feed.items.filter { it.kind != "work_order_reminder" }.take(6).forEach { notify(c, (it.id % 100_000).toInt() + 1000, it.title, it.body) }
            feed.items.maxOfOrNull { it.id }?.let { p.edit().putLong("after", maxOf(after, it)).apply() }
            schedule(c, feed.workOrders)
            true
        }
    }

    /** One WorkManager job per reminder (replaced when the order changes, dropped when it is gone). */
    private fun schedule(c: Context, orders: List<FeedOrder>) {
        val wm = WorkManager.getInstance(c)
        val now = System.currentTimeMillis()
        val due = reminders(orders, now)
        val names = due.map { "wo-${it.orderId}-${it.offsetMin}" }.toSet()
        val p = prefs(c)
        p.getStringSet("scheduled", emptySet()).orEmpty().filter { it !in names }.forEach { wm.cancelUniqueWork(it) }
        due.forEach { r ->
            val req = OneTimeWorkRequestBuilder<ReminderWorker>()
                .setInitialDelay(r.atMs - now, TimeUnit.MILLISECONDS)
                .setInputData(Data.Builder().putString("title", r.title).putString("text", r.text).putInt("id", r.orderId * 10 + OFFSETS.indexOf(r.offsetMin)).build())
                .build()
            wm.enqueueUniqueWork("wo-${r.orderId}-${r.offsetMin}", ExistingWorkPolicy.REPLACE, req)
        }
        p.edit().putStringSet("scheduled", names).apply()
    }

    fun notify(c: Context, id: Int, title: String, text: String) {
        if (!canNotify(c)) return
        channel(c)
        val open = c.packageManager.getLaunchIntentForPackage(c.packageName)?.apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val pi = open?.let { PendingIntent.getActivity(c, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        val n = NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .apply { if (pi != null) setContentIntent(pi) }
            .build()
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(c).notify(id, n)
    }
}

class PhoneFeedWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = runCatching { PhoneAlerts.check(applicationContext) }.fold(
        onSuccess = { if (it) Result.success() else Result.retry() },
        onFailure = { Result.retry() },
    )
}

class ReminderWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        PhoneAlerts.notify(applicationContext, inputData.getInt("id", 1), inputData.getString("title").orEmpty(), inputData.getString("text").orEmpty())
        return Result.success()
    }
}
