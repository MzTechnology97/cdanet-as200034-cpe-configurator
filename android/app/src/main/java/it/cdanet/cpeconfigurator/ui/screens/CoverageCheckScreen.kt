package it.cdanet.cpeconfigurator.ui.screens

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.CoverageAp
import it.cdanet.cpeconfigurator.data.CoverageDto
import it.cdanet.cpeconfigurator.data.GeocodeResult
import it.cdanet.cpeconfigurator.data.SimulationInfoDto
import it.cdanet.cpeconfigurator.field.CompassTarget
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.EmbeddedMap
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.SectionCard
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Same scale as the console simulation, from excellent to unusable. */
private val SIM_SCALE = listOf(
    Color(0xFF15803D) to "oltre −60 dBm",
    Color(0xFF22C55E) to "−60…−65",
    Color(0xFFA3E635) to "−65…−70",
    Color(0xFFFACC15) to "−70…−75",
    Color(0xFFF97316) to "−75…−80 (sotto il minimo)",
    Color(0xFFDC2626) to "sotto −80",
)

/** "37.56, 14.27", "37,56 14,27", "37.56;14.27" → lat/lon; null when it is not a pair of coordinates. */
fun parseCoords(text: String): Pair<Double, Double>? {
    val t = text.trim()
    if (!Regex("""^[\s\d.,;+-]+$""").matches(t)) return null
    // "37,56 14,27": decimal commas, the pair split by spaces; otherwise by comma, semicolon or spaces
    val parts = if (Regex("""^\s*[+-]?\d+,\d+\s+[+-]?\d+,\d+\s*$""").matches(t)) t.split(Regex("""\s+""")).map { it.replace(',', '.') }
    else t.split(Regex("""\s*[;,]\s*|\s+""")).filter { it.isNotBlank() }
    if (parts.size != 2) return null
    val lat = parts[0].toDoubleOrNull() ?: return null
    val lon = parts[1].toDoubleOrNull() ?: return null
    return if (lat in -90.0..90.0 && lon in -180.0..180.0 && !(lat == 0.0 && lon == 0.0)) lat to lon else null
}

/** Calls of the map page (window.CdaApp): a tapped point, "Simula copertura" on an AP. */
class CoverageBridge(private val onTap: (Double, Double) -> Unit, private val onSimulate: (String) -> Unit) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun onMapClick(lat: Double, lon: Double) {
        main.post { onTap(lat, lon) }
    }

    @JavascriptInterface
    fun onSimulate(apId: String) {
        main.post { onSimulate(apId) }
    }
}

private data class CheckedPoint(val lat: Double, val lon: Double, val label: String)
private data class BaseAp(val id: String, val name: String, val lat: Double, val lon: Double)

/**
 * Verifica copertura: is an address served, before going there? One search box (address,
 * coordinates, AP name for admins), the phone GPS or a tap on the map; the APs ranked for the point
 * with the expected signal, line of sight with the customer's CPE height and, for admins, every AP
 * on the map and the radio simulation of each one (as the console). Installers get the server's
 * limits: their assigned APs, approximate areas.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CoverageCheckScreen(c: AppContainer, onCompass: ((CompassTarget) -> Unit)? = null) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val admin = c.session.isAdmin
    val modules by c.modules.collectAsState()
    val gps = remember { it.cdanet.cpeconfigurator.network.LocationHelper(context) }
    var query by remember { mutableStateOf("") }
    var height by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var suggestions by remember { mutableStateOf<List<GeocodeResult>>(emptyList()) }
    var apMatches by remember { mutableStateOf<List<BaseAp>>(emptyList()) }
    var point by remember { mutableStateOf<CheckedPoint?>(null) }
    var result by remember { mutableStateOf<CoverageDto?>(null) }
    var resultJson by remember { mutableStateOf<String?>(null) }
    var baseJson by remember { mutableStateOf<String?>(null) }
    var baseAps by remember { mutableStateOf<List<BaseAp>>(emptyList()) }
    var sim by remember { mutableStateOf<SimulationInfoDto?>(null) }
    var simJson by remember { mutableStateOf<String?>(null) }
    var page by remember { mutableStateOf<WebView?>(null) }
    var los by remember { mutableStateOf<CoverageAp?>(null) }

    // admins: every AP on the map (and for the search by name), the default CPE height
    LaunchedEffect(admin) {
        if (!admin) return@LaunchedEffect
        runCatching { c.api.defaultCpeHeight() }.getOrNull()?.let { if (height.isBlank()) height = it.toString().removeSuffix(".0").replace('.', ',') }
        runCatching { c.api.networkStatusJson() }.onSuccess { json ->
            baseJson = json
            baseAps = runCatching {
                val root = AppJson.parseToJsonElement(json).jsonObject
                val aps = root["pops"]?.jsonArray.orEmpty().flatMap { it.jsonObject["aps"]?.jsonArray.orEmpty() } + root["apsWithoutPop"]?.jsonArray.orEmpty()
                aps.mapNotNull { e ->
                    val o = e.jsonObject
                    val lat = o["lat"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
                    val lon = o["lon"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
                    BaseAp(o["id"]?.jsonPrimitive?.content.orEmpty(), o["name"]?.jsonPrimitive?.content.orEmpty(), lat, lon)
                }
            }.getOrDefault(emptyList())
        }
    }

    fun check(lat: Double, lon: Double, label: String?) {
        suggestions = emptyList()
        apMatches = emptyList()
        error = null
        scope.launch {
            busy = "check"
            try {
                val json = if (admin) c.api.coverageJson(lat, lon, 10, null) else c.api.coverageJson(lat, lon)
                result = AppJson.decodeFromString(CoverageDto.serializer(), json)
                resultJson = json
                point = CheckedPoint(lat, lon, label ?: runCatching { c.api.reverseGeocode(lat, lon)?.label }.getOrNull()?.takeIf { it.isNotBlank() } ?: String.format(java.util.Locale.US, "%.5f, %.5f", lat, lon))
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = null
            }
        }
    }

    fun simulate(apId: String) {
        if (!admin) return
        scope.launch {
            busy = "sim"
            error = null
            try {
                val json = c.api.coverageSimulationJson(apId)
                sim = AppJson.decodeFromString(SimulationInfoDto.serializer(), json)
                simJson = json
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = null
            }
        }
    }

    fun search() {
        val q = query.trim()
        parseCoords(q)?.let { (la, lo) -> return check(la, lo, String.format(java.util.Locale.US, "Coordinate %.5f, %.5f", la, lo)) }
        // admins: an AP by name
        apMatches = if (admin) baseAps.filter { it.name.contains(q, ignoreCase = true) }.take(5) else emptyList()
        if (q.length < 3) return
        scope.launch {
            busy = "search"
            error = null
            try {
                val found = c.api.geocode(q)
                if (found.size == 1 && apMatches.isEmpty()) found.first().let { check(it.lat, it.lon, it.label) } else suggestions = found
                if (found.isEmpty() && apMatches.isEmpty()) error = "Indirizzo non trovato: aggiungi comune o CAP"
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = null
            }
        }
    }

    val onTap by rememberUpdatedState { la: Double, lo: Double -> check(la, lo, null) }
    val onSim by rememberUpdatedState { id: String -> simulate(id) }
    val bridge = remember { CoverageBridge({ la, lo -> onTap(la, lo) }, { id -> onSim(id) }) }

    // the map follows the data: base APs (admins), the checked point with its APs, the simulation
    LaunchedEffect(page, baseJson) { if (baseJson != null) page?.evaluateJavascript("window.cdaCoverageBase($baseJson)", null) }
    LaunchedEffect(page, resultJson, point) {
        val p = point
        if (resultJson != null && p != null) page?.evaluateJavascript("window.cdaCoverage(Object.assign($resultJson, { lat: ${p.lat}, lon: ${p.lon} }))", null)
    }
    LaunchedEffect(page, simJson) { page?.evaluateJavascript(if (simJson != null) "window.cdaSimulation($simJson)" else "window.cdaClearSimulation()", null) }

    val heightM = height.replace(',', '.').toDoubleOrNull()?.takeIf { it in 0.5..100.0 }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            "Verifica se un indirizzo è coperto prima del sopralluogo: cerca, usa il GPS o tocca un punto sulla mappa." +
                if (admin) " Tocca un AP sulla mappa per simularne la copertura." else " Sono considerati solo gli AP assegnati al tuo account.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(vertical = 4.dp),
        )
        ErrorBanner(error) { error = null }
        SectionCard("Dove") {
            Field(if (admin) "Indirizzo, coordinate o nome di un AP" else "Indirizzo o coordinate", query, { query = it }, placeholder = "Via Roma 12, Enna · 37.56, 14.27", leadingIcon = R.drawable.ic_search)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BusyButton("Cerca", busy == "search", Modifier.weight(1f), enabled = busy == null && query.isNotBlank()) { search() }
                BusyButton("Qui (GPS)", busy == "gps", Modifier.weight(1f), enabled = busy == null, primary = false) {
                    scope.launch {
                        busy = "gps"
                        try {
                            val l = gps.current()
                            busy = null
                            check(l.latitude, l.longitude, null)
                        } catch (e: Exception) {
                            error = e.message
                            busy = null
                        }
                    }
                }
            }
            apMatches.forEach { a ->
                TextButton(onClick = {
                    // only the simulation: a coverage check on the AP itself (0 m) says nothing
                    apMatches = emptyList()
                    suggestions = emptyList()
                    simulate(a.id)
                }) { Text("AP ${a.name} · simula copertura", style = MaterialTheme.typography.bodySmall) }
            }
            suggestions.forEach { r -> TextButton(onClick = { check(r.lat, r.lon, r.label) }) { Text(r.label, style = MaterialTheme.typography.bodySmall) } }
            Field(
                "Altezza della CPE dal suolo (m)",
                height,
                { v -> height = v.filter { ch -> ch.isDigit() || ch == ',' || ch == '.' }.take(5) },
                keyboardType = KeyboardType.Decimal,
                placeholder = "es. 6",
                supporting = if (height.isNotBlank() && heightM == null) "Da 0,5 a 100 m" else "Per la visibilità verso l'AP: dal terreno all'antenna montata.",
                isError = height.isNotBlank() && heightM == null,
            )
        }

        EmbeddedMap(c, "window.cdaCoverageMode()", Modifier.fillMaxWidth().height(380.dp).padding(vertical = 4.dp), bridge = bridge) { page = it }
        if (busy == "check" || busy == "sim") Text(if (busy == "sim") "Simulazione in corso…" else "Valutazione degli AP…", style = MaterialTheme.typography.bodySmall)

        sim?.let { s ->
            SectionCard("Simulazione${if (s.theoretical) " teorica" else ""} · ${s.ap.name}") {
                val good = s.cells.count { it.dbm >= s.minDbm }
                Text(
                    if (s.cells.isEmpty()) "Simulazione non possibile: ${if (s.customers > 0) "troppo pochi clienti con segnale e posizione" else "nessun cliente con posizione"}."
                    else "${if (s.theoretical) "Nessun cliente da cui imparare" else "Da ${s.customers} clienti"} · raggio ${km(s.radiusM)} · ${Math.round(100.0 * good / s.cells.size)}% dell'area sopra ${s.minDbm} dBm",
                    style = MaterialTheme.typography.bodySmall,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    SIM_SCALE.forEach { (color, label) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(12.dp).clip(RoundedCornerShape(3.dp)).background(color))
                            Spacer(Modifier.width(4.dp))
                            Text(label, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                Text(
                    if (s.theoretical) "Stima teorica in spazio libero (l'AP non ha ancora clienti con segnale): margine ±8 dB, non considera ostacoli. Per un punto preciso usa Visibilità."
                    else "Segnale atteso per una CPE nuova, stimato dai clienti già collegati. Non considera ostacoli: per un punto preciso usa Visibilità. Colori tenui: stima poco affidabile.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { sim = null; simJson = null }) { Text("Togli simulazione") }
            }
        }

        val p = point
        val d = result
        if (p != null && d != null) {
            SectionCard("AP per ${p.label}") {
                if (d.aps.isEmpty()) Text(noApMessage(d.restricted, d.assignedCount, d.discarded, d.maxKm), color = MaterialTheme.colorScheme.error)
                d.aps.forEachIndexed { i, ap ->
                    if (i > 0) HorizontalDivider()
                    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("↑", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, modifier = Modifier.rotate(ap.bearing.toFloat()))
                            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(ap.name.ifBlank { ap.id }, fontWeight = FontWeight.SemiBold)
                                    RatingLabel(ap.rating)
                                }
                                Text(
                                    "${km(ap.distanceM)} · ${ap.bearing}° ${ap.direction}" + (ap.stations?.let { " · $it client" } ?: "") + (if (ap.status != "active") " · ${ap.status}" else ""),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                ap.estimate?.describe()?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium) }
                            }
                        }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(start = 34.dp)) {
                            TextButton(onClick = { page?.evaluateJavascript("window.cdaFocus(${JsonPrimitive(ap.id)})", null) }) { Text("Mappa") }
                            if (modules["compass"] != false) OutlinedButton(onClick = { los = ap }) { Text("Visibilità") }
                            if (admin) OutlinedButton(onClick = { simulate(ap.id) }) { Text("Simula") }
                            if (onCompass != null) OutlinedButton(onClick = { onCompass(CompassTarget(ap.name.ifBlank { ap.id }, ap.bearing, ap.distanceM, p.lat, p.lon)) }) { Text("Bussola") }
                        }
                    }
                }
                Text(
                    "Prima gli AP con il segnale stimato migliore, poi i più vicini. La freccia indica la direzione di puntamento (0° = nord).",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
    los?.let { ap ->
        val pt = point
        if (pt != null) LineOfSightDialog(c, pt.lat, pt.lon, ap.id, ap.name.ifBlank { ap.id }, heightM) { los = null }
    }
}

private fun km(m: Int) = if (m < 1000) "$m m" else "%.2f km".format(m / 1000.0)
