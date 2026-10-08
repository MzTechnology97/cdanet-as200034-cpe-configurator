package it.cdanet.cpeconfigurator.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings as AndroidSettings
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

@Serializable
data class UpdateInfo(
    val available: Boolean = false,
    val versionCode: Long = 0,
    val versionName: String = "",
    val sha256: String = "",
    val mandatory: Boolean = false,
    val apkUrl: String = "/api/mobile/apk",
)

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object UpToDate : UpdateState
    data class Available(val info: UpdateInfo) : UpdateState
    data class Downloading(val info: UpdateInfo) : UpdateState
    data object PermissionRequired : UpdateState
    data class ReadyToInstall(val info: UpdateInfo) : UpdateState
    data class Failed(val message: String) : UpdateState
}

/**
 * Self-update from the CDA Net server release channel. The APK is verified with
 * SHA-256; Android additionally enforces the same signing key for in-place updates.
 */
class AppUpdater(private val context: Context, private val settings: Settings) {
    private val http = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()

    fun installedVersionCode(): Long {
        @Suppress("DEPRECATION")
        val p = context.packageManager.getPackageInfo(context.packageName, 0)
        return PackageInfoCompat.getLongVersionCode(p)
    }

    suspend fun check(): UpdateInfo? = withContext(Dispatchers.IO) {
        val base = settings.backendUrlNow()
        http.newCall(Request.Builder().url("$base/api/mobile/update").header("Cache-Control", "no-cache").build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("Canale aggiornamenti HTTP ${r.code}")
            val info = AppJson.decodeFromString(UpdateInfo.serializer(), r.body?.string().orEmpty())
            info.takeIf { it.available && it.versionCode > installedVersionCode() }
        }
    }

    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    fun openInstallPermissionSettings() {
        context.startActivity(
            Intent(AndroidSettings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    suspend fun download(info: UpdateInfo): File = withContext(Dispatchers.IO) {
        val base = settings.backendUrlNow()
        val url = if (info.apkUrl.startsWith("http")) info.apkUrl else base + (if (info.apkUrl.startsWith("/")) info.apkUrl else "/${info.apkUrl}")
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val out = File(dir, "CDA-Net-CPE-${info.versionName}.apk")
        val md = MessageDigest.getInstance("SHA-256")
        http.newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("Download APK HTTP ${r.code}")
            val body = r.body ?: throw IOException("Download APK vuoto")
            var total = 0L
            body.byteStream().use { input ->
                out.outputStream().use { os ->
                    val buf = ByteArray(128 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        total += n
                        if (total > 200L * 1024 * 1024) throw IOException("APK troppo grande")
                        md.update(buf, 0, n)
                        os.write(buf, 0, n)
                    }
                }
            }
        }
        val got = md.digest().joinToString("") { "%02x".format(it) }
        if (!got.equals(info.sha256, ignoreCase = true)) {
            out.delete()
            throw IOException("SHA-256 dell'APK non valido: download scartato")
        }
        out
    }

    fun install(apk: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        context.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
