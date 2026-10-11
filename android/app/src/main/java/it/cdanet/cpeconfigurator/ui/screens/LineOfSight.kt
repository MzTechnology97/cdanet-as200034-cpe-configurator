package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.LosDto
import it.cdanet.cpeconfigurator.data.SignalEstimateDto
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.StatusPalette
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** Radius of the first Fresnel zone at [d] metres of a [total] metres link, m. */
fun fresnelRadius(d: Double, total: Double, freqMhz: Int): Double =
    if (total <= 0) 0.0 else sqrt((299.79 / (if (freqMhz > 0) freqMhz else 5600)) * d * max(0.0, total - d) / total)

/** Elevation angle from the CPE antenna to the AP antenna, degrees (positive: the AP is higher). */
fun tiltDeg(d: LosDto): Double {
    val a = d.chart.firstOrNull() ?: return 0.0
    val b = d.chart.lastOrNull() ?: return 0.0
    return Math.toDegrees(atan2(b.los - a.los, d.distanceM.toDouble().coerceAtLeast(1.0)))
}

/** Share of the first Fresnel zone left free at the critical point, % (100 when nothing enters it). */
fun fresnelFreePct(d: LosDto): Int {
    val w = d.worst ?: return 100
    val r = if (w.fresnel60M > 0) w.fresnel60M / 0.6 else return 100
    return (100 * w.clearanceM / r).roundToInt().coerceIn(0, 100)
}

/**
 * What the coverage check adds to the link (Verifica copertura): the AP as the server shows it to
 * this user, the CPE to install and its height, which the user can change from here.
 */
class LinkControls(
    val frequencyMhz: Int?,
    val stations: Int?,
    val loadLevel: String?,
    /** Admins only (installers do not get the numbers of the AP). */
    val noiseDbm: Double?,
    val cpeModels: List<it.cdanet.cpeconfigurator.data.CpeModelDto>,
    val cpeId: String,
    val cpeName: String?,
    val onCpe: (String) -> Unit,
    val heightM: Double?,
    val onHeight: (Double) -> Unit,
)

/** Indicative airMAX ac sensitivity at 40 MHz (dBm) for MCS 0…9 and the airOS rate multiplier. */
val MCS_SCALE = listOf(-91 to "1x", -89 to "2x", -86 to "3x", -83 to "4x", -79 to "6x", -75 to "8x", -73 to "9x", -71 to "10x", -66 to "12x", -64 to "13x")

/** Index of the highest modulation reached by [dbm] (−1: none). */
fun mcsReached(dbm: Int?): Int = if (dbm == null) -1 else MCS_SCALE.count { dbm >= it.first } - 1

/** Magnetic declination at the point, degrees east (to point with a compass). */
fun declinationDeg(lat: Double, lon: Double): Double =
    android.hardware.GeomagneticField(lat.toFloat(), lon.toFloat(), 300f, System.currentTimeMillis()).declination.toDouble()

/**
 * Line of sight towards an AP, as in UISP Design: the figures of the link (distance, pointing and
 * tilt from both ends, antenna heights, expected signal, free Fresnel zone) and the elevation
 * profile with the antennas on their masts, the line of sight and the whole first Fresnel zone.
 * [onLoaded] receives the profile (admins: the app draws the link on its map).
 */
@Composable
fun LineOfSightDialog(
    c: AppContainer,
    lat: Double,
    lon: Double,
    apId: String,
    apName: String,
    height: Double?,
    bearing: Int? = null,
    estimate: SignalEstimateDto? = null,
    onLoaded: ((LosDto) -> Unit)? = null,
    controls: LinkControls? = null,
    onClose: () -> Unit,
) {
    var data by remember { mutableStateOf<LosDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    // another height of the CPE: the profile again (the estimate comes with the new check)
    LaunchedEffect(apId, height) {
        runCatching { c.api.lineOfSight(lat, lon, apId, height) }.onSuccess { data = it; onLoaded?.invoke(it) }.onFailure { error = it.message }
    }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Collegamento con $apName") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val d = data
                when {
                    error != null -> Notice(error ?: "", NoticeKind.Bad)
                    d == null -> Text("Calcolo del profilo del terreno…")
                    else -> {
                        Notice(
                            when (d.verdict) {
                                "clear" -> "Visibilità libera: nessun rilievo sulla linea e zona di Fresnel libera."
                                "fresnel" -> "Si vede, ma il terreno entra nella zona di Fresnel: il segnale può calare. " +
                                    if (d.raiseCpeM <= MAX_MAST_M) "Alza il palo di ${fmt(d.raiseCpeM)} m." else "Meglio un altro AP."
                                else -> "Ostruita ${if (d.buildings) "da edifici" else "dal terreno"} a ${km(d.worst?.d ?: 0)} dalla CPE. " +
                                    if (d.raiseCpeM <= MAX_MAST_M) "Serve un palo più alto di ${fmt(d.raiseCpeM)} m oppure un altro AP." else "Nessun palo realistico la libera: scegli un altro AP."
                            },
                            when (d.verdict) { "clear" -> NoticeKind.Good; "fresnel" -> NoticeKind.Warn; else -> NoticeKind.Bad },
                        )
                        if (controls != null) ApFacts(controls)
                        LinkFacts(d, bearing, estimate, lat, lon)
                        if (controls != null) CpeControls(controls, d)
                        SignalBar(estimate?.signalDbm)
                        ProfileChart(d)
                        d.apAntenna?.let { a ->
                            Text(
                                "Antenna dell'AP a ${a.altitude} m s.l.m., ${a.aboveGroundM} m sopra il suolo (" + when (a.from) {
                                    "sito" -> "altezza del sito in UISP"
                                    "gps" -> "altitudine GPS"
                                    "uisp" -> "altezza scritta in UISP"
                                    else -> "altezza predefinita"
                                } + ").",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (d.foliageM > 0) Text("La linea di vista attraversa ${d.foliageM} m di vegetazione: il segnale cala per il fogliame.", style = MaterialTheme.typography.bodySmall)
                        Text(
                            (if (d.terrainSource == "tinitaly") "Terreno a 10 m con edifici (grigio) e alberi (verde) della mappa del suolo, ad altezze medie: verifica a vista."
                            else "Solo terreno (modello a 30 m): edifici e alberi non sono nel calcolo, verifica a vista.") +
                                if (d.ap?.lat != null) " Chiudi per vedere il collegamento e la zona di Fresnel sulla mappa." else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Chiudi") } },
    )
}

/** The figures of the link, two per row. */
@Composable
private fun LinkFacts(d: LosDto, bearing: Int?, estimate: SignalEstimateDto?, lat: Double, lon: Double) {
    val first = d.chart.firstOrNull()
    val last = d.chart.lastOrNull()
    val tilt = tiltDeg(d)
    val facts = buildList {
        add(Triple("Distanza", km(d.distanceM), "${d.frequencyMhz} MHz"))
        add(Triple("Fresnel libera", "${fresnelFreePct(d)}%", d.worst?.let { "punto critico a ${km(it.d)}" } ?: "su tutto il collegamento"))
        estimate?.capacityMbps?.let { add(Triple("Capacità stimata", "$it Mbit/s", "collegamento radio")) }
        if (bearing != null) {
            val magnetic = ((bearing - declinationDeg(lat, lon)).roundToInt() + 360) % 360
            add(Triple("CPE → AP", "$bearing° ${dirOf(bearing)}", "magnetico $magnetic° · inclinazione ${signed(tilt)}°"))
            add(Triple("AP → CPE", "${(bearing + 180) % 360}° ${dirOf((bearing + 180) % 360)}", "inclinazione ${signed(-tilt)}°"))
        }
        if (first != null) add(Triple("Antenna CPE", "${fmt(first.los - first.ground)} m", "${first.los.roundToInt()} m s.l.m."))
        if (last != null) add(Triple("Antenna AP", "${fmt(last.los - last.ground)} m", "${last.los.roundToInt()} m s.l.m."))
        estimate?.signalDbm?.let { add(Triple("Segnale stimato", "$it dBm", if (estimate.low != null) "${estimate.low}…${estimate.high} dBm" else "")) }
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        facts.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { (label, value, sub) ->
                    Column(
                        Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(horizontal = 10.dp, vertical = 8.dp),
                    ) {
                        Text(label.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(value, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                        if (sub.isNotBlank()) Text(sub, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/** The AP as the server shows it to this user. */
@Composable
private fun ApFacts(k: LinkControls) {
    val parts = listOfNotNull(
        k.frequencyMhz?.let { "$it MHz" },
        k.stations?.let { "$it client" },
        k.loadLevel?.let { "sera: $it" },
        k.noiseDbm?.let { "rumore ${it.roundToInt()} dBm" },
    )
    if (parts.isNotEmpty()) Text("AP · " + parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
}

/** The CPE to install (proposed or chosen) and its height, as in UISP Design. */
@Composable
private fun CpeControls(k: LinkControls, d: LosDto) {
    val h = k.heightM ?: (d.chart.firstOrNull()?.let { it.los - it.ground } ?: 6.0)
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("CPE DA INSTALLARE", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        d.roofM?.let { roof -> Text("Sul tetto: edificio di circa $roof m, antenna a ${fmt(d.mountedM ?: h)} m dal suolo", style = MaterialTheme.typography.bodySmall) }
        if (k.cpeModels.isNotEmpty()) {
            val options = listOf("auto") + k.cpeModels.map { it.id }
            it.cdanet.cpeconfigurator.ui.Dropdown(
                "Modello",
                options,
                k.cpeId,
                { id -> if (id == "auto") "Consigliata" + (k.cpeName?.let { " ($it)" } ?: "") else k.cpeModels.first { it.id == id }.let { m -> "${m.name} · ${m.gainDbi} dBi" } },
                k.onCpe,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Altezza", modifier = Modifier.weight(1f))
            androidx.compose.material3.FilledTonalIconButton(onClick = { k.onHeight((h - 1).coerceAtLeast(1.0)) }) { Text("−", fontWeight = FontWeight.Bold) }
            Text("${fmt(h)} m", fontWeight = FontWeight.Bold)
            androidx.compose.material3.FilledTonalIconButton(onClick = { k.onHeight((h + 1).coerceAtMost(60.0)) }) { Text("+", fontWeight = FontWeight.Bold) }
        }
    }
}

/** Expected signal on the airMAX modulation scale: the bar fills up to it, the reached MCS lit. */
@Composable
private fun SignalBar(dbm: Int?) {
    if (dbm == null) return
    val reached = mcsReached(dbm)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row {
            Text("Segnale atteso", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            Text("$dbm dBm", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
        }
        androidx.compose.material3.LinearProgressIndicator(
            progress = { ((dbm + 95) / 45f).coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)),
            color = if (reached >= 7) Color(0xFF22C55E) else if (reached >= 4) Color(0xFFFACC15) else Color(0xFFF97316),
            trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            drawStopIndicator = {},
        )
        Row {
            MCS_SCALE.forEachIndexed { i, (_, label) ->
                Text(
                    label,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    fontWeight = if (i <= reached) FontWeight.Bold else FontWeight.Normal,
                    color = if (i <= reached) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline,
                )
            }
        }
    }
}

@Composable
private fun ProfileChart(d: LosDto) {
    val st = StatusPalette
    val ground = MaterialTheme.colorScheme.outline
    val groundFill = MaterialTheme.colorScheme.surfaceContainerHighest
    val ink = MaterialTheme.colorScheme.onSurface
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val fresnel = Color(0xFF38BDF8)
    val sight = Color(0xFF2563EB)
    Canvas(Modifier.fillMaxWidth().height(230.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerLow)) {
        val pts = d.chart
        if (pts.size < 2) return@Canvas
        val total = pts.last().d.toDouble().coerceAtLeast(1.0)
        val r = pts.map { fresnelRadius(it.d.toDouble(), total, d.frequencyMhz) }
        val lo = pts.indices.minOf { minOf(pts[it].ground, pts[it].los - r[it]) } - 6
        val hi = pts.indices.maxOf { maxOf(pts[it].top ?: pts[it].ground, pts[it].los + r[it]) } + 14
        val padL = 8.dp.toPx()
        val padR = 8.dp.toPx()
        val padB = 18.dp.toPx()
        val w = size.width - padL - padR
        val hgt = size.height - padB
        fun x(v: Int) = padL + (v / total * w).toFloat()
        fun y(v: Double) = ((hi - v) / (hi - lo) * hgt).toFloat()
        val text = android.graphics.Paint().apply { isAntiAlias = true; textSize = 10.dp.toPx(); color = muted.toArgb() }
        // distances along the bottom
        val step = listOf(100, 250, 500, 1000, 2000, 5000).firstOrNull { total / it <= 6 } ?: 5000
        var t = 0
        while (t <= total) {
            drawLine(muted.copy(alpha = 0.18f), Offset(x(t), 0f), Offset(x(t), hgt), strokeWidth = 1f)
            text.textAlign = if (t == 0) android.graphics.Paint.Align.LEFT else android.graphics.Paint.Align.CENTER
            drawContext.canvas.nativeCanvas.drawText(km(t), x(t), size.height - 4.dp.toPx(), text)
            t += step
        }
        // whole first Fresnel zone (ellipse) and its 60% limit
        val ellipse = Path().apply {
            pts.forEachIndexed { i, p -> if (i == 0) moveTo(x(p.d), y(p.los + r[i])) else lineTo(x(p.d), y(p.los + r[i])) }
            for (i in pts.indices.reversed()) lineTo(x(pts[i].d), y(pts[i].los - r[i]))
            close()
        }
        drawPath(ellipse, fresnel.copy(alpha = 0.16f))
        drawPath(ellipse, fresnel.copy(alpha = 0.8f), style = Stroke(1.dp.toPx()))
        drawPath(
            Path().apply { pts.forEachIndexed { i, p -> if (i == 0) moveTo(x(p.d), y(p.los - 0.6 * r[i])) else lineTo(x(p.d), y(p.los - 0.6 * r[i])) } },
            st.warn.copy(alpha = 0.85f),
            style = Stroke(1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 8f))),
        )
        // terrain and the obstacles of the land cover on it
        val barW = (w / pts.size).coerceAtLeast(2f)
        pts.forEach { p ->
            val top = p.top ?: return@forEach
            val color = if (p.obstacle == "edificio") ground.copy(alpha = 0.6f) else Color(0xFF2E7D32).copy(alpha = 0.5f)
            drawRect(color, Offset(x(p.d) - barW / 2, y(top)), androidx.compose.ui.geometry.Size(barW, y(p.ground) - y(top)))
        }
        val terrain = Path().apply {
            moveTo(x(0), hgt)
            pts.forEach { lineTo(x(it.d), y(it.ground)) }
            lineTo(x(pts.last().d), hgt)
            close()
        }
        drawPath(terrain, groundFill)
        drawPath(Path().apply { pts.forEachIndexed { i, p -> if (i == 0) moveTo(x(p.d), y(p.ground)) else lineTo(x(p.d), y(p.ground)) } }, ground, style = Stroke(1.5.dp.toPx()))
        // line of sight and the two antennas on their masts
        drawLine(sight, Offset(x(pts.first().d), y(pts.first().los)), Offset(x(pts.last().d), y(pts.last().los)), strokeWidth = 2.5.dp.toPx())
        val label = android.graphics.Paint().apply { isAntiAlias = true; textSize = 11.dp.toPx(); isFakeBoldText = true; color = ink.toArgb() }
        listOf(pts.first() to "CPE", pts.last() to "AP").forEachIndexed { i, (p, name) ->
            drawLine(ink, Offset(x(p.d), y(p.ground)), Offset(x(p.d), y(p.los)), strokeWidth = 2.dp.toPx())
            drawCircle(Color(0xFFF97316), 5.dp.toPx(), Offset(x(p.d), y(p.los)))
            label.textAlign = if (i == 0) android.graphics.Paint.Align.LEFT else android.graphics.Paint.Align.RIGHT
            drawContext.canvas.nativeCanvas.drawText("$name ${fmt(p.los - p.ground)} m", x(p.d) + if (i == 0) 6.dp.toPx() else -6.dp.toPx(), y(p.los) - 8.dp.toPx(), label)
        }
        d.worst?.takeIf { d.verdict != "clear" }?.let { wst ->
            val p = pts.minByOrNull { abs(it.d - wst.d) }!!
            val top = maxOf(p.ground, p.top ?: p.ground)
            drawLine(st.bad, Offset(x(p.d), y(top)), Offset(x(p.d), y(p.los)), strokeWidth = 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
            drawCircle(st.bad, 5.dp.toPx(), Offset(x(p.d), y(top)))
        }
    }
}

/** Beyond this extra height a mast is not a realistic answer: another AP is. */
private const val MAX_MAST_M = 12.0

private fun fmt(v: Double) = if (abs(v % 1.0) < 0.05) v.roundToInt().toString() else "%.1f".format(java.util.Locale.ITALY, v)

private fun signed(v: Double) = (if (v >= 0) "+" else "") + "%.1f".format(java.util.Locale.ITALY, v)

private fun dirOf(deg: Int) = listOf("N", "NE", "E", "SE", "S", "SO", "O", "NO")[((deg + 22) % 360) / 45]

private fun km(m: Int) = if (m < 1000) "$m m" else "%.1f km".format(java.util.Locale.ITALY, m / 1000.0)
