package it.cdanet.cpeconfigurator.network

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.altitude.AltitudeConverter
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import it.cdanet.cpeconfigurator.data.CpeLocation
import it.cdanet.cpeconfigurator.field.GpsAltitude
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Phone position for the CPE (GPS works offline; no network needed). */
class LocationHelper(private val context: Context) {
    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /**
     * Position plus altitude above sea level. Android gives the GPS altitude above the WGS84
     * ellipsoid (about 40-50 m higher than sea level in Italy): only the sea-level one (Android 14+,
     * from the GPS or converted with the geoid model) is good to compare with the terrain.
     */
    suspend fun currentWithAltitude(): Pair<CpeLocation, GpsAltitude> {
        val loc = fix()
        return toCpe(loc) to mslAltitude(loc)
    }

    private suspend fun mslAltitude(loc: Location): GpsAltitude {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE || !loc.hasAltitude()) return GpsAltitude(null, null)
        if (!loc.hasMslAltitude()) {
            // geoid model shipped with Android: converts the ellipsoid altitude (reads files, off the main thread)
            runCatching { withContext(Dispatchers.IO) { AltitudeConverter().addMslAltitudeToLocation(context, loc) } }
        }
        if (!loc.hasMslAltitude()) return GpsAltitude(null, null)
        val acc = when {
            loc.hasMslAltitudeAccuracy() -> loc.mslAltitudeAccuracyMeters.toDouble()
            loc.hasVerticalAccuracy() -> loc.verticalAccuracyMeters.toDouble()
            else -> null
        }
        return GpsAltitude(loc.mslAltitudeMeters, acc)
    }

    suspend fun current(): CpeLocation = toCpe(fix())

    private fun toCpe(loc: Location) = CpeLocation(
        latitude = loc.latitude,
        longitude = loc.longitude,
        accuracy = if (loc.hasAccuracy()) loc.accuracy.toDouble() else null,
        source = "gps",
    )

    @SuppressLint("MissingPermission")
    private suspend fun fix(): Location {
        if (!hasPermission()) throw IllegalStateException("Autorizza la posizione per l'app (Impostazioni → Permessi)")
        val client = LocationServices.getFusedLocationProviderClient(context)
        val cts = CancellationTokenSource()
        val loc = withTimeoutOrNull(20_000) { client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token).await() }
            ?: run {
                cts.cancel()
                client.lastLocation.await()
            }
            ?: throw IllegalStateException("Posizione non disponibile: attiva la localizzazione e riprova all'aperto")
        return loc
    }
}
