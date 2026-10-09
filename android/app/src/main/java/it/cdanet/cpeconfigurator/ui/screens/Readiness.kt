package it.cdanet.cpeconfigurator.ui.screens

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.StatusChip

/** What the field work needs from the phone: permissions, GPS on, no battery restrictions. */
object FieldReadiness {
    private fun granted(c: Context, p: String) = ContextCompat.checkSelfPermission(c, p) == PackageManager.PERMISSION_GRANTED

    fun hasLocation(c: Context) = granted(c, Manifest.permission.ACCESS_FINE_LOCATION)

    fun locationOn(c: Context) = LocationManagerCompat.isLocationEnabled(c.getSystemService(LocationManager::class.java))

    /** Installations and interventions need both: the position is checked and written. */
    fun gpsReady(c: Context) = hasLocation(c) && locationOn(c)

    fun hasNotifications(c: Context) = Build.VERSION.SDK_INT < 33 || granted(c, Manifest.permission.POST_NOTIFICATIONS)

    fun hasCamera(c: Context) = granted(c, Manifest.permission.CAMERA)

    fun hasNearbyWifi(c: Context) = Build.VERSION.SDK_INT < 33 || granted(c, Manifest.permission.NEARBY_WIFI_DEVICES)

    /** Background alerts arrive on time only when Android does not restrict the app. */
    fun batteryFree(c: Context) = c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(c.packageName)

    /** Anything missing that the start screen should show. */
    fun missing(c: Context) = !gpsReady(c) || !hasNotifications(c) || !hasCamera(c) || !hasNearbyWifi(c)

    val PERMISSIONS: Array<String> = buildList {
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        add(Manifest.permission.ACCESS_COARSE_LOCATION)
        add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33) {
            add(Manifest.permission.POST_NOTIFICATIONS)
            add(Manifest.permission.NEARBY_WIFI_DEVICES)
        }
    }.toTypedArray()
}

private fun appSettings(c: Context) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", c.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

@Composable
private fun ReadinessRow(@DrawableRes icon: Int, title: String, why: String, ok: Boolean, required: Boolean, action: String, onFix: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(painterResource(icon), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            Text(why, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (ok) StatusChip("ok", NoticeKind.Good) else OutlinedButton(onClick = onFix) { Text(action) }
    }
    if (!ok && required) Text("Obbligatorio per installazioni e interventi", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
}

/** The checklist of the phone's permissions and settings, with a button to fix each one. */
@Composable
fun ReadinessCard(onAllDone: (() -> Unit)? = null) {
    val context = LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    // back from Android's settings or from a permission dialog: read everything again
    LifecycleResumeEffect(Unit) {
        tick++
        onPauseOrDispose { }
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        tick++
        // denied for good: only Android's settings can grant it now
        if (result.values.any { !it }) runCatching { context.startActivity(appSettings(context)) }
    }
    // [tick] changes on resume and after each answer: the rows read the permissions again
    androidx.compose.runtime.key(tick) {
    SectionCard("Permessi e impostazioni del telefono", icon = R.drawable.ic_lock) {
        ReadinessRow(R.drawable.ic_my_location, "Posizione", "Posizione della CPE, AP vicini, controllo dell'indirizzo dell'intervento.", FieldReadiness.hasLocation(context), true, "Consenti") { ask.launch(FieldReadiness.PERMISSIONS) }
        HorizontalDivider()
        ReadinessRow(R.drawable.ic_explore, "GPS attivo", "La localizzazione del telefono deve essere accesa.", FieldReadiness.locationOn(context), true, "Attiva") {
            runCatching { context.startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        HorizontalDivider()
        ReadinessRow(R.drawable.ic_notifications, "Notifiche", "Interventi assegnati, promemoria, ritardi ed esiti del NOC.", FieldReadiness.hasNotifications(context), true, "Consenti") { ask.launch(FieldReadiness.PERMISSIONS) }
        HorizontalDivider()
        ReadinessRow(R.drawable.ic_photo_camera, "Fotocamera", "Foto del collaudo, etichetta della CPE, mirino verso l'AP.", FieldReadiness.hasCamera(context), true, "Consenti") { ask.launch(FieldReadiness.PERMISSIONS) }
        if (Build.VERSION.SDK_INT >= 33) {
            HorizontalDivider()
            ReadinessRow(R.drawable.ic_wifi_find, "Dispositivi Wi-Fi vicini", "Leggere la Wi-Fi della CPE e del router del cliente.", FieldReadiness.hasNearbyWifi(context), true, "Consenti") { ask.launch(FieldReadiness.PERMISSIONS) }
        }
        HorizontalDivider()
        ReadinessRow(R.drawable.ic_speed, "Nessuna limitazione della batteria", "Consigliato: promemoria e notifiche arrivano in orario anche ad app chiusa.", FieldReadiness.batteryFree(context), false, "Apri") {
            runCatching { context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        if (onAllDone != null) {
            Button(onClick = onAllDone, modifier = Modifier.fillMaxWidth()) { Text(if (FieldReadiness.missing(context)) "Continua (le installazioni restano bloccate)" else "Continua") }
        }
    }
    }
}

/** After the login, when something is missing: the checklist before the app. */
@Composable
fun ReadinessScreen(onContinue: () -> Unit) {
    Column(Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Prepara il telefono", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("Per lavorare sul campo l'app ha bisogno di questi permessi. Le installazioni e gli interventi non partono senza posizione e GPS attivo.", style = MaterialTheme.typography.bodyMedium)
        ReadinessCard(onAllDone = onContinue)
    }
}

/** Installations and interventions: with the GPS off or the position denied they do not start. */
@Composable
fun GpsGate(content: @Composable () -> Unit) {
    val context = LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        tick++
        onPauseOrDispose { }
    }
    val ready = remember(tick) { FieldReadiness.gpsReady(context) }
    if (ready) {
        content()
        return
    }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Notice(
            if (!FieldReadiness.hasLocation(context)) "Installazioni e interventi richiedono il permesso di posizione: la posizione viene scritta nella CPE e confrontata con l'indirizzo dell'intervento."
            else "Il GPS del telefono è spento: attivalo per iniziare l'installazione o l'intervento.",
            NoticeKind.Bad,
        )
        ReadinessCard()
    }
}
