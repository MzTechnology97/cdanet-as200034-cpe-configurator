package it.cdanet.cpeconfigurator.field

import it.cdanet.cpeconfigurator.network.NetworkHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Speed and latency towards the CDA Net server **through the Wi-Fi** (customer router behind
 * the new CPE), never over mobile data: it measures the line just installed.
 */
object InternetProbe {
    suspend fun measure(network: NetworkHelper, baseUrl: String, token: String?): InternetTest = withContext(Dispatchers.IO) {
        val wifi = network.wifiNetwork() ?: return@withContext InternetTest(false, note = "Telefono non collegato a una Wi-Fi")
        val http = OkHttpClient.Builder()
            .socketFactory(wifi.socketFactory)
            .dns(Dns { host -> wifi.getAllByName(host).toList() })
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
        fun req(path: String) = Request.Builder().url(baseUrl + path).header("Cache-Control", "no-store").also { b -> token?.let { b.header("Authorization", "Bearer $it") } }
        try {
            val pings = (1..5).map {
                val t = System.nanoTime()
                http.newCall(req("/api/tools/speed/ping").build()).execute().use { r -> if (!r.isSuccessful) throw IOException("HTTP ${r.code}") }
                (System.nanoTime() - t) / 1e6
            }
            var t = System.nanoTime()
            val bytes = http.newCall(req("/api/tools/speed/download?bytes=${12 * 1024 * 1024}").build()).execute().use { r -> r.body?.bytes()?.size ?: 0 }
            val down = bytes * 8 / ((System.nanoTime() - t) / 1e9) / 1e6
            val payload = ByteArray(6 * 1024 * 1024)
            t = System.nanoTime()
            http.newCall(req("/api/tools/speed/upload").post(payload.toRequestBody("application/octet-stream".toMediaType())).build()).execute().close()
            val up = payload.size * 8 / ((System.nanoTime() - t) / 1e9) / 1e6
            InternetTest(
                tested = true,
                pingMs = pings.drop(1).average(), // first request includes the TLS handshake
                jitterMs = pings.zipWithNext { a, b -> abs(b - a) }.average(),
                downloadMbps = down,
                uploadMbps = up,
            )
        } catch (e: Exception) {
            InternetTest(
                tested = false,
                note = "Internet non raggiungibile dalla Wi-Fi collegata (${e.message ?: "errore"}): per misurarlo collega il telefono alla Wi-Fi del router del cliente",
            )
        }
    }
}
