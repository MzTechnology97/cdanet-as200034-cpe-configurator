package it.cdanet.cpeconfigurator.ui.screens

import android.annotation.SuppressLint
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import it.cdanet.cpeconfigurator.core.AppContainer

/**
 * airOS first-boot UI inside the app. The process is bound to the Wi-Fi network
 * while this screen is open so the CPE is reachable even with mobile data on.
 * The CPE's self-signed certificate is accepted only for the factory address.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CpeWebScreen(c: AppContainer) {
    val state by c.provisioning.state.collectAsState()
    val host = state.pkg?.target?.host ?: "192.168.172.1"
    val bound = remember { c.network.bindToWifi() }
    DisposableEffect(Unit) {
        onDispose { c.network.unbind() }
    }
    Column(Modifier.fillMaxSize()) {
        Text(
            if (bound) "Interfaccia CPE https://$host · al termine torna indietro" else "Nessuna Wi-Fi collegata: collegati alla Wi-Fi della CPE",
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.fillMaxWidth().padding(8.dp),
        )
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.saveFormData = false
                    webViewClient = object : WebViewClient() {
                        @SuppressLint("WebViewClientOnReceivedSslError")
                        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                            val errHost = runCatching { android.net.Uri.parse(error.url).host }.getOrNull()
                            if (errHost == host) handler.proceed() else handler.cancel()
                        }
                    }
                    loadUrl("https://$host/")
                }
            },
            onRelease = { it.destroy() },
        )
    }
}
