package it.cdanet.cpeconfigurator

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.FragmentActivity
import it.cdanet.cpeconfigurator.ui.AppRoot
import it.cdanet.cpeconfigurator.ui.CdaTheme

/** FragmentActivity: the biometric prompt of the quick login needs it. */
class MainActivity : FragmentActivity() {
    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as CdaApplication).container
        // Location is required by Android to read Wi-Fi SSID/scan results; nearby Wi-Fi on 13+.
        val perms = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.NEARBY_WIFI_DEVICES)
        }
        if (savedInstanceState == null) permissionLauncher.launch(perms.toTypedArray())
        setContent {
            CdaTheme {
                // the background and the text colour of the theme for every screen, also those drawn
                // outside the Scaffold (update, login, lock, privacy): no black text on the dark theme
                androidx.compose.material3.Surface(androidx.compose.ui.Modifier.fillMaxSize(), color = androidx.compose.material3.MaterialTheme.colorScheme.background) {
                    AppRoot(container)
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        val c = (application as CdaApplication).container
        c.backgroundSince = System.currentTimeMillis()
    }

    override fun onStart() {
        super.onStart()
        // "Sblocco a ogni apertura": back after more than a minute away, fingerprint or face again
        val c = (application as CdaApplication).container
        val since = c.backgroundSince
        val s = c.quickLogin.saved()
        if (since > 0 && System.currentTimeMillis() - since > 60_000 && c.quickLogin.lockAtOpen() && s != null && !s.persistent && c.session.token != null) {
            c.locked.value = true
        }
    }
}
