package it.cdanet.cpeconfigurator.ui.screens

import android.webkit.WebView
import androidx.compose.foundation.layout.height
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.ui.EmbeddedMap
import kotlinx.serialization.json.JsonPrimitive
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.field.CompassTarget
import it.cdanet.cpeconfigurator.data.CoverageAp
import it.cdanet.cpeconfigurator.data.CoverageDto
import it.cdanet.cpeconfigurator.data.CpeLocation
import it.cdanet.cpeconfigurator.data.GeocodeResult
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.SectionCard
import kotlinx.coroutines.launch

private fun km(m: Int) = if (m < 1000) "$m m" else "%.2f km".format(m / 1000.0)

/** Position input: phone GPS or address search (OpenStreetMap through the server). */
@Composable
fun LocationPicker(c: AppContainer, current: CpeLocation?, label: String, onLocation: (CpeLocation, String) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var address by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<GeocodeResult>>(emptyList()) }
    val gps = remember { it.cdanet.cpeconfigurator.network.LocationHelper(context) }

    ErrorBanner(error) { error = null }
    if (current != null) {
        Text(
            label + "\n" + "%.6f, %.6f".format(current.latitude, current.longitude) + (current.accuracy?.let { " · ±%.0f m".format(it) } ?: ""),
            style = MaterialTheme.typography.bodyMedium,
        )
        TextButton(onClick = {
            val uri = Uri.parse("geo:${current.latitude},${current.longitude}?q=${current.latitude},${current.longitude}")
            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
        }) { Text("Apri nelle mappe") }
    }
    BusyButton("Usa GPS del telefono", busy == "gps", Modifier.fillMaxWidth(), enabled = busy == null, primary = current == null) {
        scope.launch {
            busy = "gps"
            error = null
            try {
                val l = gps.current()
                val rev = runCatching { c.api.reverseGeocode(l.latitude, l.longitude) }.getOrNull()
                onLocation(l, rev?.label?.takeIf { it.isNotBlank() }?.let { "GPS · $it" } ?: "Posizione GPS del telefono")
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = null
            }
        }
    }
    Field("Oppure indirizzo", address, { address = it }, placeholder = "Via Roma 12, 94100 Enna", leadingIcon = it.cdanet.cpeconfigurator.R.drawable.ic_map)
    BusyButton("Cerca indirizzo", busy == "addr", Modifier.fillMaxWidth(), enabled = busy == null && address.trim().length >= 3, primary = false) {
        scope.launch {
            busy = "addr"
            error = null
            try {
                results = c.api.geocode(address)
                if (results.isEmpty()) error = "Indirizzo non trovato: aggiungi comune o CAP"
                results.singleOrNull()?.let {
                    onLocation(CpeLocation(it.lat, it.lon, null, "address"), it.label)
                    results = emptyList()
                }
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = null
            }
        }
    }
    results.forEach { r ->
        TextButton(onClick = {
            onLocation(CpeLocation(r.lat, r.lon, null, "address"), r.label)
            results = emptyList()
        }) { Text(r.label, style = MaterialTheme.typography.bodySmall) }
    }
}

/** How promising the AP is from here (server rating, the list is already sorted best first). */
@Composable
fun RatingLabel(rating: String?) {
    val r = rating ?: return
    val color = when (r) {
        "buono" -> MaterialTheme.colorScheme.primary
        "improbabile", "non attivo" -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text("  $r", style = MaterialTheme.typography.labelMedium, color = color, fontWeight = FontWeight.SemiBold)
}

/** "No AP" message: nothing assigned, everything discarded (inactive or weak) or nothing in range. */
fun noApMessage(restricted: Boolean, assignedCount: Int?, discarded: Int, maxKm: Int): String = when {
    restricted && assignedCount == 0 -> "Nessun POP/AP assegnato al tuo account: chiedi all'amministratore."
    discarded == 1 -> "Nessun AP utilizzabile: l'unico AP entro $maxKm km ha un segnale stimato insufficiente o non è attivo."
    discarded > 1 -> "Nessun AP utilizzabile: tutti i $discarded AP entro $maxKm km hanno un segnale stimato insufficiente o non sono attivi."
    restricted -> "Nessun AP tra quelli assegnati entro $maxKm km."
    else -> "Nessun AP entro $maxKm km."
}

/** Nearest APs (from UISP, via the server) with distance and pointing direction. */
@Composable
fun NearbyAps(c: AppContainer, location: CpeLocation, onPick: ((CoverageAp) -> Unit)? = null, onCompass: ((CompassTarget) -> Unit)? = null, withMap: Boolean = false) {
    var data by remember { mutableStateOf<CoverageDto?>(null) }
    var raw by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var page by remember { mutableStateOf<WebView?>(null) }
    LaunchedEffect(location) {
        data = null
        raw = null
        error = null
        try {
            val json = c.api.coverageJson(location.latitude, location.longitude)
            data = AppJson.decodeFromString(CoverageDto.serializer(), json)
            raw = json
        } catch (e: Exception) {
            error = e.message
        }
    }
    ErrorBanner(error)
    val d = data
    // map of the point and the APs (same drawing as the console); "Mappa" on a row shows that AP
    val json = raw
    if (withMap && json != null && d != null && d.aps.isNotEmpty()) {
        EmbeddedMap(
            c,
            "window.cdaCoverage(Object.assign($json, { lat: ${location.latitude}, lon: ${location.longitude} }))",
            Modifier.fillMaxWidth().height(320.dp),
        ) { page = it }
    }
    when {
        d == null && error == null -> Text("Ricerca AP vicini…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        d != null && d.aps.isEmpty() -> Text(
            noApMessage(d.restricted, d.assignedCount, d.discarded, d.maxKm),
            color = MaterialTheme.colorScheme.error,
        )
        d != null -> d.aps.forEachIndexed { i, ap ->
            if (i > 0) HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("↑", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, modifier = Modifier.rotate(ap.bearing.toFloat()))
                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(ap.name.ifBlank { ap.id }, fontWeight = FontWeight.SemiBold)
                        RatingLabel(ap.rating)
                    }
                    Text(
                        listOfNotNull(ap.ssid, ap.siteName).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "${km(ap.distanceM)} · ${ap.bearing}° ${ap.direction}" +
                            (ap.stations?.let { " · $it client" } ?: "") + (if (ap.status != "active") " · ${ap.status}" else ""),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    ap.estimate?.describe()?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium) }
                }
                if (withMap && page != null) {
                    TextButton(onClick = { page?.evaluateJavascript("window.cdaFocus(${JsonPrimitive(ap.id)})", null) }) { Text("Mappa") }
                }
                if (onCompass != null) {
                    androidx.compose.foundation.layout.Spacer(Modifier.width(8.dp))
                    OutlinedButton(onClick = { onCompass(CompassTarget(ap.name.ifBlank { ap.id }, ap.bearing, ap.distanceM, location.latitude, location.longitude)) }) { Text("Bussola") }
                }
                if (onPick != null && ap.node != null && ap.district != null) {
                    androidx.compose.foundation.layout.Spacer(Modifier.width(8.dp))
                    OutlinedButton(onClick = { onPick(ap) }) { Text("Usa") }
                }
            }
        }
    }
}
