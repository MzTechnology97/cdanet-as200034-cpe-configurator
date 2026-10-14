package it.cdanet.cpeconfigurator.ui.screens

import android.annotation.SuppressLint
import android.net.http.SslError
import android.content.Intent
import android.net.Uri
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
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
    // a file field of the page (System → Upload firmware): the firmware already on the phone, or
    // any file through Android's picker. The callback must be answered once, even with nothing.
    var chooseFirmware by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var picker by remember { mutableStateOf<Intent?>(null) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        pending?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        pending = null
    }
    val context = LocalContext.current
    val onPhone = remember { c.firmware.savedList()?.items.orEmpty().filter { c.firmware.has(it) } }
    DisposableEffect(Unit) {
        onDispose {
            pending?.onReceiveValue(null)
            c.network.unbind()
        }
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
                    webChromeClient = object : WebChromeClient() {
                        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                            pending?.onReceiveValue(null)
                            pending = callback
                            val intent = runCatching { params.createIntent() }.getOrNull()
                            if (onPhone.isNotEmpty() || intent == null) {
                                picker = intent
                                chooseFirmware = true
                            } else {
                                runCatching { pick.launch(intent) }.onFailure { callback.onReceiveValue(null); pending = null }
                            }
                            return true
                        }
                    }
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
    if (chooseFirmware) {
        fun answer(value: Array<Uri>?) {
            pending?.onReceiveValue(value)
            pending = null
            chooseFirmware = false
        }
        AlertDialog(
            onDismissRequest = { answer(null) },
            title = { Text("Quale file?") },
            text = {
                Column {
                    if (onPhone.isEmpty()) Text("Nessun firmware sul telefono: scaricalo da CPE collegata → Firmware con Internet.")
                    onPhone.forEach { img ->
                        TextButton(onClick = {
                            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", c.firmware.fileOf(img))
                            answer(arrayOf(uri))
                        }) { Text("Firmware ${img.platform} ${img.version} (sul telefono)") }
                    }
                }
            },
            confirmButton = {
                picker?.let { i ->
                    TextButton(onClick = {
                        chooseFirmware = false
                        runCatching { pick.launch(i) }.onFailure { answer(null) }
                    }) { Text("Altro file…") }
                }
            },
            dismissButton = { TextButton(onClick = { answer(null) }) { Text("Annulla") } },
        )
    }
}
