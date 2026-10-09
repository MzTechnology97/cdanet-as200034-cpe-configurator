package it.cdanet.cpeconfigurator.network

import android.annotation.SuppressLint
import it.cdanet.cpeconfigurator.BuildConfig
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Collections
import java.util.WeakHashMap
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * TEST ONLY - "Accept the server's unverified certificate" (Settings → Server): the CDA Net server
 * with a self-signed HTTPS certificate. Applied only to the clients that talk to our server
 * (API, updates, outage feed, speed test, embedded map), never to anything else. Off by default;
 * the proper fix is installing the server's CA on the phone (`sudo cdanet-cpe https-ca`).
 */
@SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager", "BadHostnameVerifier")
object TestTls {
    @Volatile
    var enabled: Boolean = false

    private val trustAll = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private val secure: MutableMap<OkHttpClient, OkHttpClient> = Collections.synchronizedMap(WeakHashMap())
    private val insecure: MutableMap<OkHttpClient, OkHttpClient> = Collections.synchronizedMap(WeakHashMap())

    /**
     * "android/<version>" on every call to our server (API, updates, outage feed, speed test, map):
     * the server refuses outdated apps, except on the update channel.
     */
    val clientHeader = "android/${BuildConfig.VERSION_NAME.removeSuffix("-debug")}"
    private val identify = Interceptor { chain ->
        val r = chain.request()
        chain.proceed(if (r.header("X-CDA-Client") == null) r.newBuilder().header("X-CDA-Client", clientHeader).build() else r)
    }

    fun apply(b: OkHttpClient.Builder): OkHttpClient.Builder {
        b.addInterceptor(identify)
        return if (!enabled) b else b
            .sslSocketFactory(SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustAll), SecureRandom()) }.socketFactory, trustAll)
            .hostnameVerifier { _, _ -> true }
    }

    /** [base] with the app identity, and without certificate checks when the test option is on. */
    fun wrap(base: OkHttpClient): OkHttpClient = (if (enabled) insecure else secure).getOrPut(base) { apply(base.newBuilder()).build() }
}
