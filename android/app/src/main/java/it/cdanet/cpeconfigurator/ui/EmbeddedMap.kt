package it.cdanet.cpeconfigurator.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.network.TestTls

/**
 * The console's map page (Leaflet + Protomaps on our server) inside the app. The page has no
 * session: [script] (JavaScript, e.g. `window.cdaOutages({...})`) passes it the data the app
 * already received, and is re-run whenever it changes. [onReady] gets the page for live updates.
 */
@SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
@Composable
fun EmbeddedMap(c: AppContainer, script: String?, modifier: Modifier = Modifier, onReady: (WebView) -> Unit = {}) {
    val baseUrl by produceState<String?>(null) { value = c.api.base().trimEnd('/') }
    val base = baseUrl ?: run {
        Text("Caricamento mappa…", modifier.padding(14.dp))
        return
    }
    val background = androidx.compose.material3.MaterialTheme.colorScheme.background.toArgb()
    var page by remember { mutableStateOf<WebView?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    failure?.let {
        Text("Mappa non disponibile: $it", modifier.padding(14.dp), color = androidx.compose.material3.MaterialTheme.colorScheme.error)
        return
    }
    DisposableEffect(Unit) { onDispose { page?.destroy() } }
    LaunchedEffect(loaded, script) {
        val p = page
        if (loaded && p != null) {
            onReady(p)
            if (script != null) p.evaluateJavascript(script, null)
        }
    }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                // theme color while the page loads (no white frame in dark mode)
                setBackgroundColor(background)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                // pan/zoom the map instead of scrolling the screen around it
                setOnTouchListener { v, _ ->
                    v.parent?.requestDisallowInterceptTouchEvent(true)
                    false
                }
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) {
                        loaded = true
                    }

                    // Pages and files of our server go through the app's HTTP client: same certificate
                    // trust as the API (server CA or the test option), byte ranges for the basemap.
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val url = request.url.toString()
                        if (request.method != "GET" || !url.startsWith("$base/")) return null
                        return try {
                            val r = c.api.fetchForWebView(url, request.requestHeaders.orEmpty())
                            if (r.code in 300..399) {
                                r.close()
                                return null
                            }
                            val type = r.header("Content-Type").orEmpty()
                            val mime = type.substringBefore(';').trim().ifBlank { "application/octet-stream" }
                            val charset = Regex("charset=([^;]+)", RegexOption.IGNORE_CASE).find(type)?.groupValues?.get(1)?.trim()
                            val headers = r.headers.names().associateWith { r.header(it).orEmpty() }
                                .filterKeys { !it.equals("Content-Type", true) && !it.equals("Content-Encoding", true) && !it.equals("Transfer-Encoding", true) && !it.equals("Content-Length", true) }
                            WebResourceResponse(mime, charset, r.code, r.message.ifBlank { if (r.code == 206) "Partial Content" else "OK" }, headers, r.body?.byteStream())
                        } catch (e: Exception) {
                            if (request.isForMainFrame) failure = e.message ?: e.toString()
                            null
                        }
                    }

                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                        if (request.isForMainFrame) failure = error.description?.toString() ?: "errore di rete"
                    }

                    // test option "unverified server certificate": only for our server
                    @SuppressLint("WebViewClientOnReceivedSslError")
                    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                        if (TestTls.enabled && error.url.startsWith(base)) handler.proceed() else handler.cancel()
                    }

                    // only our map page inside the app; anything else opens outside
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url.toString()
                        if (url.startsWith(base)) return false
                        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                        return true
                    }
                }
                loadUrl("$base/map-embed.html")
                page = this
            }
        },
    )
}
