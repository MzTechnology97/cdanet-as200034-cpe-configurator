package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import it.cdanet.cpeconfigurator.ui.DataColors
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.LinkEndDto
import it.cdanet.cpeconfigurator.data.LinkSimDto
import it.cdanet.cpeconfigurator.data.SignalEstimateDto
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import kotlinx.coroutines.launch
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/** The points of the simulation A → B, as typed or set by a tap on the map ([picking]: which one). */
class LinkSimState {
    var a by mutableStateOf("")
    var b by mutableStateOf("")
    var picking by mutableStateOf<Char?>(null)

    fun place(lat: Double, lon: Double) {
        val text = String.format(java.util.Locale.US, "%.6f, %.6f", lat, lon)
        if (picking == 'A') a = text else b = text
        picking = null
    }
}

/**
 * Simulazione A → B (admins and specialists, as in the console): a link between two points chosen
 * by hand, on the map, with the GPS or by coordinates. The server puts terrain, 3D buildings and
 * trees between them (the profile of Visibilità, A in the place of the CPE) and gives the loss, the
 * expected signal and the modulation with the radio of the server or the one written here. [onArm]
 * makes the next tap on the map a point; [onDraw] draws the link on the map (null: takes it away).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LinkSimCard(c: AppContainer, s: LinkSimState, onArm: () -> Unit, onDraw: (String?, Pair<Double, Double>?) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val gps = remember { it.cdanet.cpeconfigurator.network.LocationHelper(context) }
    var open by remember { mutableStateOf(false) }
    var aH by remember { mutableStateOf("") }
    var bH by remember { mutableStateOf("") }
    var freq by remember { mutableStateOf("") }
    var radio by remember { mutableStateOf(false) }
    var eirp by remember { mutableStateOf("") }
    var gain by remember { mutableStateOf("") }
    var noise by remember { mutableStateOf("") }
    var raise by remember { mutableStateOf(true) }
    // the channel of the link: the capacity of airMAX ac 2×2 follows its width
    var width by remember { mutableStateOf(40) }
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<LinkSimDto?>(null) }

    fun run() {
        val a = parseCoords(s.a) ?: return
        val b = parseCoords(s.b) ?: return
        scope.launch {
            busy = "link"
            error = null
            try {
                val json = c.api.coverageLinkJson(
                    a, b, num(aH), num(bH), freq.toIntOrNull(),
                    num(eirp), num(gain), noise.toDoubleOrNull(), raise,
                )
                result = AppJson.decodeFromString(LinkSimDto.serializer(), json)
                onDraw(json, a)
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = null
            }
        }
    }

    SectionCard("Simulazione A → B") {
        if (!open) {
            Text(
                "Un collegamento tra due punti scelti a mano: terreno, edifici 3D e alberi tra A e B, segnale e modulazione attesi.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            SecondaryButton(onClick = { open = true }) { Text("Apri la simulazione") }
            return@SectionCard
        }
        ErrorBanner(error) { error = null }
        val aPt = parseCoords(s.a)
        val bPt = parseCoords(s.b)
        listOf('A', 'B').forEach { which ->
            val text = if (which == 'A') s.a else s.b
            val pt = if (which == 'A') aPt else bPt
            Field(
                "Punto $which (coordinate)",
                text,
                { v -> if (which == 'A') s.a = v else s.b = v },
                placeholder = "37.56, 14.27",
                isError = text.isNotBlank() && pt == null,
                supporting = if (text.isNotBlank() && pt == null) "Scrivi latitudine e longitudine, es. 37.56, 14.27" else null,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                SecondaryButton(onClick = {
                    s.picking = if (s.picking == which) null else which
                    if (s.picking != null) onArm()
                }) { Text(if (s.picking == which) "Tocca la mappa…" else "$which sulla mappa") }
                BusyButton("$which qui (GPS)", busy == "gps$which", enabled = busy == null, primary = false) {
                    scope.launch {
                        busy = "gps$which"
                        try {
                            val l = gps.current()
                            s.picking = which
                            s.place(l.latitude, l.longitude)
                        } catch (e: Exception) {
                            error = e.message
                        } finally {
                            busy = null
                        }
                    }
                }
            }
        }
        if (s.picking != null) Text("Tocca la mappa qui sopra dove va il punto ${s.picking}.", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Field("Altezza A (m)", aH, { aH = decimal(it) }, Modifier.weight(1f), keyboardType = KeyboardType.Decimal, placeholder = "predefinita")
            Field("Altezza B (m)", bH, { bH = decimal(it) }, Modifier.weight(1f), keyboardType = KeyboardType.Decimal, placeholder = "predefinita")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Field("Frequenza (MHz)", freq, { freq = it.filter(Char::isDigit).take(4) }, Modifier.weight(1f), keyboardType = KeyboardType.Number, placeholder = "5600")
            Column(Modifier.weight(1f)) {
                it.cdanet.cpeconfigurator.ui.Dropdown("Canale", listOf(10, 20, 40, 80), width, { w -> "$w MHz" }, { width = it })
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Antenne sopra tetti e alberi intorno", style = MaterialTheme.typography.bodyMedium)
                Text("Come si montano: l'altezza conta da sopra quello che c'è attorno.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = raise, onCheckedChange = { raise = it })
        }
        TextButton(onClick = { radio = !radio }) { Text(if (radio) "Nascondi la radio" else "Radio: potenza, guadagno e rumore") }
        if (radio) {
            Text("Vuoti: quelli delle Impostazioni server.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field("EIRP di A (dBm)", eirp, { eirp = decimal(it) }, Modifier.weight(1f), keyboardType = KeyboardType.Decimal)
                Field("Guadagno B (dBi)", gain, { gain = decimal(it) }, Modifier.weight(1f), keyboardType = KeyboardType.Decimal)
            }
            Field("Rumore (dBm)", noise, { noise = it.filter { ch -> ch.isDigit() || ch == '-' }.take(4) }, keyboardType = KeyboardType.Text, placeholder = "-92")
        }
        BusyButton("Simula collegamento", busy == "link", Modifier.fillMaxWidth(), enabled = busy == null && aPt != null && bPt != null) { run() }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // A ⇄ B: the same link seen from the other end (heights go with their point)
            SecondaryButton(onClick = {
                val t = s.a
                s.a = s.b
                s.b = t
                val h = aH
                aH = bH
                bH = h
                if (result != null) run()
            }, Modifier.weight(1f), enabled = busy == null && (s.a.isNotBlank() || s.b.isNotBlank())) { Text("A ⇄ B") }
            SecondaryButton(onClick = {
                open = false
                result = null
                s.picking = null
                onDraw(null, null)
            }, Modifier.weight(1f)) { Text("Chiudi") }
        }
        result?.let { d ->
            LinkSimResult(d, width, enabled = busy == null) { which, m ->
                val v = m.toString().removeSuffix(".0").replace('.', ',')
                if (which == 'A') aH = v else bH = v
                run()
            }
        }
    }
}

/** airMAX ac rate multipliers of the modulations of [MCS_SCALE] (1x…13x), as the console. */
private val MCS_MULT = listOf(1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 9.0, 10.0, 12.0, 13.33)

/** Radio rate of airMAX ac 2×2 at [mcs] in a channel of [widthMhz], and the throughput a link usually gives (about 60%), Mbit/s. */
private fun capacity(mcs: Int?, widthMhz: Int): Pair<Int, Int>? {
    if (mcs == null || mcs < 0) return null
    val phy = (MCS_MULT[minOf(mcs, MCS_MULT.size - 1)] * 13.5 * 2 * (widthMhz / 40.0)).roundToInt()
    return phy to (phy * 0.6).roundToInt()
}

/**
 * The simulation as the AP–customer link of Copertura: A (orange, as the CPE) | the link | B (blue,
 * as the AP), each end with its height −/+, altitude, pointing and tilt; in the middle the verdict,
 * distance, Fresnel, losses, signal, modulation and capacity; then the profile, touchable.
 */
@Composable
private fun LinkSimResult(d: LinkSimDto, widthMhz: Int, enabled: Boolean, onHeight: (Char, Double) -> Unit) {
    val los = d.los()
    val raise = if (d.raiseCpeM <= MAX_MAST_M) "Alzando A di ${m(d.raiseCpeM)} m la linea si libera." else "Non basta un palo: servirebbero più di ${MAX_MAST_M.toInt()} m in più."
    // a line cut by the terrain: the physics decides (a design, not a connected customer); as the console
    val physical = d.physical
    val shown = if (d.verdict == "blocked" && physical != null) physical else d.estimate
    val physicalDbm = physical?.signalDbm
    val estimateDbm = d.estimate.signalDbm
    val ab = bearing(d.a, d.b)
    val tilt = tiltDeg(los)
    EndCard('A', DataColors.CpeEnd, d.a, ab, d.a.lat, d.a.lon, tilt, enabled) { onHeight('A', it) }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerLow).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("COLLEGAMENTO", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Notice(
            when (d.verdict) {
                "clear" -> "Visibilità libera tra A e B: nessun ostacolo sulla linea e zona di Fresnel libera."
                "fresnel" -> "Si vede, ma ${if (d.buildings) "gli edifici entrano" else "il terreno entra"} nella zona di Fresnel: il segnale può calare. $raise"
                else -> "Ostruita ${if (d.buildings) "da edifici" else "dal terreno"} a ${dist(d.worst?.d ?: 0)} da A. $raise"
            },
            when (d.verdict) { "clear" -> NoticeKind.Good; "fresnel" -> NoticeKind.Warn; else -> NoticeKind.Bad },
        )
        if (d.tooFar) Notice("Oltre 20 km: collegamento poco realistico, la stima è solo indicativa.", NoticeKind.Warn)
        if (d.verdict != "clear" && physicalDbm != null && estimateDbm != null && physicalDbm < estimateDbm - 6) {
            Notice("Con la diffrazione pura il segnale in B è $physicalDbm dBm" + if (physicalDbm < -80) ": da non progettare così." else ".", NoticeKind.Warn)
        }
        val cap = capacity(shown.mcs, widthMhz)
        FactGrid(
            buildList {
                add(Triple("Distanza", dist(d.distanceM), "${d.frequencyMhz} MHz · canale $widthMhz MHz"))
                add(Triple("Fresnel libera", "${fresnelFreePct(los)}%", d.worst?.let { "punto critico a ${dist(it.d)} da A" } ?: "su tutto il collegamento"))
                shown.signalDbm?.let {
                    add(
                        Triple(
                            "Segnale atteso in B",
                            "$it dBm",
                            if (shown === d.estimate) "EIRP ${m(d.radio.eirpDbm)} dBm · ${m(d.radio.gainDbi)} dBi"
                            else "con la diffrazione pura · come Copertura ${estimateDbm ?: "—"} dBm",
                        ),
                    )
                }
                add(
                    Triple(
                        "Capacità stimata",
                        cap?.let { "~${it.second} Mbit/s" } ?: "nessuna",
                        cap?.let { "radio ${it.first} Mbit/s, airMAX ac 2×2" } ?: "il collegamento non si aggancia",
                    ),
                )
                d.diffractionDb?.takeIf { d.verdict != "clear" }?.let { diff ->
                    add(Triple("Diffrazione pura", "${m(diff)} dB", physicalDbm?.let { "segnale $it dBm" + (physical.label?.let { l -> " · $l" } ?: "") } ?: "fisica degli ostacoli"))
                }
                add(
                    Triple(
                        "Perdita stimata (come Copertura)",
                        "${m(d.lossDb)} dB",
                        listOfNotNull(if (d.buildings) "edifici" else null, if (d.foliageM > 0) "${d.foliageM} m di alberi" else null).joinToString(" · ")
                            .ifEmpty { if (d.lossDb > 0) "il terreno" else "nessun ostacolo" },
                    ),
                )
            },
        )
        SignalBar(SignalEstimateDto(signalDbm = shown.signalDbm, snrDb = shown.snrDb, mcs = shown.mcs))
    }
    EndCard('B', DataColors.ApEnd, d.b, (ab + 180) % 360, d.b.lat, d.b.lon, -tilt, enabled) { onHeight('B', it) }
    ProfileChart(los, "A" to "B")
    Text(
        (if (d.terrainSource == "tinitaly") "Terreno a 10 m con edifici (grigio) e alberi (verde) della mappa del suolo, ad altezze medie: verifica a vista."
        else "Solo terreno (modello a 30 m): edifici e alberi non sono nel calcolo, verifica a vista.") +
            " Capacità: modulazione attesa su airMAX ac 2×2 nel canale scelto, circa il 60% della velocità radio." +
            " Rumore considerato ${m(d.radio.noiseDbm)} dBm. Il collegamento è disegnato sulla mappa.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** One end of the link: its height −/+ (the simulation runs again), altitude, pointing to the other end and tilt. */
@Composable
private fun EndCard(which: Char, color: Color, e: LinkEndDto, bearingDeg: Int, lat: Double, lon: Double, tilt: Double, enabled: Boolean, onHeight: (Double) -> Unit) {
    val decl = declinationDeg(lat, lon)
    val other = if (which == 'A') 'B' else 'A'
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(24.dp).clip(CircleShape).background(color), contentAlignment = Alignment.Center) {
                Text("$which", color = Color.White, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
            }
            Text(String.format(java.util.Locale.US, "%.5f, %.5f", e.lat, e.lon), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Altezza", modifier = Modifier.weight(1f))
            androidx.compose.material3.FilledTonalIconButton(onClick = { onHeight((e.heightM - 1).coerceAtLeast(1.0)) }, enabled = enabled) { Text("−", fontWeight = FontWeight.Bold) }
            Text("${m(e.heightM)} m", fontWeight = FontWeight.Bold)
            androidx.compose.material3.FilledTonalIconButton(onClick = { onHeight((e.heightM + 1).coerceAtMost(200.0)) }, enabled = enabled) { Text("+", fontWeight = FontWeight.Bold) }
        }
        FactGrid(
            listOf(
                Triple("Antenna", "${m(e.mountedM ?: e.heightM)} m", end(e)),
                Triple("Puntamento $which → $other", "$bearingDeg° ${compass(bearingDeg)}", "magnetico ${((bearingDeg - decl).roundToInt() + 360) % 360}° · inclinazione ${signedDeg(tilt)}°"),
            ),
        )
    }
}

/** The note under an antenna: from the ground, on the roof or over the trees around it. */
private fun end(e: LinkEndDto): String {
    val mounted = e.mountedM
    val asl = e.ground + (mounted ?: e.heightM).roundToInt()
    return when {
        e.roofM != null -> "sul tetto di ${e.roofM} m · $asl m s.l.m."
        mounted != null && mounted > e.heightM + 0.5 -> "sopra gli ostacoli intorno · $asl m s.l.m."
        else -> "dal suolo · $asl m s.l.m."
    }
}

/** Bearing from [a] to [b], degrees from north. */
private fun bearing(a: LinkEndDto, b: LinkEndDto): Int {
    val f1 = Math.toRadians(a.lat)
    val f2 = Math.toRadians(b.lat)
    val dl = Math.toRadians(b.lon - a.lon)
    val y = sin(dl) * cos(f2)
    val x = cos(f1) * sin(f2) - sin(f1) * cos(f2) * cos(dl)
    return ((Math.toDegrees(atan2(y, x)).roundToInt() % 360) + 360) % 360
}

private fun decimal(v: String) = v.filter { ch -> ch.isDigit() || ch == ',' || ch == '.' }.take(5)

private fun num(v: String) = v.replace(',', '.').toDoubleOrNull()

private fun m(v: Double) = if (kotlin.math.abs(v % 1.0) < 0.05) v.roundToInt().toString() else "%.1f".format(java.util.Locale.ITALY, v)

private fun compass(deg: Int) = listOf("N", "NE", "E", "SE", "S", "SO", "O", "NO")[((deg + 22) % 360) / 45]

private fun signedDeg(v: Double) = (if (v >= 0) "+" else "") + "%.1f".format(java.util.Locale.ITALY, v)

private fun dist(m: Int) = if (m < 1000) "$m m" else "%.2f km".format(java.util.Locale.ITALY, m / 1000.0)
