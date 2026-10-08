package it.cdanet.cpeconfigurator.field

import android.annotation.SuppressLint
import it.cdanet.cpeconfigurator.network.Ip
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class AirosAuthException(message: String) : IOException(message)

/**
 * airOS 8 web API (the one used by the CPE's own web UI): POST /api/auth, then GET /status.cgi.
 * The CPE certificate is self-signed, so verification is skipped; this client therefore refuses
 * any non-private address. Sockets go through [socketFactory] (the Wi-Fi network), so polling
 * the CPE never disturbs calls to the server over mobile data.
 */
@SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager", "BadHostnameVerifier")
class AirosClient(
    val baseUrl: String,
    socketFactory: SocketFactory?,
) {
    private val cookies = mutableListOf<Cookie>()
    private var csrf: String? = null

    init {
        val host = baseUrl.substringAfter("://").substringBefore(':').substringBefore('/')
        require(Ip.isPrivate(host)) { "La CPE deve avere un indirizzo privato" }
    }

    private val trustAll = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private val http: OkHttpClient = OkHttpClient.Builder()
        .apply { if (socketFactory != null) socketFactory(socketFactory) }
        .sslSocketFactory(SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustAll), SecureRandom()) }.socketFactory, trustAll)
        .hostnameVerifier { _, _ -> true }
        .cookieJar(object : CookieJar {
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                synchronized(this@AirosClient.cookies) {
                    this@AirosClient.cookies.removeAll { c -> cookies.any { it.name == c.name } }
                    this@AirosClient.cookies.addAll(cookies)
                }
            }
            override fun loadForRequest(url: HttpUrl): List<Cookie> = synchronized(cookies) { cookies.toList() }
        })
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .followRedirects(false)
        .build()

    private fun call(path: String, body: RequestBody? = null): Pair<Int, String> {
        val b = Request.Builder().url(baseUrl + path).header("Accept", "application/json")
        csrf?.let { b.header("X-CSRF-ID", it) }
        if (body != null) b.post(body)
        http.newCall(b.build()).execute().use { r ->
            r.header("X-CSRF-ID")?.let { csrf = it }
            return r.code to (r.body?.string().orEmpty())
        }
    }

    fun login(username: String, password: String) {
        val jsonBody = buildJsonObject { put("username", username); put("password", password) }.toString()
            .toRequestBody("application/json".toMediaType())
        var (code, _) = call("/api/auth", jsonBody)
        // Some 8.x builds accept only the form encoding used by their login page.
        if (code !in 200..299 && code != 401 && code != 403) {
            code = call("/api/auth", FormBody.Builder().add("username", username).add("password", password).build()).first
        }
        when {
            code in 200..299 -> Unit
            code == 401 || code == 403 -> throw AirosAuthException("Credenziali CPE rifiutate: la CPE non usa le credenziali CDA Net (non provisionata o configurata a mano?)")
            else -> throw IOException("Login airOS non riuscito (HTTP $code)")
        }
    }

    /** Raw `/status.cgi` JSON. Throws [AirosAuthException] when the session expired. */
    fun statusJson(): String {
        val (code, text) = call("/status.cgi")
        if (code == 401 || code == 403 || (code in 300..399)) throw AirosAuthException("Sessione airOS scaduta")
        if (code !in 200..299) throw IOException("status.cgi HTTP $code")
        return text
    }

    fun status(): AirosStatus = AirosStatus.parse(statusJson())

    companion object {
        /** Web UI endpoints tried on a host: standard HTTPS, then the CDA Net management port. */
        fun candidates(host: String): List<String> = listOf("https://$host", "https://$host:20443", "http://$host", "http://$host:20080")
    }
}
