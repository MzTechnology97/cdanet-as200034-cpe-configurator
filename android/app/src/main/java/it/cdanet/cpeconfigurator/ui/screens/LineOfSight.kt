package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.LosDto
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.StatusPalette

/**
 * Line of sight towards an AP before climbing: terrain profile, sight line and 60% of the first
 * Fresnel zone, with the verdict and how much higher the mast should be.
 */
@Composable
fun LineOfSightDialog(c: AppContainer, lat: Double, lon: Double, apId: String, apName: String, height: Double?, onClose: () -> Unit) {
    var data by remember { mutableStateOf<LosDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(apId) {
        runCatching { c.api.lineOfSight(lat, lon, apId, height) }.onSuccess { data = it }.onFailure { error = it.message }
    }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Visibilità verso $apName") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val d = data
                when {
                    error != null -> Notice(error ?: "", NoticeKind.Bad)
                    d == null -> Text("Calcolo del profilo del terreno…")
                    else -> {
                        Notice(
                            when (d.verdict) {
                                "clear" -> "Visibilità libera: nessun rilievo sulla linea e zona di Fresnel libera."
                                "fresnel" -> "Si vede, ma il terreno entra nella zona di Fresnel: il segnale può calare. Alza il palo di ${fmt(d.raiseCpeM)} m."
                                else -> "Ostruita dal terreno a ${km(d.worst?.d ?: 0)} dalla CPE. Serve un palo più alto di ${fmt(d.raiseCpeM)} m oppure un altro AP."
                            },
                            when (d.verdict) { "clear" -> NoticeKind.Good; "fresnel" -> NoticeKind.Warn; else -> NoticeKind.Bad },
                        )
                        ProfileChart(d)
                        Text(
                            "${km(d.distanceM)} · CPE a ${fmt(d.cpeHeightM)} m dal suolo · ${d.frequencyMhz} MHz. Solo terreno: edifici e alberi non sono nel modello, verifica a vista.",
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

@Composable
private fun ProfileChart(d: LosDto) {
    val st = StatusPalette
    val ground = MaterialTheme.colorScheme.outline
    val groundFill = MaterialTheme.colorScheme.surfaceContainerHighest
    val sight = if (d.verdict == "blocked") st.bad else if (d.verdict == "fresnel") st.warn else st.good
    Canvas(Modifier.fillMaxWidth().height(170.dp)) {
        val pts = d.chart
        if (pts.size < 2) return@Canvas
        val maxD = pts.last().d.toFloat().coerceAtLeast(1f)
        val lo = pts.minOf { minOf(it.ground, it.fresnel60) } - 5
        val hi = pts.maxOf { maxOf(it.ground, it.los) } + 10
        fun x(v: Int) = v / maxD * size.width
        fun y(v: Double) = ((hi - v) / (hi - lo) * size.height).toFloat()
        val terrain = Path().apply {
            moveTo(0f, size.height)
            pts.forEach { lineTo(x(it.d), y(it.ground)) }
            lineTo(size.width, size.height)
            close()
        }
        drawPath(terrain, groundFill)
        drawPath(Path().apply { pts.forEachIndexed { i, p -> if (i == 0) moveTo(x(p.d), y(p.ground)) else lineTo(x(p.d), y(p.ground)) } }, ground, style = Stroke(2.dp.toPx()))
        // lower edge of 60% of the Fresnel zone (dashed) and the line of sight
        drawPath(
            Path().apply { pts.forEachIndexed { i, p -> if (i == 0) moveTo(x(p.d), y(p.fresnel60)) else lineTo(x(p.d), y(p.fresnel60)) } },
            sight.copy(alpha = 0.7f),
            style = Stroke(1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 8f))),
        )
        drawLine(sight, Offset(0f, y(pts.first().los)), Offset(size.width, y(pts.last().los)), strokeWidth = 3.dp.toPx())
        drawCircle(sight, 5.dp.toPx(), Offset(0f, y(pts.first().los)))
        drawCircle(sight, 5.dp.toPx(), Offset(size.width, y(pts.last().los)))
        d.worst?.takeIf { d.verdict != "clear" }?.let { w ->
            val p = pts.minByOrNull { kotlin.math.abs(it.d - w.d) }!!
            drawCircle(st.bad, 6.dp.toPx(), Offset(x(p.d), y(p.ground)))
        }
    }
}

private fun fmt(v: Double) = if (v % 1.0 == 0.0) v.toInt().toString() else "%.1f".format(java.util.Locale.ITALY, v)

private fun km(m: Int) = if (m < 1000) "$m m" else "%.1f km".format(java.util.Locale.ITALY, m / 1000.0)
