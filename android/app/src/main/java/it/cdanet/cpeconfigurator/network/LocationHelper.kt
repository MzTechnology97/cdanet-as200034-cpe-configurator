package it.cdanet.cpeconfigurator.network

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import it.cdanet.cpeconfigurator.data.CpeLocation
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull

/** Phone position for the CPE (GPS works offline; no network needed). */
class LocationHelper(private val context: Context) {
    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    suspend fun current(): CpeLocation {
        if (!hasPermission()) throw IllegalStateException("Autorizza la posizione per l'app (Impostazioni → Permessi)")
        val client = LocationServices.getFusedLocationProviderClient(context)
        val cts = CancellationTokenSource()
        val loc = withTimeoutOrNull(20_000) { client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token).await() }
            ?: run {
                cts.cancel()
                client.lastLocation.await()
            }
            ?: throw IllegalStateException("Posizione non disponibile: attiva la localizzazione e riprova all'aperto")
        return CpeLocation(
            latitude = loc.latitude,
            longitude = loc.longitude,
            accuracy = if (loc.hasAccuracy()) loc.accuracy.toDouble() else null,
            source = "gps",
        )
    }
}
