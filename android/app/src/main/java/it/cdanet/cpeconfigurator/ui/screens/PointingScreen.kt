package it.cdanet.cpeconfigurator.ui.screens

import android.webkit.WebView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.data.PointingCache
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.PointingApDto
import it.cdanet.cpeconfigurator.data.PointingDto
import it.cdanet.cpeconfigurator.field.CompassSensor
import it.cdanet.cpeconfigurator.field.CompassTarget
import it.cdanet.cpeconfigurator.network.LocationHelper
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.EmbeddedMap
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private fun km(m: Int) = if (m < 1000) "$m m" else "%.2f km".format(java.util.Locale.ITALY, m / 1000.0)

/**
 * "Trova l'AP": the nearest APs from the GPS position, as a map (with the phone heading) or a list
 * with distance, altitude a.s.l., azimuth and tilt; each AP opens the camera sight or the compass.
 */
@Composable
fun PointingScreen(c: AppContainer, onAim: (CompassTarget) -> Unit, onCompass: (CompassTarget) -> Unit) {
    it.cdanet.cpeconfigurator.ui.KeepScreenOn()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<PointingDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf<String?>(null) }
    var height by remember { mutableStateOf("") }
    var tab by remember { mutableIntStateOf(1) }
    var los by remember { mutableStateOf<it.cdanet.cpeconfigurator.data.PointingApDto?>(null) }
    los?.let { a ->
        data?.let { d -> LineOfSightDialog(c, d.from.lat, d.from.lon, a.id, a.name, height.replace(',', '.').toDoubleOrNull(), onClose = { los = null }) }
    }

    suspend fun load() {
        busy = true
        error = null
        saved = null
        val user = c.session.state.value?.user?.id
        val loc = runCatching { LocationHelper(context).current() }.getOrElse {
            error = it.message
            busy = false
            return
        }
        runCatching {
            c.api.pointing(loc.latitude, loc.longitude, height.replace(',', '.').toDoubleOrNull())
        }.onSuccess { d ->
            data = d
            user?.let { u -> c.pointingCache.put(u, d) }
            if (height.isBlank()) height = d.from.height.let { if (it % 1.0 == 0.0) it.roundToInt().toString() else it.toString() }
        }.onFailure { e ->
            // no network on the roof: the APs saved here before (or with the day's work orders)
            val hit = c.pointingCache.near(user, loc.latitude, loc.longitude)
            if (hit != null) {
                data = hit.first.data
                saved = PointingCache.describe(hit.first, hit.second)
            } else {
                error = e.message + " · Nessun dato salvato vicino: apri Trova l'AP con la rete (gli interventi di oggi si salvano da soli)."
            }
        }
        busy = false
    }
    LaunchedEffect(Unit) { load() }

    fun target(a: PointingApDto, d: PointingDto) = CompassTarget(
        name = a.name,
        bearing = a.bearing,
        distanceM = a.distanceM,
        fromLatitude = d.from.lat,
        fromLongitude = d.from.lon,
        tiltDeg = a.tiltDeg,
        altitude = a.altitude,
        fromAltitude = d.from.altitude,
    )

    Column(Modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("MAPPA") })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("LISTA") })
        }
        ErrorBanner(error) { error = null }
        saved?.let { Box(Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) { Notice(it, NoticeKind.Warn) } }
        val d = data
        if (tab == 0) {
            if (d != null) PointingMap(c, d, Modifier.weight(1f).fillMaxWidth()) else Text("Ricerca della posizione…", Modifier.padding(14.dp))
            d?.let { Text("Lat: %.6f   Lon: %.6f".format(java.util.Locale.ROOT, it.from.lat, it.from.lon), Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall) }
            return@Column
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field("Altezza CPE dal suolo (m)", height, { height = it }, Modifier.weight(1f), keyboardType = KeyboardType.Decimal)
                BusyButton("Aggiorna", busy, Modifier.width(130.dp), primary = false) { scope.launch { load() } }
            }
            if (d == null) {
                Text(if (busy) "Ricerca della posizione e degli AP…" else "")
                return@Column
            }
            Text(
                d.from.altitude?.let { "Tu: ${it.roundToInt()} m s.l.m. (terreno ${d.from.ground?.roundToInt()} m + ${d.from.height} m) · antenne AP a ${d.apHeightM.roundToInt()} m dal suolo" }
                    ?: "Altitudine non disponibile: il tilt non viene calcolato",
                style = MaterialTheme.typography.bodySmall,
            )
            if (d.aps.isEmpty()) {
                SectionCard {
                    Text(
                        noApMessage(d.restricted, d.assignedCount, d.discarded, d.maxKm),
                        color = WarnAmber,
                    )
                }
            }
            SectionCard("AP utilizzabili") {
                d.aps.forEachIndexed { i, a ->
                    if (i > 0) HorizontalDivider()
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(km(a.distanceM), Modifier.width(76.dp), style = MaterialTheme.typography.bodyMedium)
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(a.name, fontWeight = FontWeight.SemiBold)
                                RatingLabel(a.rating)
                            }
                            Text(
                                listOfNotNull(
                                    a.altitude?.let { "Alt: ${it.roundToInt()} m s.l.m." + if (a.altitudeFrom == "gps") " (GPS)" else "" },
                                    "Azi: ${a.bearing}°",
                                    a.tiltDeg?.let { "Tilt: ${"%.1f".format(java.util.Locale.ITALY, it)}°" },
                                ).joinToString("   "),
                                style = MaterialTheme.typography.bodySmall,
                            )
                            a.estimate?.describe()?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium) }
                            if (a.status != "active") Text("AP non attivo", color = WarnAmber, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    Row {
                        TextButton(onClick = { onAim(target(a, d)) }) { Text("Mirino") }
                        TextButton(onClick = { onCompass(target(a, d)) }) { Text("Bussola") }
                        TextButton(onClick = { los = a }) { Text("Visibilità") }
                    }
                }
            }
            Text(
                "Azimut rispetto al Nord vero; tilt positivo = verso l'alto. Il tilt usa il modello del terreno e le altezze delle antenne: per il puntamento fine usa il segnale (Puntamento antenna).",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/** The console's map page with the data passed in; the arrow follows the phone heading. */
@Composable
private fun PointingMap(c: AppContainer, d: PointingDto, modifier: Modifier) {
    val context = LocalContext.current
    val json = remember(d) { AppJson.encodeToString(PointingDto.serializer(), d) }
    val sensor = remember { CompassSensor(context) }
    val reading by sensor.reading.collectAsState()
    var page by remember { mutableStateOf<WebView?>(null) }
    DisposableEffect(Unit) {
        sensor.start(d.from.lat, d.from.lon)
        onDispose { sensor.stop() }
    }
    LaunchedEffect(page) {
        while (page != null) {
            reading?.let { page?.evaluateJavascript("window.cdaHeading(${it.heading.roundToInt()})", null) }
            delay(250)
        }
    }
    EmbeddedMap(c, "window.cdaShow($json)", modifier) { page = it }
}
