package it.cdanet.cpeconfigurator.push

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import it.cdanet.cpeconfigurator.alerts.PhoneAlerts
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.Settings
import it.cdanet.cpeconfigurator.network.TestTls
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** The Firebase options of this app, given by the server (Connettori → Firebase). */
@Serializable
data class FirebaseClient(val projectId: String, val senderId: String, val appId: String, val apiKey: String)

@Serializable
data class PushConfig(val firebase: FirebaseClient? = null)

/**
 * Notifications that arrive at once, with the app closed too. When the server has Firebase
 * (Connettori → Firebase) and the phone has Google services: Firebase Cloud Messaging, nothing
 * else running. Otherwise [LiveService] keeps the app connected to /api/events itself. The choice
 * is made at every login, so configuring Firebase later moves the phones to it by themselves.
 * Both only wake [PhoneAlerts.check], which shows the notifications as before.
 */
object Push {
    private const val PREFS = "push"

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** "fcm", "live" or null (off: logged out, or notifications not enabled yet). */
    fun mode(c: Context): String? = prefs(c).getString("mode", null)

    /** Called by the Application at start: Firebase must be ready before a message wakes the app. */
    fun initAtStart(c: Context) {
        val saved = prefs(c).getString("firebase", null) ?: return
        runCatching { firebase(c, AppJson.decodeFromString(FirebaseClient.serializer(), saved)) }
    }

    private fun firebase(c: Context, f: FirebaseClient): FirebaseApp =
        FirebaseApp.getApps(c).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
            ?: FirebaseApp.initializeApp(
                c,
                FirebaseOptions.Builder().setProjectId(f.projectId).setGcmSenderId(f.senderId).setApplicationId(f.appId).setApiKey(f.apiKey).build(),
            )

    private fun googleServices(c: Context) =
        runCatching { GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(c) == ConnectionResult.SUCCESS }.getOrDefault(false)

    private fun http(): OkHttpClient = TestTls.apply(OkHttpClient.Builder()).connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()

    private suspend fun call(c: Context, method: String, path: String, body: String? = null): String? = withContext(Dispatchers.IO) {
        val (backend, token) = PhoneAlerts.feed(c) ?: return@withContext null
        TestTls.enabled = Settings(c).insecureTlsNow()
        val b = Request.Builder().url("$backend$path").header("Authorization", "Bearer $token")
        b.method(method, body?.toRequestBody("application/json; charset=utf-8".toMediaType()))
        http().newCall(b.build()).execute().use { r -> if (r.isSuccessful) r.body?.string().orEmpty() else null }
    }

    /** Hands an FCM token to the server (also from the Firebase service, with the app closed). */
    suspend fun register(c: Context, token: String): Boolean =
        runCatching { call(c, "POST", "/api/notifications/push-token", """{"token":"$token"}""") != null }.getOrDefault(false)

    /**
     * After login, with the app open (a foreground service may only start from here or at boot):
     * Firebase when the server offers it, else the app's own connection. Without an answer from
     * the server the last choice stays.
     */
    suspend fun start(c: Context) = withContext(Dispatchers.IO) {
        if (!PhoneAlerts.isEnabled(c)) return@withContext
        val cfg = runCatching { call(c, "GET", "/api/mobile/push-config?package=${c.packageName}") }.getOrNull()
            ?.let { runCatching { AppJson.decodeFromString(PushConfig.serializer(), it) }.getOrNull() }
        val p = prefs(c)
        if (cfg == null) {
            if (mode(c) == "live") LiveService.start(c)
            return@withContext
        }
        val f = cfg.firebase
        if (f != null && googleServices(c)) {
            val ok = runCatching {
                firebase(c, f)
                val token = FirebaseMessaging.getInstance().token.await()
                register(c, token)
            }.getOrDefault(false)
            if (ok) {
                p.edit().putString("mode", "fcm").putString("firebase", AppJson.encodeToString(FirebaseClient.serializer(), f)).apply()
                LiveService.stop(c)
                return@withContext
            }
        }
        p.edit().putString("mode", "live").remove("firebase").apply()
        LiveService.start(c)
    }

    /** Logout: no notifications to this phone any more. */
    fun stop(c: Context) {
        LiveService.stop(c)
        if (mode(c) == "fcm") {
            runCatching {
                val token = FirebaseMessaging.getInstance().token.result
                Thread { runCatching { kotlinx.coroutines.runBlocking { call(c, "DELETE", "/api/notifications/push-token", """{"token":"$token"}""") } } }.start()
                FirebaseMessaging.getInstance().deleteToken()
            }
        }
        prefs(c).edit().clear().apply()
    }
}
