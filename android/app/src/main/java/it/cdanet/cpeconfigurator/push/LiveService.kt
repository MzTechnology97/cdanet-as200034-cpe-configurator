package it.cdanet.cpeconfigurator.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.alerts.PhoneAlerts
import it.cdanet.cpeconfigurator.data.Settings
import it.cdanet.cpeconfigurator.network.TestTls
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Notifications without Firebase: the app stays connected to the server's /api/events (the same
 * stream as the console) with its read-only token, and checks its notifications as soon as one
 * arrives. Android requires a silent notification while it runs ("CDA Net: notifiche attive").
 * Reconnects by itself (the server ends each stream after 15 minutes); stops on a revoked token.
 */
class LiveService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        runCatching { ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type) }.onFailure {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!running) {
            running = true
            scope.launch { loop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun loop() {
        var wait = 5_000L
        val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(70, TimeUnit.SECONDS).build()
        while (scope.isActive) {
            val feed = PhoneAlerts.feed(this)
            if (feed == null) {
                stopSelf()
                return
            }
            val (backend, token) = feed
            TestTls.enabled = Settings(this).insecureTlsNow()
            val result = runCatching {
                TestTls.wrap(http).newCall(Request.Builder().url("$backend/api/events").header("Authorization", "Bearer $token").header("Accept", "text/event-stream").build()).execute().use { r ->
                    if (r.code == 401) return@use 401
                    if (!r.isSuccessful) return@use r.code
                    wait = 5_000L
                    // anything missed while disconnected
                    scope.launch { runCatching { PhoneAlerts.check(this@LiveService) } }
                    val source = r.body?.source() ?: return@use 0
                    while (scope.isActive) {
                        val line = source.readUtf8Line() ?: break
                        if (line == "event: notifications") scope.launch { runCatching { PhoneAlerts.check(this@LiveService) } }
                    }
                    0
                }
            }.getOrDefault(-1)
            if (result == 401) {
                // token revoked (password changed, logged out everywhere): the next login starts it again
                stopSelf()
                return
            }
            delay(wait)
            wait = (wait * 2).coerceAtMost(120_000L)
        }
    }

    private fun notification() = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("CDA Net: notifiche attive")
        .setContentText("Interventi e avvisi del NOC arrivano subito, anche con l'app chiusa.")
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setOngoing(true)
        .setSilent(true)
        .apply {
            packageManager.getLaunchIntentForPackage(packageName)?.let {
                setContentIntent(PendingIntent.getActivity(this@LiveService, 0, it, PendingIntent.FLAG_IMMUTABLE))
            }
        }
        .build()
        .also { channel(this) }

    companion object {
        private const val CHANNEL = "live_connection"
        private const val NOTIFICATION_ID = 41
        @Volatile private var running = false

        private fun channel(c: Context) {
            if (Build.VERSION.SDK_INT >= 26) {
                c.getSystemService(NotificationManager::class.java).createNotificationChannel(
                    NotificationChannel(CHANNEL, "Collegamento per le notifiche", NotificationManager.IMPORTANCE_MIN).apply {
                        description = "Notifica fissa e silenziosa mentre l'app resta collegata al server"
                        setShowBadge(false)
                    },
                )
            }
        }

        fun start(c: Context) {
            channel(c)
            runCatching { androidx.core.content.ContextCompat.startForegroundService(c, Intent(c, LiveService::class.java)) }
        }

        fun stop(c: Context) {
            runCatching { c.stopService(Intent(c, LiveService::class.java)) }
        }
    }
}

/** After a restart of the phone: the connection comes back by itself (without Firebase). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Push.mode(context) == "live") LiveService.start(context)
    }
}
